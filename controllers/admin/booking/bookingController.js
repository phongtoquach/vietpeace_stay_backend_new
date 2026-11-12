const bookingAdminService = require("../../../services/booking_admin_service");
const bookingAdminUpdateService = require("../../../services/booking_admin_update_service");
const { ok, fail } = require("../../../utils/response");

async function getBookingsList(req, res) {
  try {
    const result = await bookingAdminService.getBookingList(
      req.query,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy danh sách đặt phòng thành công.");
  } catch (error) {
    console.error("[getBookingsList] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy danh sách đặt phòng.",
    );
  }
}

async function getBookingDetail(req, res) {
  try {
    const result = await bookingAdminService.getBookingDetail(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy chi tiết đặt phòng thành công.");
  } catch (error) {
    console.error("[getBookingDetail] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy chi tiết đặt phòng.",
    );
  }
}

async function approveBooking(req, res) {
  try {
    const result = await bookingAdminService.approveBooking(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Duyệt đặt phòng thành công.");
  } catch (error) {
    console.error("[approveBooking] Lỗi:", error);

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
      "Đã xảy ra lỗi khi duyệt đặt phòng.",
    );
  }
}

async function checkInBooking(req, res) {
  try {
    const result = await bookingAdminService.checkInBooking(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Nhận phòng thành công.");
  } catch (error) {
    console.error("[checkInBooking] Lỗi:", error);

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
      "Đã xảy ra lỗi khi nhận phòng.",
    );
  }
}

async function checkOutBooking(req, res) {
  try {
    const result = await bookingAdminService.checkOutBooking(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Trả phòng thành công.");
  } catch (error) {
    console.error("[checkOutBooking] Lỗi:", error);

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
      "Đã xảy ra lỗi khi trả phòng.",
    );
  }
}

async function updateBookingDates(req, res) {
  try {
    const result = await bookingAdminUpdateService.updateBookingDates(
      req.params.id,
      req.body ?? {},
      req.currentAdmin,
    );
    return ok(res, result, "Đã cập nhật kỳ lưu trú và tính lại giá.");
  } catch (error) {
    console.error("[updateBookingDates] Lỗi:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(res, 500, "INTERNAL_ERROR", "Đã xảy ra lỗi khi cập nhật kỳ lưu trú.");
  }
}

async function updateBookingContact(req, res) {
  try {
    const result = await bookingAdminUpdateService.updateBookingContact(
      req.params.id,
      req.body ?? {},
      req.currentAdmin,
    );
    return ok(res, result, "Đã cập nhật thông tin liên hệ.");
  } catch (error) {
    console.error("[updateBookingContact] Lỗi:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(res, 500, "INTERNAL_ERROR", "Đã xảy ra lỗi khi cập nhật thông tin liên hệ.");
  }
}

module.exports = {
  getBookingsList,
  getBookingDetail,
  approveBooking,
  checkInBooking,
  checkOutBooking,
  updateBookingDates,
  updateBookingContact,
};
