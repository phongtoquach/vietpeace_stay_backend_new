const { Type } = require("@google/genai");
const { getDBPool, sqlObj } = require("../../configs/database");
const { searchAccommodationsByFilters } = require("../accommodation_daily_search_service");
const { recommendRoomsAndQuote } = require("../room_recommendation_service");
const {
  listCustomerBookings,
  getCustomerBookingByCodeOrId,
} = require("../customer_booking_read_service");

// Rate limit incorrect/missed booking lookups: max 5 misses in 5 minutes per customer
const wrongBookingAttempts = new Map();

function checkAndRecordBookingMiss(userId) {
  const key = String(userId).toLowerCase();
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const list = (wrongBookingAttempts.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  wrongBookingAttempts.set(key, list);
  return list.length;
}

function isBookingLookupRateLimited(userId) {
  const key = String(userId).toLowerCase();
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const list = (wrongBookingAttempts.get(key) || []).filter((t) => now - t < windowMs);
  return list.length >= 5;
}

const TOOL_DECLARATIONS = [
  {
    name: "search_accommodations",
    description:
      "Tìm kiếm khách sạn, resort, homestay đang mở bán theo điểm đến, từ khóa tên cơ sở, ngày nhận/trả phòng, số phòng, loại hình, hạng sao hoặc khoảng giá.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        locationId: { type: Type.INTEGER, description: "ID điểm đến/thành phố (ví dụ Vũng Tàu = 14)." },
        locationName: { type: Type.STRING, description: "Tên điểm đến/thành phố (ví dụ: Vũng Tàu, Đà Nẵng, Phú Quốc, Cần Thơ)." },
        keyword: { type: Type.STRING, description: "Từ khóa tên cơ sở lưu trú nếu khách nhắc tên cụ thể." },
        checkinDate: { type: Type.STRING, description: "Ngày nhận phòng YYYY-MM-DD." },
        checkoutDate: { type: Type.STRING, description: "Ngày trả phòng YYYY-MM-DD." },
        rooms: { type: Type.INTEGER, description: "Số lượng phòng cần tìm." },
        priceFrom: { type: Type.NUMBER, description: "Giá mỗi đêm tối thiểu (VND)." },
        priceTo: { type: Type.NUMBER, description: "Giá mỗi đêm tối đa (VND)." },
      },
    },
  },
  {
    name: "get_accommodation_info",
    description:
      "Lấy thông tin chi tiết của một cơ sở lưu trú (áp dụng cho cả 72/72 cơ sở): mô tả, giờ nhận/trả phòng, chính sách trẻ em/thú cưng/hút thuốc/nội quy, tiện ích (có tính phí hay miễn phí), điểm tham quan gần đó và thông tin liên hệ thật (SĐT, email, website, địa chỉ).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        accommodationId: { type: Type.INTEGER, description: "ID cơ sở lưu trú." },
        accommodationName: { type: Type.STRING, description: "Tên cơ sở lưu trú nếu chưa có ID." },
      },
    },
  },
  {
    name: "get_accommodation_room_types",
    description:
      "Lấy danh sách các hạng phòng của một cơ sở lưu trú kèm giá tham khảo, sức chứa tiêu chuẩn/tối đa, giường ngủ và tiện ích phòng.",
    parameters: {
      type: Type.OBJECT,
      required: ["accommodationId"],
      properties: {
        accommodationId: { type: Type.INTEGER, description: "ID cơ sở lưu trú." },
      },
    },
  },
  {
    name: "get_room_recommendations",
    description:
      "Tính toán phân bổ phòng, kiểm tra tồn kho theo ngày và báo giá chính xác khớp 100% với bước thanh toán (gồm phụ thu khách thêm, thuế, phí dịch vụ).",
    parameters: {
      type: Type.OBJECT,
      required: ["accommodationId", "checkinDate", "checkoutDate", "adults"],
      properties: {
        accommodationId: { type: Type.INTEGER, description: "ID cơ sở lưu trú." },
        checkinDate: { type: Type.STRING, description: "Ngày nhận phòng YYYY-MM-DD." },
        checkoutDate: { type: Type.STRING, description: "Ngày trả phòng YYYY-MM-DD." },
        adults: { type: Type.INTEGER, description: "Tổng số người lớn (1..40)." },
        children: { type: Type.INTEGER, description: "Tổng số trẻ em (0..30)." },
        rooms: { type: Type.INTEGER, description: "Số phòng mong muốn nếu khách chỉ định (1..10)." },
        preferredRoomTypeId: { type: Type.INTEGER, description: "ID hạng phòng ưu tiên nếu có." },
      },
    },
  },
  {
    name: "get_my_booking",
    description:
      "Tra cứu chi tiết 1 đơn đặt phòng cá nhân của Khách hàng đã đăng nhập theo mã đơn (VP-...) hoặc bookingId.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        bookingCode: { type: Type.STRING, description: "Mã đơn đặt phòng (ví dụ VP-...)." },
        bookingId: { type: Type.STRING, description: "ID số của đơn đặt phòng." },
      },
    },
  },
  {
    name: "list_my_bookings",
    description:
      "Liệt kê danh sách các đơn đặt phòng gần đây của chính Khách hàng đang đăng nhập.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, description: "Lọc theo trạng thái nếu cần (PAID, PENDING, CANCELLED, EXPIRED)." },
      },
    },
  },
];

