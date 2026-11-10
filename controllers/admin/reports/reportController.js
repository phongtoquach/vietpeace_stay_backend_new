const reportAdminService = require("../../../services/report_admin_service");
const { ok, fail, paginated } = require("../../../utils/response");

async function getRevenueReport(req, res) {
  try {
    const year = reportAdminService.normalizeReportYear(req.query.year);
    const month = reportAdminService.normalizeReportMonth(req.query.month);
    const result = await reportAdminService.getRevenueReport(
      req.currentAdmin,
      year,
      month,
      req.query,
    );
    return ok(res, result, "Lấy báo cáo doanh thu thành công.");
  } catch (error) {
    console.error("[getRevenueReport] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy báo cáo doanh thu.",
    );
  }
}

async function getBookingsReport(req, res) {
  try {
    const year = reportAdminService.normalizeReportYear(req.query.year);
    const month = reportAdminService.normalizeReportMonth(req.query.month);
    const result = await reportAdminService.getBookingsReport(
      req.currentAdmin,
      year,
      month,
    );
    return ok(res, result, "Lấy báo cáo đặt phòng thành công.");
  } catch (error) {
    console.error("[getBookingsReport] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy báo cáo đặt phòng.",
    );
  }
}

async function getOccupancyReport(req, res) {
  try {
    const year = reportAdminService.normalizeReportYear(req.query.year);
    const month = reportAdminService.normalizeReportMonth(req.query.month);
    const result = await reportAdminService.getOccupancyReport(
      req.currentAdmin,
      year,
      month,
    );
    return ok(res, result, "Lấy báo cáo công suất phòng thành công.");
  } catch (error) {
    console.error("[getOccupancyReport] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy báo cáo công suất phòng.",
    );
  }
}

async function getMonthlyOrders(req, res) {
  try {
    const year = reportAdminService.normalizeReportYear(req.query.year);
    const month = reportAdminService.normalizeReportMonth(req.query.month);
    const result = await reportAdminService.getMonthlyOrders(
      req.currentAdmin,
      year,
      month,
      req.query,
    );
    return paginated(res, result.items, result.pagination);
  } catch (error) {
    console.error("[getMonthlyOrders] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy danh sách đơn trong tháng.",
    );
  }
}

module.exports = {
  getRevenueReport,
  getBookingsReport,
  getOccupancyReport,
  getMonthlyOrders,
};
