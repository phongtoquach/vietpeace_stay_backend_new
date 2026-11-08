const { getDBPool, sqlObj } = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const { getAccommodationScope, assertAccommodationAccess } = require("./accommodation_access_service");
const { moveImagesIntoRoomTypeFolder } = require("../utils/room_type_image_storage");
const {
  ROOM_TYPE_STATUS_LABEL,
  ROOM_TYPE_SORT_FIELD_MAP,
  ROOM_TYPE_DEFAULT_PAGE_SIZE,
  ROOM_TYPE_MAX_PAGE_SIZE,
} = require("../constants/room_type");

const sql = sqlObj;

// Lỗi nghiệp vụ của module room type, controller đọc statusCode/errorCode
// để trả đúng HTTP thay vì luôn 500.
class RoomTypeServiceError extends Error {
  constructor(statusCode, errorCode, message, errors = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errors = errors;
  }
}

// Đọc số nguyên dương; sai/không có thì dùng fallback.
function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(query) {
  const page = parsePositiveInt(query.page, 1);
  const requestedLimit = parsePositiveInt(query.limit, ROOM_TYPE_DEFAULT_PAGE_SIZE);
  const limit = Math.min(ROOM_TYPE_MAX_PAGE_SIZE, Math.max(1, requestedLimit));
  return { page, limit, offset: (page - 1) * limit };
}

// status=0,1,2 (CSV). Chỉ giữ số hợp lệ để tránh SQL injection.
function parseStatusList(value) {
  if (value === undefined || value === null || value === "") return [];
  return String(value)
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((number) => Number.isInteger(number) && number >= 0 && number <= 2);
}

// DTO camelCase cho frontend, không lộ tên cột SQL.
function mapRoomTypeSummary(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accommodationId: row.accommodation_id,
    accommodationName: row.accommodation_name,
    quantity: row.quantity,
    basePrice: row.base_price === null ? null : Number(row.base_price),
    areaSqm: row.area_sqm === null ? null : Number(row.area_sqm),
    bedDescription: row.bed_description,
    includedAdults: row.included_adults,
    includedChildren: row.included_children,
    maxOccupancy: row.max_occupancy,
    status: row.status,
    statusLabel: ROOM_TYPE_STATUS_LABEL[row.status] || null,
    sortOrder: row.sort_order,
    coverImageUrl: row.cover_image_url || null,
    updatedAt: row.updated_at,
  };
}

// Dựng WHERE + params dùng chung cho cả COUNT và SELECT.
// Nhờ vậy total luôn khớp đúng bộ lọc của trang hiện tại.
function buildListFilters(query, currentUser = {}) {
  const whereParts = ["rt.deleted_at IS NULL", "a.deleted_at IS NULL"];
  const params = [];

  const scope = getAccommodationScope(currentUser);
  whereParts.push(scope.condition);
  params.push(...scope.inputs);

  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q) {
    whereParts.push(
      "(rt.name LIKE @q OR rt.code LIKE @q OR rt.bed_description LIKE @q)",
    );
    params.push({ name: "q", type: sql.NVarChar(255), value: `%${q}%` });
  }

  const accommodationId = parsePositiveInt(query.accommodationId);
  if (accommodationId) {
    whereParts.push("rt.accommodation_id = @accommodationId");
    params.push({
      name: "accommodationId",
      type: sql.Int,
      value: accommodationId,
    });
  }

  const statusIds = parseStatusList(query.status);
  if (statusIds.length > 0) {
    // Chỉ tạo placeholder từ số đã validate, không nối chuỗi thô từ client.
    const placeholders = statusIds.map((value, index) => {
      const name = `status${index}`;
      params.push({ name, type: sql.TinyInt, value });
      return `@${name}`;
    });
    whereParts.push(`rt.status IN (${placeholders.join(", ")})`);
  }

  return { whereSql: `WHERE ${whereParts.join(" AND ")}`, params };
}

function bindParams(request, params) {
  params.forEach((param) => request.input(param.name, param.type, param.value));
  return request;
}

