const { Server } = require("socket.io");
const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const { consumeSocketTicket, revalidateSocketActor, actorKeyForUser } = require("./identity");
const { parseJsonSafe } = require("./db");
const chatService = require("./service");
const adminService = require("./admin");
const internalService = require("./internal");
const aiService = require("./ai");
const lifecycleService = require("./lifecycle");

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let ioInstance = null;
let outboxTimer = null;
let expiryTimer = null;
let cleanupTimer = null;
let revalidateTimer = null;
let activeDrainPromise = null;
let drainQueuedAgain = false;

function actorRoom(actorKey) {
  return `actor:${actorKey}`;
}

function getRuntime() {
  if (!ioInstance) return null;
  const nsp = ioInstance.of("/chat");

  function emitToConversation(conversationId, eventName, payload) {
    const cid = Number(conversationId);
    nsp.to(`conversation:${cid}:public`).emit(eventName, payload);
  }

  return {
    io: ioInstance,
    nsp,
    emitToConversation,
    triggerOutboxDrain,
  };
}

async function dispatchOutboxJob(job) {
  const runtime = getRuntime();
  if (!runtime) return;
  const { nsp } = runtime;
  const payload = parseJsonSafe(job.payloadJson, {}) || {};

  if (job.kind === "AI_SCHEDULE") {
    // Execute async without stalling other outbox deliveries
    setImmediate(() => {
      aiService.executeAiJob(payload.conversationId || job.conversationId, runtime).catch((err) => {
        console.error("[chat.outbox.AI_SCHEDULE]", err);
      });
    });
    return;
  }

  if (job.kind === "ACCESS_REVOKED") {
    const room = actorRoom(payload.actorKey || `user:${String(payload.userId).toLowerCase()}`);
    const sockets = await nsp.in(room).fetchSockets();
    for (const s of sockets) {
      if (payload.audience && s.data?.audience !== payload.audience) continue;
      s.emit("access:revoked", { reason: payload.reason || "ACCESS_REVOKED" });
      s.disconnect(true);
    }
    return;
  }

  if (job.kind === "INTERNAL_EVENT") {
    if (payload.threadId) {
      nsp.to(`internal:thread:${payload.threadId}`).emit(job.eventName, payload);
    }
    if (payload.adminUserId) {
      nsp.to(actorRoom(`user:${String(payload.adminUserId).toLowerCase()}`)).emit(job.eventName, payload);
    }
    if (payload.managerUserId) {
      nsp.to(actorRoom(`user:${String(payload.managerUserId).toLowerCase()}`)).emit(job.eventName, payload);
    }
    return;
  }

  if (job.kind === "SOCKET_EVENT") {
    // 1. Expired Guest hard-delete events where job.conversationId is NULL
    if (job.eventName === "conversation:expired") {
      if (payload.ownerKey) {
        nsp.to(actorRoom(payload.ownerKey)).emit("conversation:expired", payload);
      }
      if (payload.conversationId) {
        nsp.to(`conversation:${payload.conversationId}:public`).emit("conversation:expired", payload);
      }
      return;
    }

    // 2. Admin-only real-time alerts
    if (job.eventName === "admin:missed-handoff-alert" || job.eventName === "admin:low-rating-alert") {
      nsp.to("role:ADMIN").emit(job.eventName, payload);
      return;
    }

    // 3. Targeted Manager handoff / missed / queue alerts
    if (["handoff:requested", "handoff:missed", "queue:updated"].includes(job.eventName)) {
      if (payload.managerUserId) {
        nsp.to(actorRoom(`user:${String(payload.managerUserId).toLowerCase()}`)).emit(job.eventName, payload);
      }
      if (payload.ownerKey) {
        nsp.to(actorRoom(payload.ownerKey)).emit(job.eventName, payload);
      }
      nsp.to("role:ADMIN").emit(job.eventName, payload);
      return;
    }

    // 4. Visibility-scoped message & conversation updates
    const cid = Number(payload.conversationId || job.conversationId);
    if (!cid) return;

    const visibility = payload.visibility || payload.message?.visibility || "PUBLIC";

    if (visibility === "OWNER_ONLY") {
      nsp.to(`conversation:${cid}:owner`).emit(job.eventName, payload);
      if (payload.ownerKey) nsp.to(actorRoom(payload.ownerKey)).emit(job.eventName, payload);
      return;
    }

    if (visibility === "STAFF") {
      nsp.to(`conversation:${cid}:staff`).emit(job.eventName, payload);
      return;
    }

    // PUBLIC events: deliver to joined conversation room + owner room + target/assigned manager room + admin supervisors
    nsp.to(`conversation:${cid}:public`).emit(job.eventName, payload);
    if (payload.ownerKey) {
      nsp.to(actorRoom(payload.ownerKey)).emit(job.eventName, payload);
    }
    if (payload.assignedUserId) {
      nsp.to(actorRoom(`user:${String(payload.assignedUserId).toLowerCase()}`)).emit(job.eventName, payload);
    }
    if (payload.targetManagerUserId) {
      nsp.to(actorRoom(`user:${String(payload.targetManagerUserId).toLowerCase()}`)).emit(job.eventName, payload);
    }
    if (["message:created", "conversation:updated"].includes(job.eventName)) {
      nsp.to("role:ADMIN").emit(job.eventName, payload);
    }
  }
}

