/**
 * CHATBOT WEB
 * /api/web/chatbot/*
 * - POST /message  : guest + customer gửi tin nhắn cho chatbot (public, sessionKey tự sinh phía client)
 * - GET  /tickets  : customer đã login xem danh sách ticket của mình
 */

const express = require("express");
const router = express.Router();

const requireCustomerLogin = require("../../middlewares/requireCustomerLogin");
const { chatbotRateLimit } = require("../../middlewares/chatbot_rate_limit");
const chatbotController = require("../../controllers/web/chatbot_web_controller");

router.post("/message", chatbotRateLimit, chatbotController.postMessage);
router.get("/tickets", requireCustomerLogin, chatbotController.getMyTickets);

module.exports = router;
