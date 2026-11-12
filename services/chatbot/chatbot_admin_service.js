// Admin support inbox (T07): list/detail/assign/transition/reply.
// Thực thi state machine T02 (constants/chatbot.ALLOWED_TRANSITIONS)
// và scope check T03 (manager chỉ thấy ticket đúng accommodation assignment).

const sql = require("mssql");
const db = require("../../configs/database");
const { ERROR_CODES } = require("../../constants/error_codes");
const { ALLOWED_TRANSITIONS, TRANSITIONS_REQUIRE_REASON, AUDIT_ACTIONS } = require("../../constants/chatbot");

const MANAGER_ROLE = "ACCOMMODATION_MANAGER";
const ADMIN_ROLE = "ADMIN";

// Manager chỉ được các transition theo T02: T-05 (ASSIGNED->IN_PROGRESS),
// T-06 (IN_PROGRESS->WAITING_CUSTOMER khi gửi reply), T-08/T-09 (->RESOLVED),
// T-11 (RESOLVED->IN_PROGRESS). OPEN->* và ->CLOSED/CANCELLED chỉ ADMIN.
const MANAGER_ALLOWED_TRANSITIONS = Object.freeze([
    "ASSIGNED->IN_PROGRESS",
    "IN_PROGRESS->WAITING_CUSTOMER",
    "IN_PROGRESS->RESOLVED",
    "WAITING_CUSTOMER->RESOLVED",
    "RESOLVED->IN_PROGRESS",
]);

class TicketError extends Error {
    constructor(message, statusCode, errorCode) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
    }
}

async function writeAudit(pool, { actorType, actorUserId, action, resourceType, resourceId, decision, reason = null, detail = null }) {
    try {
        await pool.request()
            .input("actorType", sql.VarChar(30), actorType)
            .input("actorUserId", sql.UniqueIdentifier, actorUserId ?? null)
            .input("action", sql.VarChar(100), action)
            .input("resourceType", sql.VarChar(50), resourceType)
            .input("resourceId", sql.BigInt, resourceId)
            .input("decision", sql.VarChar(20), decision)
            .input("reason", sql.NVarChar(1000), reason)
            .input("detailJson", sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
            .query(`
                INSERT INTO dbo.audit_logs
                    (actor_type, actor_user_id, action, resource_type, resource_id, decision, reason, detail_json)
                VALUES
                    (@actorType, @actorUserId, @action, @resourceType, @resourceId, @decision, @reason, @detailJson);
            `);
    } catch (error) {
        console.error("[chatbot_admin_service] audit failed:", error.message);
    }
}

async function withTransaction(pool, operation) {
    if (typeof pool.transaction !== "function") {
        return operation(() => pool.request());
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
        const result = await operation(() => transaction.request());
        await transaction.commit();
        return result;
    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error("[chatbot_admin_service] rollback failed:", rollbackError.message);
        }
        throw error;
    }
}

function isAdminUser(admin) {
    return admin?.role === ADMIN_ROLE;
}

// Scope check T03: manager chỉ chạm ticket có accommodation_id trong assignment của mình.
// Ticket accommodation_id NULL -> chỉ ADMIN. Deny -> 403 + audit.
async function assertTicketScope(pool, ticket, admin) {
    if (isAdminUser(admin)) {
        return;
    }

    if (admin.role !== MANAGER_ROLE || !ticket.accommodation_id) {
        await writeAudit(pool, {
            actorType: admin.role === MANAGER_ROLE ? "ACCOMMODATION_MANAGER" : admin.role,
            actorUserId: admin.id,
            action: AUDIT_ACTIONS.AUTHZ_DENY,
            resourceType: "ticket", resourceId: ticket.id,
            decision: "DENY", reason: "OUT_OF_SCOPE_TICKET",
        });
        throw new TicketError("Bạn không có quyền truy cập ticket này.", 403, ERROR_CODES.FORBIDDEN);
    }

    const assigned = await pool.request()
        .input("accommodationId", sql.Int, ticket.accommodation_id)
        .input("userId", sql.UniqueIdentifier, admin.id)
        .query(`
            SELECT 1
            FROM dbo.accommodation_managers
            WHERE accommodation_id = @accommodationId AND user_id = @userId;
        `);

    if (!assigned.recordset.length) {
        await writeAudit(pool, {
            actorType: "ACCOMMODATION_MANAGER", actorUserId: admin.id,
            action: AUDIT_ACTIONS.AUTHZ_DENY,
            resourceType: "ticket", resourceId: ticket.id,
            decision: "DENY", reason: "OUT_OF_SCOPE_TICKET",
            detail: { ticket_accommodation_id: ticket.accommodation_id },
        });
        throw new TicketError("Bạn không có quyền truy cập ticket này.", 403, ERROR_CODES.FORBIDDEN);
    }
}

