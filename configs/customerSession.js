/**
 * Session dành cho customer login trên Web
 */

const session = require("express-session");

const customerSession = session({
    name: "vietpeace.customer.sid",
    secret: process.env.CUSTOMER_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        //secure: process.env.NODE_ENV === "production",
        secure: false,  // trên production dùng https thì đổi thành true
        sameSite: "lax",
        path: "/api/web",
        maxAge: 1000 * 3600 * 24   // 24 hours
    },
});

module.exports = customerSession;
