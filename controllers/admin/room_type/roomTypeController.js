const roomTypeService = require("../../../services/room_type_service");
const { ok, fail } = require("../../../utils/response");

// Controller chỉ nhận HTTP → gọi service → trả JSON.
async function getRoomTypesList(req, res) {
  try {
    const result = await roomTypeService.getRoomTypeList(
      req.query,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy danh sách loại phòng thành công.");
  } catch (error) {
    console.error("[getRoomTypesList] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy danh sách loại phòng.",
    );
  }
}

async function getRoomTypeDetail(req, res) {
  try {
    const result = await roomTypeService.getRoomTypeDetail(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy chi tiết loại phòng thành công.");
  } catch (error) {
    console.error("[getRoomTypeDetail] Lỗi:", error);

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
      "Đã xảy ra lỗi khi lấy chi tiết loại phòng.",
    );
  }
}

async function createRoomType(req, res) {
  try {
    const result = await roomTypeService.createRoomType(
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Tạo loại phòng thành công.", 201);
  } catch (error) {
    console.error("[createRoomType] Lỗi:", error);

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
      "Đã xảy ra lỗi khi tạo loại phòng.",
    );
  }
}

async function updateRoomType(req, res) {
  try {
    const result = await roomTypeService.updateRoomType(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Cập nhật loại phòng thành công.");
  } catch (error) {
    console.error("[updateRoomType] Lỗi:", error);

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
      "Đã xảy ra lỗi khi cập nhật loại phòng.",
    );
  }
}

async function deleteRoomType(req, res) {
  try {
    const result = await roomTypeService.deleteRoomType(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Đã xóa loại phòng.");
  } catch (error) {
    console.error("[deleteRoomType] Lỗi:", error);

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
      "Đã xảy ra lỗi khi xóa loại phòng.",
    );
  }
}

module.exports = {
  getRoomTypesList,
  getRoomTypeDetail,
  createRoomType,
  updateRoomType,
  deleteRoomType,
};