async function resolveLocationIdByName(name) {
  if (!name || typeof name !== "string") return null;
  const pool = getDBPool();
  const clean = name.trim();
  const res = await pool
    .request()
    .input("q", sqlObj.NVarChar(255), `%${clean}%`)
    .query(`
      SELECT TOP 1 id, name
      FROM dbo.locations
      WHERE is_active = 1
        AND (name LIKE @q OR search_keywords LIKE @q)
      ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, is_featured DESC, id ASC;
    `);
  return res.recordset[0] || null;
}

async function resolveAccommodationIdByName(name) {
  if (!name || typeof name !== "string") return null;
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("q", sqlObj.NVarChar(255), `%${name.trim()}%`)
    .query(`
      SELECT TOP 1 id, accommodation_name AS name
      FROM dbo.accommodations
      WHERE status = 1 AND deleted_at IS NULL
        AND accommodation_name LIKE @q
      ORDER BY is_featured DESC, id ASC;
    `);
  return res.recordset[0]?.id || null;
}

async function executeSearchAccommodations(args) {
  const pool = getDBPool();
  let locId = Number.isSafeInteger(Number(args.locationId)) && Number(args.locationId) > 0
    ? Number(args.locationId)
    : null;
  let resolvedLocationName = null;

  if (!locId && args.locationName) {
    const loc = await resolveLocationIdByName(args.locationName);
    if (loc) {
      locId = Number(loc.id);
      resolvedLocationName = loc.name;
    } else if (!args.keyword) {
      return {
        status: "NO_PROPERTY_IN_LOCATION",
        message: `Không tìm thấy điểm đến "${args.locationName}" trên hệ thống VietPeace Stay.`,
        items: [],
      };
    }
  }

  // Filter keyword direct lookup if no location filters are constraining or keyword provided
  let matchedAccomIds = null;
  if (args.keyword && String(args.keyword).trim()) {
    const kwRes = await pool
      .request()
      .input("kw", sqlObj.NVarChar(255), `%${String(args.keyword).trim()}%`)
      .query(`
        SELECT id FROM dbo.accommodations
        WHERE status = 1 AND deleted_at IS NULL AND accommodation_name LIKE @kw;
      `);
    matchedAccomIds = new Set(kwRes.recordset.map((r) => Number(r.id)));
    if (matchedAccomIds.size === 0) {
      return {
        status: "NO_MATCH_FILTERS",
        message: `Không tìm thấy cơ sở nào khớp từ khóa "${args.keyword}".`,
        items: [],
      };
    }
  }

  const baseFilterBody = {
    ...(locId ? { locationId: locId } : {}),
    sort: "default",
    page: 1,
    pageSize: 20,
  };

  const fullFilterBody = {
    ...baseFilterBody,
    ...(args.checkinDate ? { checkinDate: args.checkinDate } : {}),
    ...(args.checkoutDate ? { checkoutDate: args.checkoutDate } : {}),
    ...(args.rooms ? { rooms: Number(args.rooms) } : {}),
    ...(args.priceFrom !== undefined ? { priceFrom: Number(args.priceFrom) } : {}),
    ...(args.priceTo !== undefined ? { priceTo: Number(args.priceTo) } : {}),
  };

  let searchResult;
  try {
    searchResult = await searchAccommodationsByFilters(fullFilterBody);
  } catch (err) {
    return {
      status: "INVALID_FILTERS",
      message: err?.message || "Bộ lọc tìm kiếm không hợp lệ.",
      items: [],
    };
  }

  let items = searchResult?.data?.items || [];
  if (matchedAccomIds) {
    items = items.filter((item) => matchedAccomIds.has(Number(item.id)));
  }

  if (items.length === 0 && locId) {
    // Distinguish NO_PROPERTY_IN_LOCATION vs NO_MATCH_FILTERS vs NO_AVAILABILITY
    const rawInLoc = await searchAccommodationsByFilters({ locationId: locId, page: 1, pageSize: 5 });
    const rawItems = rawInLoc?.data?.items || [];
    if (rawItems.length === 0) {
      return {
        status: "NO_PROPERTY_IN_LOCATION",
        locationId: locId,
        locationName: resolvedLocationName || args.locationName || null,
        message: `Hiện chưa có cơ sở nào mở bán tại khu vực ${resolvedLocationName || args.locationName || locId}.`,
        items: [],
      };
    }
    if (args.checkinDate && args.checkoutDate) {
      const noDatesResult = await searchAccommodationsByFilters({
        ...baseFilterBody,
        ...(args.priceFrom !== undefined ? { priceFrom: Number(args.priceFrom) } : {}),
        ...(args.priceTo !== undefined ? { priceTo: Number(args.priceTo) } : {}),
      });
      if ((noDatesResult?.data?.items || []).length > 0) {
        return {
          status: "NO_AVAILABILITY",
          locationId: locId,
          locationName: resolvedLocationName || args.locationName || null,
          message: `Có cơ sở phù hợp tại khu vực này nhưng hiện hết phòng cho ngày ${args.checkinDate} – ${args.checkoutDate}.`,
          items: [],
        };
      }
    }
    return {
      status: "NO_MATCH_FILTERS",
      locationId: locId,
      locationName: resolvedLocationName || args.locationName || null,
      message: "Có cơ sở tại điểm đến này nhưng không khớp điều kiện lọc giá/hạng sao hiện tại.",
      items: [],
    };
  }

  const compact = items.slice(0, 6).map((a) => ({
    accommodationId: Number(a.id),
    accommodationName: a.accommodation_name,
    accommodationType: a.accommodation_type_name || null,
    starRating: a.star_rating,
    locationName: a.location_name,
    addressLine: a.address_line,
    minNightlyPrice: a.min_price !== null && a.min_price !== undefined ? Number(a.min_price) : null,
    availableRooms: a.available_rooms,
    coverImage: (a.images || []).find((i) => i.is_cover)?.image_url || a.images?.[0]?.image_url || null,
    phone: a.phone || null,
    email: a.email || null,
    detailUrl: `/accommodation-detail?accommodationId=${a.id}`,
  }));

  return {
    status: compact.length > 0 ? "FOUND" : "NO_MATCH_FILTERS",
    totalMatched: items.length,
    items: compact,
  };
}

