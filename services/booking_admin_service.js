const db = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const { getAccommodationScope } = require("./accommodation_access_service");
const {
  BOOKING_STATUSES,
  BOOKING_SORT_FIELD_MAP,
  BOOKING_DEFAULT_PAGE_SIZE,
  BOOKING_MAX_PAGE_SIZE,
  BOOKING_DEFAULT_SORT_BY,
  BOOKING_DEFAULT_SORT_DIR,
} = require("../constants/booking");

const sql = db.sqlObj;

class BookingAdminServiceError extends Error {
  constructor(statusCode, errorCode, message, errors = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errors = errors;
  }
}

function validationError(message, errors) {
  return new BookingAdminServiceError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    message,
    errors,
  );
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(query) {
  const page = parsePositiveInt(query.page, 1);
  const requestedLimit = parsePositiveInt(query.limit, BOOKING_DEFAULT_PAGE_SIZE);
  const limit = Math.min(BOOKING_MAX_PAGE_SIZE, Math.max(1, requestedLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function parseStatus(query) {
  if (query.status === undefined || query.status === null || query.status === "") {
    return null;
  }

  const status = String(query.status).trim().toUpperCase();

  if (!BOOKING_STATUSES.includes(status)) {
    throw validationError("Trạng thái đặt phòng không hợp lệ.", {
      status: `Chỉ chấp nhận: ${BOOKING_STATUSES.join(", ")}`,
    });
  }

  return status;
}

function parseAccommodationId(query) {
  if (
    query.accommodationId === undefined ||
    query.accommodationId === null ||
    query.accommodationId === ""
  ) {
    return null;
  }

  const accommodationId = parsePositiveInt(query.accommodationId);

  if (!accommodationId) {
    throw validationError("accommodationId không hợp lệ.", {
      accommodationId: "Phải là số nguyên dương.",
    });
  }

  return accommodationId;
}

function parseStayStatus(query) {
  if (
    query.stayStatus === undefined ||
    query.stayStatus === null ||
    query.stayStatus === ""
  ) {
    return null;
  }

  const value = String(query.stayStatus).trim().toLowerCase();

  if (!["checkin", "checkout"].includes(value)) {
    throw validationError("stayStatus không hợp lệ.", {
      stayStatus: "Chỉ chấp nhận: checkin, checkout",
    });
  }

  return value;
}

function toDateOnly(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return typeof value === "string" ? value.slice(0, 10) : null;
}

function toIsoString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toTimeOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(11, 16);
  return String(value).slice(0, 5);
}

function toNumber(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function mapBookingSummary(row) {
  return {
    id: Number(row.id),
    code: row.booking_code,
    status: row.status,
    customerName: row.contact_name,
    customerPhone: row.contact_phone,
    customerEmail: row.contact_email,
    accommodationId: row.accommodation_id,
    accommodationName: row.accommodation_name,
    roomTypeNames: row.room_type_names
      ? String(row.room_type_names).split(", ")
      : [],
    checkInDate: toDateOnly(row.check_in_date),
    checkOutDate: toDateOnly(row.check_out_date),
    totalNights: row.total_nights,
    roomsCount: row.total_rooms,
    adultsCount: row.total_adults,
    childrenCount: row.total_children,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    checkedInAt: toIsoString(row.checked_in_at),
    checkedOutAt: toIsoString(row.checked_out_at),
    operationalStatus: getOperationalStatus(row),
    specialRequests: row.special_requests ?? null,
  };
}

function getOperationalStatus(row) {
  if (row.checked_out_at) return "CHECKED_OUT";
  if (row.checked_in_at) return "CHECKED_IN";
  return null;
}

// Dựng WHERE + params dùng chung cho COUNT và SELECT để total luôn khớp filter.
function buildListFilters(query, currentUser = {}) {
  const whereParts = [];
  const params = [];

  const scope = getAccommodationScope(currentUser, "a");
  whereParts.push(scope.condition);
  params.push(...scope.inputs);

  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q) {
    whereParts.push(
      "(b.booking_code LIKE @q OR b.contact_name LIKE @q OR b.contact_phone LIKE @q OR b.contact_email LIKE @q)",
    );
    params.push({ name: "q", type: sql.NVarChar(255), value: `%${q}%` });
  }

  const status = parseStatus(query);
  if (status) {
    whereParts.push("b.status = @status");
    params.push({ name: "status", type: sql.VarChar(30), value: status });
  }

  const accommodationId = parseAccommodationId(query);
  if (accommodationId) {
    whereParts.push("b.accommodation_id = @accommodationId");
    params.push({
      name: "accommodationId",
      type: sql.Int,
      value: accommodationId,
    });
  }

  const stayStatus = parseStayStatus(query);
  if (stayStatus === "checkin") {
    whereParts.push(
      "b.status = 'CONFIRMED' AND b.checked_in_at IS NULL AND b.check_in_date <= CAST(SYSDATETIME() AS DATE)",
    );
  } else if (stayStatus === "checkout") {
    whereParts.push(
      "b.status = 'CONFIRMED' AND b.checked_in_at IS NOT NULL AND b.checked_out_at IS NULL",
    );
  }

  return { whereSql: `WHERE ${whereParts.join(" AND ")}`, params };
}

function bindParams(request, params) {
  params.forEach((param) => request.input(param.name, param.type, param.value));
  return request;
}

async function getBookingList(query = {}, currentUser = {}) {
  const { page, limit, offset } = parsePagination(query);

  const requestedSortBy = String(query.sortBy || BOOKING_DEFAULT_SORT_BY);
  const sortColumn =
    BOOKING_SORT_FIELD_MAP[requestedSortBy] ||
    BOOKING_SORT_FIELD_MAP[BOOKING_DEFAULT_SORT_BY];
  const sortDirection =
    String(query.sortDir || BOOKING_DEFAULT_SORT_DIR).toLowerCase() === "asc"
      ? "ASC"
      : "DESC";

  // Tie-breaker giữ thứ tự ổn định khi hai booking cùng giá trị sort.
  const tieBreaker = sortColumn === "b.id" ? "" : ", b.id ASC";

  const { whereSql, params } = buildListFilters(query, currentUser);

  const pool = db.getDBPool();

  const countResult = await bindParams(pool.request(), params).query(`
    SELECT COUNT(*) AS total
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    ${whereSql};
  `);

  const total = countResult.recordset[0] ? countResult.recordset[0].total : 0;

  if (total === 0) {
    return {
      items: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
    };
  }

  const dataRequest = bindParams(pool.request(), params)
    .input("offset", sql.Int, offset)
    .input("limit", sql.Int, limit);

  const dataResult = await dataRequest.query(`
    SELECT
      b.id,
      b.booking_code,
      b.status,
      b.contact_name,
      b.contact_phone,
      b.contact_email,
      b.accommodation_id,
      a.accommodation_name,
      b.check_in_date,
      b.check_out_date,
      b.total_nights,
      b.total_rooms,
      b.total_adults,
      b.total_children,
      b.total_amount,
      b.created_at,
      b.checked_in_at,
      b.checked_out_at,
      b.special_requests,
      room_type_names.names AS room_type_names
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    OUTER APPLY (
      SELECT STRING_AGG(rt.name, ', ') AS names
      FROM (
        SELECT DISTINCT rt2.name
        FROM dbo.booking_items i
        JOIN dbo.room_types rt2 ON rt2.id = i.room_type_id
        WHERE i.booking_id = b.id
      ) rt
    ) room_type_names
    ${whereSql}
    ORDER BY ${sortColumn} ${sortDirection}${tieBreaker}
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
  `);

  return {
    items: dataResult.recordset.map(mapBookingSummary),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

function mapBookingItem(row) {
  return {
    id: Number(row.id),
    roomTypeId: row.room_type_id,
    roomTypeName: row.room_type_name,
    adults: row.adults,
    children: row.children,
    includedAdults: row.included_adults,
    includedChildren: row.included_children,
    basePrice: toNumber(row.base_price),
    roomSubtotal: toNumber(row.room_subtotal),
    extraAdultTotal: toNumber(row.extra_adult_total),
    extraChildTotal: toNumber(row.extra_child_total),
    discountAmount: toNumber(row.discount_amount),
    totalAmount: toNumber(row.total_amount),
  };
}

function mapBookingDetail(row, items) {
  return {
    id: Number(row.id),
    code: row.booking_code,
    status: row.status,
    customer: {
      name: row.contact_name,
      email: row.contact_email,
      phone: row.contact_phone,
    },
    accommodation: {
      id: row.accommodation_id,
      name: row.accommodation_name,
      phone: row.accommodation_phone,
      email: row.accommodation_email,
      addressLine: row.accommodation_address,
      checkInTime: toTimeOnly(row.accommodation_check_in_time),
      checkOutTime: toTimeOnly(row.accommodation_check_out_time),
    },
    stay: {
      checkInDate: toDateOnly(row.check_in_date),
      checkOutDate: toDateOnly(row.check_out_date),
      totalNights: row.total_nights,
      roomsCount: row.total_rooms,
      adultsCount: row.total_adults,
      childrenCount: row.total_children,
      checkedInAt: toIsoString(row.checked_in_at),
      checkedOutAt: toIsoString(row.checked_out_at),
      operationalStatus: getOperationalStatus(row),
    },
    pricing: {
      roomsSubtotal: toNumber(row.rooms_subtotal),
      extraGuestTotal: toNumber(row.extra_guest_total),
      roomDiscountTotal: toNumber(row.room_discount_total),
      discountAmount: toNumber(row.discount_amount),
      taxAmount: toNumber(row.tax_amount),
      serviceFee: toNumber(row.service_fee),
      totalAmount: toNumber(row.total_amount),
      currency: row.currency,
    },
    lifecycle: {
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      confirmedAt: toIsoString(row.confirmed_at),
      cancelledAt: toIsoString(row.cancelled_at),
      cancellationReason: row.cancellation_reason,
      pendingExpiresAt: toIsoString(row.pending_expires_at),
    },
    specialRequests: row.special_requests,
    items: items.map(mapBookingItem),
  };
}

async function getBookingDetail(bookingId, currentUser = {}) {
  const id = parsePositiveInt(bookingId);

  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.", {
      id: "Phải là số nguyên dương.",
    });
  }

  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  const bookingRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    bookingRequest.input(input.name, input.type, input.value);
  });

  const bookingResult = await bookingRequest.query(`
    SELECT
      b.id,
      b.booking_code,
      b.status,
      b.contact_name,
      b.contact_phone,
      b.contact_email,
      b.check_in_date,
      b.check_out_date,
      b.total_nights,
      b.total_rooms,
      b.total_adults,
      b.total_children,
      b.rooms_subtotal,
      b.extra_guest_total,
      b.room_discount_total,
      b.discount_amount,
      b.tax_amount,
      b.service_fee,
      b.total_amount,
      b.currency,
      b.special_requests,
      b.created_at,
      b.updated_at,
      b.confirmed_at,
      b.cancelled_at,
      b.cancellation_reason,
      b.pending_expires_at,
      b.checked_in_at,
      b.checked_out_at,
      b.accommodation_id,
      a.accommodation_name,
      a.phone AS accommodation_phone,
      a.email AS accommodation_email,
      a.address_line AS accommodation_address,
      a.check_in_time AS accommodation_check_in_time,
      a.check_out_time AS accommodation_check_out_time
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND ${scope.condition};
  `);

  const booking = bookingResult.recordset[0];

  // Không tồn tại và ngoài scope trả cùng 404 để không lộ dữ liệu.
  if (!booking) {
    throw new BookingAdminServiceError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng.",
    );
  }

  const itemsResult = await pool
    .request()
    .input("bookingId", sql.BigInt, id)
    .query(`
      SELECT
        i.id,
        i.room_type_id,
        i.room_type_name,
        i.adults,
        i.children,
        i.included_adults,
        i.included_children,
        i.base_price,
        i.room_subtotal,
        i.extra_adult_total,
        i.extra_child_total,
        i.discount_amount,
        i.total_amount
      FROM dbo.booking_items i
      WHERE i.booking_id = @bookingId
      ORDER BY i.id ASC;
    `);

  return mapBookingDetail(booking, itemsResult.recordset);
}

