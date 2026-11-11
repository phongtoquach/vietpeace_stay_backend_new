// Admin support inbox controller: list/detail/assign/transition/reply ticket.

const chatbotAdminService = require("../../services/chatbot/chatbot_admin_service");

function sendError(res, error) {
    console.error("[chatbot_admin_controller]", error.message);
    return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || "Lỗi hệ thống.",
        errorCode: error.errorCode || "INTERNAL_ERROR",
    });
}

async function listTickets(req, res) {
    try {
        const { status, category, limit } = req.query ?? {};
        const tickets = await chatbotAdminService.listTickets({
            admin: req.currentAdmin,
            status: status || null,
            category: category || null,
            limit: limit || 50,
        });

        return res.status(200).json({ success: true, data: { tickets } });
    } catch (error) {
        return sendError(res, error);
    }
}

async function getTicketDetail(req, res) {
    try {
        const detail = await chatbotAdminService.getTicketDetail(Number(req.params.id), req.currentAdmin);

        return res.status(200).json({ success: true, data: detail });
    } catch (error) {
        return sendError(res, error);
    }
}

async function assignTicket(req, res) {
    try {
        const { assigneeId } = req.body ?? {};
        if (typeof assigneeId !== "string" || !assigneeId.trim()) {
            return res.status(400).json({
                success: false,
                message: "assigneeId là bắt buộc.",
                errorCode: "VALIDATION_ERROR",
            });
        }

        const result = await chatbotAdminService.assignTicket(
            Number(req.params.id), assigneeId.trim(), req.currentAdmin,
        );

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return sendError(res, error);
    }
}

async function transitionTicket(req, res) {
    try {
        const { status, reason } = req.body ?? {};
        if (typeof status !== "string" || !status.trim()) {
            return res.status(400).json({
                success: false,
                message: "status (trạng thái đích) là bắt buộc.",
                errorCode: "VALIDATION_ERROR",
            });
        }

        const result = await chatbotAdminService.transitionTicket(
            Number(req.params.id), status.trim(), reason || null, req.currentAdmin,
        );

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return sendError(res, error);
    }
}

async function staffReply(req, res) {
    try {
        const { content, isInternalNote } = req.body ?? {};
        const result = await chatbotAdminService.staffReply(
            Number(req.params.id), content, Boolean(isInternalNote), req.currentAdmin,
        );

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return sendError(res, error);
    }
}

module.exports = { listTickets, getTicketDetail, assignTicket, transitionTicket, staffReply };