async function runDrainPass() {
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("workerId", sqlObj.VarChar(100), WORKER_ID)
    .query(`
      SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
      ;WITH cte AS (
        SELECT TOP 30 *
        FROM dbo.chat_outbox WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE status = 'PENDING'
          AND available_at <= SYSUTCDATETIME()
          AND (locked_until IS NULL OR locked_until < SYSUTCDATETIME())
        ORDER BY available_at ASC, id ASC
      )
      UPDATE cte
      SET locked_until = DATEADD(second, 15, SYSUTCDATETIME()),
          locked_by = @workerId
      OUTPUT
        INSERTED.id,
        INSERTED.kind,
        INSERTED.conversation_id AS conversationId,
        INSERTED.event_name AS eventName,
        INSERTED.payload_json AS payloadJson,
        INSERTED.attempts;
    `);

  for (const job of res.recordset) {
    try {
      await dispatchOutboxJob(job);
      await pool
        .request()
        .input("id", sqlObj.BigInt, job.id)
        .query(`
          UPDATE dbo.chat_outbox
          SET status = 'SENT', processed_at = SYSUTCDATETIME(), locked_until = NULL, locked_by = NULL
          WHERE id = @id;
        `);
    } catch (err) {
      const nextAttempt = Number(job.attempts || 0) + 1;
      const nextStatus = nextAttempt >= 5 ? "DEAD" : "PENDING";
      await pool
        .request()
        .input("id", sqlObj.BigInt, job.id)
        .input("status", sqlObj.VarChar(16), nextStatus)
        .input("attempts", sqlObj.Int, nextAttempt)
        .input("err", sqlObj.NVarChar(500), String(err?.message || "DISPATCH_ERR").slice(0, 480))
        .query(`
          UPDATE dbo.chat_outbox
          SET status = @status,
              attempts = @attempts,
              last_error = @err,
              available_at = DATEADD(second, CASE WHEN @attempts = 1 THEN 2 ELSE 10 END, SYSUTCDATETIME()),
              processed_at = CASE WHEN @status = 'DEAD' THEN SYSUTCDATETIME() ELSE NULL END,
              locked_until = NULL,
              locked_by = NULL
          WHERE id = @id;
        `);
    }
  }
}

async function drainOutboxOnce() {
  if (activeDrainPromise) {
    drainQueuedAgain = true;
    return activeDrainPromise;
  }

  activeDrainPromise = (async () => {
    try {
      do {
        drainQueuedAgain = false;
        await runDrainPass();
      } while (drainQueuedAgain);
    } catch (err) {
      console.error("[chat.outbox.poll]", err);
    } finally {
      activeDrainPromise = null;
    }
  })();

  return activeDrainPromise;
}