async function approveBooking(bookingId, currentUser = {}) {
  const id = parsePositiveInt(bookingId);

  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.", {
      id: "Phải là số nguyên dương.",
    });
  }

  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  const currentRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    currentRequest.input(input.name, input.type, input.value);
  });

  const currentResult = await currentRequest.query(`
    SELECT b.id, b.status
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND ${scope.condition};
  `);

  const current = currentResult.recordset[0];

  if (!current) {
    throw new BookingAdminServiceError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng.",
    );
  }

  if (current.status !== "PENDING") {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      `Chỉ có thể duyệt đặt phòng đang chờ xử lý (hiện tại: ${current.status}).`,
    );
  }

  const updateRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    updateRequest.input(input.name, input.type, input.value);
  });

  // Điều kiện status lặp lại trong UPDATE để hai request duyệt đồng thời
  // chỉ có một request thắng.
  const updateResult = await updateRequest.query(`
    UPDATE b
    SET b.status = 'CONFIRMED',
        b.confirmed_at = SYSDATETIME(),
        b.updated_at = SYSDATETIME()
    OUTPUT INSERTED.id, INSERTED.booking_code, INSERTED.status, INSERTED.confirmed_at
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND b.status = 'PENDING'
      AND ${scope.condition};
  `);

  const updated = updateResult.recordset[0];

  if (!updated) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Đặt phòng vừa được thay đổi trạng thái, vui lòng tải lại danh sách.",
    );
  }

  return {
    id: Number(updated.id),
    code: updated.booking_code,
    status: updated.status,
    confirmedAt: toIsoString(updated.confirmed_at),
  };
}