async function getRoomTypeList(query = {}, currentUser = {}) {
  console.group("[getRoomTypeList]");

  try {
    const { page, limit, offset } = parsePagination(query);

    const requestedSortBy = String(query.sortBy || "sortOrder");
    const sortColumn =
      ROOM_TYPE_SORT_FIELD_MAP[requestedSortBy] ||
      ROOM_TYPE_SORT_FIELD_MAP.sortOrder;
    const sortDirection =
      String(query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    // Thêm tie-breaker để thứ tự ổn định khi hai dòng cùng giá trị sort.
    const tieBreaker = sortColumn === "rt.id" ? "" : ", rt.id ASC";

    const { whereSql, params } = buildListFilters(query, currentUser);

    console.log("[1] filter:", {
      q: query.q || null,
      accommodationId: query.accommodationId || null,
      status: query.status || null,
      page,
      limit,
      sortBy: requestedSortBy,
      sortDir: sortDirection,
    });

    const pool = getDBPool();

    const countRequest = bindParams(pool.request(), params);
    const countResult = await countRequest.query(`
      SELECT COUNT(*) AS total
      FROM dbo.room_types rt
      JOIN dbo.accommodations a ON a.id = rt.accommodation_id
      ${whereSql};
    `);

    const listRequest = bindParams(pool.request(), params);
    listRequest.input("offset", sql.Int, offset);
    listRequest.input("limit", sql.Int, limit);

    const listResult = await listRequest.query(`
      SELECT
        rt.id,
        rt.accommodation_id,
        a.accommodation_name,
        rt.code,
        rt.name,
        rt.quantity,
        rt.base_price,
        rt.area_sqm,
        rt.bed_description,
        rt.included_adults,
        rt.included_children,
        rt.max_occupancy,
        rt.status,
        rt.sort_order,
        rt.updated_at,
        cover.image_url AS cover_image_url
      FROM dbo.room_types rt
      JOIN dbo.accommodations a ON a.id = rt.accommodation_id
      OUTER APPLY (
        SELECT TOP 1 rti.image_url
        FROM dbo.room_type_images rti
        WHERE rti.room_type_id = rt.id
        ORDER BY rti.is_cover DESC, rti.sort_order ASC, rti.id ASC
      ) cover
      ${whereSql}
      ORDER BY ${sortColumn} ${sortDirection}${tieBreaker}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

    const items = listResult.recordset.map(mapRoomTypeSummary);
    const total = Number(countResult.recordset[0]?.total || 0);

    console.log("[2] kết quả:", {
      total,
      pageItems: items.length,
      firstId: items[0]?.id ?? null,
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  } finally {
    console.groupEnd();
  }
}

// DTO chi tiết: trả đủ field DB để form Sửa hiển thị không cần mock.
function mapRoomTypeDetailRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortDescription: row.short_description,
    description: row.description,
    accommodationId: row.accommodation_id,
    accommodationName: row.accommodation_name,
    accommodationCode: row.accommodation_code,
    quantity: row.quantity,
    basePrice: Number(row.base_price),
    areaSqm: row.area_sqm === null ? null : Number(row.area_sqm),
    bedDescription: row.bed_description,
    bedroomCount: row.bedroom_count,
    bathroomCount: row.bathroom_count,
    includedAdults: row.included_adults,
    includedChildren: row.included_children,
    maxAdults: row.max_adults,
    maxChildren: row.max_children,
    maxOccupancy: row.max_occupancy,
    extraAdultFee: Number(row.extra_adult_fee),
    extraChildFee: Number(row.extra_child_fee),
    status: row.status,
    statusLabel: ROOM_TYPE_STATUS_LABEL[row.status] || null,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoomTypeImageRow(row) {
  return {
    id: row.id,
    imageUrl: row.image_url,
    altText: row.alt_text,
    caption: row.caption,
    isCover: Boolean(row.is_cover),
    sortOrder: row.sort_order,
  };
}

function mapRoomTypeAmenityRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    amenityScope: row.amenity_scope,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    iconKey: row.icon_key,
    description: row.description,
    isChargeable: Boolean(row.is_chargeable),
    note: row.note,
  };
}

function mapRoomTypeRateRow(row) {
  return {
    dayOfWeek: row.day_of_week,
    price: Number(row.price),
  };
}

async function getRoomTypeDetail(id, currentUser = {}) {
  console.group("[getRoomTypeDetail]");

  try {
    const roomTypeId = parsePositiveInt(id);
    if (!roomTypeId) {
      throw new RoomTypeServiceError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        "ID loại phòng không hợp lệ.",
        { id: "ID phải là số nguyên dương." },
      );
    }

    console.log("[1] id:", roomTypeId);

    const pool = getDBPool();
    const scope = getAccommodationScope(currentUser);
    const scopeSql = `AND ${scope.condition}`;
    const mainRequest = pool.request().input("id", sql.Int, roomTypeId);

    for (const input of scope.inputs) {
      mainRequest.input(input.name, input.type, input.value);
    }

    const mainResult = await mainRequest.query(`
        SELECT
          rt.id,
          rt.accommodation_id,
          a.accommodation_name,
          a.accommodation_code,
          rt.code,
          rt.name,
          rt.short_description,
          rt.description,
          rt.quantity,
          rt.base_price,
          rt.area_sqm,
          rt.bed_description,
          rt.bedroom_count,
          rt.bathroom_count,
          rt.included_adults,
          rt.included_children,
          rt.max_adults,
          rt.max_children,
          rt.max_occupancy,
          rt.extra_adult_fee,
          rt.extra_child_fee,
          rt.status,
          rt.sort_order,
          rt.created_at,
          rt.updated_at
        FROM dbo.room_types rt
        JOIN dbo.accommodations a ON a.id = rt.accommodation_id
        WHERE rt.id = @id
          AND rt.deleted_at IS NULL
          AND a.deleted_at IS NULL
          ${scopeSql};
      `);

    if (mainResult.recordset.length === 0) {
      throw new RoomTypeServiceError(
        404,
        ERROR_CODES.NOT_FOUND,
        "Không tìm thấy loại phòng.",
      );
    }

    const imagesResult = await pool
      .request()
      .input("id", sql.Int, roomTypeId)
      .query(`
        SELECT id, image_url, alt_text, caption, is_cover, sort_order
        FROM dbo.room_type_images
        WHERE room_type_id = @id
        ORDER BY is_cover DESC, sort_order ASC, id ASC;
      `);

    const amenitiesResult = await pool
      .request()
      .input("id", sql.Int, roomTypeId)
      .query(`
        SELECT
          am.id,
          am.code,
          am.name,
          am.amenity_scope,
          am.category_code,
          ac.name AS category_name,
          am.icon_key,
          am.description,
          rta.is_chargeable,
          rta.note
        FROM dbo.room_type_amenities rta
        JOIN dbo.amenities am ON am.id = rta.amenity_id
        LEFT JOIN dbo.amenity_categories ac ON ac.code = am.category_code
        WHERE rta.room_type_id = @id
        ORDER BY ac.sort_order, am.sort_order, am.id;
      `);

    const ratesResult = await pool
      .request()
      .input("id", sql.Int, roomTypeId)
      .query(`
        SELECT day_of_week, price
        FROM dbo.room_weekday_rates
        WHERE room_type_id = @id
        ORDER BY day_of_week ASC;
      `);

    const detail = {
      ...mapRoomTypeDetailRow(mainResult.recordset[0]),
      images: imagesResult.recordset.map(mapRoomTypeImageRow),
      amenities: amenitiesResult.recordset.map(mapRoomTypeAmenityRow),
      weekdayRates: ratesResult.recordset.map(mapRoomTypeRateRow),
    };

    console.log("[2] kết quả:", {
      id: detail.id,
      images: detail.images.length,
      amenities: detail.amenities.length,
      weekdayRates: detail.weekdayRates.length,
    });

    return detail;
  } finally {
    console.groupEnd();
  }
}

/* ============================================================
 * WRITE APIs: validate + create/update/delete
 * ============================================================ */

function validationError(errors) {
  return new RoomTypeServiceError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    "Dữ liệu không hợp lệ.",
    errors,
  );
}

function readRoomTypeString(
  raw,
  { required = false, requiredMessage = "Vui lòng nhập giá trị.", max = null } = {},
) {
  if (raw === undefined || raw === null) {
    return required ? { error: requiredMessage } : { value: null };
  }
  if (typeof raw !== "string") {
    return { error: "Giá trị phải là chuỗi." };
  }

  const value = raw.trim();
  if (required && value.length === 0) return { error: requiredMessage };
  if (!required && value.length === 0) return { value: null };
  if (max !== null && value.length > max) {
    return { error: `Tối đa ${max} ký tự.` };
  }

  return { value };
}

function readRoomTypeInt(
  raw,
  { required = false, requiredMessage = "Vui lòng nhập số nguyên.", min = null, max = null } = {},
) {
  if (raw === undefined || raw === null || raw === "") {
    return required ? { error: requiredMessage } : { value: null };
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) return { error: "Giá trị phải là số nguyên." };
  if (min !== null && value < min) {
    return { error: `Giá trị phải lớn hơn hoặc bằng ${min}.` };
  }
  if (max !== null && value > max) {
    return { error: `Giá trị phải nhỏ hơn hoặc bằng ${max}.` };
  }

  return { value };
}

function readRoomTypeNumber(
  raw,
  { required = false, requiredMessage = "Vui lòng nhập số.", min = null } = {},
) {
  if (raw === undefined || raw === null || raw === "") {
    return required ? { error: requiredMessage } : { value: null };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: "Giá trị phải là số." };
  if (min !== null && value < min) {
    return { error: `Giá trị phải lớn hơn hoặc bằng ${min}.` };
  }

  return { value };
}

function validateRoomTypeImages(raw, errors) {
  if (!Array.isArray(raw)) {
    errors.images = "Danh sách ảnh không hợp lệ.";
    return undefined;
  }
  if (raw.length > 30) {
    errors.images = "Tối đa 30 ảnh cho mỗi loại phòng.";
  }

  let coverCount = 0;
  const images = [];

  raw.forEach((item, index) => {
    const imageUrl = typeof item?.imageUrl === "string" ? item.imageUrl.trim() : "";
    if (!imageUrl) {
      errors.images = `Ảnh #${index + 1} thiếu URL.`;
      return;
    }
    if (imageUrl.length > 1000) {
      errors.images = `URL ảnh #${index + 1} tối đa 1000 ký tự.`;
      return;
    }

    const isCover = item?.isCover === true;
    if (isCover) coverCount += 1;

    const sortOrder = Number(item?.sortOrder);
    images.push({
      imageUrl,
      altText:
        typeof item?.altText === "string" ? item.altText.trim() || null : null,
      caption:
        typeof item?.caption === "string" ? item.caption.trim() || null : null,
      isCover,
      sortOrder: Number.isInteger(sortOrder) && sortOrder >= 0 ? sortOrder : index,
    });
  });

  if (coverCount > 1) {
    errors.images = "Chỉ được chọn 1 ảnh bìa.";
  }
  // Nếu client không đánh dấu ảnh bìa, ảnh đầu tiên làm ảnh bìa.
  if (coverCount === 0 && images.length > 0) {
    images[0].isCover = true;
  }

  return images;
}

