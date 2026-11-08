/**
 * Session dành cho user login (đội ngũ nhân viên, quản lý của VietPeace Stay) trên Admin Panel
 */

const session = require("express-session");

const adminSession = session({
    name: "vietpeace.admin.sid",
    secret: process.env.ADMIN_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        //secure: process.env.NODE_ENV === "production",
        secure: false,  // trên production dùng https thì đổi thành true
        sameSite: "lax",
        path: "/api/admin",
        maxAge: 1000 * 3600 * 24    // 24 hours
    },
});

module.exports = adminSession;