function buildStayResponse(row) {
  return {
    id: Number(row.id),
    code: row.booking_code,
    status: row.status,
    checkedInAt: toIsoString(row.checked_in_at),
    checkedOutAt: toIsoString(row.checked_out_at),
    operationalStatus: getOperationalStatus(row),
  };
}

async function checkInBooking(bookingId, currentUser = {}) {
  const id = parsePositiveInt(bookingId);

  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.", {
      id: "Phải là số nguyên dương.",
    });
  }

  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  const currentRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    currentRequest.input(input.name, input.type, input.value);
  });

  const currentResult = await currentRequest.query(`
    SELECT
      b.id,
      b.booking_code,
      b.status,
      b.check_in_date,
      b.checked_in_at,
      b.checked_out_at,
      CASE WHEN b.check_in_date <= CAST(SYSDATETIME() AS DATE) THEN 1 ELSE 0 END AS can_check_in
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND ${scope.condition};
  `);

  const current = currentResult.recordset[0];

  if (!current) {
    throw new BookingAdminServiceError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng.",
    );
  }

  if (current.status !== "CONFIRMED") {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      `Chỉ có thể nhận phòng cho booking đã xác nhận (hiện tại: ${current.status}).`,
    );
  }

  if (current.checked_in_at) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Booking đã được nhận phòng.",
    );
  }

  if (!current.can_check_in) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      `Chưa đến ngày nhận phòng (${toDateOnly(current.check_in_date)}).`,
    );
  }

  const updateRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    updateRequest.input(input.name, input.type, input.value);
  });
  updateRequest.input("actorId", sql.UniqueIdentifier, currentUser.id ?? null);

  const updateResult = await updateRequest.query(`
    UPDATE b
    SET b.checked_in_at = SYSDATETIME(),
        b.checked_in_by = @actorId,
        b.updated_at = SYSDATETIME()
    OUTPUT INSERTED.id, INSERTED.booking_code, INSERTED.status,
           INSERTED.checked_in_at, INSERTED.checked_out_at
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND b.status = 'CONFIRMED'
      AND b.checked_in_at IS NULL
      AND b.check_in_date <= CAST(SYSDATETIME() AS DATE)
      AND ${scope.condition};
  `);

  const updated = updateResult.recordset[0];

  if (!updated) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Booking vừa được thay đổi trạng thái, vui lòng tải lại danh sách.",
    );
  }

  return buildStayResponse(updated);
}

