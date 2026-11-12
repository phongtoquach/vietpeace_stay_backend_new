/**
 * ADMIN CHATBOT SUPPORT INBOX
 * /api/admin/chatbot/*
 * - GET  /tickets           : danh sách ticket (ADMIN: toàn bộ; MANAGER: đúng accommodation assignment)
 * - GET  /tickets/:id       : chi tiết ticket + conversation + booking context tối thiểu
 * - POST /tickets/:id/assign: gán nhân viên (chỉ ADMIN)
 * - POST /tickets/:id/status: chuyển trạng thái theo state machine (bắt buộc reason với CANCELLED/OPEN)
 * - POST /tickets/:id/reply : phản hồi customer hoặc ghi chú nội bộ (isInternalNote)
 */

const express = require("express");
const router = express.Router();

const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requireRole = require("../../middlewares/requireRole");
const chatbotAdminController = require("../../controllers/admin/chatbot_admin_controller");

router.get("/tickets", chatbotAdminController.listTickets);
router.get("/tickets/:id", chatbotAdminController.getTicketDetail);
router.post("/tickets/:id/assign", requireRole("ADMIN"), chatbotAdminController.assignTicket);
router.post("/tickets/:id/status", chatbotAdminController.transitionTicket);
router.post("/tickets/:id/reply", chatbotAdminController.staffReply);

module.exports = router;