async function getTicketById(pool, ticketId) {
    const result = await pool.request()
        .input("ticketId", sql.BigInt, ticketId)
        .query(`
            SELECT
                t.id, t.ticket_code, t.user_id, t.conversation_id, t.booking_id,
                t.accommodation_id, t.category, t.subject, t.status,
                t.assigned_to_user_id, t.assigned_at, t.reason,
                t.created_at, t.updated_at, t.resolved_at, t.closed_at, t.cancelled_at,
                a.accommodation_name,
                cu.full_name AS customer_name,
                assignee.full_name AS assignee_name
            FROM dbo.tickets t
            LEFT JOIN dbo.accommodations a ON a.id = t.accommodation_id
            LEFT JOIN dbo.users cu ON cu.id = t.user_id
            LEFT JOIN dbo.users assignee ON assignee.id = t.assigned_to_user_id
            WHERE t.id = @ticketId;
        `);

    return result.recordset[0] ?? null;
}

// ---------- list ----------

async function listTickets({ admin, status, category, limit = 50 }) {
    const pool = db.getDBPool();
    const conditions = [];
    const inputs = [["limit", sql.Int, Math.min(Number(limit) || 50, 200)]];

    if (status) {
        conditions.push("t.status = @status");
        inputs.push(["status", sql.VarChar(30), status]);
    }
    if (category) {
        conditions.push("t.category = @category");
        inputs.push(["category", sql.VarChar(50), category]);
    }

    // Manager: chỉ ticket có accommodation_id thuộc assignment của mình (T03);
    // ticket không scope (admin queue) không xuất hiện.
    const scopeCondition = isAdminUser(admin)
        ? "1 = 1"
        : `
            EXISTS (
                SELECT 1
                FROM dbo.accommodation_managers m
                WHERE m.accommodation_id = t.accommodation_id
                  AND m.user_id = @adminUserId
            )`;
    if (!isAdminUser(admin)) {
        inputs.push(["adminUserId", sql.UniqueIdentifier, admin.id]);
    }

    const request = pool.request();
    for (const [name, type, value] of inputs) {
        request.input(name, type, value);
    }

    const result = await request.query(`
        SELECT TOP (@limit)
            t.id, t.ticket_code, t.category, t.subject, t.status,
            t.created_at, t.updated_at,
            t.accommodation_id, a.accommodation_name,
            t.booking_id, b.booking_code,
            cu.full_name AS customer_name,
            assignee.full_name AS assignee_name
        FROM dbo.tickets t
        LEFT JOIN dbo.accommodations a ON a.id = t.accommodation_id
        LEFT JOIN dbo.bookings b ON b.id = t.booking_id
        LEFT JOIN dbo.users cu ON cu.id = t.user_id
        LEFT JOIN dbo.users assignee ON assignee.id = t.assigned_to_user_id
        WHERE ${scopeCondition}
        ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
        ORDER BY t.created_at DESC;
    `);

    return result.recordset;
}

// ---------- detail (booking context tối thiểu, masking theo T06) ----------

