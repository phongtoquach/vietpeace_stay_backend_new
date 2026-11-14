const financialReportService = require("../../services/financial_report_service");
const { ok, fail } = require("../../utils/response");

function handleControllerError(res, error, contextLabel, fallbackMessage) {
  console.error(`[${contextLabel}] Lỗi:`, error);
  if (error.statusCode && error.errorCode) {
    return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
  }
  return fail(res, 500, "INTERNAL_ERROR", fallbackMessage);
}

function getActor(req) {
  return req.currentAdmin || req.session?.admin || {};
}

async function getOverview(req, res) {
  try {
    const result = await financialReportService.getChainFinancialOverview(req.query, getActor(req));
    return ok(res, result, "Lấy báo cáo tài chính Thu – Chi (P&L) thành công.");
  } catch (error) {
    return handleControllerError(res, error, "getFinancialOverview", "Đã xảy ra lỗi khi tải báo cáo tài chính.");
  }
}

async function getAccommodationDetail(req, res) {
  try {
    const result = await financialReportService.getAccommodationFinancialDetail(
      req.params.id,
      req.query,
      getActor(req),
    );
    return ok(res, result, "Lấy chi tiết tài chính cơ sở thành công.");
  } catch (error) {
    return handleControllerError(res, error, "getAccommodationFinancialDetail", "Đã xảy ra lỗi khi tải chi tiết cơ sở.");
  }
}

async function upsertLedger(req, res) {
  try {
    const record = await financialReportService.upsertAccommodationMonthlyLedger(
      req.params.id,
      req.body,
      getActor(req),
    );
    return ok(res, record, "Cập nhật sổ cái Thu – Chi tháng thành công.");
  } catch (error) {
    return handleControllerError(res, error, "upsertAccommodationMonthlyLedger", "Đã xảy ra lỗi khi cập nhật sổ cái.");
  }
}

async function updateProfile(req, res) {
  try {
    const record = await financialReportService.updateAccommodationOperatingProfile(
      req.params.id,
      req.body,
      getActor(req),
    );
    return ok(res, record, "Cập nhật định mức vận hành cơ sở thành công.");
  } catch (error) {
    return handleControllerError(res, error, "updateAccommodationOperatingProfile", "Đã xảy ra lỗi khi cập nhật định mức.");
  }
}

async function getBonusPreview(req, res) {
  try {
    const result = await financialReportService.getTetBonusAnd13thSalaryPreview(req.query, getActor(req));
    return ok(res, result, "Tính bảng dự kiến thưởng & lương tháng 13 thành công.");
  } catch (error) {
    return handleControllerError(res, error, "getBonusPreview", "Đã xảy ra lỗi khi tính bảng thưởng.");
  }
}

async function approveBonuses(req, res) {
  try {
    const result = await financialReportService.approveAndSaveBonusSettlements(req.body, getActor(req));
    return ok(res, result, "Phê duyệt quyết toán thưởng thành công.");
  } catch (error) {
    return handleControllerError(res, error, "approveBonuses", "Đã xảy ra lỗi khi phê duyệt quyết toán thưởng.");
  }
}

async function sendWarningEmail(req, res) {
  try {
    const result = await financialReportService.sendFinancialWarningEmailToManager(
      req.params.id,
      req.body,
      getActor(req),
    );
    return ok(res, result, "Đã gửi Gmail cảnh báo tài chính tới Manager phụ trách.");
  } catch (error) {
    return handleControllerError(res, error, "sendFinancialWarningEmail", "Đã xảy ra lỗi khi gửi Gmail cảnh báo.");
  }
}

async function getPaymentsLedger(req, res) {
  try {
    const result = await financialReportService.getPaymentReconciliationLedger(req.query, getActor(req));
    return ok(res, result, "Lấy sổ cái đối soát thanh toán thành công.");
  } catch (error) {
    return handleControllerError(res, error, "getPaymentReconciliationLedger", "Đã xảy ra lỗi khi tải sổ cái giao dịch.");
  }
}

module.exports = {
  getOverview,
  getAccommodationDetail,
  upsertLedger,
  updateProfile,
  getBonusPreview,
  approveBonuses,
  sendWarningEmail,
  getPaymentsLedger,
};