function validateRoomTypeAmenities(raw, errors) {
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

function validateRoomTypeWeekdayRates(raw, errors, isCreate) {
  if (!Array.isArray(raw)) {
    if (isCreate) {
      errors.weekdayRates = "Vui lòng nhập đủ 7 mức giá cho 7 ngày trong tuần.";
    }
    return undefined;
  }

  if (raw.length !== 7) {
    errors.weekdayRates = "Cần đúng 7 mức giá cho 7 ngày trong tuần.";
  }

  const seen = new Set();
  const rates = [];

  for (const item of raw) {
    const dayOfWeek = Number(item?.dayOfWeek);
    const price = Number(item?.price);

    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      errors.weekdayRates = "Ngày trong tuần phải từ 1 đến 7.";
      continue;
    }
    if (seen.has(dayOfWeek)) {
      errors.weekdayRates = `Ngày ${dayOfWeek} bị trùng.`;
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      errors.weekdayRates = `Giá ngày ${dayOfWeek} phải lớn hơn 0.`;
      continue;
    }

    seen.add(dayOfWeek);
    rates.push({ dayOfWeek, price });
  }

  if (isCreate && seen.size !== 7) {
    errors.weekdayRates = "Cần đủ 7 ngày trong tuần.";
  }

  return rates;
}

