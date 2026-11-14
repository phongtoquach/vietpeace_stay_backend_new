const express = require("express");
const config = require("../configs/chat");
const { chatError } = require("../services/chat/db");
const { createOrRefreshGuestSession, getGuestRawToken, resolveGuestByRawToken, clearGuestCookie } = require("../services/chat/guest");
const { resolveWebActor, resolveAdminActor, issueSocketTicket } = require("../services/chat/identity");
const chatService = require("../services/chat/service");
const ratingService = require("../services/chat/ratings");
const adminService = require("../services/chat/admin");
const internalService = require("../services/chat/internal");
const { triggerOutboxDrain } = require("../services/chat/runtime");

function handleChatError(res, err) {
  const status = err?.statusCode || 500;
  if (status >= 500) {
    console.error("[chat.routes]", err);
  }
  return res.status(status).json({
    success: false,
    errorCode: err?.errorCode || "CHAT_ERROR",
    message: err?.message || "Đã có lỗi xảy ra trên hệ thống chat.",
  });
}

function createWebChatRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!config.enabled) {
      return res.status(503).json({
        success: false,
        errorCode: "CHAT_DISABLED",
        message: "Hệ thống chat hiện đang bảo trì.",
      });
    }
    return next();
  });

  // Ensure Customer or Guest actor
  async function requireWebActor(req, res, next) {
    try {
      const resolved = await resolveWebActor(req, { allowGuest: true });
      if (!resolved.actor) {
        return next(chatError(401, "CHAT_IDENTITY_REQUIRED", "Chưa có phiên trò chuyện hợp lệ."));
      }
      req.chatActor = resolved.actor;
      req.chatSessionKey = resolved.sourceSessionKey;
      return next();
    } catch (err) {
      return handleChatError(res, err);
    }
  }

  router.get("/bootstrap", async (req, res) => {
    try {
      const resolved = await resolveWebActor(req, { allowGuest: true });
      const conversations = resolved.actor ? await chatService.listOwnerConversations(resolved.actor) : [];
      const featuredLocations = await chatService.getFeaturedDestinations(8);

      return res.json({
        success: true,
        data: {
          enabled: config.enabled,
          aiEnabled: config.aiEnabled(),
          actor: resolved.actor
            ? {
                type: resolved.actor.type,
                actorKey: resolved.actor.actorKey,
                displayName: resolved.actor.displayName,
                userId: resolved.actor.userId || null,
                guestSessionId: resolved.actor.guestSessionId || null,
              }
            : null,
          greetingText: chatService.POLITE_HOME_GREETING,
          featuredLocations,
          conversations,
        },
      });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/guest-session", async (req, res) => {
    try {
      const resolved = await resolveWebActor(req, { allowGuest: false });
      if (resolved.actor?.type === "CUSTOMER") {
        return res.json({
          success: true,
          data: {
            actor: {
              type: "CUSTOMER",
              actorKey: resolved.actor.actorKey,
              displayName: resolved.actor.displayName,
              userId: resolved.actor.userId,
            },
          },
        });
      }
      const guest = await createOrRefreshGuestSession(req, res);
      return res.json({
        success: true,
        data: {
          actor: {
            type: guest.type,
            actorKey: guest.actorKey,
            displayName: guest.displayName,
            guestSessionId: guest.guestSessionId,
          },
        },
      });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/socket-ticket", async (req, res) => {
    try {
      let resolved = await resolveWebActor(req, { allowGuest: true });
      if (!resolved.actor) {
        const guest = await createOrRefreshGuestSession(req, res);
        resolved = { actor: guest, sourceSessionKey: `guest:${guest.guestSessionId}` };
      }
      const ticket = await issueSocketTicket(resolved.actor, "web", resolved.sourceSessionKey);
      return res.json({ success: true, data: ticket });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/claim-guest-conversations", async (req, res) => {
    try {
      const resolved = await resolveWebActor(req, { allowGuest: false });
      if (!resolved.actor || resolved.actor.type !== "CUSTOMER") {
        return res.status(401).json({
          success: false,
          errorCode: "LOGIN_REQUIRED",
          message: "Cần đăng nhập tài khoản Khách hàng để đồng bộ lịch sử trò chuyện.",
        });
      }
      const rawGuest = getGuestRawToken(req);
      if (!rawGuest) {
        return res.json({ success: true, data: { claimedCount: 0, mergedCount: 0 } });
      }
      const guest = await resolveGuestByRawToken(rawGuest);
      if (!guest) {
        clearGuestCookie(res);
        return res.json({ success: true, data: { claimedCount: 0, mergedCount: 0 } });
      }
      const result = await chatService.claimGuestConversationsToCustomer(resolved.actor, guest.guestSessionId);
      clearGuestCookie(res);
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/handoff-guide/destinations", async (req, res) => {
    try {
      const items = await chatService.listHandoffGuideDestinations();
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/handoff-guide/accommodations", async (req, res) => {
    try {
      const items = await chatService.listHandoffGuideAccommodations(req.query.locationId);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations", requireWebActor, async (req, res) => {
    try {
      const items = await chatService.listOwnerConversations(req.chatActor);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations", async (req, res) => {
    try {
      let resolved = await resolveWebActor(req, { allowGuest: true });
      if (!resolved.actor) {
        const guest = await createOrRefreshGuestSession(req, res);
        resolved = { actor: guest, sourceSessionKey: `guest:${guest.guestSessionId}` };
      }
      const result = await chatService.openOrReuseConversation(resolved.actor, req.body || {});
      triggerOutboxDrain();
      return res.status(result.created ? 201 : 200).json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id", requireWebActor, async (req, res) => {
    try {
      const item = await chatService.getOwnerConversationDetail(req.chatActor, req.params.id);
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/context", requireWebActor, async (req, res) => {
    try {
      const item = await chatService.updateConversationContext(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id/messages", requireWebActor, async (req, res) => {
    try {
      const items = await chatService.getOwnerConversationMessages(req.chatActor, req.params.id, req.query || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/messages", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.sendOwnerMessage(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/transfer", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.transferScopeOrReopen(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/reopen", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.transferScopeOrReopen(req.chatActor, req.params.id, {});
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/end-guest", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.endGuestConversation(req.chatActor, req.params.id);
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/handoff", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.requestHumanSupport(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/cancel-handoff", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.cancelHumanSupport(req.chatActor, req.params.id);
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/delivered", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.updateOwnerReceipt(req.chatActor, req.params.id, req.body?.sequence, {
        kind: "delivered",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/delivered-sync", requireWebActor, async (req, res) => {
    try {
      const updated = await chatService.syncOwnerDeliveredAll(req.chatActor);
      triggerOutboxDrain();
      return res.json({ success: true, data: { updated } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/read", requireWebActor, async (req, res) => {
    try {
      const result = await chatService.updateOwnerReceipt(req.chatActor, req.params.id, req.body?.sequence, {
        kind: "read",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/handoffs/:handoffId/rating", requireWebActor, async (req, res) => {
    try {
      const result = await ratingService.submitHandoffRating(req.chatActor, req.params.handoffId, req.body || {});
      triggerOutboxDrain();
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id/ratings", requireWebActor, async (req, res) => {
    try {
      const items = await ratingService.listOwnerConversationRatings(req.chatActor, req.params.id);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  return router;
}

function createAdminChatRouter() {
  const router = express.Router();

  async function requireAdminChatActor(req, res, next) {
    try {
      const resolved = await resolveAdminActor(req);
      req.chatActor = resolved.actor;
      req.chatSessionKey = resolved.sourceSessionKey;
      return next();
    } catch (err) {
      return handleChatError(res, err);
    }
  }

  router.use(requireAdminChatActor);

  router.post("/socket-ticket", async (req, res) => {
    try {
      const ticket = await issueSocketTicket(req.chatActor, "admin", req.chatSessionKey);
      return res.json({ success: true, data: ticket });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/me", async (req, res) => {
    return res.json({
      success: true,
      data: {
        userId: req.chatActor.userId,
        actorKey: req.chatActor.actorKey,
        role: req.chatActor.role,
        displayName: req.chatActor.displayName,
        accommodationId: req.chatActor.accommodationId,
        accommodationName: req.chatActor.accommodationName,
        assignmentEpochId: req.chatActor.assignmentEpochId,
        permissions: req.chatActor.permissions,
      },
    });
  });

  // Customer-Manager operations (NO ADMIN_UNASSIGNED_QUEUE, NO FAQ)
  router.get("/conversations", async (req, res) => {
    try {
      const items = await adminService.listStaffConversations(req.chatActor, req.query || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversation-accommodations", async (req, res) => {
    try {
      const items = await adminService.listSuperviseAccommodations(req.chatActor);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id", async (req, res) => {
    try {
      const item = await adminService.assertStaffConversationAccess(req.chatActor, req.params.id);
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id/messages", async (req, res) => {
    try {
      const items = await adminService.getStaffConversationMessages(req.chatActor, req.params.id, req.query || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/messages", async (req, res) => {
    try {
      const result = await adminService.sendManagerReply(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/claim", async (req, res) => {
    try {
      const item = await adminService.claimConversation(req.chatActor, req.params.id);
      triggerOutboxDrain();
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/notes", async (req, res) => {
    try {
      const msg = await adminService.addStaffNote(req.chatActor, req.params.id, req.body || {});
      triggerOutboxDrain();
      return res.status(201).json({ success: true, data: msg });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/ai-drafts", async (req, res) => {
    try {
      const draft = await adminService.generateAiDraftForManager(req.chatActor, req.params.id);
      return res.json({ success: true, data: draft });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/return-to-ai", async (req, res) => {
    try {
      const item = await adminService.returnConversationToAi(req.chatActor, req.params.id);
      triggerOutboxDrain();
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/resolve", async (req, res) => {
    try {
      const item = await adminService.resolveConversationByManager(req.chatActor, req.params.id);
      triggerOutboxDrain();
      return res.json({ success: true, data: item });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/delivered", async (req, res) => {
    try {
      const result = await adminService.updateManagerReceipt(req.chatActor, req.params.id, req.body?.sequence, {
        kind: "delivered",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/delivered-sync", async (req, res) => {
    try {
      const updated = await adminService.syncManagerDeliveredAll(req.chatActor);
      triggerOutboxDrain();
      return res.json({ success: true, data: { updated } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/conversations/:id/read", async (req, res) => {
    try {
      const result = await adminService.updateManagerReceipt(req.chatActor, req.params.id, req.body?.sequence, {
        kind: "read",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/conversations/:id/events", async (req, res) => {
    try {
      const items = await adminService.getConversationAuditEvents(req.chatActor, req.params.id);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/settings", async (req, res) => {
    try {
      const items = await adminService.getSupportSettings(req.chatActor);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const items = await adminService.updateSupportSettings(req.chatActor, req.body || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  // Internal Chat (Admin <-> Manager & Manager <-> Manager)
  router.get("/internal/contacts", async (req, res) => {
    try {
      const items = await internalService.listInternalContacts(req.chatActor);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/internal/threads", async (req, res) => {
    try {
      const items = await internalService.listInternalThreads(req.chatActor);
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/internal/threads", async (req, res) => {
    try {
      const thread = await internalService.openOrCreateInternalThread(req.chatActor, req.body?.targetUserId);
      return res.json({ success: true, data: thread });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/internal/threads/:threadId/messages", async (req, res) => {
    try {
      const items = await internalService.listInternalMessages(req.chatActor, req.params.threadId, req.query || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/internal/threads/:threadId/messages", async (req, res) => {
    try {
      const result = await internalService.sendInternalMessage(req.chatActor, req.params.threadId, req.body || {});
      triggerOutboxDrain();
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/internal/threads/:threadId/delivered", async (req, res) => {
    try {
      const result = await internalService.updateInternalReceipt(req.chatActor, req.params.threadId, req.body?.sequence, {
        kind: "delivered",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/internal/delivered-sync", async (req, res) => {
    try {
      const updated = await internalService.syncInternalDeliveredAll(req.chatActor);
      triggerOutboxDrain();
      return res.json({ success: true, data: { updated } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/internal/threads/:threadId/read", async (req, res) => {
    try {
      const result = await internalService.updateInternalReceipt(req.chatActor, req.params.threadId, req.body?.sequence, {
        kind: "read",
      });
      triggerOutboxDrain();
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.patch("/internal/threads/:threadId/rename", async (req, res) => {
    try {
      const result = await internalService.renameInternalThread(
        req.chatActor,
        req.params.threadId,
        req.body?.customName,
      );
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/internal/summary", async (req, res) => {
    try {
      const summary = await internalService.getInternalSummary(req.chatActor);
      return res.json({ success: true, data: summary });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  // Admin-Only Reports (Missed 5-minute handoffs + Low CSKH Ratings + Warning Email)
  router.get("/reports/summary", async (req, res) => {
    try {
      const summary = await adminService.getAdminReportsSummary(req.chatActor);
      return res.json({ success: true, data: summary });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/reports/missed-handoffs", async (req, res) => {
    try {
      const items = await adminService.listMissedHandoffReports(req.chatActor, {
        unreadOnly: req.query.unreadOnly === "true",
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/reports/missed-handoffs/:id/ack", async (req, res) => {
    try {
      const result = await adminService.ackMissedHandoffReport(req.chatActor, req.params.id);
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.get("/ratings", async (req, res) => {
    try {
      const items = await ratingService.listAdminRatings(req.chatActor, req.query || {});
      return res.json({ success: true, data: { items } });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/ratings/:ratingId/review", async (req, res) => {
    try {
      const result = await ratingService.reviewAdminRating(req.chatActor, req.params.ratingId, req.body || {});
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  router.post("/ratings/:ratingId/warning-email", async (req, res) => {
    try {
      const result = await ratingService.sendRatingWarningEmail(req.chatActor, req.params.ratingId, req.body || {});
      return res.json({ success: true, data: result });
    } catch (err) {
      return handleChatError(res, err);
    }
  });

  return router;
}

module.exports = {
  createWebChatRouter,
  createAdminChatRouter,
};