function attachChatSocket(httpServer) {
  if (!config.enabled) return null;
  if (ioInstance) return ioInstance;

  ioInstance = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: config.allowedOrigins(),
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  const nsp = ioInstance.of("/chat");

  nsp.use(async (socket, next) => {
    try {
      const ticket = socket.handshake.auth?.ticket;
      const verified = await consumeSocketTicket(ticket, socket.handshake);
      socket.data.audience = verified.audience;
      socket.data.actor = verified.actor;
      socket.data.sourceSessionKey = verified.sourceSessionKey;
      next();
    } catch (err) {
      next(new Error(err?.message || "Unauthorized Socket Connection"));
    }
  });

  nsp.on("connection", async (socket) => {
    const actor = socket.data.actor;
    socket.join(actorRoom(actor.actorKey));
    if (actor.role === "ADMIN") socket.join("role:ADMIN");

    // On Web/Admin reconnect: automatically mark pending inbox messages delivered cleanly
    setImmediate(() => {
      if (socket.data.audience === "web") {
        chatService.syncOwnerDeliveredAll(actor).catch(() => {});
      } else if (actor.role === "ACCOMMODATION_MANAGER") {
        adminService.syncManagerDeliveredAll(actor).catch(() => {});
        internalService.syncInternalDeliveredAll(actor).catch(() => {});
      } else if (actor.role === "ADMIN") {
        internalService.syncInternalDeliveredAll(actor).catch(() => {});
      }
    });

    socket.on("conversation:join", async (data = {}, ack) => {
      try {
        const freshActor = await revalidateSocketActor(socket.data);
        if (!freshActor) {
          socket.emit("access:revoked", { reason: "SESSION_EXPIRED" });
          socket.disconnect(true);
          return ack?.({ ok: false, errorCode: "SESSION_EXPIRED" });
        }
        socket.data.actor = freshActor;
        const cid = Number(data.conversationId);
        if (socket.data.audience === "web") {
          await chatService.assertOwnerConversation?.(freshActor, cid).catch(async () => {
            await chatService.getOwnerConversationDetail(freshActor, cid);
          });
          // Re-verify strictly using getOwnerConversationDetail
          const detail = await chatService.getOwnerConversationDetail(freshActor, cid);
          socket.join(`conversation:${cid}:public`);
          socket.join(`conversation:${cid}:owner`);
          return ack?.({ ok: true, conversation: detail });
        } else {
          const conv = await adminService.assertStaffConversationAccess(freshActor, cid);
          socket.join(`conversation:${cid}:public`);
          socket.join(`conversation:${cid}:staff`);
          return ack?.({ ok: true, conversationId: cid, lastSequence: Number(conv.lastSequence) });
        }
      } catch (err) {
        return ack?.({ ok: false, errorCode: err?.errorCode || "JOIN_FAILED", message: err?.message });
      }
    });

    socket.on("conversation:leave", (data = {}) => {
      const cid = Number(data.conversationId);
      if (cid) {
        socket.leave(`conversation:${cid}:public`);
        socket.leave(`conversation:${cid}:owner`);
        socket.leave(`conversation:${cid}:staff`);
      }
    });

    socket.on("conversation:context", async (data = {}, ack) => {
      try {
        if (socket.data.audience !== "web") return ack?.({ ok: false });
        const freshActor = await revalidateSocketActor(socket.data);
        if (!freshActor) return ack?.({ ok: false, errorCode: "SESSION_EXPIRED" });
        const updated = await chatService.updateConversationContext(
          freshActor,
          data.conversationId,
          data.pageContext || {},
        );
        return ack?.({ ok: true, conversation: updated });
      } catch (err) {
        return ack?.({ ok: false, message: err?.message });
      }
    });

    socket.on("message:send", async (data = {}, ack) => {
      try {
        const freshActor = await revalidateSocketActor(socket.data);
        if (!freshActor) {
          socket.emit("access:revoked", { reason: "SESSION_EXPIRED" });
          socket.disconnect(true);
          return ack?.({ ok: false, errorCode: "SESSION_EXPIRED" });
        }
        socket.data.actor = freshActor;

        let res;
        if (socket.data.audience === "web") {
          res = await chatService.sendOwnerMessage(freshActor, data.conversationId, data);
        } else {
          res = await adminService.sendManagerReply(freshActor, data.conversationId, data);
        }
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, ...res });
      } catch (err) {
        return ack?.({ ok: false, errorCode: err?.errorCode || "SEND_FAILED", message: err?.message });
      }
    });

    socket.on("message:delivered", async (data = {}, ack) => {
      try {
        const actorNow = socket.data.actor;
        let out = null;
        if (socket.data.audience === "web") {
          out = await chatService.updateOwnerReceipt(actorNow, data.conversationId, data.sequence, { kind: "delivered" });
        } else if (actorNow?.role === "ACCOMMODATION_MANAGER") {
          out = await adminService.updateManagerReceipt(actorNow, data.conversationId, data.sequence, { kind: "delivered" });
        }
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, receipt: out });
      } catch (err) {
        return ack?.({ ok: false, message: err?.message });
      }
    });

    socket.on("message:read", async (data = {}, ack) => {
      try {
        const actorNow = socket.data.actor;
        let out = null;
        if (socket.data.audience === "web") {
          out = await chatService.updateOwnerReceipt(actorNow, data.conversationId, data.sequence, { kind: "read" });
        } else if (actorNow?.role === "ACCOMMODATION_MANAGER") {
          out = await adminService.updateManagerReceipt(actorNow, data.conversationId, data.sequence, { kind: "read" });
        }
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, receipt: out });
      } catch (err) {
        return ack?.({ ok: false, message: err?.message });
      }
    });

    socket.on("typing:update", (data = {}) => {
      const cid = Number(data.conversationId);
      if (!cid || actor.role === "ADMIN") return;
      socket.to(`conversation:${cid}:public`).emit("typing:update", {
        conversationId: cid,
        actorKey: actor.actorKey,
        actorName: actor.displayName,
        isTyping: Boolean(data.isTyping),
      });
    });

    socket.on("presence:heartbeat", () => {
      socket.data.lastHeartbeat = Date.now();
    });

    // Internal chat events (Admin <-> Manager & Manager <-> Manager)
    socket.on("internal:join", async (data = {}, ack) => {
      try {
        if (socket.data.audience !== "admin") return ack?.({ ok: false, errorCode: "FORBIDDEN" });
        const freshActor = await revalidateSocketActor(socket.data);
        if (!freshActor) return ack?.({ ok: false, errorCode: "SESSION_EXPIRED" });
        socket.data.actor = freshActor;
        const tid = Number(data.threadId);
        await internalService.assertThreadParticipant(freshActor, tid);
        socket.join(`internal:thread:${tid}`);
        return ack?.({ ok: true, threadId: tid });
      } catch (err) {
        return ack?.({ ok: false, errorCode: err?.errorCode, message: err?.message });
      }
    });

    socket.on("internal:send", async (data = {}, ack) => {
      try {
        if (socket.data.audience !== "admin") return ack?.({ ok: false, errorCode: "FORBIDDEN" });
        const freshActor = await revalidateSocketActor(socket.data);
        if (!freshActor) return ack?.({ ok: false, errorCode: "SESSION_EXPIRED" });
        socket.data.actor = freshActor;
        const res = await internalService.sendInternalMessage(freshActor, data.threadId, data);
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, ...res });
      } catch (err) {
        return ack?.({ ok: false, errorCode: err?.errorCode || "INTERNAL_SEND_FAILED", message: err?.message });
      }
    });

    socket.on("internal:delivered", async (data = {}, ack) => {
      try {
        if (socket.data.audience !== "admin") return ack?.({ ok: false });
        const out = await internalService.updateInternalReceipt(socket.data.actor, data.threadId, data.sequence, {
          kind: "delivered",
        });
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, receipt: out });
      } catch (err) {
        return ack?.({ ok: false, message: err?.message });
      }
    });

    socket.on("internal:read", async (data = {}, ack) => {
      try {
        if (socket.data.audience !== "admin") return ack?.({ ok: false });
        const out = await internalService.updateInternalReceipt(socket.data.actor, data.threadId, data.sequence, {
          kind: "read",
        });
        setImmediate(() => drainOutboxOnce().catch(() => {}));
        return ack?.({ ok: true, receipt: out });
      } catch (err) {
        return ack?.({ ok: false, message: err?.message });
      }
    });
  });

  startWorkers();
  return ioInstance;
}

