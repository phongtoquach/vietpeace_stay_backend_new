const { getDBPool, sqlObj } = require("../../configs/database");
const { sendChatCskhWarningEmail } = require("../mail_service");
const {
  chatError,
  withTransaction,
  newRequest,
  lockConversationsInOrder,
  enqueueOutbox,
  recordChatEvent,
} = require("./db");
const { hasPermission } = require("./identity");

/**
 * Customer rates a specific handoff session 1-5 stars after at least one public manager reply.
 * Strictly requires CUSTOMER actor; 1-3 stars automatically flag PENDING_REVIEW for Admin Reports.
 */
async function submitHandoffRating(actor, handoffId, { rating, comment = null }) {
  if (!actor || actor.type !== "CUSTOMER") {
    throw chatError(403, "CUSTOMER_REQUIRED", "Vui lòng đăng nhập tài khoản khách hàng để gửi đánh giá.");
  }
  const hid = Number(handoffId);
  const stars = Number(rating);
  if (!Number.isSafeInteger(hid) || hid < 1) {
    throw chatError(400, "INVALID_HANDOFF_ID", "Mã phiên hỗ trợ không hợp lệ.");
  }
  if (!Number.isSafeInteger(stars) || stars < 1 || stars > 5) {
    throw chatError(400, "INVALID_RATING", "Số sao đánh giá phải từ 1 đến 5.");
  }
  const cleanComment = comment ? String(comment).trim().slice(0, 950) : null;

  return withTransaction(async (tx) => {
    const hRes = await newRequest(tx)
      .input("hid", sqlObj.BigInt, hid)
      .query(`
        SELECT TOP 1
          h.id,
          h.conversation_id AS conversationId,
          h.accommodation_id AS accommodationId,
          a.accommodation_name AS accommodationName,
          h.manager_user_id AS managerUserId,
          u.full_name AS managerName,
          h.manager_assignment_epoch_id AS managerAssignmentEpochId,
          h.first_human_reply_at AS firstHumanReplyAt,
          c.customer_user_id AS customerUserId
        FROM dbo.chat_handoff_sessions AS h
        INNER JOIN dbo.chat_conversations AS c ON c.id = h.conversation_id
        INNER JOIN dbo.accommodations AS a ON a.id = h.accommodation_id
        LEFT JOIN dbo.users AS u ON u.id = h.manager_user_id
        WHERE h.id = @hid;
      `);

    const h = hRes.recordset[0];
    if (!h) {
      throw chatError(404, "HANDOFF_NOT_FOUND", "Không tìm thấy phiên hỗ trợ cần đánh giá.");
    }
    if (String(h.customerUserId || "").toLowerCase() !== String(actor.userId).toLowerCase()) {
      throw chatError(403, "FORBIDDEN_RATING", "Bạn chỉ được đánh giá phiên hỗ trợ thuộc về mình.");
    }
    if (!h.firstHumanReplyAt) {
      throw chatError(
        409,
        "NO_HUMAN_REPLY_YET",
        "Phiên hỗ trợ chỉ có thể đánh giá sau khi Quản lý đã phản hồi ít nhất 1 tin nhắn.",
      );
    }

    await lockConversationsInOrder(tx, [Number(h.conversationId)]);

    const dup = await newRequest(tx)
      .input("hid", sqlObj.BigInt, hid)
      .query(`SELECT id FROM dbo.chat_conversation_ratings WHERE handoff_id = @hid;`);
    if (dup.recordset[0]) {
      throw chatError(409, "ALREADY_RATED", "Bạn đã gửi đánh giá cho phiên hỗ trợ này trước đó.");
    }

    const reviewStatus = stars <= 3 ? "PENDING_REVIEW" : "NONE";
    const ins = await newRequest(tx)
      .input("cid", sqlObj.BigInt, Number(h.conversationId))
      .input("hid", sqlObj.BigInt, hid)
      .input("accomId", sqlObj.Int, Number(h.accommodationId))
      .input("custId", sqlObj.UniqueIdentifier, actor.userId)
      .input("mgrId", sqlObj.UniqueIdentifier, h.managerUserId || null)
      .input("epochId", sqlObj.BigInt, h.managerAssignmentEpochId ? Number(h.managerAssignmentEpochId) : null)
      .input("rating", sqlObj.TinyInt, stars)
      .input("comment", sqlObj.NVarChar(1000), cleanComment)
      .input("revStatus", sqlObj.VarChar(32), reviewStatus)
      .query(`
        INSERT INTO dbo.chat_conversation_ratings (
          conversation_id, handoff_id, accommodation_id, customer_user_id,
          manager_user_id, manager_assignment_epoch_id, rating, comment, admin_review_status
        )
        OUTPUT INSERTED.id, INSERTED.created_at AS createdAt
        VALUES (
          @cid, @hid, @accomId, @custId,
          @mgrId, @epochId, @rating, @comment, @revStatus
        );
      `);

    const ratingId = Number(ins.recordset[0].id);
    const createdAt = new Date(ins.recordset[0].createdAt).toISOString();

    await recordChatEvent(tx, {
      conversationId: Number(h.conversationId),
      actorKey: actor.actorKey,
      eventType: "RATING_SUBMITTED",
      payload: { ratingId, handoffId: hid, rating: stars, reviewStatus },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: Number(h.conversationId),
      eventName: "rating:submitted",
      payload: {
        ratingId,
        conversationId: Number(h.conversationId),
        handoffId: hid,
        rating: stars,
        ownerKey: actor.actorKey,
      },
    });

    if (stars <= 3) {
      await enqueueOutbox(tx, {
        kind: "SOCKET_EVENT",
        conversationId: null,
        eventName: "admin:low-rating-alert",
        payload: {
          ratingId,
          conversationId: Number(h.conversationId),
          handoffId: hid,
          accommodationId: Number(h.accommodationId),
          accommodationName: h.accommodationName,
          managerUserId: h.managerUserId ? String(h.managerUserId) : null,
          managerName: h.managerName || null,
          rating: stars,
          comment: cleanComment,
          adminReviewStatus: reviewStatus,
          createdAt,
        },
      });
    }

    return {
      ratingId,
      conversationId: Number(h.conversationId),
      handoffId: hid,
      rating: stars,
      comment: cleanComment,
      adminReviewStatus: reviewStatus,
      createdAt,
    };
  });
}

