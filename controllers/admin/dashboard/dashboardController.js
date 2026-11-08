const dashboardAdminService = require("../../../services/dashboard_admin_service");
const { ok, fail } = require("../../../utils/response");

async function getDashboardSummary(req, res) {
  try {
    const result = await dashboardAdminService.getDashboardSummary(
      req.currentAdmin,
    );
    return ok(res, result, "Lấy dữ liệu tổng quan thành công.");
  } catch (error) {
    console.error("[getDashboardSummary] Lỗi:", error);

    if (error.statusCode && error.errorCode) {
      return fail(
        res,
        error.statusCode,
        error.errorCode,
        error.message,
        error.errors,
      );
    }

    return fail(
      res,
      500,
      "INTERNAL_ERROR",
      "Đã xảy ra lỗi khi lấy dữ liệu tổng quan.",
    );
  }
}

async function getDashboardCharts(req, res) {
  try {
    const result = await dashboardAdminService.getDashboardCharts(
      req.currentAdmin,
    );
    return ok(res, result, "Lấy dữ liệu biểu đồ tổng quan thành công.");
  } catch (error) {
    console.error("[getDashboardCharts] Lỗi:", error);

    if (error.statusCode && error.errorCode) {
      return fail(
        res,
        error.statusCode,
        error.errorCode,
        error.message,
        error.errors,
      );
    }

    return fail(
      res,
      500,
      "INTERNAL_ERROR",
      "Đã xảy ra lỗi khi lấy dữ liệu biểu đồ tổng quan.",
    );
  }
}

module.exports = {
  getDashboardSummary,
  getDashboardCharts,
};