// Các ràng buộc chéo giống CHECK constraint của bảng room_types.
function validateRoomTypeCapacityRules(values, errors) {
  const {
    includedAdults,
    includedChildren,
    maxAdults,
    maxChildren,
    maxOccupancy,
  } = values;

  const numbers = [
    includedAdults,
    includedChildren,
    maxAdults,
    maxChildren,
    maxOccupancy,
  ];
  if (!numbers.every((value) => Number.isInteger(value))) return;

  if (includedAdults > maxAdults) {
    errors.includedAdults =
      "Số người lớn tiêu chuẩn không được lớn hơn số người lớn tối đa.";
  }
  if (includedChildren > maxChildren) {
    errors.includedChildren =
      "Số trẻ em tiêu chuẩn không được lớn hơn số trẻ em tối đa.";
  }
  if (maxAdults > maxOccupancy) {
    errors.maxAdults =
      "Số người lớn tối đa không được lớn hơn sức chứa tối đa.";
  }
  if (maxChildren > maxOccupancy) {
    errors.maxChildren =
      "Số trẻ em tối đa không được lớn hơn sức chứa tối đa.";
  }
  if (includedAdults + includedChildren > maxOccupancy) {
    errors.maxOccupancy =
      "Số khách tiêu chuẩn không được lớn hơn sức chứa tối đa.";
  }
  if (maxAdults + maxChildren < maxOccupancy) {
    errors.maxOccupancy =
      "Tổng giới hạn người lớn và trẻ em phải lớn hơn hoặc bằng sức chứa tối đa.";
  }
}

/**
 * Chuẩn hoá + validate payload room type.
 * Create: bắt buộc các field chính và đúng 7 giá tuần.
 * Update: chỉ validate field có mặt.
 */
function validateRoomTypePayload(body = {}, { isCreate = false } = {}) {
  const values = {};
  const errors = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

  const apply = (field, result) => {
    if (result.error) errors[field] = result.error;
    else values[field] = result.value;
  };

  if (has("accommodationId") || isCreate) {
    apply(
      "accommodationId",
      readRoomTypeInt(body.accommodationId, {
        required: true,
        requiredMessage: "Vui lòng chọn cơ sở lưu trú.",
        min: 1,
      }),
    );
  }

  if (has("code") || isCreate) {
    const result = readRoomTypeString(body.code, {
      required: true,
      requiredMessage: "Vui lòng nhập mã loại phòng.",
      max: 255,
    });
    if (result.error) {
      errors.code = result.error;
    } else if (!/^[A-Za-z0-9._-]+$/.test(result.value)) {
      errors.code =
        "Mã loại phòng chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang.";
    } else {
      values.code = result.value;
    }
  }

  if (has("name") || isCreate) {
    apply(
      "name",
      readRoomTypeString(body.name, {
        required: true,
        requiredMessage: "Vui lòng nhập tên loại phòng.",
        max: 255,
      }),
    );
  }

  [
    ["shortDescription", 1000],
    ["description", null],
    ["bedDescription", 500],
  ].forEach(([field, max]) => {
    if (has(field)) {
      apply(field, readRoomTypeString(body[field], { max }));
    }
  });

  [
    ["quantity", { required: true, requiredMessage: "Vui lòng nhập số phòng.", min: 1 }],
    ["bedroomCount", { min: 0 }],
    ["bathroomCount", { min: 0 }],
    ["includedAdults", { required: true, requiredMessage: "Vui lòng nhập số người lớn tiêu chuẩn.", min: 1 }],
    ["includedChildren", { min: 0 }],
    ["maxAdults", { required: true, requiredMessage: "Vui lòng nhập số người lớn tối đa.", min: 1 }],
    ["maxChildren", { min: 0 }],
    ["maxOccupancy", { required: true, requiredMessage: "Vui lòng nhập sức chứa tối đa.", min: 1 }],
    ["sortOrder", { min: 0 }],
  ].forEach(([field, options]) => {
    if (has(field) || (isCreate && options.required)) {
      apply(field, readRoomTypeInt(body[field], options));
    }
  });

  [
    ["basePrice", { required: true, requiredMessage: "Vui lòng nhập giá gốc.", min: 0.01 }],
    ["areaSqm", { min: 0.01 }],
    ["extraAdultFee", { min: 0 }],
    ["extraChildFee", { min: 0 }],
  ].forEach(([field, options]) => {
    if (has(field) || (isCreate && options.required)) {
      apply(field, readRoomTypeNumber(body[field], options));
    }
  });

  if (has("status") || isCreate) {
    const result = readRoomTypeInt(body.status, { min: 0, max: 2 });
    if (result.error) {
      errors.status = "Trạng thái phải là 0, 1 hoặc 2.";
    } else {
      values.status = result.value ?? 0;
    }
  }

  if (has("images")) {
    values.images = validateRoomTypeImages(body.images, errors);
  }
  if (has("amenities")) {
    values.amenities = validateRoomTypeAmenities(body.amenities, errors);
  }
  if (has("weekdayRates") || isCreate) {
    values.weekdayRates = validateRoomTypeWeekdayRates(
      body.weekdayRates,
      errors,
      isCreate,
    );
  }

  if (isCreate) {
    values.shortDescription ??= null;
    values.description ??= null;
    values.bedDescription ??= null;
    values.areaSqm ??= null;
    values.bedroomCount ??= 1;
    values.bathroomCount ??= 1;
    values.includedChildren ??= 0;
    values.maxChildren ??= 0;
    values.extraAdultFee ??= 0;
    values.extraChildFee ??= 0;
    values.sortOrder ??= 0;
    values.status ??= 0;
    values.images ??= [];
    values.amenities ??= [];
  }

  if (isCreate) {
    validateRoomTypeCapacityRules(values, errors);
  }

  if (Object.keys(errors).length > 0) {
    throw validationError(errors);
  }

  return values;
}