async function executeGetAccommodationInfo(args) {
  let accomId = Number(args.accommodationId);
  if (!Number.isSafeInteger(accomId) || accomId < 1) {
    accomId = await resolveAccommodationIdByName(args.accommodationName);
  }
  if (!accomId) {
    return { status: "NOT_FOUND", message: "Không tìm thấy cơ sở lưu trú phù hợp." };
  }

  const pool = getDBPool();
  const res = await pool
    .request()
    .input("accomId", sqlObj.Int, accomId)
    .query(`
      SELECT TOP 1
        a.id,
        a.accommodation_code AS accommodationCode,
        a.accommodation_name AS accommodationName,
        atp.name AS accommodationTypeName,
        l.id AS locationId,
        l.name AS locationName,
        a.address_line AS addressLine,
        a.postal_code AS postalCode,
        a.directions,
        a.short_description AS shortDescription,
        a.description,
        a.phone,
        a.email,
        a.website_url AS websiteUrl,
        a.star_rating AS starRating,
        CONVERT(VARCHAR(8), a.check_in_time, 108) AS checkInTime,
        CONVERT(VARCHAR(8), a.check_out_time, 108) AS checkOutTime,
        a.check_in_instructions AS checkInInstructions,
        a.house_rules AS houseRules,
        a.children_policy AS childrenPolicy,
        a.pet_policy AS petPolicy,
        a.smoking_policy AS smokingPolicy,
        CASE WHEN EXISTS (
          SELECT 1 FROM dbo.chat_manager_assignment_epochs e
          WHERE e.accommodation_id = a.id AND e.revoked_at_utc IS NULL
        ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasActiveManager
      FROM dbo.accommodations AS a
      LEFT JOIN dbo.accommodation_types AS atp ON atp.id = a.accommodation_type_id
      LEFT JOIN dbo.locations AS l ON l.id = a.location_id
      WHERE a.id = @accomId AND a.status = 1 AND a.deleted_at IS NULL;

      SELECT am.name, am.category_code AS categoryCode, aa.is_chargeable AS isChargeable, aa.note
      FROM dbo.accommodation_amenities AS aa
      INNER JOIN dbo.amenities AS am ON am.id = aa.amenity_id
      WHERE aa.accommodation_id = @accomId
      ORDER BY aa.is_chargeable ASC, am.name ASC;

      SELECT TOP 10 att.name, att.address_line AS addressLine, CAST(aa.distance_meters AS FLOAT) AS distanceMeters, aa.note
      FROM dbo.accommodation_attractions AS aa
      INNER JOIN dbo.attractions AS att ON att.id = aa.attraction_id
      WHERE aa.accommodation_id = @accomId AND att.is_active = 1
      ORDER BY aa.sort_order ASC, aa.distance_meters ASC;
    `);

  const info = res.recordsets[0][0];
  if (!info) {
    return { status: "NOT_FOUND", message: "Cơ sở lưu trú không tồn tại hoặc tạm ngừng hoạt động." };
  }

  return {
    status: "FOUND",
    accommodation: {
      ...info,
      id: Number(info.id),
      locationId: info.locationId ? Number(info.locationId) : null,
      hasActiveManager: Boolean(info.hasActiveManager),
      contact: {
        phone: info.phone,
        email: info.email,
        websiteUrl: info.websiteUrl,
        addressLine: info.addressLine,
        postalCode: info.postalCode,
      },
      amenities: res.recordsets[1],
      nearbyAttractions: res.recordsets[2],
    },
  };
}