async function getTicketDetail(ticketId, admin) {
    const pool = db.getDBPool();
    const ticket = await getTicketById(pool, ticketId);
    if (!ticket) {
        throw new TicketError("Không tìm thấy ticket.", 404, ERROR_CODES.NOT_FOUND);
    }
    await assertTicketScope(pool, ticket, admin);

    const messages = await pool.request()
        .input("conversationId", sql.BigInt, ticket.conversation_id)
        .query(`
            SELECT id, sender_type, sender_user_id, content, is_internal_note, created_at
            FROM dbo.messages
            WHERE conversation_id = @conversationId
            ORDER BY id ASC;
        `);

    let bookingContext = null;
    if (ticket.booking_id) {
        const booking = await pool.request()
            .input("bookingId", sql.BigInt, ticket.booking_id)
            .query(`
                SELECT TOP 1
                    b.booking_code, b.check_in_date, b.check_out_date, b.status AS booking_status,
                    b.total_amount, b.currency, b.contact_name,
                    a.accommodation_name
                FROM dbo.bookings b
                INNER JOIN dbo.accommodations a ON a.id = b.accommodation_id
                WHERE b.id = @bookingId;
            `);
        const row = booking.recordset[0];
        if (row) {
            // Whitelist DTO (T06) — không phụ thuộc SELECT trả gì thêm
            bookingContext = {
                booking_code: row.booking_code,
                check_in_date: row.check_in_date,
                check_out_date: row.check_out_date,
                booking_status: row.booking_status,
                total_amount: row.total_amount,
                currency: row.currency,
                contact_name: row.contact_name,
                accommodation_name: row.accommodation_name,
            };
        }
    }

    return {
        ticket: {
            id: ticket.id,
            ticket_code: ticket.ticket_code,
            category: ticket.category,
            subject: ticket.subject,
            status: ticket.status,
            accommodation_id: ticket.accommodation_id,
            accommodation_name: ticket.accommodation_name,
            booking_id: ticket.booking_id,
            customer_name: ticket.customer_name,
            assignee_name: ticket.assignee_name,
            assigned_at: ticket.assigned_at,
            reason: ticket.reason,
            created_at: ticket.created_at,
            resolved_at: ticket.resolved_at,
            closed_at: ticket.closed_at,
            cancelled_at: ticket.cancelled_at,
        },
        messages: messages.recordset.map((row) => ({
            id: row.id,
            sender_type: row.sender_type,
            content: row.content,
            is_internal_note: Boolean(row.is_internal_note),
            created_at: row.created_at,
        })),
        booking_context: bookingContext,
    };
}

// ---------- assign (T-02, ADMIN only) ----------

async function assignTicket(ticketId, assigneeId, admin) {
    const pool = db.getDBPool();
    const ticket = await getTicketById(pool, ticketId);
    if (!ticket) {
        throw new TicketError("Không tìm thấy ticket.", 404, ERROR_CODES.NOT_FOUND);
    }
    await assertTicketScope(pool, ticket, admin);

    if (!["OPEN", "ASSIGNED", "IN_PROGRESS"].includes(ticket.status)) {
        throw new TicketError(
            `Không thể gán ticket ở trạng thái ${ticket.status}.`,
            409, ERROR_CODES.INVALID_STATE,
        );
    }
    if (!ticket.accommodation_id) {
        throw new TicketError(
            "Ticket không có scope cơ sở — chỉ xử lý trong admin queue, không gán manager.",
            409, ERROR_CODES.INVALID_STATE,
        );
    }

    // Assignee phải là manager đang hoạt động và có assignment đúng scope ticket
    const assignee = await pool.request()
        .input("assigneeId", sql.UniqueIdentifier, assigneeId)
        .query(`
            SELECT u.id, u.full_name, u.role, u.status
            FROM dbo.users u
            WHERE u.id = @assigneeId AND u.role = '${MANAGER_ROLE}' AND u.status = 1;
        `);

    const manager = assignee.recordset[0];
    if (!manager) {
        throw new TicketError("Nhân viên không tồn tại hoặc không hoạt động.", 400, ERROR_CODES.VALIDATION_ERROR);
    }

    const inScope = await pool.request()
        .input("accommodationId", sql.Int, ticket.accommodation_id)
        .input("userId", sql.UniqueIdentifier, assigneeId)
        .query(`
            SELECT 1
            FROM dbo.accommodation_managers
            WHERE accommodation_id = @accommodationId AND user_id = @userId;
        `);

    if (!inScope.recordset.length) {
        throw new TicketError(
            "Nhân viên không được phân công cho cơ sở của booking trong ticket.",
            409, ERROR_CODES.MANAGER_NOT_ASSIGNED,
        );
    }

    const newStatus = ticket.status === "OPEN" ? "ASSIGNED" : ticket.status;
    await pool.request()
        .input("ticketId", sql.BigInt, ticketId)
        .input("assigneeId", sql.UniqueIdentifier, assigneeId)
        .input("newStatus", sql.VarChar(30), newStatus)
        .query(`
            UPDATE dbo.tickets
            SET assigned_to_user_id = @assigneeId,
                assigned_at = SYSUTCDATETIME(),
                status = @newStatus,
                updated_at = SYSUTCDATETIME()
            WHERE id = @ticketId;
        `);

    await writeAudit(pool, {
        actorType: "ADMIN", actorUserId: admin.id,
        action: AUDIT_ACTIONS.TICKET_ASSIGNED,
        resourceType: "ticket", resourceId: ticketId,
        decision: "ALLOW", reason: newStatus,
        detail: { assignee_id: assigneeId, accommodation_id: ticket.accommodation_id },
    });

    return { ticket_id: ticketId, status: newStatus, assignee_name: manager.full_name };
}