async function assertRoomTypeCodeAvailable(accommodationId, code, excludeId = null) {
  // Không lọc deleted_at vì UNIQUE constraint của DB vẫn tính bản ghi đã xóa mềm.
  const result = await getDBPool()
    .request()
    .input("accommodationId", sql.Int, accommodationId)
    .input("code", sql.VarChar(255), code)
    .input("excludeId", sql.Int, excludeId)
    .query(`
      SELECT TOP 1 id
      FROM dbo.room_types
      WHERE accommodation_id = @accommodationId
        AND code = @code
        AND (@excludeId IS NULL OR id <> @excludeId);
    `);

  if (result.recordset.length > 0) {
    throw new RoomTypeServiceError(
      409,
      ERROR_CODES.DUPLICATE_CODE,
      "Dữ liệu không hợp lệ.",
      { code: "Mã loại phòng đã tồn tại trong cơ sở này." },
    );
  }
}

function mapRoomTypeSqlError(error) {
  if (error instanceof RoomTypeServiceError) return error;

  if (error.number === 2627 || error.number === 2601) {
    return new RoomTypeServiceError(
      409,
      ERROR_CODES.DUPLICATE_CODE,
      "Dữ liệu không hợp lệ.",
      { code: "Mã loại phòng đã tồn tại trong cơ sở này." },
    );
  }

  if (error.number === 547) {
    return validationError({
      amenities: "Dữ liệu tham chiếu không hợp lệ (khóa ngoại).",
    });
  }

  return error;
}

async function replaceRoomTypeImages(transaction, roomTypeId, images = []) {
  await new sql.Request(transaction)
    .input("roomTypeId", sql.Int, roomTypeId)
    .query(`DELETE FROM dbo.room_type_images WHERE room_type_id = @roomTypeId;`);

  if (images.length === 0) return;

  for (const image of images) {
    await new sql.Request(transaction)
      .input("roomTypeId", sql.Int, roomTypeId)
      .input("imageUrl", sql.NVarChar(1000), image.imageUrl)
      .input("altText", sql.NVarChar(250), image.altText)
      .input("caption", sql.NVarChar(500), image.caption)
      .input("isCover", sql.Bit, image.isCover)
      .input("sortOrder", sql.Int, image.sortOrder)
      .query(`
        INSERT INTO dbo.room_type_images
          (room_type_id, image_url, alt_text, caption, is_cover, sort_order)
        VALUES
          (@roomTypeId, @imageUrl, @altText, @caption, @isCover, @sortOrder);
      `);
  }
}

