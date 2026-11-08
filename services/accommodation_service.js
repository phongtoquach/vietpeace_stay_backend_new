const sql = require("mssql");
const { getDBPool } = require("../configs/database");

// Các hằng số trong Accommodation
const {
  ACCOMMODATION_STATUS,
  ACCOMMODATION_STATUS_LABEL,
  SORT_FIELD_MAP,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} = require("../constants/accommodation");

// Mã lỗi dùng chung: VALIDATION_ERROR, DUPLICATE_CODE...
const { ERROR_CODES } = require("../constants/error_codes");

// Format ngày giờ
const { formatTime, formatDateTime } = require("../utils/datetime");

// Sinh slug + đảm bảo slug không trùng.
const { toSlug, ensureUniqueSlug } = require("../utils/slug");

// Đưa ảnh vừa upload vào folder theo id cơ sở lưu trú.
const {
  moveImagesIntoAccommodationFolder,
} = require("../utils/accommodation_image_storage");

// Scope ownership: ADMIN toàn hệ thống, manager theo accommodation_managers.
const { getAccommodationScope } = require("./accommodation_access_service");

/**
 * Lỗi riêng của service accommodation.
 *
 * Vì sao cần class này?
 * Service có thể phát hiện nhiều loại lỗi khác nhau:
 *
 * - Filter sai  → HTTP 400
 * - Không tìm thấy dữ liệu → HTTP 404
 * - Dữ liệu bị trùng → HTTP 409
 *
 * Controller sẽ đọc các thuộc tính này để trả response đúng chuẩn.
 */

class AccommodationServiceError extends Error {
  constructor(
    message,
    statusCode = 400,
    errorCode = "VALIDATION_ERROR",
    errors = undefined,
  ) {
    // Gọi constructor của Error gốc.
    super(message);

    // HTTP status muốn trả về frontend.
    this.statusCode = statusCode;

    // Mã lỗi
    this.errorCode = errorCode;

    // Lỗi theo từng field, ví dụ { status: "..." }.
    this.errors = errors;
  }
}

/* =====================================================================
 * Phase 4.1 — Validate & chuẩn hoá payload ghi (create / update)
 * ---------------------------------------------------------------------
 * Hàm này KHÔNG kiểm tra dữ liệu phụ thuộc DB (loại hình có tồn tại,
 * điểm đến có active, phường/xã có thuộc tỉnh...). Những việc đó cần
 * query DB nên để 4.2 resolveLocationContext và bước create/update.
 * Ở đây chỉ kiểm tra "hình dạng" dữ liệu để báo lỗi theo từng field.
 * ===================================================================== */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_REGEX = /^[A-Za-z0-9._-]+$/;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_PREFIX_REGEX = /^https?:\/\//i;

/**
 * Đọc một chuỗi: trim, kiểm tra bắt buộc và độ dài.
 *
 * Ba trạng thái cần phân biệt:
 * - undefined → client KHÔNG gửi field  → { skip: true } (update giữ nguyên)
 * - null      → client gửi null rõ ràng → { value: null } (xoá field nullable)
 * - ""        → chuỗi rỗng              → giống null nếu không bắt buộc
 *
 * Trả về { error } nếu sai để hàm chính ghi vào đúng tên field.
 */
function readString(
  raw,
  { required = false, requiredMessage = "Không được để trống.", max = null } = {},
) {
  if (raw === undefined) {
    return required ? { error: requiredMessage } : { skip: true };
  }
  if (raw === null) {
    return required ? { error: requiredMessage } : { value: null };
  }
  if (typeof raw !== "string") {
    return { error: "Giá trị phải là chuỗi." };
  }

  const value = raw.trim();
  if (value.length === 0) {
    return required ? { error: requiredMessage } : { value: null };
  }
  if (max !== null && value.length > max) {
    return { error: `Không được vượt quá ${max} ký tự.` };
  }
  return { value };
}

/**
 * Đọc số nguyên. Chỉ nhận number hoặc chuỗi số — tránh bẫy Number(true) = 1.
 * undefined/"": bỏ qua (hoặc báo lỗi nếu bắt buộc).
 */
function readInt(
  raw,
  {
    required = false,
    requiredMessage = "Không được để trống.",
    min = null,
    max = null,
  } = {},
) {
  const isEmpty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "");

  if (isEmpty) {
    return required ? { error: requiredMessage } : { value: null };
  }
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: "Giá trị phải là số nguyên." };
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return { error: "Giá trị phải là số nguyên." };
  }
  if (min !== null && value < min) {
    return { error: `Giá trị phải lớn hơn hoặc bằng ${min}.` };
  }
  if (max !== null && value > max) {
    return { error: `Giá trị phải nhỏ hơn hoặc bằng ${max}.` };
  }
  return { value };
}

/**
 * Đọc số thực (latitude/longitude).
 * undefined/"": bỏ qua để update giữ nguyên; null: xoá toạ độ.
 */
function readNumber(raw, { min = null, max = null } = {}) {
  const isEmpty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "");

  if (isEmpty) return { skip: true };
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: "Giá trị phải là số." };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { error: "Giá trị phải là số." };
  }
  if (min !== null && value < min) {
    return { error: `Giá trị phải lớn hơn hoặc bằng ${min}.` };
  }
  if (max !== null && value > max) {
    return { error: `Giá trị phải nhỏ hơn hoặc bằng ${max}.` };
  }
  return { value };
}

/**
 * Đọc boolean thật (không nhận "true"/1) để tránh ghi sai cờ isFeatured.
 */
function readBool(
  raw,
  { required = false, requiredMessage = "Không được để trống." } = {},
) {
  if (raw === undefined) {
    return required ? { error: requiredMessage } : { skip: true };
  }
  if (raw === null) {
    return required ? { error: requiredMessage } : { value: null };
  }
  if (typeof raw !== "boolean") {
    return { error: "Giá trị phải là true hoặc false." };
  }
  return { value: raw };
}

/* ---------- Validate cấu trúc 3 mảng con ---------- */

// Ảnh: tối đa 30, URL bắt buộc ≤ 1000, tối đa 1 isCover.
// KHÔNG tự thêm cover ở đây — việc normalize cover thuộc 4.5 syncImages.
function validateImageList(raw, errors) {
  if (!Array.isArray(raw)) {
    errors.images = "Danh sách ảnh không hợp lệ.";
    return undefined;
  }
  if (raw.length > 30) {
    errors.images = "Tối đa 30 ảnh.";
    return undefined;
  }

  let coverCount = 0;
  const images = raw.map((item, index) => {
    const imageUrl =
      typeof item?.imageUrl === "string" ? item.imageUrl.trim() : "";
    const altText =
      typeof item?.altText === "string" ? item.altText.trim() : null;
    const caption =
      typeof item?.caption === "string" ? item.caption.trim() : null;

    if (!imageUrl || imageUrl.length > 1000) {
      errors.images = `Ảnh thứ ${index + 1}: URL bắt buộc và tối đa 1000 ký tự.`;
    }
    if (altText && altText.length > 250) {
      errors.images = `Ảnh thứ ${index + 1}: mô tả thay thế tối đa 250 ký tự.`;
    }
    if (caption && caption.length > 500) {
      errors.images = `Ảnh thứ ${index + 1}: chú thích tối đa 500 ký tự.`;
    }

    const isCover = item?.isCover === true;
    if (isCover) coverCount += 1;

    return {
      imageUrl,
      altText,
      caption,
      isCover,
      sortOrder:
        Number.isInteger(item?.sortOrder) && item.sortOrder >= 0
          ? item.sortOrder
          : index,
    };
  });

  if (coverCount > 1) {
    errors.images = "Chỉ được chọn 1 ảnh bìa.";
  }
  return images;
}

// Tiện nghi: ID nguyên dương, không trùng trong payload.
// Việc amenity có active/scope phù hợp cần DB → để 4.5.
function validateAmenityList(raw, errors) {
  if (!Array.isArray(raw)) {
    errors.amenities = "Danh sách tiện nghi không hợp lệ.";
    return undefined;
  }

  const seen = new Set();
  const amenities = [];
  for (const item of raw) {
    const amenityId = Number(item?.amenityId);
    if (!Number.isInteger(amenityId) || amenityId <= 0) {
      errors.amenities = "Tiện nghi có ID không hợp lệ.";
      continue;
    }
    if (seen.has(amenityId)) {
      errors.amenities = "Tiện nghi bị trùng trong payload.";
      continue;
    }
    seen.add(amenityId);

    const note = typeof item?.note === "string" ? item.note.trim() : null;
    if (note && note.length > 1000) {
      errors.amenities = "Ghi chú tiện nghi tối đa 1000 ký tự.";
    }

    amenities.push({
      amenityId,
      isChargeable: item?.isChargeable === true,
      note,
    });
  }
  return amenities;
}

// Điểm tham quan: ID nguyên dương, không trùng, khoảng cách null hoặc ≥ 0.
function validateAttractionList(raw, errors) {
  if (!Array.isArray(raw)) {
    errors.attractions = "Danh sách điểm tham quan không hợp lệ.";
    return undefined;
  }

  const seen = new Set();
  const attractions = [];

  raw.forEach((item, index) => {
    const attractionId = Number(item?.attractionId);
    if (!Number.isInteger(attractionId) || attractionId <= 0) {
      errors.attractions = "Điểm tham quan có ID không hợp lệ.";
      return;
    }
    if (seen.has(attractionId)) {
      errors.attractions = "Điểm tham quan bị trùng trong payload.";
      return;
    }
    seen.add(attractionId);

    let distanceMeters = null;
    if (
      item?.distanceMeters !== undefined &&
      item.distanceMeters !== null &&
      item.distanceMeters !== ""
    ) {
      distanceMeters = Number(item.distanceMeters);
      if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
        errors.attractions = "Khoảng cách phải là số không âm.";
        distanceMeters = null;
      }
    }

    const note = typeof item?.note === "string" ? item.note.trim() : null;
    if (note && note.length > 500) {
      errors.attractions = "Ghi chú điểm tham quan tối đa 500 ký tự.";
    }

    attractions.push({
      attractionId,
      distanceMeters,
      note,
      sortOrder:
        Number.isInteger(item?.sortOrder) && item.sortOrder >= 0
          ? item.sortOrder
          : index,
    });
  });

  return attractions;
}

/**
 * Validate payload ghi cơ sở lưu trú.
 *
 * @param {object} body     Payload camelCase từ client (mục 5.2).
 * @param {object} options  { isCreate } — true khi POST, false khi PUT.
 * @returns {object} values — chỉ gồm field được gửi lên (+ default khi create).
 * @throws {AccommodationServiceError} 400 VALIDATION_ERROR kèm errors theo field.
 *
 * Quy ước mảng con:
 * - Có mặt trong body  → hiểu là "thay thế toàn bộ".
 * - Không có mặt       → update giữ nguyên; create coi như mảng rỗng.
 */