// ---------- transition (state machine T02 + actor rules) ----------

async function transitionTicket(ticketId, toStatus, reason, admin) {
    const pool = db.getDBPool();
    const ticket = await getTicketById(pool, ticketId);
    if (!ticket) {
        throw new TicketError("Không tìm thấy ticket.", 404, ERROR_CODES.NOT_FOUND);
    }
    await assertTicketScope(pool, ticket, admin);

    const allowedTargets = ALLOWED_TRANSITIONS[ticket.status] ?? [];
    if (!allowedTargets.includes(toStatus)) {
        throw new TicketError(
            `Chuyển trạng thái ${ticket.status} -> ${toStatus} không hợp lệ theo state machine.`,
            409, ERROR_CODES.INVALID_STATE,
        );
    }

    if (!isAdminUser(admin)) {
        const transitionKey = `${ticket.status}->${toStatus}`;
        if (!MANAGER_ALLOWED_TRANSITIONS.includes(transitionKey)) {
            await writeAudit(pool, {
                actorType: "ACCOMMODATION_MANAGER", actorUserId: admin.id,
                action: AUDIT_ACTIONS.AUTHZ_DENY,
                resourceType: "ticket", resourceId: ticketId,
                decision: "DENY", reason: `MANAGER_TRANSITION_${transitionKey}`,
            });
            throw new TicketError("Bạn không có quyền chuyển ticket này.", 403, ERROR_CODES.FORBIDDEN);
        }
    }

    if (TRANSITIONS_REQUIRE_REASON.includes(toStatus) && !reason?.trim()) {
        throw new TicketError("Bắt buộc ghi lý do cho chuyển trạng thái này.", 400, ERROR_CODES.VALIDATION_ERROR);
    }

    await pool.request()
        .input("ticketId", sql.BigInt, ticketId)
        .input("toStatus", sql.VarChar(30), toStatus)
        .input("reason", sql.NVarChar(1000), reason ?? null)
        .query(`
            UPDATE dbo.tickets
            SET status = @toStatus,
                reason = CASE WHEN @reason IS NOT NULL THEN @reason ELSE reason END,
                resolved_at = CASE
                    WHEN @toStatus = 'RESOLVED' THEN SYSUTCDATETIME()
                    WHEN status = 'RESOLVED' THEN NULL
                    ELSE resolved_at
                END,
                closed_at = CASE
                    WHEN @toStatus = 'CLOSED' THEN SYSUTCDATETIME()
                    WHEN status = 'CLOSED' THEN NULL
                    ELSE closed_at
                END,
                cancelled_at = CASE
                    WHEN @toStatus = 'CANCELLED' THEN SYSUTCDATETIME()
                    WHEN status = 'CANCELLED' THEN NULL
                    ELSE cancelled_at
                END,
                updated_at = SYSUTCDATETIME()
            WHERE id = @ticketId;
        `);

    await writeAudit(pool, {
        actorType: isAdminUser(admin) ? "ADMIN" : "ACCOMMODATION_MANAGER",
        actorUserId: admin.id,
        action: AUDIT_ACTIONS.TICKET_TRANSITION,
        resourceType: "ticket", resourceId: ticketId,
        decision: "ALLOW", reason: reason ?? null,
        detail: { from: ticket.status, to: toStatus },
    });

    return { ticket_id: ticketId, from: ticket.status, to: toStatus };
}

// ---------- staff reply (auto advance: ASSIGNED -> IN_PROGRESS -> WAITING_CUSTOMER) ----------