async function replaceRoomTypeAmenities(transaction, roomTypeId, amenities = []) {
  await new sql.Request(transaction)
    .input("roomTypeId", sql.Int, roomTypeId)
    .query(`DELETE FROM dbo.room_type_amenities WHERE room_type_id = @roomTypeId;`);

  if (amenities.length === 0) return;

  const checkRequest = new sql.Request(transaction);
  amenities.forEach((item, index) => {
    checkRequest.input(`amenityId${index}`, sql.Int, item.amenityId);
  });
  const parameterList = amenities
    .map((_, index) => `@amenityId${index}`)
    .join(", ");

  const checkResult = await checkRequest.query(`
    SELECT id
    FROM dbo.amenities
    WHERE id IN (${parameterList})
      AND is_active = 1
      AND amenity_scope IN ('room', 'both');
  `);

  const validIds = new Set(checkResult.recordset.map((row) => row.id));
  const invalidIds = amenities
    .filter((item) => !validIds.has(item.amenityId))
    .map((item) => item.amenityId);

  if (invalidIds.length > 0) {
    throw validationError({
      amenities: `Tiện nghi không hợp lệ hoặc không áp dụng cho loại phòng: ${invalidIds.join(", ")}.`,
    });
  }

  for (const item of amenities) {
    await new sql.Request(transaction)
      .input("roomTypeId", sql.Int, roomTypeId)
      .input("amenityId", sql.Int, item.amenityId)
      .input("isChargeable", sql.Bit, item.isChargeable)
      .input("note", sql.NVarChar(1000), item.note)
      .query(`
        INSERT INTO dbo.room_type_amenities
          (room_type_id, amenity_id, is_chargeable, note)
        VALUES
          (@roomTypeId, @amenityId, @isChargeable, @note);
      `);
  }
}

async function replaceRoomTypeWeekdayRates(transaction, roomTypeId, rates = []) {
  await new sql.Request(transaction)
    .input("roomTypeId", sql.Int, roomTypeId)
    .query(`DELETE FROM dbo.room_weekday_rates WHERE room_type_id = @roomTypeId;`);

  for (const rate of rates) {
    await new sql.Request(transaction)
      .input("roomTypeId", sql.Int, roomTypeId)
      .input("dayOfWeek", sql.TinyInt, rate.dayOfWeek)
      .input("price", sql.Decimal(18, 2), rate.price)
      .query(`
        INSERT INTO dbo.room_weekday_rates
          (room_type_id, day_of_week, price)
        VALUES
          (@roomTypeId, @dayOfWeek, @price);
      `);
  }
}

async function createRoomType(body = {}, currentUser = {}) {
  console.group("[createRoomType]");

  try {
    const values = validateRoomTypePayload(body, { isCreate: true });
    console.log("[1] payload hợp lệ:", Object.keys(values));

    await assertAccommodationAccess(values.accommodationId, currentUser);
    await assertRoomTypeCodeAvailable(values.accommodationId, values.code);

    const pool = getDBPool();
    const scope = getAccommodationScope(currentUser);
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    let newId;

    try {
      const insertRequest = new sql.Request(transaction)
        .input("accommodationId", sql.Int, values.accommodationId)
        .input("code", sql.VarChar(255), values.code)
        .input("name", sql.NVarChar(255), values.name)
        .input("shortDescription", sql.NVarChar(1000), values.shortDescription)
        .input("description", sql.NVarChar(sql.MAX), values.description)
        .input("quantity", sql.Int, values.quantity)
        .input("basePrice", sql.Decimal(18, 2), values.basePrice)
        .input("areaSqm", sql.Decimal(8, 2), values.areaSqm)
        .input("bedDescription", sql.NVarChar(500), values.bedDescription)
        .input("bedroomCount", sql.SmallInt, values.bedroomCount)
        .input("bathroomCount", sql.SmallInt, values.bathroomCount)
        .input("includedAdults", sql.Int, values.includedAdults)
        .input("includedChildren", sql.Int, values.includedChildren)
        .input("maxAdults", sql.Int, values.maxAdults)
        .input("maxChildren", sql.Int, values.maxChildren)
        .input("maxOccupancy", sql.Int, values.maxOccupancy)
        .input("extraAdultFee", sql.Decimal(18, 2), values.extraAdultFee)
        .input("extraChildFee", sql.Decimal(18, 2), values.extraChildFee)
        .input("status", sql.TinyInt, values.status)
        .input("sortOrder", sql.Int, values.sortOrder);

      for (const input of scope.inputs) {
        insertRequest.input(input.name, input.type, input.value);
      }

      const insertResult = await insertRequest.query(`
          INSERT INTO dbo.room_types (
            accommodation_id, code, name, short_description, description,
            quantity, base_price, area_sqm, bed_description,
            bedroom_count, bathroom_count,
            included_adults, included_children, max_adults, max_children, max_occupancy,
            extra_adult_fee, extra_child_fee, status, sort_order
          )
          OUTPUT INSERTED.id
          SELECT
            @accommodationId, @code, @name, @shortDescription, @description,
            @quantity, @basePrice, @areaSqm, @bedDescription,
            @bedroomCount, @bathroomCount,
            @includedAdults, @includedChildren, @maxAdults, @maxChildren, @maxOccupancy,
            @extraAdultFee, @extraChildFee, @status, @sortOrder
          WHERE EXISTS (
            SELECT 1
            FROM dbo.accommodations a
            WHERE a.id = @accommodationId
              AND a.deleted_at IS NULL
              AND ${scope.condition}
          );
        `);

      newId = insertResult.recordset[0]?.id;
      if (!newId) {
        throw new RoomTypeServiceError(
          404,
          ERROR_CODES.NOT_FOUND,
          "Không tìm thấy cơ sở lưu trú.",
        );
      }

      await replaceRoomTypeImages(transaction, newId, values.images);
      await replaceRoomTypeAmenities(transaction, newId, values.amenities);
      await replaceRoomTypeWeekdayRates(transaction, newId, values.weekdayRates || []);

      await transaction.commit();
      console.log("[2] đã commit, id:", newId);
    } catch (error) {
      await transaction.rollback();
      throw mapRoomTypeSqlError(error);
    }

    /* Ảnh upload trước khi có id nằm ở folder phẳng → chuyển vào folder id. */
    try {
      await moveImagesIntoRoomTypeFolder(
        newId,
        (values.images ?? []).map((image) => image.imageUrl),
      );
    } catch (error) {
      console.error("[2.1] không thể chuyển ảnh vào folder id:", error.message);
    }

    return await getRoomTypeDetail(newId, currentUser);
  } finally {
    console.groupEnd();
  }
}