function validateAccommodationPayload(body = {}, { isCreate = false } = {}) {
  const errors = {};
  const values = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  // apply: ghi lỗi vào errors[field], hoặc ghi giá trị đã chuẩn hoá vào values.
  // transform (tuỳ chọn) trả về message lỗi hoặc null.
  const apply = (field, result, transform = null) => {
    if (result.error) {
      errors[field] = result.error;
      return;
    }
    if (result.skip) return;

    if (transform) {
      const message = transform(result.value);
      if (message) {
        errors[field] = message;
        return;
      }
    }
    values[field] = result.value;
  };

  console.group("[validateAccommodationPayload]");
  console.log("[1] input", { isCreate, fields: Object.keys(body) });

  /* ---------- Nhóm chuỗi bắt buộc ---------- */

  // Khi create: bắt buộc kể cả không gửi. Khi update: chỉ kiểm tra nếu có gửi.
  if (has("name") || isCreate) {
    apply(
      "name",
      readString(body.name, {
        required: true,
        requiredMessage: "Vui lòng nhập tên cơ sở lưu trú.",
        max: 255,
      }),
    );
  }

  if (has("code") || isCreate) {
    apply(
      "code",
      readString(body.code, {
        required: true,
        requiredMessage: "Vui lòng nhập mã cơ sở lưu trú.",
        max: 150,
      }),
      (value) =>
        value !== null && !CODE_REGEX.test(value)
          ? "Mã cơ sở lưu trú không hợp lệ."
          : null,
    );
  }

  if (has("addressLine") || isCreate) {
    apply(
      "addressLine",
      readString(body.addressLine, {
        required: true,
        requiredMessage: "Vui lòng nhập địa chỉ cụ thể.",
        max: 400,
      }),
    );
  }

  if (has("shortDescription") || isCreate) {
    apply(
      "shortDescription",
      readString(body.shortDescription, {
        required: true,
        requiredMessage: "Vui lòng nhập mô tả tóm tắt.",
        max: 1000,
      }),
    );
  }

  /* ---------- Khoá ngoại (chỉ kiểm tra hình dạng, tồn tại để 4.2) ---------- */

  if (has("typeId") || isCreate) {
    apply(
      "typeId",
      readInt(body.typeId, {
        required: true,
        requiredMessage: "Vui lòng chọn loại hình lưu trú.",
        min: 1,
      }),
    );
  }

  if (has("locationId") || isCreate) {
    apply(
      "locationId",
      readInt(body.locationId, {
        required: true,
        requiredMessage: "Vui lòng chọn điểm đến.",
        min: 1,
      }),
    );
  }

  if (has("wardId") || isCreate) {
    apply(
      "wardId",
      readInt(body.wardId, {
        required: true,
        requiredMessage: "Vui lòng chọn phường/xã.",
        min: 1,
      }),
    );
  }

  /* ---------- Chuỗi tuỳ chọn ---------- */

  if (has("postalCode")) {
    apply("postalCode", readString(body.postalCode, { max: 10 }));
  }
  if (has("directions")) {
    apply("directions", readString(body.directions, { max: 2000 }));
  }
  if (has("description")) {
    apply("description", readString(body.description));
  }
  if (has("checkInInstructions")) {
    apply(
      "checkInInstructions",
      readString(body.checkInInstructions, { max: 4000 }),
    );
  }
  if (has("houseRules")) {
    apply("houseRules", readString(body.houseRules));
  }
  if (has("childrenPolicy")) {
    apply("childrenPolicy", readString(body.childrenPolicy, { max: 2000 }));
  }
  if (has("petPolicy")) {
    apply("petPolicy", readString(body.petPolicy, { max: 2000 }));
  }
  if (has("smokingPolicy")) {
    apply("smokingPolicy", readString(body.smokingPolicy, { max: 2000 }));
  }
  if (has("phone")) {
    apply("phone", readString(body.phone, { max: 30 }));
  }
  if (has("email")) {
    apply(
      "email",
      readString(body.email, { max: 255 }),
      (value) =>
        value !== null && !EMAIL_REGEX.test(value)
          ? "Email không hợp lệ."
          : null,
    );
  }
  if (has("websiteUrl")) {
    apply(
      "websiteUrl",
      readString(body.websiteUrl, { max: 1000 }),
      (value) =>
        value !== null && !URL_PREFIX_REGEX.test(value)
          ? "Website phải bắt đầu bằng http:// hoặc https://."
          : null,
    );
  }
  if (has("checkInTime")) {
    apply(
      "checkInTime",
      readString(body.checkInTime, {
        required: true,
        requiredMessage: "Giờ nhận phòng không được để trống.",
      }),
      (value) =>
        value !== null && !TIME_REGEX.test(value)
          ? "Giờ nhận phòng phải có dạng HH:mm."
          : null,
    );
  }
  if (has("checkOutTime")) {
    apply(
      "checkOutTime",
      readString(body.checkOutTime, {
        required: true,
        requiredMessage: "Giờ trả phòng không được để trống.",
      }),
      (value) =>
        value !== null && !TIME_REGEX.test(value)
          ? "Giờ trả phòng phải có dạng HH:mm."
          : null,
    );
  }

  // Slug: chỉ kiểm tra định dạng. Quyền ADMIN mới được gửi slug → xử lý ở 4.3.
  if (has("slug")) {
    apply(
      "slug",
      readString(body.slug, { max: 350 }),
      (value) =>
        value !== null && !SLUG_REGEX.test(value)
          ? "Slug chỉ gồm chữ thường, số và dấu gạch nối."
          : null,
    );
  }

  /* ---------- Số / boolean / enum ---------- */

  // star_rating: NULL hợp lệ, có số thì 1..5.
  if (has("starRating")) {
    apply("starRating", readInt(body.starRating, { min: 1, max: 5 }));
  }

  if (has("status")) {
    apply(
      "status",
      readInt(body.status, {
        required: true,
        requiredMessage: "Trạng thái không hợp lệ.",
        min: ACCOMMODATION_STATUS.DRAFT,
        max: ACCOMMODATION_STATUS.INACTIVE,
      }),
    );
  } else if (isCreate) {
    // Không gửi status khi tạo → mặc định bản nháp (mục 5.2).
    values.status = ACCOMMODATION_STATUS.DRAFT;
  }

  if (has("sortOrder")) {
    apply(
      "sortOrder",
      readInt(body.sortOrder, {
        required: true,
        requiredMessage: "Thứ tự hiển thị phải là số nguyên không âm.",
        min: 0,
      }),
    );
  } else if (isCreate) {
    values.sortOrder = 0;
  }

  if (has("isFeatured")) {
    apply(
      "isFeatured",
      readBool(body.isFeatured, {
        required: true,
        requiredMessage: "Trường nổi bật phải là true hoặc false.",
      }),
    );
  } else if (isCreate) {
    values.isFeatured = false;
  }

  /* ---------- Ràng buộc chéo latitude/longitude (R3) ---------- */

  const latFilled =
    body.latitude !== undefined &&
    body.latitude !== null &&
    body.latitude !== "";
  const lngFilled =
    body.longitude !== undefined &&
    body.longitude !== null &&
    body.longitude !== "";

  if (latFilled !== lngFilled) {
    const message = "Vĩ độ và kinh độ phải có hoặc bỏ trống cùng nhau.";
    errors.latitude = message;
    errors.longitude = message;
  } else if (latFilled) {
    apply("latitude", readNumber(body.latitude, { min: -90, max: 90 }));
    apply("longitude", readNumber(body.longitude, { min: -180, max: 180 }));
  } else if (has("latitude") || has("longitude")) {
    // Client gửi null/"" cho cả hai → xoá toạ độ.
    values.latitude = null;
    values.longitude = null;
  }

  /* ---------- Mảng con (chỉ có mặt mới validate) ---------- */

  if (has("images")) {
    values.images = validateImageList(body.images, errors);
  }
  if (has("amenities")) {
    values.amenities = validateAmenityList(body.amenities, errors);
  }
  if (has("attractions")) {
    values.attractions = validateAttractionList(body.attractions, errors);
  }

  /* ---------- Kết luận ---------- */

  const errorCount = Object.keys(errors).length;
  if (errorCount > 0) {
    console.log(`[2] phát hiện ${errorCount} lỗi`, errors);
    console.groupEnd();
    throw new AccommodationServiceError(
      "Dữ liệu không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      errors,
    );
  }

  console.log("[2] hợp lệ, field sẽ ghi:", Object.keys(values));
  console.groupEnd();
  return values;
}

/**
 * Suy ra ngữ cảnh địa lý hợp lệ từ locationId + wardId.
 *
 * Vì sao cần hàm này?
 * - Bảng accommodations.ward_id KHÔNG có FK, DB không chặn ward sai tỉnh.
 * - province_id phải luôn khớp locations.province_id (R1) -> server tự suy,
 *   không tin giá trị client gửi lên.
 *
 * @param {number} locationId ID điểm đến client chọn.
 * @param {number} wardId     ID phường/xã client chọn.
 * @returns {{ locationId: number, provinceId: number, wardId: number }}
 * @throws {AccommodationServiceError} 400 khi điểm đến/phường không hợp lệ.
 */
async function resolveLocationContext(locationId, wardId) {
  const pool = getDBPool();

  console.group("[resolveLocationContext]");
  console.log("[1] input", { locationId, wardId });

  /* ---------- Bước 1: điểm đến phải tồn tại và đang hoạt động ---------- */
  const locationResult = await pool
    .request()
    .input("locationId", sql.Int, locationId)
    .query(`
      SELECT id, province_id, name, is_active
      FROM dbo.locations
      WHERE id = @locationId;
    `);

  if (locationResult.recordset.length === 0) {
    console.log("[2] không tìm thấy điểm đến", locationId);
    console.groupEnd();
    throw new AccommodationServiceError(
      "Điểm đến không tồn tại.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { locationId: "Điểm đến không tồn tại." },
    );
  }

  const location = locationResult.recordset[0];

  if (!location.is_active) {
    console.log("[2] điểm đến đã ngừng hoạt động", {
      locationId,
      name: location.name,
    });
    console.groupEnd();
    throw new AccommodationServiceError(
      "Điểm đến đã ngừng hoạt động.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { locationId: "Điểm đến đã ngừng hoạt động." },
    );
  }

  console.log("[2] điểm đến hợp lệ", {
    locationId: location.id,
    locationName: location.name,
    provinceId: location.province_id,
  });

  /* ---------- Bước 2: ward phải thuộc đúng province vừa suy ra ---------- */
  const wardResult = await pool
    .request()
    .input("wardId", sql.Int, wardId)
    .input("provinceId", sql.Int, location.province_id)
    .query(`
      SELECT id, name
      FROM dbo.wards
      WHERE id = @wardId
        AND province_id = @provinceId
        AND is_active = 1;
    `);

  if (wardResult.recordset.length === 0) {
    console.log("[3] phường/xã không thuộc tỉnh của điểm đến", {
      wardId,
      provinceId: location.province_id,
    });
    console.groupEnd();
    throw new AccommodationServiceError(
      "Phường/xã không thuộc tỉnh/thành của điểm đến.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { wardId: "Phường/xã không thuộc tỉnh/thành của điểm đến." },
    );
  }

  const ward = wardResult.recordset[0];

  console.log("[3] phường/xã hợp lệ", {
    wardId: ward.id,
    wardName: ward.name,
  });
  console.groupEnd();

  return {
    locationId: location.id,
    provinceId: location.province_id,
    wardId: ward.id,
  };
}

/* =====================================================================
 * Phase 4.3 — createAccommodation
 * Phase 4.5 (một phần) — replace 3 bảng phụ trong cùng transaction
 * ---------------------------------------------------------------------
 * Luồng: validate (4.1) → loại hình → resolve vị trí (4.2) → chặn trùng
 * mã → sinh slug → transaction → insert bảng chính → 3 bảng phụ →
 * kiểm tra publish nếu status = ACTIVE → commit → trả DTO detail.
 * ===================================================================== */

