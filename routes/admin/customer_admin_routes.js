const express = require("express");
const router = express.Router();

const customerAdminController = require("../../controllers/admin/users/customerAdminController");
const requireRole = require("../../middlewares/requireRole");

// ADMIN và ACCOMMODATION_MANAGER được phép xem danh sách khách hàng
router.get(
    "/",
    requireRole("ADMIN", "ACCOMMODATION_MANAGER"),
    customerAdminController.getCustomersList
);

// ADMIN và ACCOMMODATION_MANAGER được phép xem chi tiết khách hàng
router.get(
    "/:id",
    requireRole("ADMIN", "ACCOMMODATION_MANAGER"),
    customerAdminController.getCustomerDetail
);

module.exports = router;