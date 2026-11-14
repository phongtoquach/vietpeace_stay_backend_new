//require("dotenv").config();
require("dotenv/config");

const http = require("http");
const { sqlObj, connectDB } = require("./configs/database");

const express = require("express");
const cors = require("cors");
const path = require("path");

// import Session object của Customer & Admin
const customerSession = require("./configs/customerSession");
const adminSession = require("./configs/adminSession");

// import bộ routes của phần Web & phần Admin Panel
const webRoutes = require("./routes/web/web_routes");
const adminRoutes = require("./routes/admin/admin_routes");
const { createWebChatRouter, createAdminChatRouter } = require("./routes/chat_routes");
const { attachChatSocket, stopWorkers } = require("./services/chat/runtime");

const app = express();
const PORT = process.env.PORT || 3000;

// cấu hình CORS : cho phép app BE này nhận & xử lý các request được gửi đến từ các domain được khai báo trong mảng origin
console.log("[Server] WEB_DOMAIN env : " + process.env.WEB_DOMAIN);
console.log("[Server] ADMIN_PANEL_DOMAIN env : " + process.env.ADMIN_PANEL_DOMAIN);
app.use(cors({
    origin: [
        process.env.WEB_DOMAIN,             // Web
        process.env.ADMIN_PANEL_DOMAIN      // Admin Panel
    ],
    credentials: true                       // cho phép phía browser gửi & nhận cookie khi gọi các API của app BE này
}));

// cho phép app nhận data JSON trong request được gửi đến server đang run app
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

//app.use(express.static("public"));
// cấu hình đế map folder tĩnh "/public/uploads" vào URL prefix "/uploads"
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));


// cấu hình để map folder tĩnh "/public/uploads" vào URL prefix "/uploads"


// chỉ định tất cả API của phần Web (có prefix "/api/web/*") phải áp dụng Customer Session & toàn bộ route trong webRoutes 
app.use("/api/web/chat", customerSession, createWebChatRouter());
app.use("/api/web", customerSession, webRoutes);

// chỉ định tất cả API của phần Web (có prefix "/api/admin/*") phải áp dụng Admin Session & toàn bộ route trong adminRoutes
app.use("/api/admin/chat", adminSession, createAdminChatRouter());
app.use("/api/admin", adminSession, adminRoutes);

async function startServer({ port = PORT } = {}) {
    await connectDB();

    const httpServer = http.createServer(app);
    attachChatSocket(httpServer);

    await new Promise((resolve) => {
        httpServer.listen(port, () => {
            const addr = httpServer.address();
            const boundPort = typeof addr === "object" && addr ? addr.port : port;
            console.log(`App đang run trên server bind với domain http://localhost:${boundPort}`);
            resolve();
        });
    });

    const stop = async () => {
        stopWorkers();
        await new Promise((resolve) => httpServer.close(() => resolve()));
    };

    return { app, httpServer, stop };
}

if (require.main === module) {
    startServer().catch((err) => {
        console.error("[Server] Failed to start:", err);
        process.exit(1);
    });
}

module.exports = { app, startServer };
