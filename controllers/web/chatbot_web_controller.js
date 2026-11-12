// Web chatbot controller: guest + customer message, danh sách ticket của customer.

const chatbotService = require("../../services/chatbot/chatbot_service");

function sendError(res, error) {
    console.error("[chatbot_web_controller]", error.message);
    return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || "Lỗi hệ thống.",
        errorCode: error.errorCode || "INTERNAL_ERROR",
    });
}

async function postMessage(req, res) {
    try {
        const { sessionKey, content } = req.body ?? {};
        const customer = req.session?.customer
            ? { id: req.session.customer.id }
            : null;

        const result = await chatbotService.postMessage({ sessionKey, content, customer });

        return res.status(200).json({
            success: true,
            data: result,
        });
    } catch (error) {
        return sendError(res, error);
    }
}

async function getMyTickets(req, res) {
    try {
        const tickets = await chatbotService.getMyTickets(req.session.customer.id);

        return res.status(200).json({
            success: true,
            data: { tickets },
        });
    } catch (error) {
        return sendError(res, error);
    }
}

module.exports = { postMessage, getMyTickets };