/**
 * Loại hình phải tồn tại và đang hoạt động (mục 6.3).
 * Bước 4.1 chỉ kiểm tra "là số nguyên dương", không kiểm tra DB.
 */
async function resolveAccommodationType(typeId) {
  console.group("[resolveAccommodationType]");
  console.log("[1] typeId:", typeId);

  const pool = getDBPool();
  const result = await pool
    .request()
    .input("typeId", sql.Int, typeId)
    .query(`
      SELECT id, code, name
      FROM dbo.accommodation_types
      WHERE id = @typeId AND is_active = 1;
    `);

  if (result.recordset.length === 0) {
    console.log("[2] không có loại hình hợp lệ");
    console.groupEnd();
    throw new AccommodationServiceError(
      "Dữ liệu không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { typeId: "Loại hình lưu trú không hợp lệ." },
    );
  }

  console.log("[2] hợp lệ:", result.recordset[0].code);
  console.groupEnd();
  return result.recordset[0];
}

/**
 * Chặn trùng accommodation_code trước khi INSERT.
 * DB vẫn có UNIQUE; bước này giúp trả 409 dễ đọc thay vì lỗi SQL 2627.
 * excludeId dùng lại cho update ở 4.4.
 */
async function assertCodeAvailable(code, excludeId = null) {
  const pool = getDBPool();
  const result = await pool
    .request()
    .input("code", sql.VarChar(150), code)
    .input("excludeId", sql.Int, excludeId)
    .query(`
      SELECT TOP 1 id
      FROM dbo.accommodations
      WHERE accommodation_code = @code
        AND (@excludeId IS NULL OR id <> @excludeId);
    `);

  if (result.recordset.length > 0) {
    throw new AccommodationServiceError(
      "Mã cơ sở lưu trú đã tồn tại.",
      409,
      ERROR_CODES.DUPLICATE_CODE,
      { code: "Mã cơ sở lưu trú đã tồn tại." },
    );
  }
}

/**
 * Chuẩn hoá ảnh bìa (R6):
 * - Không ảnh nào isCover → ảnh đầu tiên thành bìa.
 * - Nhiều ảnh isCover → chỉ giữ ảnh đầu tiên.
 *
 * Lưu ý: payload có > 1 isCover đã bị 4.1 chặn 400; hàm này là lớp
 * bảo hiểm cuối cùng trước khi ghi DB.
 */
function normalizeCover(images = []) {
  if (images.length === 0) return images;

  const hasExplicitCover = images.some((image) => image.isCover === true);
  let covered = false;

  return images.map((image, index) => {
    // Có ảnh được đánh dấu → ưu tiên ảnh đó; không có → ảnh đầu tiên làm bìa.
    const isCover = hasExplicitCover
      ? !covered && image.isCover === true
      : index === 0;
    if (isCover) covered = true;
    return { ...image, isCover };
  });
}

/**
 * mssql không nhận Time dạng chuỗi, chỉ nhận Date.
 * Dựng Date theo giờ địa phương để khớp formatTime() khi đọc lại.
 */
function toSqlTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return value;
  return new Date(1970, 0, 1, Number(match[1]), Number(match[2]), 0);
}

/* ---------- Ghi 3 bảng phụ: delete-all + insert-all (mục 6.5) ---------- */

async function replaceImages(transaction, accommodationId, rawImages = []) {
  const images = normalizeCover(rawImages);

  await new sql.Request(transaction)
    .input("accommodationId", sql.Int, accommodationId)
    .query(
      `DELETE FROM dbo.accommodation_images WHERE accommodation_id = @accommodationId;`,
    );

  if (images.length === 0) return;

  // ≤30 ảnh nên insert từng dòng; mỗi dòng tạo Request MỚI từ transaction.
  for (const image of images) {
    await new sql.Request(transaction)
      .input("accommodationId", sql.Int, accommodationId)
      .input("imageUrl", sql.NVarChar(1000), image.imageUrl)
      .input("altText", sql.NVarChar(250), image.altText)
      .input("caption", sql.NVarChar(500), image.caption)
      .input("isCover", sql.Bit, image.isCover)
      .input("sortOrder", sql.Int, image.sortOrder)
      .query(`
        INSERT INTO dbo.accommodation_images
          (accommodation_id, image_url, alt_text, caption, is_cover, sort_order)
        VALUES
          (@accommodationId, @imageUrl, @altText, @caption, @isCover, @sortOrder);
      `);
  }

  console.log("[replaceImages] đã ghi", images.length, "ảnh");
}

async function replaceAmenities(transaction, accommodationId, amenities = []) {
  await new sql.Request(transaction)
    .input("accommodationId", sql.Int, accommodationId)
    .query(
      `DELETE FROM dbo.accommodation_amenities WHERE accommodation_id = @accommodationId;`,
    );

  if (amenities.length === 0) return;

  // Kiểm tra tiện nghi có thật, đang hoạt động và đúng scope (mục 6.3).
  const checkRequest = new sql.Request(transaction);
  amenities.forEach((item, index) => {
    checkRequest.input(`amenityId${index}`, sql.Int, item.amenityId);
  });
  const parameterList = amenities
    .map((_, index) => `@amenityId${index}`)
    .join(", ");

  const checkResult = await checkRequest.query(`
    SELECT id, amenity_scope
    FROM dbo.amenities
    WHERE id IN (${parameterList}) AND is_active = 1;
  `);

  // Chỉ 'accommodation' và 'both' được gắn vào cơ sở lưu trú.
  const allowedIds = new Set(
    checkResult.recordset
      .filter(
        (row) =>
          row.amenity_scope === "accommodation" || row.amenity_scope === "both",
      )
      .map((row) => row.id),
  );
  const invalidIds = amenities
    .filter((item) => !allowedIds.has(item.amenityId))
    .map((item) => item.amenityId);

  if (invalidIds.length > 0) {
    throw new AccommodationServiceError(
      "Dữ liệu không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      {
        amenities: `Tiện nghi không hợp lệ hoặc không áp dụng cho cơ sở: ${invalidIds.join(", ")}.`,
      },
    );
  }

  for (const item of amenities) {
    await new sql.Request(transaction)
      .input("accommodationId", sql.Int, accommodationId)
      .input("amenityId", sql.Int, item.amenityId)
      .input("isChargeable", sql.Bit, item.isChargeable)
      .input("note", sql.NVarChar(1000), item.note)
      .query(`
        INSERT INTO dbo.accommodation_amenities
          (accommodation_id, amenity_id, is_chargeable, note)
        VALUES
          (@accommodationId, @amenityId, @isChargeable, @note);
      `);
  }

  console.log("[replaceAmenities] đã ghi", amenities.length, "tiện nghi");
}

async function replaceAttractions(transaction, accommodationId, attractions = []) {
  await new sql.Request(transaction)
    .input("accommodationId", sql.Int, accommodationId)
    .query(
      `DELETE FROM dbo.accommodation_attractions WHERE accommodation_id = @accommodationId;`,
    );

  if (attractions.length === 0) return;

  for (const item of attractions) {
    await new sql.Request(transaction)
      .input("accommodationId", sql.Int, accommodationId)
      .input("attractionId", sql.Int, item.attractionId)
      .input("distanceMeters", sql.Decimal(18, 2), item.distanceMeters)
      .input("note", sql.NVarChar(500), item.note)
      .input("sortOrder", sql.Int, item.sortOrder)
      .query(`
        INSERT INTO dbo.accommodation_attractions
          (accommodation_id, attraction_id, distance_meters, note, sort_order)
        VALUES
          (@accommodationId, @attractionId, @distanceMeters, @note, @sortOrder);
      `);
  }

  console.log("[replaceAttractions] đã ghi", attractions.length, "điểm tham quan");
}

/**
 * P1 — phải có ảnh bìa trước khi ACTIVE (mục 6.1).
 * 4.6 sẽ mở rộng thành validatePublishRequirements (P1–P4) và dùng cho update.
 */
async function assertPublishable(transaction, accommodationId) {
  const result = await new sql.Request(transaction)
    .input("accommodationId", sql.Int, accommodationId)
    .query(`
      SELECT COUNT(*) AS coverCount
      FROM dbo.accommodation_images
      WHERE accommodation_id = @accommodationId AND is_cover = 1;
    `);

  if (result.recordset[0].coverCount === 0) {
    throw new AccommodationServiceError(
      "Cần có ảnh bìa trước khi kích hoạt.",
      409,
      ERROR_CODES.PUBLISH_REQUIREMENT_MISSING,
      { images: "Cần có ảnh bìa trước khi kích hoạt." },
    );
  }
}

/**
 * R7 — cơ sở có được gán Manager đang hoạt động hay không?
 *
 * "Có Manager assigned" nghĩa là tồn tại dòng trong dbo.accommodation_managers
 * nối tới tài khoản users còn hoạt động (users.status = 1). Manager bị tạm
 * khóa (status = 2) không được tính.
 *
 * @param {sql.Connection|sql.Transaction} executor pool hoặc transaction
 *   đang chạy, giúp gọi được cả trong và ngoài transaction.
 * @returns {Promise<boolean>}
 */
async function hasActiveManager(executor, accommodationId) {
  const result = await new sql.Request(executor)
    .input("accommodationId", sql.Int, accommodationId)
    .query(`
      SELECT TOP 1 1 AS has_manager
      FROM dbo.accommodation_managers m
      JOIN dbo.users u ON u.id = m.user_id
      WHERE m.accommodation_id = @accommodationId
        AND u.status = 1;
    `);

  return result.recordset.length > 0;
}

/**
 * R7 — phải có Manager đang hoạt động trước khi chuyển sang ACTIVE.
 *
 * Thu hồi manager qua API luôn buộc chọn manager thay thế, nên một cơ sở
 * đã gán không thể mất trắng manager; chỉ cần chặn đường chuyển trạng thái
 * là giữ vững bất biến "ACTIVE ⟹ có Manager đang hoạt động".
 *
 * Lỗi 409 kèm errors.status để form Sửa gắn thông báo đúng ô select.
 */
async function assertManagerAssigned(transaction, accommodationId) {
  if (await hasActiveManager(transaction, accommodationId)) {
    return;
  }

  throw new AccommodationServiceError(
    "Cơ sở lưu trú chưa có người quản lý đang hoạt động.",
    409,
    ERROR_CODES.MANAGER_NOT_ASSIGNED,
    {
      status:
        "Cần gán Manager đang hoạt động trước khi chuyển sang Đang hoạt động.",
    },
  );
}

/**
 * Tạo mới cơ sở lưu trú.
 *
 * @param {object} body        payload thô từ controller
 * @param {object} currentUser req.session.admin
 * @returns {Promise<object>}  DTO giống API detail
 */