async function executeGetAccommodationRoomTypes(args) {
  const accomId = Number(args.accommodationId);
  if (!Number.isSafeInteger(accomId) || accomId < 1) {
    return { status: "INVALID_INPUT", message: "Thiếu accommodationId hợp lệ." };
  }

  const pool = getDBPool();
  const res = await pool
    .request()
    .input("accomId", sqlObj.Int, accomId)
    .query(`
      SELECT
        rt.id,
        rt.name,
        rt.short_description AS shortDescription,
        rt.quantity,
        CAST(rt.base_price AS FLOAT) AS basePrice,
        CAST(rt.area_sqm AS FLOAT) AS areaSqm,
        rt.bed_description AS bedDescription,
        rt.bedroom_count AS bedroomCount,
        rt.bathroom_count AS bathroomCount,
        rt.included_adults AS includedAdults,
        rt.included_children AS includedChildren,
        rt.max_adults AS maxAdults,
        rt.max_children AS maxChildren,
        rt.max_occupancy AS maxOccupancy,
        CAST(rt.extra_adult_fee AS FLOAT) AS extraAdultFee,
        CAST(rt.extra_child_fee AS FLOAT) AS extraChildFee
      FROM dbo.room_types AS rt
      INNER JOIN dbo.accommodations AS a ON a.id = rt.accommodation_id
      WHERE rt.accommodation_id = @accomId
        AND a.status = 1 AND a.deleted_at IS NULL
        AND rt.status = 1 AND rt.deleted_at IS NULL
      ORDER BY rt.sort_order ASC, rt.base_price ASC, rt.id ASC;

      SELECT ra.room_type_id AS roomTypeId, am.name, ra.is_chargeable AS isChargeable, ra.note
      FROM dbo.room_type_amenities AS ra
      INNER JOIN dbo.room_types AS rt ON rt.id = ra.room_type_id
      INNER JOIN dbo.amenities AS am ON am.id = ra.amenity_id
      WHERE rt.accommodation_id = @accomId AND rt.status = 1 AND rt.deleted_at IS NULL
      ORDER BY am.name ASC;
    `);

  const amenitiesByRoom = new Map();
  for (const row of res.recordsets[1]) {
    const list = amenitiesByRoom.get(row.roomTypeId) || [];
    list.push({ name: row.name, isChargeable: Boolean(row.isChargeable), note: row.note || null });
    amenitiesByRoom.set(row.roomTypeId, list);
  }

  const rooms = res.recordsets[0].map((r) => ({
    ...r,
    id: Number(r.id),
    amenities: amenitiesByRoom.get(r.id) || [],
  }));

  return {
    status: rooms.length > 0 ? "FOUND" : "NOT_FOUND",
    accommodationId: accomId,
    roomTypes: rooms,
  };
}

