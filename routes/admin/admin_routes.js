const express = require("express");
const router = express.Router();

const requireAdminLogin = require("../../middlewares/requireAdminLogin");

/**
 * ADMIN AUTH
 * /api/admin/auth/*
 */
const authAdminRoutes = require("./auth_admin_routes");
router.use("/auth", authAdminRoutes);

/**
 * ADMIN ROLES & PERMISSIONS
 * /api/admin/roles/*
 */
const rolePermissionAdminRoutes = require("./role_permission_admin_routes");
router.use("/roles", requireAdminLogin, rolePermissionAdminRoutes);

/**
 * ADMIN USERS (Tài khoản nhân sự quản trị)
 * /api/admin/users/*
 */
const userAdminRoutes = require("./user_admin_routes");
router.use("/users", requireAdminLogin, userAdminRoutes);

/**
 * ADMIN ACCOMMODATIONS & MANAGERS
 * /api/admin/accommodations/*
 */
const accommodationAdminRoutes = require("./accommodation_admin_routes");
router.use("/accommodations", requireAdminLogin, accommodationAdminRoutes);

/**
 * ADMIN BOOKINGS
 * /api/admin/bookings/*
 */
const bookingAdminRoutes = require("./booking_admin_routes");
router.use("/bookings", requireAdminLogin, bookingAdminRoutes);


/**
 * ADMIN CUSTOMERS
 * /api/admin/customers/*
 */
const customerAdminRoutes = require("./customer_admin_routes");
router.use("/customers", requireAdminLogin, customerAdminRoutes);

/**
 * ADMIN DASHBOARD
 * /api/admin/dashboard/*
 */
const dashboardAdminRoutes = require("./dashboard_admin_routes");
router.use("/dashboard", requireAdminLogin, dashboardAdminRoutes);

/**
 * ADMIN REPORTS
 * /api/admin/reports/*
 */
const reportAdminRoutes = require("./report_admin_routes");
router.use("/reports", requireAdminLogin, reportAdminRoutes);

/**
 * LOOKUP (Tỉnh/Thành phố, Loại hình, Tiện ích, ...)
 * /api/admin/lookup/*
 */
const lookupAdminRoutes = require("./lookup_admin_routes");
router.use("/lookup", requireAdminLogin, lookupAdminRoutes);

/**
 * UPLOADS
 * /api/admin/uploads/*
 */
const uploadAdminRoutes = require("./upload_admin_routes");
router.use("/uploads", requireAdminLogin, uploadAdminRoutes);

/**
 * ADMIN ROOM-TYPE
 * /api/admin/room-types/*
 */
const roomTypeAdminRoutes = require("./room_type_admin_routes");
router.use("/room-types", requireAdminLogin, roomTypeAdminRoutes);

/**
 * ADMIN LOCATIONS
 * /api/admin/locations/*
 */
const locationAdminRoutes = require("./location_admin_routes");
router.use("/locations", requireAdminLogin, locationAdminRoutes);

/**
 * ADMIN ATTRACTIONS
 * /api/admin/attractions/*
 */
const attractionAdminRoutes = require("./attraction_admin_routes");
router.use("/attractions", requireAdminLogin, attractionAdminRoutes);

/**
 * ADMIN AMENITIES
 * /api/admin/amenities/*
 */
const amenityAdminRoutes = require("./amenity_admin_routes");
router.use("/amenities", requireAdminLogin, amenityAdminRoutes);

/**
 * ADMIN CHATBOT SUPPORT INBOX
 * /api/admin/chatbot/*
 */
const chatbotAdminRoutes = require("./chatbot_admin_routes");
router.use("/chatbot", requireAdminLogin, chatbotAdminRoutes);

module.exports = router;
