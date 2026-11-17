const { sqlObj } = require("../../configs/database");
const { newRequest } = require("./db");

// Shared by owner snapshots and realtime updates: hasRatedHandoff belongs only
// to the current handoff; pendingRatingHandoffId may refer to an older one.
const RATING_STATE_JOINS_SQL = `
  LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
  LEFT JOIN dbo.chat_conversation_ratings AS r ON r.handoff_id = h.id
  OUTER APPLY (
    SELECT TOP 1 hp.id AS pendingRatingHandoffId, hu.full_name AS pendingRatingManagerName
    FROM dbo.chat_handoff_sessions AS hp
    INNER JOIN dbo.chat_conversations AS hc ON hc.id = hp.conversation_id
    LEFT JOIN dbo.users AS hu ON hu.id = hp.manager_user_id
    WHERE (
        hp.conversation_id = c.id
        OR (
          ((c.customer_user_id IS NOT NULL AND hc.customer_user_id = c.customer_user_id)
            OR (c.guest_session_id IS NOT NULL AND hc.guest_session_id = c.guest_session_id))
          AND (hp.conversation_id = c.source_conversation_id OR EXISTS (
            SELECT 1 FROM dbo.chat_messages AS carried
            WHERE carried.conversation_id = c.id AND carried.handoff_id = hp.id
          ))
        )
      )
      AND hp.first_human_reply_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dbo.chat_conversation_ratings AS rr WHERE rr.handoff_id = hp.id)
    ORDER BY hp.id DESC
  ) AS pr
`;

async function getConversationRatingState(executor, conversationId) {
  const res = await newRequest(executor)
    .input("ratingCid", sqlObj.BigInt, Number(conversationId))
    .query(`
      SELECT c.current_handoff_id AS currentHandoffId,
        h.first_human_reply_at AS handoffFirstHumanReplyAt,
        CASE WHEN r.id IS NOT NULL THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasRatedHandoff,
        pr.pendingRatingHandoffId, pr.pendingRatingManagerName
      FROM dbo.chat_conversations AS c
      ${RATING_STATE_JOINS_SQL}
      WHERE c.id = @ratingCid;
    `);
  const row = res.recordset[0] || {};
  return {
    currentHandoffId: row.currentHandoffId ? Number(row.currentHandoffId) : null,
    handoffFirstHumanReplyAt: row.handoffFirstHumanReplyAt ? new Date(row.handoffFirstHumanReplyAt).toISOString() : null,
    hasRatedHandoff: Boolean(row.hasRatedHandoff),
    pendingRatingHandoffId: row.pendingRatingHandoffId ? Number(row.pendingRatingHandoffId) : null,
    pendingRatingManagerName: row.pendingRatingManagerName || null,
  };
}

module.exports = { RATING_STATE_JOINS_SQL, getConversationRatingState };