async function checkOutBooking(bookingId, currentUser = {}) {
  const id = parsePositiveInt(bookingId);

  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.", {
      id: "Phải là số nguyên dương.",
    });
  }

  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  const currentRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    currentRequest.input(input.name, input.type, input.value);
  });

  const currentResult = await currentRequest.query(`
    SELECT b.id, b.booking_code, b.status, b.checked_in_at, b.checked_out_at
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND ${scope.condition};
  `);

  const current = currentResult.recordset[0];

  if (!current) {
    throw new BookingAdminServiceError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng.",
    );
  }

  if (current.checked_out_at) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Booking đã được trả phòng.",
    );
  }

  if (!current.checked_in_at) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Booking chưa được nhận phòng.",
    );
  }

  const updateRequest = pool.request().input("bookingId", sql.BigInt, id);
  scope.inputs.forEach((input) => {
    updateRequest.input(input.name, input.type, input.value);
  });
  updateRequest.input("actorId", sql.UniqueIdentifier, currentUser.id ?? null);

  const updateResult = await updateRequest.query(`
    UPDATE b
    SET b.checked_out_at = SYSDATETIME(),
        b.checked_out_by = @actorId,
        b.updated_at = SYSDATETIME()
    OUTPUT INSERTED.id, INSERTED.booking_code, INSERTED.status,
           INSERTED.checked_in_at, INSERTED.checked_out_at
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE b.id = @bookingId
      AND b.checked_in_at IS NOT NULL
      AND b.checked_out_at IS NULL
      AND ${scope.condition};
  `);

  const updated = updateResult.recordset[0];

  if (!updated) {
    throw new BookingAdminServiceError(
      409,
      ERROR_CODES.INVALID_STATE,
      "Booking vừa được thay đổi trạng thái, vui lòng tải lại danh sách.",
    );
  }

  return buildStayResponse(updated);
}

module.exports = {
  BookingAdminServiceError,
  getBookingList,
  getBookingDetail,
  approveBooking,
  checkInBooking,
  checkOutBooking,
};
