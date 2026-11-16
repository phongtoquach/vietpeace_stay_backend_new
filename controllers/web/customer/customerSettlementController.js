const {
  createCustomerVnpaySettlement,
  verifyCustomerSettlementVnpayReturn,
} = require("../../../services/web_checkout_settlement_service");

async function createCustomerSettlementVnpay(req, res) {
  try {
    const customerId = req.session?.customer?.id;
    const clientIp = req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress;
    const data = await createCustomerVnpaySettlement(
      customerId,
      req.params.bookingId,
      clientIp,
    );

    return res.json({
      success: true,
      message: "Tạo liên kết thanh toán VNPay cho chi phí phát sinh thành công.",
      data,
    });
  } catch (error) {
    if (error?.statusCode && error?.errorCode) {
      return res.status(error.statusCode).json({
        success: false,
        errorCode: error.errorCode,
        message: error.message,
      });
    }
    console.error("[customerSettlementController.createVnpay]", error);
    return res.status(500).json({
      success: false,
      errorCode: "INTERNAL_SERVER_ERROR",
      message: "Không thể khởi tạo thanh toán VNPay lúc này.",
    });
  }
}

async function verifyCheckoutSettlementVnpayReturn(req, res) {
  try {
    const result = await verifyCustomerSettlementVnpayReturn(req.body);
    return res.json({
      success: true,
      message: result.paid
        ? "Thanh toán chi phí phát sinh trả phòng thành công."
        : "Giao dịch VNPay chưa hoàn tất hoặc bị hủy.",
      data: result,
    });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        errorCode: error.errorCode || "VALIDATION_ERROR",
        message: error.message,
      });
    }
    console.error("[customerSettlementController.vnpayReturn]", error);
    return res.status(500).json({
      success: false,
      errorCode: "INTERNAL_SERVER_ERROR",
      message: "Không thể xác nhận kết quả thanh toán VNPay.",
    });
  }
}

module.exports = {
  createCustomerSettlementVnpay,
  verifyCheckoutSettlementVnpayReturn,
};