function startWorkers() {
  if (!outboxTimer) {
    outboxTimer = setInterval(() => {
      drainOutboxOnce().catch(() => {});
    }, config.outboxPollMs);
  }

  if (!expiryTimer) {
    expiryTimer = setInterval(async () => {
      try {
        await lifecycleService.processExpiryBatch();
        await drainOutboxOnce();
      } catch (err) {
        console.error("[chat.worker.expiry]", err);
      }
    }, config.expiryPollMs);
  }

  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      lifecycleService.runHousekeepingCleanup().catch((err) => {
        console.error("[chat.worker.cleanup]", err);
      });
    }, config.cleanupPollMs);
  }

  if (!revalidateTimer) {
    revalidateTimer = setInterval(async () => {
      try {
        if (!ioInstance) return;
        const sockets = await ioInstance.of("/chat").fetchSockets();
        for (const s of sockets) {
          const ok = await revalidateSocketActor(s.data).catch(() => null);
          if (!ok) {
            s.emit("access:revoked", { reason: "REVALIDATE_EXPIRED" });
            s.disconnect(true);
          } else {
            s.data.actor = ok;
          }
        }
      } catch (err) {
        console.error("[chat.worker.revalidate]", err);
      }
    }, 30000);
  }
}

function stopWorkers() {
  for (const timer of [outboxTimer, expiryTimer, cleanupTimer, revalidateTimer]) {
    if (timer) clearInterval(timer);
  }
  outboxTimer = expiryTimer = cleanupTimer = revalidateTimer = null;
}

function triggerOutboxDrain() {
  setImmediate(() => drainOutboxOnce().catch(() => {}));
}

module.exports = {
  attachChatSocket,
  stopWorkers,
  drainOutboxOnce,
  triggerOutboxDrain,
  getRuntime,
};