async function staffReply(ticketId, content, isInternalNote, admin) {
    const pool = db.getDBPool();
    const trimmed = typeof content === "string" ? content.trim() : "";
    if (!trimmed || trimmed.length > 2000) {
        throw new TicketError("Nội dung phản hồi phải từ 1 đến 2000 ký tự.", 400, ERROR_CODES.VALIDATION_ERROR);
    }

    const ticket = await getTicketById(pool, ticketId);
    if (!ticket) {
        throw new TicketError("Không tìm thấy ticket.", 404, ERROR_CODES.NOT_FOUND);
    }
    await assertTicketScope(pool, ticket, admin);

    const fromStatus = ticket.status;
    if (!["ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER"].includes(fromStatus)) {
        throw new TicketError(
            `Không thể phản hồi ticket ở trạng thái ${fromStatus}.`,
            409, ERROR_CODES.INVALID_STATE,
        );
    }

    const currentStatus = await withTransaction(pool, async (request) => {
        let status = fromStatus;
        if (status === "ASSIGNED") {
            const advance = await request()
                .input("ticketId", sql.BigInt, ticketId)
                .query(`
                    UPDATE dbo.tickets
                    SET status = 'IN_PROGRESS', updated_at = SYSUTCDATETIME()
                    WHERE id = @ticketId AND status = 'ASSIGNED';
                `);
            if (Array.isArray(advance.rowsAffected) && advance.rowsAffected[0] !== 1) {
                throw new TicketError("Ticket vừa được cập nhật bởi người khác. Vui lòng tải lại và thử lại.", 409, ERROR_CODES.INVALID_STATE);
            }
            status = "IN_PROGRESS";
        }

        await request()
            .input("conversationId", sql.BigInt, ticket.conversation_id)
            .input("senderUserId", sql.UniqueIdentifier, admin.id)
            .input("content", sql.NVarChar(sql.MAX), trimmed)
            .input("isInternalNote", sql.Bit, isInternalNote ? 1 : 0)
            .query(`
                INSERT INTO dbo.messages (conversation_id, sender_type, sender_user_id, content, is_internal_note)
                VALUES (@conversationId, 'STAFF', @senderUserId, @content, @isInternalNote);
            `);

        if (!isInternalNote && status === "IN_PROGRESS") {
            const waiting = await request()
                .input("ticketId", sql.BigInt, ticketId)
                .query(`
                    UPDATE dbo.tickets
                    SET status = 'WAITING_CUSTOMER', updated_at = SYSUTCDATETIME()
                    WHERE id = @ticketId AND status = 'IN_PROGRESS';
                `);
            if (Array.isArray(waiting.rowsAffected) && waiting.rowsAffected[0] !== 1) {
                throw new TicketError("Ticket vừa được cập nhật bởi người khác. Vui lòng tải lại và thử lại.", 409, ERROR_CODES.INVALID_STATE);
            }
            status = "WAITING_CUSTOMER";
        }
        return status;
    });

    if (fromStatus === "ASSIGNED") {
        await writeAudit(pool, {
            actorType: isAdminUser(admin) ? "ADMIN" : "ACCOMMODATION_MANAGER",
            actorUserId: admin.id,
            action: AUDIT_ACTIONS.TICKET_TRANSITION,
            resourceType: "ticket", resourceId: ticketId,
            decision: "ALLOW", reason: null,
            detail: { from: "ASSIGNED", to: "IN_PROGRESS", trigger: "staff_reply" },
        });
    }
    if (!isInternalNote && currentStatus === "WAITING_CUSTOMER") {
        await writeAudit(pool, {
            actorType: isAdminUser(admin) ? "ADMIN" : "ACCOMMODATION_MANAGER",
            actorUserId: admin.id,
            action: AUDIT_ACTIONS.TICKET_TRANSITION,
            resourceType: "ticket", resourceId: ticketId,
            decision: "ALLOW", reason: null,
            detail: { from: "IN_PROGRESS", to: "WAITING_CUSTOMER", trigger: "staff_reply" },
        });
    }

    await writeAudit(pool, {
        actorType: isAdminUser(admin) ? "ADMIN" : "ACCOMMODATION_MANAGER",
        actorUserId: admin.id,
        action: AUDIT_ACTIONS.STAFF_REPLY,
        resourceType: "ticket", resourceId: ticketId,
        decision: "ALLOW",
        reason: isInternalNote ? "INTERNAL_NOTE" : "CUSTOMER_REPLY",
    });

    return { ticket_id: ticketId, status: currentStatus };
}

module.exports = { listTickets, getTicketDetail, assignTicket, transitionTicket, staffReply };