async function executeTool(name, args = {}, runContext) {
  const actor = runContext.actor;

  switch (name) {
    case "search_accommodations":
      return executeSearchAccommodations(args);

    case "get_accommodation_info":
      return executeGetAccommodationInfo(args);

    case "get_accommodation_room_types":
      return executeGetAccommodationRoomTypes(args);

    case "get_room_recommendations": {
      const result = await recommendRoomsAndQuote({
        accommodationId: args.accommodationId,
        checkinDate: args.checkinDate,
        checkoutDate: args.checkoutDate,
        adults: args.adults,
        children: args.children,
        rooms: args.rooms,
        preferredRoomTypeId: args.preferredRoomTypeId,
      });
      if (result.status === "READY" && result.options?.length > 0) {
        runContext.cardsToEmit.push({
          messageType: "QUOTE_CARD",
          visibility: "PUBLIC",
          payload: {
            kind: "ROOM_QUOTE",
            rangeScope: result.rangeScope,
            accommodation: result.accommodation,
            checkinDate: result.checkinDate,
            checkoutDate: result.checkoutDate,
            totalNights: result.totalNights,
            adults: result.adults,
            children: result.children,
            options: result.options,
          },
        });
      }
      return result;
    }

    case "get_my_booking": {
      if (!actor || actor.type !== "CUSTOMER") {
        runContext.cardsToEmit.push({
          messageType: "LOGIN_REQUIRED_CARD",
          visibility: "PUBLIC",
          payload: {
            kind: "LOGIN_REQUIRED",
            title: "Đăng nhập để tra cứu đơn đặt phòng",
            description: "Thông tin đặt phòng và thanh toán được bảo mật theo tài khoản cá nhân.",
            loginUrl: "/login",
          },
        });
        return {
          status: "LOGIN_REQUIRED",
          message: "Quý khách cần đăng nhập tài khoản VietPeace Stay để tra cứu chi tiết đơn đặt phòng cá nhân.",
        };
      }
      if (isBookingLookupRateLimited(actor.userId)) {
        return {
          status: "RATE_LIMITED",
          message: "Bạn đã nhập sai mã đơn quá 5 lần trong 5 phút. Vui lòng thử lại sau ít phút hoặc vào mục Đơn đặt phòng của tôi.",
        };
      }
      runContext.hasPrivateBookingRead = true;
      const booking = await getCustomerBookingByCodeOrId(actor.userId, {
        bookingCode: args.bookingCode,
        bookingId: args.bookingId,
      });
      if (!booking) {
        checkAndRecordBookingMiss(actor.userId);
        return {
          status: "NOT_FOUND",
          message: "Không tìm thấy đơn đặt phòng khớp với mã bạn cung cấp trong tài khoản đang đăng nhập.",
        };
      }
      return { status: "FOUND", booking };
    }

    case "list_my_bookings": {
      if (!actor || actor.type !== "CUSTOMER") {
        runContext.cardsToEmit.push({
          messageType: "LOGIN_REQUIRED_CARD",
          visibility: "PUBLIC",
          payload: {
            kind: "LOGIN_REQUIRED",
            title: "Đăng nhập để xem đơn đặt phòng của bạn",
            description: "Vui lòng đăng nhập để hệ thống liệt kê lịch sử đặt phòng cá nhân.",
            loginUrl: "/login",
          },
        });
        return {
          status: "LOGIN_REQUIRED",
          message: "Quý khách cần đăng nhập tài khoản để xem danh sách đơn đặt phòng cá nhân.",
        };
      }
      runContext.hasPrivateBookingRead = true;
      const bookings = await listCustomerBookings(actor.userId, {
        status: args.status,
        limit: 10,
      });
      return {
        status: bookings.length > 0 ? "FOUND" : "EMPTY",
        total: bookings.length,
        bookings,
      };
    }

    default:
      return { status: "UNKNOWN_TOOL", message: `Công cụ ${name} không được hỗ trợ.` };
  }
}

module.exports = {
  TOOL_DECLARATIONS,
  executeTool,
};