async function updateRoomType(id, body = {}, currentUser = {}) {
  const roomTypeId = parsePositiveInt(id);
  if (!roomTypeId) {
    throw validationError({
      id: "ID phải là số nguyên dương.",
    });
  }

  console.group("[updateRoomType]");

  try {
    const current = await getRoomTypeDetail(roomTypeId, currentUser);
    const values = validateRoomTypePayload(body, { isCreate: false });

    // Policy P2: manager chỉ quản lý room type trong cơ sở được gán, không
    // được chuyển room type sang cơ sở khác. ADMIN được reassign toàn hệ thống.
    // Chặn ngay sau khi đọc current (đã qua scope → 404 nếu ngoài scope) và
    // trước các bước DB, không tạo existence oracle vì room type thuộc scope.
    if (
      currentUser.role !== "ADMIN" &&
      values.accommodationId !== undefined &&
      values.accommodationId !== current.accommodationId
    ) {
      throw new RoomTypeServiceError(
        403,
        ERROR_CODES.FORBIDDEN,
        "Bạn không có quyền chuyển loại phòng sang cơ sở lưu trú khác.",
        { accommodationId: "Không thể đổi cơ sở lưu trú của loại phòng." },
      );
    }

    const pick = (field, fallback) =>
      values[field] !== undefined ? values[field] : fallback;

    const merged = {
      accommodationId: pick("accommodationId", current.accommodationId),
      code: pick("code", current.code),
      name: pick("name", current.name),
      shortDescription: pick("shortDescription", current.shortDescription),
      description: pick("description", current.description),
      quantity: pick("quantity", current.quantity) ?? current.quantity,
      basePrice: pick("basePrice", current.basePrice),
      areaSqm: pick("areaSqm", current.areaSqm),
      bedDescription: pick("bedDescription", current.bedDescription),
      bedroomCount: pick("bedroomCount", current.bedroomCount) ?? current.bedroomCount,
      bathroomCount: pick("bathroomCount", current.bathroomCount) ?? current.bathroomCount,
      includedAdults: pick("includedAdults", current.includedAdults) ?? current.includedAdults,
      includedChildren: pick("includedChildren", current.includedChildren) ?? current.includedChildren,
      maxAdults: pick("maxAdults", current.maxAdults) ?? current.maxAdults,
      maxChildren: pick("maxChildren", current.maxChildren) ?? current.maxChildren,
      maxOccupancy: pick("maxOccupancy", current.maxOccupancy) ?? current.maxOccupancy,
      extraAdultFee: pick("extraAdultFee", current.extraAdultFee) ?? current.extraAdultFee,
      extraChildFee: pick("extraChildFee", current.extraChildFee) ?? current.extraChildFee,
      status: pick("status", current.status) ?? current.status,
      sortOrder: pick("sortOrder", current.sortOrder) ?? current.sortOrder,
    };

    const errors = {};
    validateRoomTypeCapacityRules(merged, errors);
    if (Object.keys(errors).length > 0) {
      throw validationError(errors);
    }

    await assertAccommodationAccess(merged.accommodationId, currentUser);
    await assertRoomTypeCodeAvailable(
      merged.accommodationId,
      merged.code,
      roomTypeId,
    );

    const pool = getDBPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    try {
      const currentScope = getAccommodationScope(currentUser, "rtaccom");
      const destinationScope = getAccommodationScope(currentUser, "dest");
      const updateRequest = new sql.Request(transaction)
        .input("id", sql.Int, roomTypeId)
        .input("accommodationId", sql.Int, merged.accommodationId)
        .input("code", sql.VarChar(255), merged.code)
        .input("name", sql.NVarChar(255), merged.name)
        .input("shortDescription", sql.NVarChar(1000), merged.shortDescription)
        .input("description", sql.NVarChar(sql.MAX), merged.description)
        .input("quantity", sql.Int, merged.quantity)
        .input("basePrice", sql.Decimal(18, 2), merged.basePrice)
        .input("areaSqm", sql.Decimal(8, 2), merged.areaSqm)
        .input("bedDescription", sql.NVarChar(500), merged.bedDescription)
        .input("bedroomCount", sql.SmallInt, merged.bedroomCount)
        .input("bathroomCount", sql.SmallInt, merged.bathroomCount)
        .input("includedAdults", sql.Int, merged.includedAdults)
        .input("includedChildren", sql.Int, merged.includedChildren)
        .input("maxAdults", sql.Int, merged.maxAdults)
        .input("maxChildren", sql.Int, merged.maxChildren)
        .input("maxOccupancy", sql.Int, merged.maxOccupancy)
        .input("extraAdultFee", sql.Decimal(18, 2), merged.extraAdultFee)
        .input("extraChildFee", sql.Decimal(18, 2), merged.extraChildFee)
        .input("status", sql.TinyInt, merged.status)
        .input("sortOrder", sql.Int, merged.sortOrder);

      for (const input of currentScope.inputs) {
        updateRequest.input(input.name, input.type, input.value);
      }

      const updateResult = await updateRequest.query(`
          UPDATE rt
          SET accommodation_id = @accommodationId,
              code = @code,
              name = @name,
              short_description = @shortDescription,
              description = @description,
              quantity = @quantity,
              base_price = @basePrice,
              area_sqm = @areaSqm,
              bed_description = @bedDescription,
              bedroom_count = @bedroomCount,
              bathroom_count = @bathroomCount,
              included_adults = @includedAdults,
              included_children = @includedChildren,
              max_adults = @maxAdults,
              max_children = @maxChildren,
              max_occupancy = @maxOccupancy,
              extra_adult_fee = @extraAdultFee,
              extra_child_fee = @extraChildFee,
              status = @status,
              sort_order = @sortOrder,
              updated_at = SYSDATETIME()
          FROM dbo.room_types rt
          JOIN dbo.accommodations rtaccom
            ON rtaccom.id = rt.accommodation_id
          WHERE rt.id = @id
            AND rt.deleted_at IS NULL
            AND rtaccom.deleted_at IS NULL
            AND ${currentScope.condition}
            AND EXISTS (
              SELECT 1
              FROM dbo.accommodations dest
              WHERE dest.id = @accommodationId
                AND dest.deleted_at IS NULL
                AND ${destinationScope.condition}
            );
        `);

      if (!updateResult.rowsAffected[0]) {
        throw new RoomTypeServiceError(
          404,
          ERROR_CODES.NOT_FOUND,
          "Không tìm thấy loại phòng.",
        );
      }

      if (values.images !== undefined) {
        await replaceRoomTypeImages(transaction, roomTypeId, values.images);
      }
      if (values.amenities !== undefined) {
        await replaceRoomTypeAmenities(transaction, roomTypeId, values.amenities);
      }
      if (values.weekdayRates !== undefined) {
        await replaceRoomTypeWeekdayRates(
          transaction,
          roomTypeId,
          values.weekdayRates || [],
        );
      }

      await transaction.commit();
      console.log("[1] đã cập nhật id:", roomTypeId);
    } catch (error) {
      await transaction.rollback();
      throw mapRoomTypeSqlError(error);
    }

    /* Ảnh mới upload khi sửa cũng phải nằm trong folder theo id. */
    if (values.images !== undefined) {
      try {
        await moveImagesIntoRoomTypeFolder(
          roomTypeId,
          (values.images ?? []).map((image) => image.imageUrl),
        );
      } catch (error) {
        console.error("[2] không thể chuyển ảnh vào folder id:", error.message);
      }
    }

    return await getRoomTypeDetail(roomTypeId, currentUser);
  } finally {
    console.groupEnd();
  }
}