async function createAccommodation(body = {}, currentUser = {}) {
  console.group("[createAccommodation]");
  console.log("[1] role:", currentUser.role, "| fields:", Object.keys(body));

  let transaction = null;

  try {
    /* Bước 1 — validate hình dạng (4.1). */
    const values = validateAccommodationPayload(body, { isCreate: true });

    /* Bước 2 — loại hình phải có thật trong DB. */
    await resolveAccommodationType(values.typeId);

    /* Bước 3 — suy province + chặn ward sai tỉnh (4.2). */
    const context = await resolveLocationContext(
      values.locationId,
      values.wardId,
    );

    /* Bước 4 — chặn trùng mã. */
    await assertCodeAvailable(values.code);

    /* Bước 5 — slug: ADMIN được gửi slug hợp lệ, còn lại sinh từ tên (6.2). */
    const requestedSlug = currentUser.role === "ADMIN" ? values.slug : null;
    const slug = await ensureUniqueSlug(requestedSlug || toSlug(values.name));
    console.log("[2] slug sẽ dùng:", slug);

    /* Bước 6 — gom giá trị cuối, field không gửi thì dùng default. */
    const payload = {
      code: values.code,
      name: values.name,
      slug,
      typeId: values.typeId,
      locationId: context.locationId,
      // R1: province luôn suy từ location, không tin client.
      provinceId: context.provinceId,
      wardId: context.wardId,
      addressLine: values.addressLine,
      postalCode: values.postalCode ?? null,
      latitude: values.latitude ?? null,
      longitude: values.longitude ?? null,
      directions: values.directions ?? null,
      shortDescription: values.shortDescription,
      description: values.description ?? null,
      phone: values.phone ?? null,
      email: values.email ?? null,
      websiteUrl: values.websiteUrl ?? null,
      starRating: values.starRating ?? null,
      checkInTime: values.checkInTime ?? "14:00",
      checkOutTime: values.checkOutTime ?? "12:00",
      checkInInstructions: values.checkInInstructions ?? null,
      houseRules: values.houseRules ?? null,
      childrenPolicy: values.childrenPolicy ?? null,
      petPolicy: values.petPolicy ?? null,
      smokingPolicy: values.smokingPolicy ?? null,
      status: values.status ?? ACCOMMODATION_STATUS.DRAFT,
      isFeatured: values.isFeatured ?? false,
      sortOrder: values.sortOrder ?? 0,
    };

    /* Bước 6.5 — R7: cơ sở mới chưa thể có Manager (gán manager chỉ làm
     * được sau khi cơ sở tồn tại) nên chặn luôn tạo thẳng ACTIVE. */
    if (payload.status === ACCOMMODATION_STATUS.ACTIVE) {
      console.log("[6.5] chặn tạo thẳng ACTIVE vì chưa thể có Manager");
      throw new AccommodationServiceError(
        "Cơ sở lưu trú mới chưa có người quản lý. Hãy tạo dưới dạng Bản nháp, gán Manager rồi mới kích hoạt.",
        409,
        ERROR_CODES.MANAGER_NOT_ASSIGNED,
        {
          status:
            "Cơ sở mới chưa có Manager nên không thể tạo ở trạng thái Đang hoạt động.",
        },
      );
    }

    const pool = getDBPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    console.log("[3] transaction bắt đầu");

    /* Bước 7 — INSERT bảng chính, lấy id vừa sinh. */
    const insertResult = await new sql.Request(transaction)
      .input("code", sql.VarChar(150), payload.code)
      .input("name", sql.NVarChar(255), payload.name)
      .input("slug", sql.VarChar(350), payload.slug)
      .input("typeId", sql.Int, payload.typeId)
      .input("locationId", sql.Int, payload.locationId)
      .input("provinceId", sql.Int, payload.provinceId)
      .input("wardId", sql.Int, payload.wardId)
      .input("addressLine", sql.NVarChar(400), payload.addressLine)
      .input("postalCode", sql.VarChar(10), payload.postalCode)
      .input("latitude", sql.Decimal(9, 6), payload.latitude)
      .input("longitude", sql.Decimal(9, 6), payload.longitude)
      .input("directions", sql.NVarChar(2000), payload.directions)
      .input("shortDescription", sql.NVarChar(1000), payload.shortDescription)
      .input("description", sql.NVarChar(sql.MAX), payload.description)
      .input("phone", sql.VarChar(30), payload.phone)
      .input("email", sql.VarChar(255), payload.email)
      .input("websiteUrl", sql.NVarChar(1000), payload.websiteUrl)
      .input("starRating", sql.TinyInt, payload.starRating)
      .input("checkInTime", sql.Time, toSqlTime(payload.checkInTime))
      .input("checkOutTime", sql.Time, toSqlTime(payload.checkOutTime))
      .input(
        "checkInInstructions",
        sql.NVarChar(4000),
        payload.checkInInstructions,
      )
      .input("houseRules", sql.NVarChar(sql.MAX), payload.houseRules)
      .input("childrenPolicy", sql.NVarChar(2000), payload.childrenPolicy)
      .input("petPolicy", sql.NVarChar(2000), payload.petPolicy)
      .input("smokingPolicy", sql.NVarChar(2000), payload.smokingPolicy)
      .input("status", sql.TinyInt, payload.status)
      .input("isFeatured", sql.Bit, payload.isFeatured)
      .input("sortOrder", sql.Int, payload.sortOrder)
      .query(`
        INSERT INTO dbo.accommodations (
          accommodation_code, accommodation_name, slug,
          accommodation_type_id, location_id, province_id, ward_id,
          address_line, postal_code, latitude, longitude, directions,
          short_description, description, phone, email, website_url,
          star_rating, check_in_time, check_out_time,
          check_in_instructions, house_rules, children_policy,
          pet_policy, smoking_policy,
          status, is_featured, sort_order
        )
        OUTPUT INSERTED.id
        VALUES (
          @code, @name, @slug,
          @typeId, @locationId, @provinceId, @wardId,
          @addressLine, @postalCode, @latitude, @longitude, @directions,
          @shortDescription, @description, @phone, @email, @websiteUrl,
          @starRating, @checkInTime, @checkOutTime,
          @checkInInstructions, @houseRules, @childrenPolicy,
          @petPolicy, @smokingPolicy,
          @status, @isFeatured, @sortOrder
        );
      `);

    const newId = insertResult.recordset[0].id;
    console.log("[4] đã insert accommodations id =", newId);

    /* Bước 8 — bảng phụ, cùng transaction. */
    await replaceImages(transaction, newId, values.images ?? []);
    await replaceAmenities(transaction, newId, values.amenities ?? []);
    await replaceAttractions(transaction, newId, values.attractions ?? []);
    console.log("[5] đã ghi ảnh / tiện nghi / điểm tham quan");

    /* Bước 9 — chỉ kiểm tra publish khi tạo thẳng ở ACTIVE. */
    if (payload.status === ACCOMMODATION_STATUS.ACTIVE) {
      console.log("[6] status = ACTIVE → kiểm tra ảnh bìa");
      await assertPublishable(transaction, newId);
    }

    /* Bước 10 — chốt transaction rồi trả DTO detail. */
    await transaction.commit();
    console.log("[7] commit OK");

    /* Ảnh upload trước khi có id nằm ở folder phẳng → chuyển vào folder id. */
    try {
      await moveImagesIntoAccommodationFolder(
        newId,
        (values.images ?? []).map((image) => image.imageUrl),
      );
    } catch (error) {
      console.error("[7.1] không thể chuyển ảnh vào folder id:", error.message);
    }

    const detail = await getAccommodationDetail(newId, currentUser);
    console.log("[8] trả detail id =", newId);
    return detail;
  } catch (error) {
    if (transaction) {
      console.log("[9] lỗi → rollback:", error.message);
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error("[10] rollback thất bại:", rollbackError.message);
      }
    }

    // Race: 2 request cùng code/slug lọt qua bước check trước INSERT.
    if (error.number === 2601 || error.number === 2627) {
      throw new AccommodationServiceError(
        "Mã hoặc slug đã tồn tại.",
        409,
        ERROR_CODES.DUPLICATE_CODE,
      );
    }

    // FK bị vi phạm (amenity/attraction/type/location không tồn tại).
    if (error.number === 547) {
      throw new AccommodationServiceError(
        "Dữ liệu liên kết không hợp lệ.",
        400,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    throw error;
  } finally {
    console.groupEnd();
  }
}

/**
 * Cập nhật một phần cơ sở lưu trú.
 * Field không gửi được giữ nguyên; mảng phụ có mặt thì thay thế toàn bộ.
 */
async function updateAccommodation(id, body = {}, currentUser = {}) {
  const accommodationId = parsePositiveInt(id);
  if (!accommodationId) {
    throw new AccommodationServiceError("ID cơ sở lưu trú không hợp lệ.", 400, ERROR_CODES.VALIDATION_ERROR, { id: "ID phải là số nguyên dương." });
  }
  console.group("[updateAccommodation]");
  console.log("[1] input", { id: accommodationId, fields: Object.keys(body) });
  let transaction = null;
  try {
    const values = validateAccommodationPayload(body, { isCreate: false });
    const pool = getDBPool();
    const scope = getAccommodationScope(currentUser);
    const currentRequest = pool
      .request()
      .input("accommodationId", sql.Int, accommodationId);

    for (const input of scope.inputs) {
      currentRequest.input(input.name, input.type, input.value);
    }

    const currentResult = await currentRequest.query(`
      SELECT * FROM dbo.accommodations a
      WHERE a.id = @accommodationId
        AND a.deleted_at IS NULL
        AND ${scope.condition};
    `);
    if (!currentResult.recordset.length) {
      throw new AccommodationServiceError("Không tìm thấy cơ sở lưu trú.", 404, ERROR_CODES.NOT_FOUND);
    }
    const current = currentResult.recordset[0];
    const locationId = values.locationId ?? current.location_id;
    const wardId = values.wardId ?? current.ward_id;
    const context = await resolveLocationContext(locationId, wardId);
    if (values.typeId !== undefined) await resolveAccommodationType(values.typeId);
    if (values.code !== undefined) await assertCodeAvailable(values.code, accommodationId);
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const isAdmin = currentUser.role === "ADMIN";
    const slug = has("slug") && isAdmin ? await ensureUniqueSlug(values.slug, accommodationId) : current.slug;
    const value = (field, column) => values[field] !== undefined ? values[field] : current[column];
    const payload = {
      code: value("code", "accommodation_code"), name: value("name", "accommodation_name"), slug,
      typeId: value("typeId", "accommodation_type_id"), locationId: context.locationId, provinceId: context.provinceId, wardId: context.wardId,
      addressLine: value("addressLine", "address_line"), postalCode: value("postalCode", "postal_code"), latitude: value("latitude", "latitude"), longitude: value("longitude", "longitude"),
      directions: value("directions", "directions"), shortDescription: value("shortDescription", "short_description"), description: value("description", "description"),
      phone: value("phone", "phone"), email: value("email", "email"), websiteUrl: value("websiteUrl", "website_url"), starRating: value("starRating", "star_rating"),
      checkInTime: values.checkInTime ?? formatTime(current.check_in_time), checkOutTime: values.checkOutTime ?? formatTime(current.check_out_time),
      checkInInstructions: value("checkInInstructions", "check_in_instructions"), houseRules: value("houseRules", "house_rules"), childrenPolicy: value("childrenPolicy", "children_policy"),
      petPolicy: value("petPolicy", "pet_policy"), smokingPolicy: value("smokingPolicy", "smoking_policy"), status: value("status", "status"),
      isFeatured: values.isFeatured !== undefined ? values.isFeatured : Boolean(current.is_featured), sortOrder: value("sortOrder", "sort_order"),
    };
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    console.log("[2] transaction bắt đầu");
    const request = new sql.Request(transaction)
      .input("id", sql.Int, accommodationId).input("code", sql.VarChar(150), payload.code).input("name", sql.NVarChar(255), payload.name).input("slug", sql.VarChar(350), payload.slug)
      .input("typeId", sql.Int, payload.typeId).input("locationId", sql.Int, payload.locationId).input("provinceId", sql.Int, payload.provinceId).input("wardId", sql.Int, payload.wardId)
      .input("addressLine", sql.NVarChar(400), payload.addressLine).input("postalCode", sql.VarChar(10), payload.postalCode).input("latitude", sql.Decimal(9, 6), payload.latitude).input("longitude", sql.Decimal(9, 6), payload.longitude)
      .input("directions", sql.NVarChar(2000), payload.directions).input("shortDescription", sql.NVarChar(1000), payload.shortDescription).input("description", sql.NVarChar(sql.MAX), payload.description)
      .input("phone", sql.VarChar(30), payload.phone).input("email", sql.VarChar(255), payload.email).input("websiteUrl", sql.NVarChar(1000), payload.websiteUrl).input("starRating", sql.TinyInt, payload.starRating)
      .input("checkInTime", sql.Time, toSqlTime(payload.checkInTime)).input("checkOutTime", sql.Time, toSqlTime(payload.checkOutTime)).input("checkInInstructions", sql.NVarChar(4000), payload.checkInInstructions)
      .input("houseRules", sql.NVarChar(sql.MAX), payload.houseRules).input("childrenPolicy", sql.NVarChar(2000), payload.childrenPolicy).input("petPolicy", sql.NVarChar(2000), payload.petPolicy).input("smokingPolicy", sql.NVarChar(2000), payload.smokingPolicy)
      .input("status", sql.TinyInt, payload.status).input("isFeatured", sql.Bit, payload.isFeatured).input("sortOrder", sql.Int, payload.sortOrder);

    for (const input of scope.inputs) {
      request.input(input.name, input.type, input.value);
    }

    const result = await request.query(`
      UPDATE a SET accommodation_code=@code, accommodation_name=@name, slug=@slug, accommodation_type_id=@typeId, location_id=@locationId, province_id=@provinceId, ward_id=@wardId,
      address_line=@addressLine, postal_code=@postalCode, latitude=@latitude, longitude=@longitude, directions=@directions, short_description=@shortDescription, description=@description, phone=@phone, email=@email,
      website_url=@websiteUrl, star_rating=@starRating, check_in_time=@checkInTime, check_out_time=@checkOutTime, check_in_instructions=@checkInInstructions, house_rules=@houseRules, children_policy=@childrenPolicy,
      pet_policy=@petPolicy, smoking_policy=@smokingPolicy, status=@status, is_featured=@isFeatured, sort_order=@sortOrder, updated_at=SYSDATETIME()
      FROM dbo.accommodations a
      WHERE a.id=@id AND a.deleted_at IS NULL
        AND ${scope.condition};
    `);
    if (!result.rowsAffected[0]) throw new AccommodationServiceError("Không tìm thấy cơ sở lưu trú.", 404, ERROR_CODES.NOT_FOUND);
    if (has("images")) await replaceImages(transaction, accommodationId, values.images);
    if (has("amenities")) await replaceAmenities(transaction, accommodationId, values.amenities);
    if (has("attractions")) await replaceAttractions(transaction, accommodationId, values.attractions);
    // R7: chỉ khi CHUYỂN lên ACTIVE (từ 0/2) mới yêu cầu Manager đang hoạt động.
    // Sửa thông tin khi đang giữ nguyên ACTIVE không phải chuyển trạng thái.
    if (
      payload.status === ACCOMMODATION_STATUS.ACTIVE &&
      Number(current.status) !== ACCOMMODATION_STATUS.ACTIVE
    ) {
      await assertManagerAssigned(transaction, accommodationId);
    }
    if (payload.status === ACCOMMODATION_STATUS.ACTIVE) await assertPublishable(transaction, accommodationId);
    await transaction.commit();
    console.log("[3] commit OK");

    /* Ảnh mới upload khi sửa cũng phải nằm trong folder theo id. */
    if (has("images")) {
      try {
        await moveImagesIntoAccommodationFolder(
          accommodationId,
          (values.images ?? []).map((image) => image.imageUrl),
        );
      } catch (error) {
        console.error("[4] không thể chuyển ảnh vào folder id:", error.message);
      }
    }

    return getAccommodationDetail(accommodationId, currentUser);
  } catch (error) {
    if (transaction) {
      console.log("[4] lỗi → rollback:", error.message);
      try { await transaction.rollback(); } catch (rollbackError) { console.error("[5] rollback thất bại:", rollbackError.message); }
    }
    if (error.number === 2601 || error.number === 2627) throw new AccommodationServiceError("Mã hoặc slug đã tồn tại.", 409, ERROR_CODES.DUPLICATE_CODE);
    if (error.number === 547) throw new AccommodationServiceError("Dữ liệu liên kết không hợp lệ.", 400, ERROR_CODES.VALIDATION_ERROR);
    throw error;
  } finally { console.groupEnd(); }
}

/**
 * PATCH /api/admin/accommodations/:id/status
 * status = 1 (ACTIVE) phải có ảnh bìa.
 */
async function updateAccommodationStatus(id, status, currentUser = {}) {
  const accommodationId = parsePositiveInt(id);
  if (!accommodationId) {
    throw new AccommodationServiceError(
      "ID cơ sở lưu trú không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { id: "ID phải là số nguyên dương." },
    );
  }

  const nextStatus = Number(status);
  const allowedStatuses = Object.values(ACCOMMODATION_STATUS);
  if (!Number.isInteger(nextStatus) || !allowedStatuses.includes(nextStatus)) {
    throw new AccommodationServiceError(
      "Trạng thái không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { status: "Trạng thái phải là 0, 1 hoặc 2." },
    );
  }

  console.group("[updateAccommodationStatus]");
  console.log("[1] input:", {
    id: accommodationId,
    status: nextStatus,
    role: currentUser.role,
  });

  let transaction = null;

  try {
    transaction = new sql.Transaction(getDBPool());
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    const scope = getAccommodationScope(currentUser);
    const request = new sql.Request(transaction)
      .input("id", sql.Int, accommodationId)
      .input("status", sql.TinyInt, nextStatus);

    for (const input of scope.inputs) {
      request.input(input.name, input.type, input.value);
    }

    // Đọc trạng thái hiện tại trước khi UPDATE để biết đây có phải là
    // "chuyển sang ACTIVE" hay giữ nguyên trạng thái đang có.
    const currentResult = await request.query(`
        SELECT a.status
        FROM dbo.accommodations a
        WHERE a.id = @id AND a.deleted_at IS NULL
          AND ${scope.condition};
      `);

    if (currentResult.recordset.length === 0) {
      throw new AccommodationServiceError(
        "Không tìm thấy cơ sở lưu trú.",
        404,
        ERROR_CODES.NOT_FOUND,
      );
    }

    const currentStatus = Number(currentResult.recordset[0].status);

    // R7: chuyển sang ACTIVE yêu cầu đã gán Manager đang hoạt động.
    // Thiếu Manager → 409, rollback và không đụng tới dữ liệu.
    if (
      nextStatus === ACCOMMODATION_STATUS.ACTIVE &&
      currentStatus !== ACCOMMODATION_STATUS.ACTIVE
    ) {
      await assertManagerAssigned(transaction, accommodationId);
    }

    const result = await request.query(`
        UPDATE a
        SET status = @status,
            updated_at = SYSDATETIME()
        FROM dbo.accommodations a
        WHERE a.id = @id AND a.deleted_at IS NULL
          AND ${scope.condition};
      `);

    if (result.rowsAffected[0] === 0) {
      throw new AccommodationServiceError(
        "Không tìm thấy cơ sở lưu trú.",
        404,
        ERROR_CODES.NOT_FOUND,
      );
    }

    // Chỉ kiểm tra ảnh bìa khi chuyển sang ACTIVE.
    // Thiếu ảnh → 409, rollback trả status về giá trị cũ.
    if (nextStatus === ACCOMMODATION_STATUS.ACTIVE) {
      await assertPublishable(transaction, accommodationId);
    }

    await transaction.commit();
    console.log("[2] commit OK");

    return {
      id: accommodationId,
      status: nextStatus,
      statusLabel: ACCOMMODATION_STATUS_LABEL[nextStatus],
    };
  } catch (error) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error("[3] rollback thất bại:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    console.groupEnd();
  }
}

/**
 * PATCH /api/admin/accommodations/:id/featured
 * Chỉ 1 câu UPDATE nên không cần transaction.
 */
async function updateAccommodationFeatured(id, isFeatured, currentUser = {}) {
  const accommodationId = parsePositiveInt(id);
  if (!accommodationId) {
    throw new AccommodationServiceError(
      "ID cơ sở lưu trú không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { id: "ID phải là số nguyên dương." },
    );
  }

  if (typeof isFeatured !== "boolean") {
    throw new AccommodationServiceError(
      "Dữ liệu không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { isFeatured: "isFeatured phải là true hoặc false." },
    );
  }

  console.group("[updateAccommodationFeatured]");
  console.log("[1] input:", {
    id: accommodationId,
    isFeatured,
    role: currentUser.role,
  });

  try {
    const scope = getAccommodationScope(currentUser);
    const request = getDBPool()
      .request()
      .input("id", sql.Int, accommodationId)
      .input("isFeatured", sql.Bit, isFeatured);

    for (const input of scope.inputs) {
      request.input(input.name, input.type, input.value);
    }

    const result = await request.query(`
        UPDATE a
        SET is_featured = @isFeatured,
            updated_at = SYSDATETIME()
        FROM dbo.accommodations a
        WHERE a.id = @id AND a.deleted_at IS NULL
          AND ${scope.condition};
      `);

    if (result.rowsAffected[0] === 0) {
      throw new AccommodationServiceError(
        "Không tìm thấy cơ sở lưu trú.",
        404,
        ERROR_CODES.NOT_FOUND,
      );
    }

    console.log("[2] cập nhật OK");
    return { id: accommodationId, isFeatured };
  } finally {
    console.groupEnd();
  }
}

/**
 * DELETE /api/admin/accommodations/:id
 * Xóa mềm; chặn nếu còn room type đang hoạt động, trừ khi force=true (ADMIN).
 */
async function deleteAccommodation(id, { force = false } = {}, currentUser = {}) {
  const accommodationId = parsePositiveInt(id);
  if (!accommodationId) {
    throw new AccommodationServiceError(
      "ID cơ sở lưu trú không hợp lệ.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { id: "ID phải là số nguyên dương." },
    );
  }

  const isAdmin = currentUser.role === "ADMIN";
  if (force && !isAdmin) {
    throw new AccommodationServiceError(
      "Chỉ ADMIN được xóa cưỡng bức.",
      403,
      ERROR_CODES.FORBIDDEN,
    );
  }

  console.group("[deleteAccommodation]");
  console.log("[1] input:", {
    id: accommodationId,
    force,
    role: currentUser.role,
  });

  try {
    const pool = getDBPool();

    const existsResult = await pool
      .request()
      .input("id", sql.Int, accommodationId)
      .query(`
        SELECT id
        FROM dbo.accommodations
        WHERE id = @id AND deleted_at IS NULL;
      `);

    if (existsResult.recordset.length === 0) {
      throw new AccommodationServiceError(
        "Không tìm thấy cơ sở lưu trú.",
        404,
        ERROR_CODES.NOT_FOUND,
      );
    }

    if (!force) {
      const activeRoomTypes = await pool
        .request()
        .input("id", sql.Int, accommodationId)
        .query(`
          SELECT COUNT(*) AS count
          FROM dbo.room_types
          WHERE accommodation_id = @id
            AND status = 1
            AND deleted_at IS NULL;
        `);

      if (activeRoomTypes.recordset[0].count > 0) {
        throw new AccommodationServiceError(
          "Không thể xóa cơ sở lưu trú vì còn loại phòng đang hoạt động.",
          409,
          ERROR_CODES.INVALID_STATE,
          { roomTypes: "Còn loại phòng đang hoạt động." },
        );
      }
    }

    const result = await pool
      .request()
      .input("id", sql.Int, accommodationId)
      .query(`
        UPDATE dbo.accommodations
        SET deleted_at = SYSDATETIME(),
            updated_at = SYSDATETIME()
        WHERE id = @id AND deleted_at IS NULL;
      `);

    if (result.rowsAffected[0] === 0) {
      throw new AccommodationServiceError(
        "Không tìm thấy cơ sở lưu trú.",
        404,
        ERROR_CODES.NOT_FOUND,
      );
    }

    console.log("[2] đã xóa mềm");
    return { id: accommodationId };
  } finally {
    console.groupEnd();
  }
}

/**
 * Chuyển một giá trị query thành số nguyên dương.
 *
 * Ví dụ:
 * parsePositiveInt("10", 1)     → 10
 * parsePositiveInt("abc", 1)    → 1
 * parsePositiveInt("-2", 1)     → 1
 * parsePositiveInt(undefined, 1) → 1
 *
 * Dùng cho page, limit, locationId, provinceId...
 */

function parsePositiveInt(value, defaultValue = null) {
  const number = Number.parseInt(value, 10);

  // Nếu không phải số nguyên dương,
  // trả về giá trị mặc định.
  if (!Number.isInteger(number) || number <= 0) {
    return defaultValue;
  }

  return number;
}

/**
 * Chuẩn hóa page và limit từ URL.
 *
 * Quy tắc:
 * - page nhỏ nhất là 1
 * - limit mặc định là 10
 * - limit lớn nhất là 100
 * - offset dùng để SQL biết bỏ qua bao nhiêu dòng
 */
function parsePagination(query) {
  // Nếu page sai hoặc không có thì dùng page 1.
  const page = Math.max(1, parsePositiveInt(query.page, 1));

  // Nếu limit sai hoặc không có thì dùng limit mặc định.
  const requestedLimit = parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE);

  // Không cho phép lấy quá MAX_PAGE_SIZE dòng một lần.
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit));

  // Ví dụ:
  // page = 1, limit = 10 → offset = 0
  // page = 2, limit = 10 → offset = 10
  // page = 3, limit = 10 → offset = 20
  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset,
  };
}

