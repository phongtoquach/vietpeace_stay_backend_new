function requireRole(...allowedRoles) {
  return function (req, res, next) {
    const admin = req.session?.admin;

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập vào Admin Panel",
        errorCode: "UNAUTHENTICATED",
      });
    }

    if (!allowedRoles.includes(admin.role)) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn không có quyền thực hiện thao tác này.",
        errorCode: "FORBIDDEN",
      });
    }

    next();
  };
}

module.exports = requireRole;