async function deleteRoomType(id, currentUser = {}) {
  const roomTypeId = parsePositiveInt(id);
  if (!roomTypeId) {
    throw validationError({
      id: "ID phải là số nguyên dương.",
    });
  }

  // Scope theo role: ADMIN bypass ownership, manager chỉ xóa được room type
  // thuộc accommodation có bản ghi assignment trong dbo.accommodation_managers.
  // Điều kiện scope nằm ngay trong UPDATE để tránh check-then-act.
  const scope = getAccommodationScope(currentUser, "a");

  const request = getDBPool()
    .request()
    .input("id", sql.Int, roomTypeId);

  for (const input of scope.inputs) {
    request.input(input.name, input.type, input.value);
  }

  const result = await request.query(`
      UPDATE rt
      SET rt.deleted_at = SYSDATETIME(),
          rt.updated_at = SYSDATETIME()
      FROM dbo.room_types rt
      JOIN dbo.accommodations a
        ON a.id = rt.accommodation_id
      WHERE rt.id = @id
        AND rt.deleted_at IS NULL
        AND a.deleted_at IS NULL
        AND ${scope.condition};
    `);

  // 0 rows: không tồn tại HOẶC đã xóa HOẶC ngoài scope → cùng một 404,
  // không tạo existence oracle qua status/message.
  if (result.rowsAffected[0] === 0) {
    throw new RoomTypeServiceError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy loại phòng.",
    );
  }

  console.log("[deleteRoomType] đã xóa mềm id:", roomTypeId);
  return { id: roomTypeId };
}

module.exports = {
  getRoomTypeList,
  getRoomTypeDetail,
  createRoomType,
  updateRoomType,
  deleteRoomType,
  validateRoomTypePayload,
  RoomTypeServiceError,
};
