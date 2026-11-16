const incidentalCatalogService = require("../../../services/incidental_catalog_service");
const checkoutSettlementService = require("../../../services/checkout_settlement_service");
const { ok, fail } = require("../../../utils/response");

function handleControllerError(res, error, fallbackMessage) {
  if (error?.statusCode && error?.errorCode) {
    return fail(
      res,
      error.statusCode,
      error.errorCode,
      error.message,
      error.errors,
    );
  }

  console.error("[checkoutSettlementController] error:", error);
  return fail(res, 500, "INTERNAL_ERROR", fallbackMessage);
}

async function getIncidentalCatalog(req, res) {
  try {
    const result = await incidentalCatalogService.listCatalog(
      req.params.id,
      req.query,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy danh mục phát sinh & tài sản cơ sở thành công.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể tải danh mục phát sinh của cơ sở.");
  }
}

async function createIncidentalCatalogItem(req, res) {
  try {
    const result = await incidentalCatalogService.createCatalogItem(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Đã thêm hạng mục mới vào danh mục cơ sở.", 201);
  } catch (error) {
    return handleControllerError(res, error, "Không thể tạo hạng mục danh mục.");
  }
}

async function updateIncidentalCatalogItem(req, res) {
  try {
    const result = await incidentalCatalogService.updateCatalogItem(
      req.params.itemId,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Cập nhật hạng mục danh mục thành công.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể cập nhật hạng mục danh mục.");
  }
}

async function deleteIncidentalCatalogItem(req, res) {
  try {
    const result = await incidentalCatalogService.deactivateCatalogItem(
      req.params.itemId,
      req.currentAdmin,
    );
    return ok(res, result, "Đã ngừng kích hoạt hạng mục danh mục.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể ngừng kích hoạt hạng mục.");
  }
}

async function getBookingCheckoutFolio(req, res) {
  try {
    const includeVoided =
      String(req.query?.includeVoided || "").toLowerCase() === "true";
    const result = await checkoutSettlementService.getCheckoutFolio(
      req.params.id,
      req.currentAdmin,
      { includeVoided },
    );
    return ok(res, result, "Lấy bảng kê chi phí trả phòng thành công.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể tải bảng kê trả phòng.");
  }
}

async function addBookingIncidentalCharge(req, res) {
  try {
    const result = await checkoutSettlementService.addIncidentalCharge(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Đã ghi nhận khoản phát sinh vào bảng kê.", 201);
  } catch (error) {
    return handleControllerError(res, error, "Không thể thêm khoản phát sinh.");
  }
}

async function updateBookingIncidentalCharge(req, res) {
  try {
    const result = await checkoutSettlementService.updateIncidentalCharge(
      req.params.id,
      req.params.chargeId,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Đã cập nhật khoản phát sinh.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể cập nhật khoản phát sinh.");
  }
}

async function voidBookingIncidentalCharge(req, res) {
  try {
    const result = await checkoutSettlementService.voidIncidentalCharge(
      req.params.id,
      req.params.chargeId,
      req.currentAdmin,
    );
    return ok(res, result, "Đã hủy khoản phát sinh khỏi bảng kê.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể hủy khoản phát sinh.");
  }
}

async function settleBookingCheckout(req, res) {
  try {
    const result = await checkoutSettlementService.settleCheckout(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Kết toán hóa đơn & hoàn tất trả phòng thành công.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể kết toán trả phòng lúc này.");
  }
}

async function createBookingVnpaySettlementUrl(req, res) {
  try {
    const clientIp = req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress;
    const result = await checkoutSettlementService.createVnpaySettlementSession(
      req.params.id,
      req.body,
      clientIp,
      req.currentAdmin,
    );
    return ok(res, result, "Đã tạo liên kết thanh toán VNPay cho phần phát sinh.");
  } catch (error) {
    return handleControllerError(res, error, "Không thể khởi tạo giao dịch VNPay phát sinh.");
  }
}

module.exports = {
  getIncidentalCatalog,
  createIncidentalCatalogItem,
  updateIncidentalCatalogItem,
  deleteIncidentalCatalogItem,
  getBookingCheckoutFolio,
  addBookingIncidentalCharge,
  updateBookingIncidentalCharge,
  voidBookingIncidentalCharge,
  settleBookingCheckout,
  createBookingVnpaySettlementUrl,
};
