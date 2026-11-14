const { getDBPool, sqlObj } = require("../configs/database");
const { calculateQuote, toCents, fromCents } = require("./booking_quote_service");

function todayInVietnam() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function parseYmd(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) return null;
  const s = str.trim();
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString().slice(0, 10);
  return iso === s ? s : null;
}

function buildStayNights(checkinDate, checkoutDate) {
  const startMs = Date.parse(`${checkinDate}T00:00:00Z`);
  const endMs = Date.parse(`${checkoutDate}T00:00:00Z`);
  const nights = [];
  for (let ms = startMs; ms < endMs; ms += 86400000) {
    nights.push(new Date(ms).toISOString().slice(0, 10));
  }
  return nights;
}

function distributeGuestsIntoSlots(totalAdults, totalChildren, capacities) {
  // Heuristic greedy balanced assignment trying to satisfy adults first, then children within maxOccupancy.
  // capacities is array of { roomType, roomByIdRow } already chosen, sorted by maxOccupancy desc.
  const k = capacities.length;
  if (k === 0) return null;
  const slots = capacities.map((c) => ({
    roomType: c.roomType,
    adults: 0,
    children: 0,
  }));

  // First ensure every room gets at least 1 adult if possible
  let remainingAdults = totalAdults;
  let remainingChildren = totalChildren;

  if (totalAdults < k) {
    return null; // Cannot occupy more rooms than adults
  }

  // Round-robin / capacity-aware pass 1: 1 adult per room
  for (let i = 0; i < k; i++) {
    if (slots[i].roomType.maxAdults < 1 || slots[i].roomType.maxOccupancy < 1) return null;
    slots[i].adults = 1;
    remainingAdults -= 1;
  }

  // Distribute remaining adults trying to keep within includedAdults first to minimize extra fees, then up to maxAdults
  for (let pass = 0; pass < 2 && remainingAdults > 0; pass++) {
    for (let i = 0; i < k && remainingAdults > 0; i++) {
      const capLimit = pass === 0 ? slots[i].roomType.includedAdults : slots[i].roomType.maxAdults;
      const roomFree = Math.min(
        capLimit - slots[i].adults,
        slots[i].roomType.maxOccupancy - (slots[i].adults + slots[i].children),
      );
      if (roomFree > 0) {
        const give = Math.min(remainingAdults, roomFree);
        slots[i].adults += give;
        remainingAdults -= give;
      }
    }
  }
  if (remainingAdults > 0) return null;

  // Distribute children within includedChildren first, then maxChildren & maxOccupancy
  for (let pass = 0; pass < 2 && remainingChildren > 0; pass++) {
    for (let i = 0; i < k && remainingChildren > 0; i++) {
      const capLimit = pass === 0 ? slots[i].roomType.includedChildren : slots[i].roomType.maxChildren;
      const roomFree = Math.min(
        capLimit - slots[i].children,
        slots[i].roomType.maxOccupancy - (slots[i].adults + slots[i].children),
      );
      if (roomFree > 0) {
        const give = Math.min(remainingChildren, roomFree);
        slots[i].children += give;
        remainingChildren -= give;
      }
    }
  }
  if (remainingChildren > 0) return null;

  return slots.map((s) => ({
    roomTypeId: s.roomType.id,
    adults: s.adults,
    children: s.children,
  }));
}

