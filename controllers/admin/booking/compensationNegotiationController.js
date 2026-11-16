const compensationNegotiationService = require("../../../services/compensation_negotiation_service");
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

  console.error("[compensationNegotiationController] error:", error);
  return fail(res, 500, "INTERNAL_ERROR", fallbackMessage);
}

async function createBookingNegotiation(req, res) {
  try {
    const result = await compensationNegotiationService.createNegotiationProposal(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(
      res,
      result,
      "Đã gửi phiếu đề xuất thương lượng giảm bồi thường lên Admin.",
      201,
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể gửi phiếu đề xuất thương lượng bồi thường.",
    );
  }
}

async function listNegotiations(req, res) {
  try {
    const result = await compensationNegotiationService.listNegotiations(
      req.query,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy danh sách phiếu thương lượng bồi thường thành công.");
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể tải danh sách phiếu thương lượng bồi thường.",
    );
  }
}

async function getNegotiationSummary(req, res) {
  try {
    const result = await compensationNegotiationService.getNegotiationSummary(
      req.currentAdmin,
    );
    return ok(res, result, "Lấy tóm tắt thông báo thương lượng bồi thường thành công.");
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể tải tóm tắt thông báo thương lượng bồi thường.",
    );
  }
}

async function getNegotiationDetail(req, res) {
  try {
    const result = await compensationNegotiationService.getNegotiationDetail(
      req.params.negotiationId,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy chi tiết phiếu thương lượng bồi thường thành công.");
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể tải chi tiết phiếu thương lượng.",
    );
  }
}

async function reviewNegotiation(req, res) {
  try {
    const result = await compensationNegotiationService.reviewNegotiationProposal(
      req.params.negotiationId,
      req.body,
      req.currentAdmin,
    );
    const msg =
      result?.negotiation?.status === "REJECTED"
        ? "Đã từ chối đề xuất và giữ nguyên mức bồi thường ban đầu."
        : "Đã xác nhận mức giảm bồi thường và thông báo về cho Quản lý cơ sở.";
    return ok(res, result, msg);
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể xử lý kết quả thẩm định thương lượng.",
    );
  }
}

async function cancelNegotiation(req, res) {
  try {
    const result = await compensationNegotiationService.cancelNegotiationProposal(
      req.params.negotiationId,
      req.currentAdmin,
    );
    return ok(res, result, "Đã hủy phiếu đề xuất thương lượng.");
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể hủy phiếu đề xuất thương lượng.",
    );
  }
}

async function acknowledgeNegotiation(req, res) {
  try {
    const result = await compensationNegotiationService.acknowledgeNegotiationDecision(
      req.params.negotiationId,
      req.currentAdmin,
    );
    return ok(res, result, "Đã xác nhận tiếp nhận kết quả từ Admin.");
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Không thể cập nhật trạng thái đã xem kết quả.",
    );
  }
}

module.exports = {
  createBookingNegotiation,
  listNegotiations,
  getNegotiationSummary,
  getNegotiationDetail,
  reviewNegotiation,
  cancelNegotiation,
  acknowledgeNegotiation,
};
