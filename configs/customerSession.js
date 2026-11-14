/**
 * Session dành cho customer login trên Web
 */

const session = require("express-session");
const { createSessionStore } = require("./sessionStore");

const customerSession = session({
    name: "vietpeace.customer.sid",
    secret: process.env.CUSTOMER_SESSION_SECRET,
    store: createSessionStore("web"),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/api/web",
        maxAge: 1000 * 3600 * 24   // 24 hours
    },
});

module.exports = customerSession;