async function recommendRoomsAndQuote({
  accommodationId,
  checkinDate,
  checkoutDate,
  adults = 2,
  children = 0,
  rooms = null,
  preferredRoomTypeId = null,
}) {
  const accomId = Number(accommodationId);
  if (!Number.isSafeInteger(accomId) || accomId < 1) {
    return { status: "INVALID_INPUT", message: "Mã cơ sở lưu trú không hợp lệ." };
  }

  const ci = parseYmd(checkinDate);
  const co = parseYmd(checkoutDate);
  const today = todayInVietnam();
  if (!ci || !co || ci < today || co <= ci) {
    return {
      status: "INVALID_DATES",
      message: "Ngày nhận phòng phải từ hôm nay trở đi (giờ Việt Nam) và ngày trả phòng phải sau ngày nhận phòng.",
    };
  }

  const stayDates = buildStayNights(ci, co);
  const totalNights = stayDates.length;
  if (totalNights < 1 || totalNights > 90) {
    return { status: "INVALID_INPUT", message: "Số đêm lưu trú hỗ trợ từ 1 đến 90 đêm." };
  }

  const totalAdults = Number(adults);
  const totalChildren = Number(children || 0);
  const requestedRooms = rooms === null || rooms === undefined || rooms === "" ? null : Number(rooms);

  if (!Number.isSafeInteger(totalAdults) || totalAdults < 1 || totalAdults > 40) {
    return { status: "INVALID_INPUT", message: "Số người lớn phải từ 1 đến 40." };
  }
  if (!Number.isSafeInteger(totalChildren) || totalChildren < 0 || totalChildren > 30) {
    return { status: "INVALID_INPUT", message: "Số trẻ em phải từ 0 đến 30." };
  }
  if (requestedRooms !== null && (!Number.isSafeInteger(requestedRooms) || requestedRooms < 1 || requestedRooms > 10)) {
    return { status: "INVALID_INPUT", message: "Số phòng yêu cầu phải từ 1 đến 10 phòng." };
  }
  if (requestedRooms !== null && requestedRooms > totalAdults) {
    return {
      status: "INVALID_INPUT",
      message: `Mỗi phòng cần tối thiểu 1 người lớn, không thể chia ${totalAdults} người lớn vào ${requestedRooms} phòng.`,
    };
  }

  const pool = getDBPool();
  const res = await pool
    .request()
    .input("accomId", sqlObj.Int, accomId)
    .input("stayDatesJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(stayDates))
    .query(`
      SELECT
        a.id,
        a.accommodation_name AS accommodationName,
        a.address_line AS addressLine,
        a.phone,
        a.email,
        a.website_url AS websiteUrl,
        l.name AS locationName
      FROM dbo.accommodations AS a
      LEFT JOIN dbo.locations AS l ON l.id = a.location_id
      WHERE a.id = @accomId AND a.status = 1 AND a.deleted_at IS NULL;

      SELECT
        rt.id,
        rt.name,
        rt.quantity,
        CAST(rt.base_price AS FLOAT) AS basePrice,
        rt.included_adults AS includedAdults,
        rt.included_children AS includedChildren,
        rt.max_adults AS maxAdults,
        rt.max_children AS maxChildren,
        rt.max_occupancy AS maxOccupancy,
        CAST(rt.extra_adult_fee AS FLOAT) AS extraAdultFeePerNight,
        CAST(rt.extra_child_fee AS FLOAT) AS extraChildFeePerNight,
        rt.bed_description AS bedDescription,
        rt.sort_order AS sortOrder
      FROM dbo.room_types AS rt
      WHERE rt.accommodation_id = @accomId
        AND rt.status = 1
        AND rt.deleted_at IS NULL
      ORDER BY rt.sort_order ASC, rt.base_price ASC, rt.id ASC;

      SELECT
        f.room_type_id AS roomTypeId,
        CONVERT(CHAR(10), f.stay_date, 23) AS stayDate,
        f.available_to_sell AS availableToSell,
        CAST(f.effective_price AS FLOAT) AS effectivePrice
      FROM dbo.room_types AS rt
      CROSS JOIN OPENJSON(@stayDatesJson) WITH (stay_date DATE '$') AS d
      CROSS APPLY dbo.fn_room_daily_offer(rt.id, d.stay_date) AS f
      WHERE rt.accommodation_id = @accomId
        AND rt.status = 1
        AND rt.deleted_at IS NULL;
    `);

  const property = res.recordsets[0][0];
  if (!property) {
    return { status: "NOT_FOUND", message: "Không tìm thấy cơ sở lưu trú đang hoạt động." };
  }

  const rawRoomTypes = res.recordsets[1];
  const offerRows = res.recordsets[2];
  const offersByKey = new Map(offerRows.map((o) => [`${o.roomTypeId}:${o.stayDate}`, o]));

  const roomById = new Map();
  const availableTypes = [];

  for (const rt of rawRoomTypes) {
    let minAvail = rt.quantity;
    let subtotalCents = 0;
    let validAllNights = true;
    const nightlyRates = [];

    for (const d of stayDates) {
      const offer = offersByKey.get(`${rt.id}:${d}`);
      if (!offer || Number(offer.effectivePrice) <= 0) {
        validAllNights = false;
        break;
      }
      minAvail = Math.min(minAvail, Number(offer.availableToSell));
      subtotalCents += toCents(offer.effectivePrice);
      nightlyRates.push({ stayDate: d, price: Number(offer.effectivePrice) });
    }

    if (!validAllNights) continue;

    const roomObj = {
      ...rt,
      availableQuantity: Math.max(0, minAvail),
      roomSubtotal: fromCents(subtotalCents),
      nightlyRates,
    };
    roomById.set(rt.id, roomObj);
    if (roomObj.availableQuantity > 0) {
      availableTypes.push(roomObj);
    }
  }

  if (availableTypes.length === 0) {
    return {
      status: "NO_AVAILABILITY",
      accommodation: property,
      checkinDate: ci,
      checkoutDate: co,
      totalNights,
      message: `Từ ${ci} đến ${co}, ${property.accommodationName} đã hết phòng trống.`,
    };
  }

  // Build candidate room counts to evaluate (up to requestedRooms or min-to-10 rooms)
  const totalAvailableCount = availableTypes.reduce((sum, r) => sum + r.availableQuantity, 0);
  const candidateRoomCounts = requestedRooms
    ? [requestedRooms]
    : Array.from({ length: Math.min(10, totalAdults, totalAvailableCount) }, (_, i) => i + 1);

  const options = [];
  const seenSignatures = new Set();

  function evaluateSelection(selection, label) {
    const sig = selection
      .map((s) => `${s.roomTypeId}:${s.adults}:${s.children}`)
      .sort()
      .join("|");
    if (seenSignatures.has(sig)) return;

    // Validate inventory & capacities across total selection
    const usedCounts = new Map();
    for (const s of selection) {
      const rt = roomById.get(s.roomTypeId);
      if (!rt) return;
      usedCounts.set(rt.id, (usedCounts.get(rt.id) || 0) + 1);
      if (usedCounts.get(rt.id) > rt.availableQuantity) return;
    }

    try {
      const quote = calculateQuote(accomId, selection, roomById, totalNights);
      if (!quote || quote.totalAmount <= 0) return;
      seenSignatures.add(sig);
      options.push({
        label,
        totalRooms: quote.selectedRooms.length,
        totalAdults,
        totalChildren,
        quote,
        bookingUrl: `/accommodation-detail?accommodationId=${accomId}&checkin=${ci}&checkout=${co}&rooms=${quote.selectedRooms.length}`,
      });
    } catch {
      // ignore invalid combinations
    }
  }

  // Strategy 1: Homogeneous combinations of each available room type
  for (const rt of availableTypes) {
    for (const k of candidateRoomCounts) {
      if (rt.availableQuantity < k) continue;
      if (k * rt.maxAdults < totalAdults || k * rt.maxChildren < totalChildren) continue;
      if (k * rt.maxOccupancy < totalAdults + totalChildren) continue;
      const dist = distributeGuestsIntoSlots(
        totalAdults,
        totalChildren,
        Array.from({ length: k }, () => ({ roomType: rt })),
      );
      if (dist) {
        const isPreferred = preferredRoomTypeId && Number(preferredRoomTypeId) === rt.id;
        evaluateSelection(dist, isPreferred ? `Đúng hạng phòng bạn quan tâm (${rt.name})` : `${k} × ${rt.name}`);
      }
    }
  }

  // Strategy 2: Mixed cheapest / high-capacity combinations if needed or for multi-room variety
  const flatUnits = [];
  for (const rt of [...availableTypes].sort((a, b) => a.roomSubtotal - b.roomSubtotal)) {
    for (let c = 0; c < Math.min(rt.availableQuantity, 10); c++) {
      flatUnits.push(rt);
    }
  }

  for (const k of candidateRoomCounts) {
    if (flatUnits.length < k) continue;
    // Try cheapest k units
    const cheapestSlice = flatUnits.slice(0, k).map((roomType) => ({ roomType }));
    const d1 = distributeGuestsIntoSlots(totalAdults, totalChildren, cheapestSlice);
    if (d1) evaluateSelection(d1, `Phương án tối ưu chi phí (${k} phòng)`);

    // Try largest-capacity first k units
    const byCap = [...flatUnits]
      .sort((a, b) => b.maxOccupancy - a.maxOccupancy || a.roomSubtotal - b.roomSubtotal)
      .slice(0, k)
      .map((roomType) => ({ roomType }));
    const d2 = distributeGuestsIntoSlots(totalAdults, totalChildren, byCap);
    if (d2) evaluateSelection(d2, `Phương án rộng rãi (${k} phòng)`);
  }

  if (options.length === 0) {
    return {
      status: "NO_FULL_FIT",
      accommodation: property,
      checkinDate: ci,
      checkoutDate: co,
      totalNights,
      message: `Không đủ sức chứa trọn vẹn cho ${totalAdults} người lớn${totalChildren ? `, ${totalChildren} trẻ em` : ""}${requestedRooms ? ` trong ${requestedRooms} phòng` : ""} vào ngày ${ci} – ${co}.`,
    };
  }

  // Sort: preferred room type first, then exact requestedRooms / fewest rooms, then lowest totalAmount
  options.sort((a, b) => {
    const aPref = preferredRoomTypeId && a.quote.selectedRooms.some((r) => r.roomTypeId === Number(preferredRoomTypeId)) ? 0 : 1;
    const bPref = preferredRoomTypeId && b.quote.selectedRooms.some((r) => r.roomTypeId === Number(preferredRoomTypeId)) ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.quote.totalAmount !== b.quote.totalAmount) return a.quote.totalAmount - b.quote.totalAmount;
    return a.totalRooms - b.totalRooms;
  });

  const topOptions = options.slice(0, 3);

  return {
    status: "READY",
    rangeScope: "RETURNED_OPTIONS",
    accommodation: property,
    checkinDate: ci,
    checkoutDate: co,
    totalNights,
    adults: totalAdults,
    children: totalChildren,
    requestedRooms,
    options: topOptions,
    minTotalAmount: Math.min(...topOptions.map((o) => o.quote.totalAmount)),
    maxTotalAmount: Math.max(...topOptions.map((o) => o.quote.totalAmount)),
  };
}

module.exports = {
  recommendRoomsAndQuote,
  todayInVietnam,
  parseYmd,
  buildStayNights,
};