/**
 * Chuyển một dòng dữ liệu từ SQL Server
 * thành một object đúng Data Transfer Ojbect của frontend.
 *
 * Database:
 *   accommodation_name
 *
 * Frontend:
 *   name
 */
function mapSummaryRow(row) {
  return {
    // Thông tin cơ bản
    id: row.id,
    code: row.accommodation_code,
    name: row.accommodation_name,
    slug: row.slug,

    // Loại hình lưu trú.
    type: {
      id: row.accommodation_type_id,
      code: row.type_code,
      name: row.type_name,
    },

    // Điểm đến du lịch.
    location: {
      id: row.location_id,
      name: row.location_name,
    },

    // Tỉnh/thành.
    province: {
      id: row.province_id,
      name: row.province_name,
    },

    // Ward có thể không có dữ liệu nên cần trả null.
    ward: row.ward_id
      ? {
        id: row.ward_id,
        name: row.ward_name,
      }
      : null,

    // Thông tin hiển thị danh sách.
    addressLine: row.address_line,
    starRating: row.star_rating,
    status: row.status,

    // Ví dụ status = 1 → "Đang hoạt động".
    statusLabel: ACCOMMODATION_STATUS_LABEL[row.status] || null,

    // SQL Server trả BIT, chuyển rõ thành boolean JavaScript.
    isFeatured: Boolean(row.is_featured),

    // Nếu chưa có ảnh thì trả null,
    // frontend có thể hiển thị placeholder.
    coverImageUrl: row.cover_image_url || null,

    // COUNT từ SQL thường trả về số,
    // nhưng ép kiểu để DTO luôn ổn định.
    roomTypesCount: Number(row.room_types_count || 0),
    amenitiesCount: Number(row.amenities_count || 0),

    // Format DATETIME2 thành "YYYY-MM-DD HH:mm:ss".
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * Chuyển chuỗi CSV thành mảng số nguyên.
 *
 * Ví dụ:
 * "1,2,3" → [1, 2, 3]
 * ""       → []
 *
 * Dùng cho:
 * ?typeId=1,2
 * ?status=1,2
 */
function parseCsvInt(value, fieldName, { allowZero = false } = {}) {
  // Không có filter thì trả mảng rỗng.
  if (value === undefined || value === null || value === "") {
    return [];
  }

  // Tách chuỗi bằng dấu phẩy.
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  // Chuyển từng phần thành Number.
  const numbers = values.map((item) => Number(item));
  const minimum = allowZero ? 0 : 1;

  // status có giá trị 0 = Bản nháp, nên có thể cho phép số 0 có kiểm soát.
  const isInvalid = numbers.some(
    (number) => !Number.isInteger(number) || number < minimum,
  );

  if (isInvalid) {
    const ruleMessage = allowZero
      ? `${fieldName} phải là danh sách số nguyên không âm.`
      : `${fieldName} phải là danh sách số nguyên dương.`;

    throw new AccommodationServiceError(
      "Dữ liệu filter không hợp lệ.",
      400,
      "VALIDATION_ERROR",
      {
        [fieldName]: ruleMessage,
      },
    );
  }

  // Loại bỏ ID trùng nhau.
  return [...new Set(numbers)];
}

/**
 * Thêm điều kiện IN vào câu SQL.
 *
 * Ví dụ:
 * values = [1, 2]
 * column = "a.status"
 *
 * Kết quả:
 * a.status IN (@status0, @status1)
 */
function addCsvFilter({
  whereParts,
  params,
  column,
  values,
  parameterPrefix,
  sqlType,
}) {
  // Không có giá trị thì không thêm điều kiện.
  if (values.length === 0) {
    return;
  }

  // Tạo tên parameter cho từng giá trị.
  const placeholders = values.map((value, index) => {
    const parameterName = `${parameterPrefix}${index}`;

    // Lưu parameter để lát nữa gắn vào SQL request.
    params.push({
      name: parameterName,
      type: sqlType,
      value,
    });

    return `@${parameterName}`;
  });

  // Ví dụ kết quả:
  // a.status IN (@status0, @status1)
  whereParts.push(`${column} IN (${placeholders.join(", ")})`);
}

/**
 * Lấy danh sách accommodation từ database.
 *
 * query:
 * - q
 * - typeId
 * - locationId
 * - provinceId
 * - status
 * - isFeatured
 * - sortBy
 * - sortDir
 * - page
 * - limit
 *
 * currentUser:
 * - req.session.admin
 */
async function getAccommodationList(query = {}, currentUser = {}) {
  // Lấy connection pool tới SQL Server.
  const pool = getDBPool();
  // Đọc thông tin phân trang.
  const { page, limit, offset } = parsePagination(query);
  // Đọc các filter dạng danh sách.
  const typeIds = parseCsvInt(query.typeId, "typeId");
  // Status hợp lệ gồm 0 (draft), 1 (active), 2 (inactive).
  const statusIds = parseCsvInt(query.status, "status", { allowZero: true });

  // Đọc các filter chỉ có một ID.
  const locationId = parsePositiveInt(query.locationId);
  const provinceId = parsePositiveInt(query.provinceId);
  // Từ khóa tìm kiếm.
  const q = typeof query.q === "string" ? query.q.trim() : "";
  // isFeatured có 3 trạng thái:
  // true  → chỉ lấy nổi bật
  // false → chỉ lấy không nổi bật
  // null  → không lọc theo nổi bật
  const isFeatured =
    query.isFeatured === "true"
      ? true
      : query.isFeatured === "false"
        ? false
        : null;

  console.log("[getAccommodationList] Filter đầu vào:", {
    q: query.q ?? null,
    typeId: query.typeId ?? null,
    locationId: query.locationId ?? null,
    provinceId: query.provinceId ?? null,
    status: query.status ?? null,
    isFeatured: query.isFeatured ?? null,
    sortBy: query.sortBy ?? null,
    sortDir: query.sortDir ?? null,
    page: query.page ?? null,
    limit: query.limit ?? null,
  });

  console.log("[getAccommodationList] Filter sau khi parse:", {
    typeIds,
    statusIds,
    locationId,
    provinceId,
    isFeatured,
  });

  // Kiểm tra user hiện tại có phải ADMIN không.
  const isAdmin = currentUser.role === "ADMIN";

  // Chỉ ADMIN mới được xem dữ liệu đã xóa mềm.
  const includeDeleted = isAdmin && query.includeDeleted === "true";

  /*
   * sortBy là tên cột do frontend gửi lên.
   *
   * Không được đưa trực tiếp query.sortBy vào SQL.
   * Phải tra qua SORT_FIELD_MAP.
   */
  const requestedSortBy = String(query.sortBy || "sortOrder");

  const sortColumn =
    SORT_FIELD_MAP[requestedSortBy] || SORT_FIELD_MAP.sortOrder;

  /*
   * Chỉ chấp nhận desc.
   * Mọi giá trị khác đều dùng asc.
   */
  const sortDirection =
    String(query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  // Khi sort theo id, không thêm a.id lần thứ hai trong ORDER BY.
  // Với các cột khác, a.id giữ thứ tự ổn định khi hai dòng có cùng giá trị.
  const tieBreaker = sortColumn === "a.id" ? "" : ", a.id ASC";

  // Mảng chứa từng điều kiện WHERE.
  const whereParts = [];

  // Mảng chứa các parameter SQL.
  const params = [];

  if (!includeDeleted) {
    whereParts.push("a.deleted_at IS NULL");
  }

  if (q) {
    whereParts.push(`
            (
                a.accommodation_name LIKE @q
                OR a.accommodation_code LIKE @q
                OR a.address_line LIKE @q
            )
        `);

    params.push({
      name: "q",
      type: sql.NVarChar(255),
      value: `%${q}%`,
    });
  }

  if (locationId) {
    whereParts.push("a.location_id = @locationId");

    params.push({
      name: "locationId",
      type: sql.Int,
      value: locationId,
    });
  }

  if (provinceId) {
    whereParts.push("a.province_id = @provinceId");

    params.push({
      name: "provinceId",
      type: sql.Int,
      value: provinceId,
    });
  }

  if (isFeatured !== null) {
    whereParts.push("a.is_featured = @isFeatured");

    params.push({
      name: "isFeatured",
      type: sql.Bit,
      value: isFeatured,
    });
  }

  // Ví dụ:
  // typeIds = [1, 2]
  // → a.accommodation_type_id IN (@typeId0, @typeId1)
  addCsvFilter({
    whereParts,
    params,
    column: "a.accommodation_type_id",
    values: typeIds,
    parameterPrefix: "typeId",
    sqlType: sql.Int,
  });

  // Ví dụ:
  // statusIds = [1, 2]
  // → a.status IN (@status0, @status1)
  addCsvFilter({
    whereParts,
    params,
    column: "a.status",
    values: statusIds,
    parameterPrefix: "status",
    sqlType: sql.TinyInt,
  });

  const scope = getAccommodationScope(currentUser);
  whereParts.push(scope.condition);
  params.push(...scope.inputs);

  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join("\nAND ")}` : "";

  const selectSql = `
        SELECT 
        -- Thông tin chính của Accommodation.
        a.id, a.accommodation_code, a.accommodation_name, a.slug,

        -- Thông tin loại hình lưu trú.
        a.accommodation_type_id, t.code AS type_code, t.name AS type_name,

        -- Thông tin điểm đến.
            a.location_id, l.name AS location_name,
        
        -- Thông tin tỉnh/thành.
            a.province_id, p.name AS province_name,
        
        -- Thông tin phường/xã.
            a.ward_id, w.name AS ward_name,

        -- Các thông tin hiển thị trong danh sách.
            a.address_line, a.star_rating, a.status, a.is_featured, a.updated_at,
        
            /*
             * Lấy một ảnh đại diện.
             *
             * Ưu tiên:
             * 1. Ảnh có is_cover = 1
             * 2. sort_order nhỏ hơn
             * 3. id nhỏ hơn
             *
             * OUTER APPLY giúp mỗi accommodation
             * chỉ xuất hiện một dòng.
             */
        cover.image_url AS cover_image_url,

            /*
             * Đếm số loại phòng của accommodation.
             *
             * deleted_at IS NULL nghĩa là không đếm
             * loại phòng đã bị xóa mềm.
             */
            (
                SELECT COUNT(*)
                FROM dbo.room_types rt
                WHERE rt.accommodation_id = a.id
                  AND rt.deleted_at IS NULL
            ) AS room_types_count,

            /*
             * Đếm số tiện nghi được gán cho accommodation.
             */
            (
                SELECT COUNT(*)
                FROM dbo.accommodation_amenities aa
                WHERE aa.accommodation_id = a.id
            ) AS amenities_count

        FROM dbo.accommodations a JOIN dbo.accommodation_types t ON t.id = a.accommodation_type_id
        JOIN dbo.locations l ON l.id = a.location_id
        JOIN dbo.provinces p ON p.id = a.province_id
        LEFT JOIN dbo.wards w ON w.id = a.ward_id

        /*
         * Lấy ảnh đầu tiên phù hợp với từng accommodation.
         */
        OUTER APPLY (
            SELECT TOP 1 ai.image_url
            FROM dbo.accommodation_images ai
            WHERE ai.accommodation_id = a.id
            ORDER BY
                ai.is_cover DESC,
                ai.sort_order ASC,
                ai.id ASC
        ) cover ${whereSql}

        /*
         * whereSql được tạo từ các filter ở bước trước.
         *
         * Ví dụ:
         * WHERE a.deleted_at IS NULL
         * AND a.status IN (@status0)
         * AND a.location_id = @locationId
         */

        /*
         * sortColumn và sortDirection đã được whitelist
         * trước đó, không lấy trực tiếp từ input người dùng.
         *
         * a.id ASC là điều kiện phụ để thứ tự ổn định
         * khi hai dòng có cùng sort_order.
         */

        ORDER BY ${sortColumn} ${sortDirection}${tieBreaker}

        /*
         * Bỏ qua offset dòng đầu tiên,
         * sau đó lấy tối đa limit dòng.
         */

        OFFSET @offset ROWS

        FETCH NEXT @limit ROWS ONLY;
    `;

  const countSql = `
        SELECT COUNT(*) AS total
        FROM dbo.accommodations a

        ${whereSql};
    `;


  const dataRequest = pool.request();

  for (const param of params) {
    dataRequest.input(param.name, param.type, param.value);
  }


  dataRequest.input("offset", sql.Int, offset).input("limit", sql.Int, limit);

  const countRequest = pool.request();

  for (const param of params) {
    countRequest.input(param.name, param.type, param.value);
  }

  const [dataResult, countResult] = await Promise.all([
    dataRequest.query(selectSql),
    countRequest.query(countSql),
  ]);

  const items = dataResult.recordset.map(mapSummaryRow);

  const total = Number(countResult.recordset[0]?.total || 0);

  return {
    items,

    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

function mapDetailRow(row) {
  return {
    id: row.id,
    code: row.accommodation_code,
    name: row.accommodation_name,
    slug: row.slug,
    type: {
      id: row.accommodation_type_id,
      code: row.type_code,
      name: row.type_name,
    },

    location: {
      id: row.location_id,
      name: row.location_name,
    },

    province: {
      id: row.province_id,
      name: row.province_name,
    },

    ward: row.ward_id
      ? {
        id: row.ward_id,
        name: row.ward_name,
      }
      : null,

    addressLine: row.address_line,
    starRating: row.star_rating,
    status: row.status,
    statusLabel: ACCOMMODATION_STATUS_LABEL[row.status] || null,
    isFeatured: Boolean(row.is_featured),
    coverImageUrl: row.cover_image_url || null,

    postalCode: row.postal_code,
    latitude: row.latitude,
    longitude: row.longitude,
    directions: row.directions,
    shortDescription: row.short_description,
    description: row.description,
    phone: row.phone,
    email: row.email,
    websiteUrl: row.website_url,

    checkInTime: formatTime(row.check_in_time),
    checkOutTime: formatTime(row.check_out_time),
    checkInInstructions: row.check_in_instructions,
    houseRules: row.house_rules,
    childrenPolicy: row.children_policy,
    petPolicy: row.pet_policy,
    smokingPolicy: row.smoking_policy,

    sortOrder: row.sort_order,
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * Chuyển một dòng ảnh từ database
 * thành DTO dùng cho frontend.
 *
 * SQL dùng snake_case:
 * image_url, alt_text, is_cover
 *
 * API dùng camelCase:
 * imageUrl, altText, isCover
 */

function mapImageRow(row) {
  return {
    id: row.id,
    imageUrl: row.image_url,
    altText: row.alt_text,
    caption: row.caption,

    // SQL Server trả BIT.
    // Boolean() giúp frontend luôn nhận true hoặc false.
    isCover: Boolean(row.is_cover),

    sortOrder: row.sort_order,
  };
}

/**
 * Chuyển một dòng tiện nghi từ database
 * thành object camelCase cho frontend.
 *
 * SQL trả về các alias dạng snake_case:
 * amenity_id, category_code, is_chargeable
 *
 * API trả về các field dạng camelCase:
 * id, categoryCode, isChargeable
 */

function mapAmenityRow(row) {
  return {
    id: row.amenity_id,
    code: row.amenity_code,
    name: row.amenity_name,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    iconKey: row.icon_key,
    isChargeable: Boolean(row.is_chargeable),
    note: row.note,
  };
}

/**
 * Chuyển số mét thành chuỗi dễ đọc.
 *
 * - null → null vì chưa có khoảng cách
 * - dưới 1000m → hiển thị theo mét
 * - từ 1000m trở lên → hiển thị theo kilomet
 */

function formatDistanceText(distanceMeters) {
  if (distanceMeters === null) {
    return null;
  }

  if (distanceMeters < 1000) {
    return `${distanceMeters} m`;
  }

  const kilometers = distanceMeters / 1000;
  return `${kilometers.toFixed(1)} km`;
}

/**
 * Chuyển một dòng điểm tham quan từ database
 * thành DTO camelCase cho frontend.
 */

function mapAttractionRow(row) {
  const distanceMeters =
    row.distance_meters === null ? null : Number(row.distance_meters);
  return {
    attractionId: row.attraction_id,
    name: row.attraction_name,
    addressLine: row.address_line,
    imageUrl: row.image_url,
    isActive: Boolean(row.is_active),

    distanceMeters,

    // Frontend có thể hiển thị trực tiếp chuỗi này.
    // Ví dụ: 3500 mét → "3.5 km".
    distanceText: formatDistanceText(distanceMeters),

    note: row.note,
    sortOrder: row.sort_order,
  };
}

/**
 * Chuyển một dòng room type từ database
 * thành DTO dùng cho frontend.
 */

function mapRoomTypeRow(row) {
  return {
    id: row.room_type_id,
    code: row.room_type_code,
    name: row.room_type_name,
    status: row.room_type_status,
    statusLabel: ACCOMMODATION_STATUS_LABEL[row.room_type_status] || null,
    quantity: row.quantity,
    bedDescription: row.bed_description,
    bedroomCount: row.bedroom_count,
    areaSqm: row.area_sqm === null ? null : Number(row.area_sqm),
    includedAdults: row.included_adults,
    includedChildren: row.included_children,
    maxOccupancy: row.max_occupancy,

    // MIN(price) có thể không có nếu room type
    // chưa được tạo giá theo các ngày trong tuần.
    minPrice: row.min_price === null ? null : Number(row.min_price),

    coverImageUrl: row.cover_image_url || null,
  };
}

/**
 * Lấy thông tin chính của một cơ sở lưu trú.
 *
 * Giai đoạn này chỉ lấy bảng chính và các bảng quan hệ:
 * - accommodations
 * - accommodation_types
 * - locations
 * - provinces
 * - wards
 *
 * Ảnh gallery, tiện nghi, điểm tham quan và loại phòng
 * sẽ được thêm ở các bước học tiếp theo.
 */
async function getAccommodationDetail(id, currentUser = {}) {
  // Kiểm tra id trước khi gửi xuống database.
  // Ví dụ: "abc", 0, -1 đều không phải ID hợp lệ.
  const accommodationId = parsePositiveInt(id);
  if (!accommodationId) {
    throw new AccommodationServiceError(
      "ID cơ sở lưu trú không hợp lệ.",
      400,
      "VALIDATION_ERROR",
      { id: "ID phải là số nguyên dương." },
    );
  }

  const pool = getDBPool();
  const scope = getAccommodationScope(currentUser);
  const detailRequest = pool
    .request()
    .input("accommodationId", sql.Int, accommodationId);

  for (const input of scope.inputs) {
    detailRequest.input(input.name, input.type, input.value);
  }

  const result = await detailRequest.query(`
        SELECT
                -- Thông tin chính của accommodation.
                a.id,
                a.accommodation_code,
                a.accommodation_name,
                a.slug,
                -- Thông tin loại hình.
                a.accommodation_type_id,
                t.code AS type_code,
                t.name AS type_name,
                -- Thông tin điểm đến.
                a.location_id,
                l.name AS location_name,
                -- Thông tin tỉnh/thành.
                a.province_id,
                p.name AS province_name,
                -- Thông tin phường/xã.
                a.ward_id,
                w.name AS ward_name,
                -- Thông tin hiển thị.
                a.address_line,
                a.star_rating,
                a.status,
                a.is_featured,
                -- Thông tin chi tiết.
                a.postal_code,
                a.latitude,
                a.longitude,
                a.directions,
                a.short_description,
                a.description,
                a.phone,
                a.email,
                a.website_url,
                -- Giờ và chính sách.
                a.check_in_time,
                a.check_out_time,
                a.check_in_instructions,
                a.house_rules,
                a.children_policy,
                a.pet_policy,
                a.smoking_policy,
                -- Thứ tự và thời gian.
                a.sort_order,
                a.created_at,
                a.updated_at,
                /*
                 * Lấy một ảnh đại diện.
                 *
                 * Ưu tiên:
                 * 1. Ảnh có is_cover = 1.
                 * 2. Nếu cùng loại thì lấy sort_order nhỏ hơn.
                 * 3. Nếu vẫn trùng thì lấy id nhỏ hơn.
                 *
                 * OUTER APPLY giúp mỗi accommodation
                 * chỉ xuất hiện một dòng.
                 */
                cover.image_url AS cover_image_url
            FROM dbo.accommodations a
            JOIN dbo.accommodation_types t
                ON t.id = a.accommodation_type_id
            JOIN dbo.locations l
                ON l.id = a.location_id
            JOIN dbo.provinces p
                ON p.id = a.province_id
            LEFT JOIN dbo.wards w
                ON w.id = a.ward_id
            OUTER APPLY (
                SELECT TOP 1
                    ai.image_url
                FROM dbo.accommodation_images ai
                WHERE ai.accommodation_id = a.id
                ORDER BY
                    ai.is_cover DESC,
                    ai.sort_order ASC,
                    ai.id ASC
            ) cover
            WHERE a.id = @accommodationId
              /*
               * Không cho xem dữ liệu đã bị xóa mềm.
               * Đây là quy tắc chung của module accommodation.
               */
              AND a.deleted_at IS NULL
              AND ${scope.condition};
        `);
  /*
   * Nếu recordset rỗng nghĩa là không có accommodation
   * hoặc accommodation đã bị xóa mềm.
   */
  if (result.recordset.length == 0) {
    throw new AccommodationServiceError(
      "Không tìm thấy cơ sở lưu trú.",
      404,
      "NOT_FOUND",
    );
  }

  const row = result.recordset[0];

  /**
   * Lấy toàn bộ ảnh của accommodation.
   *
   * Đây là query thứ hai của API detail.
   * Nếu accommodation chưa có ảnh,
   * recordset sẽ là [] và đó là trạng thái hợp lệ.
   */

  const imagesResult = await pool
    .request()
    .input("accommodationId", sql.Int, accommodationId).query(`
        SELECT id, image_url, alt_text, caption, is_cover, sort_order
        FROM dbo.accommodation_images
        WHERE accommodation_id = @accommodationId
        ORDER BY is_cover DESC, sort_order ASC, id ASC
    `);

  const images = imagesResult.recordset.map(mapImageRow);

  /**
   * Lấy các tiện nghi đã gán cho accommodation.
   *
   * Nếu accommodation chưa có tiện nghi,
   * recordset sẽ là [] và đó là trạng thái hợp lệ.
   */

  const amenitiesResult = await pool
    .request()
    .input("accommodationId", sql.Int, accommodationId).query(`
        SELECT
            aa.amenity_id,
            am.code AS amenity_code,
            am.name AS amenity_name,
            am.category_code,
            ac.name AS category_name,
            am.icon_key,
            aa.is_chargeable,
            aa.note
        FROM dbo.accommodation_amenities aa
        JOIN dbo.amenities am
        ON am.id = aa.amenity_id
        LEFT JOIN dbo.amenity_categories ac
        ON ac.code = am.category_code
        WHERE aa.accommodation_id = @accommodationId
        ORDER BY
            ac.sort_order ASC,
            am.sort_order ASC,
            am.id ASC;
    `);

  const amenities = amenitiesResult.recordset.map(mapAmenityRow);

  /**
   * Lấy các điểm tham quan được gán cho accommodation.
   *
   * Nếu chưa có điểm tham quan,
   * recordset sẽ là [] và đây là trạng thái hợp lệ.
   */

  const attractionsResult = await pool
    .request()
    .input("accommodationId", sql.Int, accommodationId).query(`
        SELECT
            aa.attraction_id,
            at.name AS attraction_name,
            at.address_line,
            at.image_url,
            at.is_active,
            aa.distance_meters,
            aa.note,
            aa.sort_order
        FROM dbo.accommodation_attractions aa
        JOIN dbo.attractions at
        ON at.id = aa.attraction_id
        WHERE aa.accommodation_id = @accommodationId
        ORDER BY
            aa.sort_order ASC,
            aa.distance_meters ASC,
            at.name ASC;
    `);

  const attractions = attractionsResult.recordset.map(mapAttractionRow);

  /**
   * Lấy các loại phòng chưa bị xóa mềm.
   *
   * OUTER APPLY lấy một ảnh cover duy nhất,
   * tránh làm nhân số dòng room type.
   *
   * Subquery MIN lấy mức giá thấp nhất trong
   * các giá theo ngày của từng room type.
   */

  const roomTypesResult = await pool
    .request()
    .input("accommodationId", sql.Int, accommodationId).query(`
            SELECT
            rt.id AS room_type_id,
            rt.code AS room_type_code,
            rt.name AS room_type_name,
            rt.status AS room_type_status,
            rt.quantity,
            rt.bed_description,
            rt.bedroom_count,
            rt.area_sqm,
            rt.included_adults,
            rt.included_children,
            rt.max_occupancy,
            rates.min_price,
            cover.image_url AS cover_image_url
            FROM dbo.room_types rt
            OUTER APPLY (
                SELECT
                MIN(r.price) AS min_price
                FROM dbo.room_weekday_rates r
                WHERE r.room_type_id = rt.id
            ) rates
            OUTER APPLY (
                SELECT TOP 1 rti.image_url
                FROM dbo.room_type_images rti
                WHERE rti.room_type_id = rt.id
                ORDER BY
                    rti.is_cover DESC,
                    rti.sort_order ASC,
                    rti.id ASC
            ) cover
            WHERE rt.accommodation_id = @accommodationId
            AND rt.deleted_at IS NULL
            ORDER BY
                rt.sort_order ASC,
                rt.id ASC;
    `);

  const roomTypes = roomTypesResult.recordset.map(mapRoomTypeRow);

  /*
   * mapDetailRow() chỉ chuyển đổi tên cột SQL
   * thành object camelCase cho frontend.
   */
  const detail = mapDetailRow(row);

  // Gắn gallery vào DTO sau khi đã map dữ liệu ảnh.
  // Nếu bảng accommodation_images rỗng,
  // images vẫn là mảng [] đúng contract API.
  detail.images = images;
  detail.amenities = amenities;
  detail.attractions = attractions;
  detail.roomTypes = roomTypes;

  /*
   * Manager đang được gán cho cơ sở (mỗi cơ sở có tối đa 1 manager
   * theo assignAccommodationManager; TOP 1 + ORDER BY là bảo hiểm).
   *
   * - detail.manager: object hiển thị "Người quản lý đang phụ trách",
   *   trả cả khi tài khoản manager bị tạm khóa (status = 2).
   * - detail.hasManager: cờ R7 để FE khóa lựa chọn "Đang hoạt động",
   *   chỉ tính khi tài khoản còn hoạt động — khớp assertManagerAssigned.
   */
  const managerResult = await pool
    .request()
    .input("accommodationId", sql.Int, accommodationId)
    .query(`
        SELECT TOP 1
            u.id AS manager_user_id,
            u.full_name AS manager_full_name,
            u.email AS manager_internal_email,
            u.personal_email AS manager_personal_email,
            u.phone_number AS manager_phone_number,
            u.status AS manager_status,
            m.assigned_at AS manager_assigned_at
        FROM dbo.accommodation_managers m
        JOIN dbo.users u ON u.id = m.user_id
        WHERE m.accommodation_id = @accommodationId
        ORDER BY m.assigned_at DESC;
    `);

  const managerRow = managerResult.recordset[0] ?? null;

  detail.manager = managerRow
    ? {
        userId: managerRow.manager_user_id,
        fullName: managerRow.manager_full_name,
        internalEmail: managerRow.manager_internal_email,
        personalEmail: managerRow.manager_personal_email,
        phoneNumber: managerRow.manager_phone_number,
        status: managerRow.manager_status,
        isActive: Number(managerRow.manager_status) === 1,
        assignedAt: formatDateTime(managerRow.manager_assigned_at),
      }
    : null;

  // R7: "có Manager" chỉ đếm khi tài khoản còn hoạt động (users.status = 1).
  detail.hasManager = Boolean(detail.manager) && detail.manager.isActive;

  return detail;
}

/**
 * Lấy thống kê các cơ sở chưa bị xóa mềm.
 * ADMIN xem tất cả; manager chỉ xem cơ sở được gán.
 *
 * Đầu vào: currentUser lấy từ req.session.admin.
 * Đầu ra: object chứa các số đếm phục vụ Dashboard.
 */

async function getAccommodationStats(currentUser = {}) {
  const pool = getDBPool();
  const isAdmin = currentUser.role === "ADMIN";

  const result = await pool
    .request()
    .input("isAdmin", sql.Bit, isAdmin)
    .input("userId", sql.UniqueIdentifier, currentUser.id ?? null).query(`
        SELECT
                COUNT(*) AS total,
                COUNT(CASE WHEN a.status = 1 THEN 1 END) AS active,
                COUNT(CASE WHEN a.status = 0 THEN 1 END) AS draft,
                COUNT(CASE WHEN a.status = 2 THEN 1 END) AS inactive,
                COUNT(CASE WHEN a.is_featured = 1 THEN 1 END) AS featured,
                COUNT(cover.has_cover) AS withCoverImage,
                COUNT(
                    CASE WHEN room.has_room IS NULL THEN 1 END
                ) AS withoutRoomTypes
            FROM dbo.accommodations a
            -- Chỉ cần biết có ảnh bìa hay không.
            -- TOP 1 tránh nhân dòng khi một cơ sở có nhiều ảnh.
            OUTER APPLY (
                SELECT TOP 1 1 AS has_cover
                FROM dbo.accommodation_images ai
                WHERE ai.accommodation_id = a.id
                  AND ai.is_cover = 1
            ) cover
            -- Loại phòng đã xóa mềm không được tính.
            OUTER APPLY (
                SELECT TOP 1 1 AS has_room
                FROM dbo.room_types rt
                WHERE rt.accommodation_id = a.id
                  AND rt.deleted_at IS NULL
            ) room
            WHERE a.deleted_at IS NULL
              AND (
                  @isAdmin = 1
                  OR EXISTS (
                      SELECT 1
                      FROM dbo.accommodation_managers manager
                      WHERE manager.accommodation_id = a.id
                        AND manager.user_id = @userId
                  )
              );    
    `);

  const row = result.recordset[0];

  return {
    total: Number(row.total),
    active: Number(row.active),
    draft: Number(row.draft),
    inactive: Number(row.inactive),
    featured: Number(row.featured),
    withCoverImage: Number(row.withCoverImage),
    withoutRoomTypes: Number(row.withoutRoomTypes),
  };
}

/*
 * Export các hàm để controller có thể sử dụng.
 */
module.exports = {
  getAccommodationList,
  getAccommodationDetail,
  getAccommodationStats,
  createAccommodation,
  updateAccommodation,
  updateAccommodationStatus,
  updateAccommodationFeatured,
  deleteAccommodation,
  validateAccommodationPayload,
  resolveLocationContext,
  mapSummaryRow,
  mapDetailRow,
  mapAmenityRow,
  mapAttractionRow,
  mapRoomTypeRow,
  AccommodationServiceError,
};
