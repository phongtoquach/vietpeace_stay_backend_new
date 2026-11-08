const express = require("express");
const router = express.Router();
const userAdminController = require("../../controllers/admin/users/userAdminController");

// Middleware: chỉ ADMIN (Super Admin) mới được quản lý danh sách tài khoản
function requireSuperAdminRole(req, res, next) {
    if (req.currentAdmin?.role !== "ADMIN") {
        return res.status(403).json({
            success: false,
            errorCode: "FORBIDDEN",
            message: "Chỉ Quản trị viên cấp cao (ADMIN) mới có quyền truy cập chức năng quản trị tài khoản.",
        });
    }
    next();
}

router.use(requireSuperAdminRole);

router.get("/", userAdminController.listUsers);
router.post("/", userAdminController.createManager);
router.post("/managers", userAdminController.createManager);
router.put("/:id", userAdminController.updateUser);
router.patch("/:id/status", userAdminController.toggleStatus);
router.post("/:id/reset-password", userAdminController.resetPassword);
router.delete("/:id", userAdminController.deleteUser);

module.exports = router;