async function listOwnerConversationRatings(actor, conversationId) {
  if (!actor || actor.type !== "CUSTOMER") return [];
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("cid", sqlObj.BigInt, Number(conversationId))
    .input("uid", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      SELECT
        r.id, r.handoff_id AS handoffId, r.rating, r.comment, r.created_at AS createdAt
      FROM dbo.chat_conversation_ratings AS r
      INNER JOIN dbo.chat_conversations AS c ON c.id = r.conversation_id
      WHERE r.conversation_id = @cid AND c.customer_user_id = @uid
      ORDER BY r.created_at DESC;
    `);
  return res.recordset.map((r) => ({
    ...r,
    id: Number(r.id),
    handoffId: Number(r.handoffId),
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

function assertAdminReportsAccess(actor) {
  if (!actor || actor.role !== "ADMIN" || !hasPermission(actor, "chat.ratings.read")) {
    throw chatError(403, "ADMIN_ONLY", "Chỉ Quản trị viên (Admin) mới có quyền xem Báo cáo chat & Đánh giá.");
  }
}

async function listAdminRatings(actor, { status = "ALL", limit = 50, offset = 0 } = {}) {
  assertAdminReportsAccess(actor);
  const pool = getDBPool();
  const cleanStatus = String(status || "ALL").toUpperCase();
  const filterStatus = ["PENDING_REVIEW", "CONFIRMED_VIOLATION", "DISMISSED", "NONE"].includes(cleanStatus)
    ? cleanStatus
    : null;

  const res = await pool
    .request()
    .input("status", sqlObj.VarChar(32), filterStatus)
    .input("limit", sqlObj.Int, Math.min(Math.max(Number(limit) || 50, 1), 100))
    .input("offset", sqlObj.Int, Math.max(Number(offset) || 0, 0))
    .query(`
      SELECT
        r.id,
        r.conversation_id AS conversationId,
        r.handoff_id AS handoffId,
        r.accommodation_id AS accommodationId,
        a.accommodation_name AS accommodationName,
        r.customer_user_id AS customerUserId,
        cu.full_name AS customerName,
        r.manager_user_id AS managerUserId,
        mu.full_name AS managerName,
        mu.personal_email AS managerPersonalEmail,
        mu.email AS managerInternalEmail,
        r.rating,
        r.comment,
        r.admin_review_status AS adminReviewStatus,
        r.review_note AS reviewNote,
        r.reviewed_at AS reviewedAt,
        r.created_at AS createdAt,
        w.id AS latestWarningId,
        w.status AS latestWarningStatus,
        w.sent_at AS latestWarningSentAt,
        w.error_message AS latestWarningError
      FROM dbo.chat_conversation_ratings AS r
      INNER JOIN dbo.accommodations AS a ON a.id = r.accommodation_id
      LEFT JOIN dbo.users AS cu ON cu.id = r.customer_user_id
      LEFT JOIN dbo.users AS mu ON mu.id = r.manager_user_id
      OUTER APPLY (
        SELECT TOP 1 id, status, sent_at, error_message
        FROM dbo.chat_warning_email_attempts wa
        WHERE wa.rating_id = r.id
        ORDER BY wa.id DESC
      ) AS w
      WHERE (@status IS NULL OR r.admin_review_status = @status)
      ORDER BY CASE WHEN r.admin_review_status = 'PENDING_REVIEW' THEN 0 ELSE 1 END, r.created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

  return res.recordset.map((r) => ({
    ...r,
    id: Number(r.id),
    conversationId: Number(r.conversationId),
    handoffId: Number(r.handoffId),
    accommodationId: Number(r.accommodationId),
    rating: Number(r.rating),
    latestWarningId: r.latestWarningId ? Number(r.latestWarningId) : null,
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
    latestWarningSentAt: r.latestWarningSentAt ? new Date(r.latestWarningSentAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

async function reviewAdminRating(actor, ratingId, { decision, reviewNote = null }) {
  assertAdminReportsAccess(actor);
  if (!hasPermission(actor, "chat.ratings.review")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền duyệt đánh giá.");
  }
  const cleanDecision = String(decision || "").toUpperCase();
  if (!["CONFIRMED_VIOLATION", "DISMISSED"].includes(cleanDecision)) {
    throw chatError(400, "INVALID_DECISION", "Trạng thái duyệt phải là CONFIRMED_VIOLATION hoặc DISMISSED.");
  }

  const rid = Number(ratingId);
  const pool = getDBPool();
  const upd = await pool
    .request()
    .input("rid", sqlObj.BigInt, rid)
    .input("decision", sqlObj.VarChar(32), cleanDecision)
    .input("note", sqlObj.NVarChar(1000), reviewNote ? String(reviewNote).trim().slice(0, 950) : null)
    .input("adminId", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      UPDATE dbo.chat_conversation_ratings
      SET admin_review_status = @decision,
          review_note = @note,
          reviewed_by_user_id = @adminId,
          reviewed_at = SYSUTCDATETIME(),
          updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id, INSERTED.admin_review_status AS adminReviewStatus, INSERTED.reviewed_at AS reviewedAt
      WHERE id = @rid;
    `);

  if (!upd.recordset[0]) {
    throw chatError(404, "RATING_NOT_FOUND", "Không tìm thấy bản ghi đánh giá.");
  }
  return {
    ratingId: Number(upd.recordset[0].id),
    adminReviewStatus: upd.recordset[0].adminReviewStatus,
    reviewedAt: new Date(upd.recordset[0].reviewedAt).toISOString(),
  };
}

/**
 * Triggers warning email outside DB lock cleanly using chat_warning_email_attempts state machine.
 */
async function sendRatingWarningEmail(actor, ratingId, { adminNote = null } = {}) {
  assertAdminReportsAccess(actor);
  if (!hasPermission(actor, "chat.warning.send")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền gửi email nhắc nhở CSKH.");
  }

  const rid = Number(ratingId);
  const pool = getDBPool();

  const loadRes = await pool
    .request()
    .input("rid", sqlObj.BigInt, rid)
    .query(`
      SELECT TOP 1
        r.id,
        r.manager_user_id AS managerUserId,
        r.rating,
        r.comment,
        r.admin_review_status AS adminReviewStatus,
        a.accommodation_name AS accommodationName,
        u.full_name AS managerName,
        COALESCE(NULLIF(LTRIM(RTRIM(u.personal_email)), ''), u.email) AS recipientEmail
      FROM dbo.chat_conversation_ratings AS r
      INNER JOIN dbo.accommodations AS a ON a.id = r.accommodation_id
      LEFT JOIN dbo.users AS u ON u.id = r.manager_user_id
      WHERE r.id = @rid;
    `);

  const row = loadRes.recordset[0];
  if (!row || !row.managerUserId) {
    throw chatError(404, "RATING_OR_MANAGER_NOT_FOUND", "Không tìm thấy đánh giá hoặc Manager để gửi cảnh báo.");
  }
  if (!row.recipientEmail) {
    throw chatError(400, "MISSING_MANAGER_EMAIL", "Tài khoản Quản lý chưa có địa chỉ email nhận cảnh báo.");
  }

  // Ensure rating is marked CONFIRMED_VIOLATION if Admin clicks send warning directly from pending
  if (row.adminReviewStatus === "PENDING_REVIEW") {
    await pool
      .request()
      .input("rid", sqlObj.BigInt, rid)
      .input("adminId", sqlObj.UniqueIdentifier, actor.userId)
      .input("note", sqlObj.NVarChar(1000), adminNote ? String(adminNote).slice(0, 950) : null)
      .query(`
        UPDATE dbo.chat_conversation_ratings
        SET admin_review_status = 'CONFIRMED_VIOLATION',
            review_note = COALESCE(@note, review_note),
            reviewed_by_user_id = @adminId,
            reviewed_at = SYSUTCDATETIME(),
            updated_at = SYSUTCDATETIME()
        WHERE id = @rid;
      `);
  }

  const cleanNote = adminNote ? String(adminNote).trim().slice(0, 950) : null;
  const attemptRes = await pool
    .request()
    .input("rid", sqlObj.BigInt, rid)
    .input("mgrId", sqlObj.UniqueIdentifier, row.managerUserId)
    .input("email", sqlObj.VarChar(255), row.recipientEmail)
    .input("adminId", sqlObj.UniqueIdentifier, actor.userId)
    .input("note", sqlObj.NVarChar(1000), cleanNote)
    .query(`
      INSERT INTO dbo.chat_warning_email_attempts (
        rating_id, manager_user_id, recipient_email, status, triggered_by_user_id, note
      )
      OUTPUT INSERTED.id
      VALUES (@rid, @mgrId, @email, 'SENDING', @adminId, @note);
    `);

  const attemptId = Number(attemptRes.recordset[0].id);

  // Send SMTP outside any transaction lock
  try {
    const mailResult = await sendChatCskhWarningEmail({
      toGmail: row.recipientEmail,
      managerName: row.managerName,
      accommodationName: row.accommodationName,
      rating: row.rating,
      customerComment: row.comment,
      adminNote: cleanNote,
    });

    await pool
      .request()
      .input("aid", sqlObj.BigInt, attemptId)
      .query(`
        UPDATE dbo.chat_warning_email_attempts
        SET status = 'SENT', sent_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
        WHERE id = @aid;
      `);

    return {
      attemptId,
      status: "SENT",
      method: mailResult.method,
      recipientEmail: row.recipientEmail,
    };
  } catch (err) {
    await pool
      .request()
      .input("aid", sqlObj.BigInt, attemptId)
      .input("errMsg", sqlObj.NVarChar(500), String(err?.message || "SMTP_FAILED").slice(0, 480))
      .query(`
        UPDATE dbo.chat_warning_email_attempts
        SET status = 'FAILED', error_message = @errMsg, updated_at = SYSUTCDATETIME()
        WHERE id = @aid;
      `);
    throw chatError(502, "EMAIL_SEND_FAILED", `Gửi email nhắc nhở thất bại: ${err?.message || "SMTP Error"}`);
  }
}

module.exports = {
  submitHandoffRating,
  listOwnerConversationRatings,
  listAdminRatings,
  reviewAdminRating,
  sendRatingWarningEmail,
};
