const accommodationService = require("../../../services/accommodation_service");
const { ok, fail } = require("../../../utils/response");

/**
 * GET /api/admin/accommodations
 *
 * Nhiệm vụ của controller:
 * 1. Nhận request từ route.
 * 2. Gửi query và user hiện tại cho service.
 * 3. Nhận dữ liệu từ service.
 * 4. Trả JSON cho frontend.
 *
 * Controller không viết SQL.
 */

async function getAccommodationsList(req, res) {
  try {
    /*
     * req.query chứa các tham số trên URL:
     *
     * ?page=1
     * ?limit=10
     * ?status=1
     */
    const result = await accommodationService.getAccommodationList(
      req.query,
      req.currentAdmin,
    );
    /*
     * result đã có:
     * - items
     * - pagination
     */
    return ok(res, result, "Lấy danh sách cơ sở lưu trú thành công.");
  } catch (error) {
    console.error("[getAccommodationsList] Lỗi lấy danh sách:", error);
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
      "Đã xảy ra lỗi khi lấy danh sách cơ sở lưu trú.",
    );
  }
}

// Lấy thông tin chi tiết 1 Accommodation theo Accommodation ID
async function getAccommodationDetail(req, res) {
  try {
    const result = await accommodationService.getAccommodationDetail(
      req.params.id,
      req.currentAdmin,
    );
    return ok(res, result, "Lấy chi tiết cơ sở lưu trú thành công.");
  } catch (error) {
    console.error("[getAccommodationDetail] Lỗi lấy chi tiết", error);
    if (error.statusCode && error.errorCode) {
      return fail(
        res,
        error.statusCode,
        error.errorCode,
        error.message,
        error.errors,
      );
    }
  }
  return fail(
    res,
    500,
    "INTERNAL_ERROR",
    "Đã xảy ra lỗi khi lấy chi tiết cơ sở lưu trú.",
  );
}

/**
 * GET /api/admin/accommodations/stats
 *
 * Controller chỉ điều phối HTTP:
 * - lấy user từ session
 * - gọi service
 * - trả response JSON
 *
 * SQL vẫn nằm hoàn toàn trong accommodation_service.js.
 */

/**
 * POST /api/admin/accommodations
 * Controller chỉ nhận body và chuyển cho service; SQL không nằm ở đây.
 */
async function createAccommodation(req, res) {
  try {
    const result = await accommodationService.createAccommodation(
      req.body,
      req.session.admin,
    );
    // 201 = đã tạo tài nguyên mới; trả kèm DTO detail để FE không phải GET lại.
    return ok(res, result, "Tạo cơ sở lưu trú thành công.", 201);
  } catch (error) {
    console.error("[createAccommodation] Lỗi tạo mới:", error);
    // Service đã phân loại lỗi (400/409/404) kèm errors dạng { field: message }.
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(res, 500, "INTERNAL_ERROR", "Đã xảy ra lỗi khi tạo cơ sở lưu trú.");
  }
}

/**
 * PUT /api/admin/accommodations/:id
 * Controller chỉ nhận body và chuyển cho service; SQL không nằm ở đây.
 */
async function updateAccommodation(req, res) {
  try {
    const result = await accommodationService.updateAccommodation(
      req.params.id,
      req.body,
      req.currentAdmin,
    );
    return ok(res, result, "Cập nhật cơ sở lưu trú thành công.");
  } catch (error) {
    console.error("[updateAccommodation] Lỗi cập nhật:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(res, 500, "INTERNAL_ERROR", "Đã xảy ra lỗi khi cập nhật cơ sở lưu trú.");
  }
}

async function updateAccommodationStatus(req, res) {
  try {
    const result = await accommodationService.updateAccommodationStatus(
      req.params.id,
      req.body.status,
      req.currentAdmin,
    );
    return ok(res, result, "Cập nhật trạng thái cơ sở lưu trú thành công.");
  } catch (error) {
    console.error("[updateAccommodationStatus] Lỗi:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(
      res,
      500,
      "INTERNAL_ERROR",
      "Đã xảy ra lỗi khi cập nhật trạng thái cơ sở lưu trú.",
    );
  }
}

async function updateAccommodationFeatured(req, res) {
  try {
    const result = await accommodationService.updateAccommodationFeatured(
      req.params.id,
      req.body.isFeatured,
      req.currentAdmin,
    );
    return ok(res, result, "Cập nhật trạng thái nổi bật thành công.");
  } catch (error) {
    console.error("[updateAccommodationFeatured] Lỗi:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(
      res,
      500,
      "INTERNAL_ERROR",
      "Đã xảy ra lỗi khi cập nhật trạng thái nổi bật.",
    );
  }
}

async function deleteAccommodation(req, res) {
  try {
    const force = req.query.force === "true";
    const result = await accommodationService.deleteAccommodation(
      req.params.id,
      { force },
      req.session.admin,
    );
    return ok(res, result, "Đã xóa cơ sở lưu trú.");
  } catch (error) {
    console.error("[deleteAccommodation] Lỗi:", error);
    if (error.statusCode && error.errorCode) {
      return fail(res, error.statusCode, error.errorCode, error.message, error.errors);
    }
    return fail(
      res,
      500,
      "INTERNAL_ERROR",
      "Đã xảy ra lỗi khi xóa cơ sở lưu trú.",
    );
  }
}

async function getAccommodationStats(req, res) {
  try {
    const result = await accommodationService.getAccommodationStats(
      req.session.admin,
    );
    return ok(res, result, "Lấy thông tin lưu trú thành công");
  } catch (error) {
    console.error("[getAccommodationStats] Lỗi lấy thống kê:", error);

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
      "Đã xảy ra lỗi khi lấy thống kê cơ sở lưu trú.",
    );
  }
}

// export
module.exports = {
  getAccommodationsList,
  getAccommodationDetail,
  getAccommodationStats,
  createAccommodation,
  updateAccommodation,
  updateAccommodationStatus,
  updateAccommodationFeatured,
  deleteAccommodation,
};
