const db = require("../configs/database");
const {
  getAccommodationScope,
  assertAccommodationAccess,
} = require("./accommodation_access_service");
const { BOOKING_STATUSES } = require("../constants/booking");

const sql = db.sqlObj;

function toNumber(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toIsoString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function roundTo1(value) {
  return Number(toNumber(value).toFixed(1));
}

function percent(numerator, denominator) {
  return denominator > 0 ? roundTo1((numerator / denominator) * 100) : 0;
}

function normalizeReportYear(rawYear) {
  if (rawYear === undefined || rawYear === null || String(rawYear).trim() === "") {
    return new Date().getFullYear();
  }

  const year = Number(rawYear);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    const error = new Error("Năm báo cáo không hợp lệ.");
    error.statusCode = 400;
    error.errorCode = "INVALID_YEAR";
    throw error;
  }

  return year;
}

function normalizeReportMonth(rawMonth) {
  if (
    rawMonth === undefined ||
    rawMonth === null ||
    String(rawMonth).trim() === "" ||
    String(rawMonth).trim() === "0"
  ) {
    return null;
  }

  const month = Number(rawMonth);

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    const error = new Error("Tháng báo cáo không hợp lệ.");
    error.statusCode = 400;
    error.errorCode = "INVALID_MONTH";
    throw error;
  }

  return month;
}

function parseAccommodationId(rawValue) {
  if (
    rawValue === undefined ||
    rawValue === null ||
    String(rawValue).trim() === ""
  ) {
    return null;
  }

  const accommodationId = Number(rawValue);

  if (!Number.isInteger(accommodationId) || accommodationId <= 0) {
    const error = new Error("Cơ sở lưu trú không hợp lệ.");
    error.statusCode = 400;
    error.errorCode = "INVALID_ACCOMMODATION";
    throw error;
  }

  return accommodationId;
}

function bindAccommodationFilter(request, accommodationId) {
  if (!accommodationId) {
    return request;
  }

  return request.input("accommodationId", sql.Int, accommodationId);
}

function accommodationFilterClause(accommodationId) {
  return accommodationId ? "AND b.accommodation_id = @accommodationId" : "";
}

function bindScopeInputs(request, scope) {
  scope.inputs.forEach((input) => {
    request.input(input.name, input.type, input.value);
  });
  return request;
}

function buildYearBounds(year) {
  return {
    yearStart: `${year}-01-01`,
    yearEnd: `${year + 1}-01-01`,
  };
}

function buildPeriodBounds(year, month) {
  if (!month) {
    const periodStart = `${year}-01-01`;
    const periodEnd = `${year + 1}-01-01`;
    return { periodStart, periodEnd, days: daysBetween(periodStart, periodEnd) };
  }

  const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const periodEnd = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  return { periodStart, periodEnd, days: daysBetween(periodStart, periodEnd) };
}

function buildMonthBounds(year) {
  const months = [];

  for (let month = 1; month <= 12; month += 1) {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const end = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    months.push({ start, end });
  }

  return months;
}

function overlapDays(stayStart, stayEnd, periodStart, periodEnd) {
  const start = Math.max(Date.parse(stayStart), Date.parse(periodStart));
  const end = Math.min(Date.parse(stayEnd), Date.parse(periodEnd));
  return Math.max(0, Math.round((end - start) / 86400000));
}

function daysBetween(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
}

function toDateOnly(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return typeof value === "string" ? value.slice(0, 10) : null;
}

async function getRevenueReport(currentUser = {}, year, month, query = {}) {
  const reportYear = normalizeReportYear(year);
  const reportMonth = normalizeReportMonth(month);
  const accommodationId = parseAccommodationId(query.accommodationId);
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();
  const accommodation = accommodationId
    ? await assertAccommodationAccess(accommodationId, currentUser, { pool })
    : null;
  const accommodationFilter = accommodationFilterClause(accommodationId);
  const { yearStart, yearEnd } = buildYearBounds(reportYear);
  const { periodStart, periodEnd, days: periodDays } = buildPeriodBounds(reportYear, reportMonth);
  const orderBy = scope.isAdmin
    ? "SUM(p.amount - p.refunded_amount) DESC, a.accommodation_name ASC"
    : "a.accommodation_name ASC";

  const monthlyRequest = bindAccommodationFilter(
    bindScopeInputs(pool.request(), scope)
      .input("yearStart", sql.Date, yearStart)
      .input("yearEnd", sql.Date, yearEnd),
    accommodationId,
  );
  const monthlyResult = await monthlyRequest.query(`
    SELECT
      MONTH(p.paid_at) AS month_index,
      SUM(p.amount - p.refunded_amount) AS revenue
    FROM dbo.payments p
    JOIN dbo.bookings b ON b.id = p.booking_id
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND p.paid_at >= @yearStart
      AND p.paid_at < @yearEnd
      ${accommodationFilter}
    GROUP BY MONTH(p.paid_at);
  `);

  const propertiesRequest = bindAccommodationFilter(
    bindScopeInputs(pool.request(), scope)
      .input("periodStart", sql.Date, periodStart)
      .input("periodEnd", sql.Date, periodEnd),
    accommodationId,
  );
  const propertiesResult = await propertiesRequest.query(`
    SELECT
      a.id,
      a.accommodation_name AS name,
      SUM(p.amount - p.refunded_amount) AS revenue,
      COUNT(DISTINCT p.booking_id) AS bookings
    FROM dbo.payments p
    JOIN dbo.bookings b ON b.id = p.booking_id
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND p.paid_at >= @periodStart
      AND p.paid_at < @periodEnd
      ${accommodationFilter}
    GROUP BY a.id, a.accommodation_name
    ORDER BY ${orderBy};
  `);

  let daily = [];

  if (reportMonth) {
    const dailyRequest = bindAccommodationFilter(
      bindScopeInputs(pool.request(), scope)
        .input("periodStart", sql.Date, periodStart)
        .input("periodEnd", sql.Date, periodEnd),
      accommodationId,
    );
    const dailyResult = await dailyRequest.query(`
      SELECT
        DAY(p.paid_at) AS day_index,
        SUM(p.amount - p.refunded_amount) AS revenue,
        COUNT(DISTINCT p.booking_id) AS bookings
      FROM dbo.payments p
      JOIN dbo.bookings b ON b.id = p.booking_id
      JOIN dbo.accommodations a ON a.id = b.accommodation_id
      WHERE ${scope.condition}
        AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND p.paid_at >= @periodStart
        AND p.paid_at < @periodEnd
        ${accommodationFilter}
      GROUP BY DAY(p.paid_at);
    `);
    const dailyByDay = new Map(
      dailyResult.recordset.map((row) => [Number(row.day_index), row]),
    );

    daily = Array.from({ length: periodDays }, (_, index) => {
      const row = dailyByDay.get(index + 1);
      return {
        day: index + 1,
        revenue: toNumber(row?.revenue),
        bookings: toNumber(row?.bookings),
      };
    });
  }

  const monthlyByIndex = Array(12).fill(0);
  monthlyResult.recordset.forEach((row) => {
    monthlyByIndex[Number(row.month_index) - 1] = toNumber(row.revenue);
  });

  const monthly = monthlyByIndex.map((revenue, index) => ({
    month: index + 1,
    revenue,
  }));

  const properties = propertiesResult.recordset.map((row) => ({
    id: Number(row.id),
    name: row.name,
    revenue: toNumber(row.revenue),
    bookings: toNumber(row.bookings),
  }));

  const totalRevenue = monthlyByIndex.reduce((total, revenue) => total + revenue, 0);
  const bestEntry = monthly.reduce(
    (best, entry) => (entry.revenue > (best ? best.revenue : 0) ? entry : best),
    null,
  );
  const monthTotals = reportMonth
    ? {
        revenue: properties.reduce((total, item) => total + item.revenue, 0),
        bookings: properties.reduce((total, item) => total + item.bookings, 0),
      }
    : null;

  return {
    year: reportYear,
    month: reportMonth,
    scope: {
      isAdmin: scope.isAdmin,
      propertyCount: accommodationId ? 1 : properties.length,
    },
    accommodation: accommodation
      ? { id: Number(accommodation.id), name: accommodation.name }
      : null,
    totals: {
      revenue: totalRevenue,
      avgMonthlyRevenue: Math.round(totalRevenue / 12),
      bestMonth: bestEntry && bestEntry.revenue > 0
        ? { month: bestEntry.month, revenue: bestEntry.revenue }
        : null,
    },
    monthTotals,
    monthly,
    daily,
    properties,
  };
}

async function queryBookingTotals(pool, scope, start, end) {
  const request = bindScopeInputs(pool.request(), scope)
    .input("periodStart", sql.Date, start)
    .input("periodEnd", sql.Date, end);
  const result = await request.query(`
    SELECT
      COUNT(*) AS total_bookings,
      SUM(CASE WHEN b.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_bookings
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.created_at >= @periodStart
      AND b.created_at < @periodEnd;
  `);

  return result.recordset[0] || {};
}

async function queryBookingAverages(pool, scope, start, end) {
  const request = bindScopeInputs(pool.request(), scope)
    .input("periodStart", sql.Date, start)
    .input("periodEnd", sql.Date, end);
  const result = await request.query(`
    SELECT
      AVG(CAST(b.total_nights AS FLOAT)) AS avg_nights,
      AVG(CAST(
        CASE
          WHEN DATEDIFF(day, b.created_at, b.check_in_date) > 0
          THEN DATEDIFF(day, b.created_at, b.check_in_date)
          ELSE 0
        END AS FLOAT
      )) AS avg_lead_days
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.status = 'CONFIRMED'
      AND b.check_in_date >= @periodStart
      AND b.check_in_date < @periodEnd;
  `);

  return result.recordset[0] || {};
}

async function getBookingsReport(currentUser = {}, year, month) {
  const reportYear = normalizeReportYear(year);
  const reportMonth = normalizeReportMonth(month);
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();
  const { yearStart, yearEnd } = buildYearBounds(reportYear);
  const { periodStart, periodEnd, days: periodDays } = buildPeriodBounds(reportYear, reportMonth);
  const orderBy = scope.isAdmin
    ? "COUNT(*) DESC, a.accommodation_name ASC"
    : "a.accommodation_name ASC";

  const totalsRow = await queryBookingTotals(pool, scope, yearStart, yearEnd);
  const averagesRow = await queryBookingAverages(pool, scope, yearStart, yearEnd);
  const monthTotalsRow = reportMonth
    ? await queryBookingTotals(pool, scope, periodStart, periodEnd)
    : null;
  const monthAveragesRow = reportMonth
    ? await queryBookingAverages(pool, scope, periodStart, periodEnd)
    : null;

  const monthlyRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const monthlyResult = await monthlyRequest.query(`
    SELECT
      MONTH(b.created_at) AS month_index,
      COUNT(*) AS total
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.created_at >= @yearStart
      AND b.created_at < @yearEnd
    GROUP BY MONTH(b.created_at);
  `);

  const statusRequest = bindScopeInputs(pool.request(), scope)
    .input("periodStart", sql.Date, periodStart)
    .input("periodEnd", sql.Date, periodEnd);
  const statusResult = await statusRequest.query(`
    SELECT b.status, COUNT(*) AS total
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.created_at >= @periodStart
      AND b.created_at < @periodEnd
    GROUP BY b.status;
  `);

  const propertiesRequest = bindScopeInputs(pool.request(), scope)
    .input("periodStart", sql.Date, periodStart)
    .input("periodEnd", sql.Date, periodEnd);
  const propertiesResult = await propertiesRequest.query(`
    SELECT
      a.id,
      a.accommodation_name AS name,
      COUNT(*) AS bookings,
      SUM(CASE WHEN b.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_bookings
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.created_at >= @periodStart
      AND b.created_at < @periodEnd
    GROUP BY a.id, a.accommodation_name
    ORDER BY ${orderBy};
  `);

  let daily = [];

  if (reportMonth) {
    const dailyRequest = bindScopeInputs(pool.request(), scope)
      .input("periodStart", sql.Date, periodStart)
      .input("periodEnd", sql.Date, periodEnd);
    const dailyResult = await dailyRequest.query(`
      SELECT
        DAY(b.created_at) AS day_index,
        COUNT(*) AS total,
        SUM(CASE WHEN b.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_bookings
      FROM dbo.bookings b
      JOIN dbo.accommodations a ON a.id = b.accommodation_id
      WHERE ${scope.condition}
        AND b.created_at >= @periodStart
        AND b.created_at < @periodEnd
      GROUP BY DAY(b.created_at);
    `);
    const dailyByDay = new Map(
      dailyResult.recordset.map((row) => [Number(row.day_index), row]),
    );

    daily = Array.from({ length: periodDays }, (_, index) => {
      const row = dailyByDay.get(index + 1);
      const bookings = toNumber(row?.total);
      const cancelledBookings = toNumber(row?.cancelled_bookings);

      return {
        day: index + 1,
        bookings,
        cancelledBookings,
        cancelRate: percent(cancelledBookings, bookings),
      };
    });
  }

  const totalBookings = toNumber(totalsRow.total_bookings);
  const cancelledBookings = toNumber(totalsRow.cancelled_bookings);
  const monthTotals = reportMonth
    ? {
        totalBookings: toNumber(monthTotalsRow.total_bookings),
        cancelledBookings: toNumber(monthTotalsRow.cancelled_bookings),
        cancelRate: percent(
          toNumber(monthTotalsRow.cancelled_bookings),
          toNumber(monthTotalsRow.total_bookings),
        ),
        avgNights: roundTo1(monthAveragesRow.avg_nights),
        avgLeadDays: roundTo1(monthAveragesRow.avg_lead_days),
      }
    : null;

  const monthlyByIndex = Array(12).fill(0);
  monthlyResult.recordset.forEach((row) => {
    monthlyByIndex[Number(row.month_index) - 1] = toNumber(row.total);
  });

  const statusCounts = new Map(
    statusResult.recordset.map((row) => [row.status, toNumber(row.total)]),
  );

  const properties = propertiesResult.recordset.map((row) => {
    const bookings = toNumber(row.bookings);
    const propertyCancelled = toNumber(row.cancelled_bookings);

    return {
      id: Number(row.id),
      name: row.name,
      bookings,
      cancelledBookings: propertyCancelled,
      cancelRate: percent(propertyCancelled, bookings),
    };
  });

  return {
    year: reportYear,
    month: reportMonth,
    scope: {
      isAdmin: scope.isAdmin,
      propertyCount: properties.length,
    },
    totals: {
      totalBookings,
      cancelledBookings,
      cancelRate: percent(cancelledBookings, totalBookings),
      avgNights: roundTo1(averagesRow.avg_nights),
      avgLeadDays: roundTo1(averagesRow.avg_lead_days),
    },
    monthTotals,
    monthly: monthlyByIndex.map((bookings, index) => ({
      month: index + 1,
      bookings,
    })),
    daily,
    statusDistribution: BOOKING_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) || 0,
    })),
    properties,
  };
}

async function getOccupancyReport(currentUser = {}, year, month) {
  const reportYear = normalizeReportYear(year);
  const reportMonth = normalizeReportMonth(month);
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();
  const { yearStart, yearEnd } = buildYearBounds(reportYear);
  const { periodStart, periodEnd, days: periodDays } = buildPeriodBounds(reportYear, reportMonth);
  const months = buildMonthBounds(reportYear);
  const yearDays = daysBetween(yearStart, yearEnd);

  const staysRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const staysResult = await staysRequest.query(`
    SELECT
      b.id,
      b.accommodation_id,
      a.accommodation_name AS name,
      b.check_in_date,
      b.check_out_date,
      COUNT(i.id) AS rooms
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    JOIN dbo.booking_items i ON i.booking_id = b.id
    WHERE ${scope.condition}
      AND b.status = 'CONFIRMED'
      AND b.check_in_date < @yearEnd
      AND b.check_out_date > @yearStart
    GROUP BY b.id, b.accommodation_id, a.accommodation_name, b.check_in_date, b.check_out_date;
  `);

  const roomsRequest = bindScopeInputs(pool.request(), scope);
  const roomsResult = await roomsRequest.query(`
    SELECT
      a.id,
      a.accommodation_name AS name,
      ISNULL(SUM(rt.quantity), 0) AS total_rooms
    FROM dbo.room_types rt
    JOIN dbo.accommodations a ON a.id = rt.accommodation_id
    WHERE ${scope.condition}
      AND rt.status = 1
      AND rt.deleted_at IS NULL
    GROUP BY a.id, a.accommodation_name;
  `);

  const revenueRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const revenueResult = await revenueRequest.query(`
    SELECT
      a.id,
      MONTH(p.paid_at) AS month_index,
      SUM(p.amount - p.refunded_amount) AS revenue
    FROM dbo.payments p
    JOIN dbo.bookings b ON b.id = p.booking_id
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND p.paid_at >= @yearStart
      AND p.paid_at < @yearEnd
    GROUP BY a.id, MONTH(p.paid_at);
  `);

  const roomsById = new Map(
    roomsResult.recordset.map((row) => [
      Number(row.id),
      { name: row.name, rooms: toNumber(row.total_rooms) },
    ]),
  );
  const revenueByYear = new Map();
  const revenueByMonth = new Map();

  revenueResult.recordset.forEach((row) => {
    const accommodationId = Number(row.id);
    const revenue = toNumber(row.revenue);

    revenueByYear.set(
      accommodationId,
      (revenueByYear.get(accommodationId) || 0) + revenue,
    );

    if (reportMonth && Number(row.month_index) === reportMonth) {
      revenueByMonth.set(
        accommodationId,
        (revenueByMonth.get(accommodationId) || 0) + revenue,
      );
    }
  });

  const roomNightsByMonth = Array(12).fill(0);
  const dailyRoomNights = reportMonth ? Array(periodDays).fill(0) : [];
  const propertyRoomNights = new Map();

  staysResult.recordset.forEach((row) => {
    const stayStart = toDateOnly(row.check_in_date);
    const stayEnd = toDateOnly(row.check_out_date);
    const rooms = toNumber(row.rooms);
    const accommodationId = Number(row.accommodation_id);
    const property = propertyRoomNights.get(accommodationId) || {
      id: accommodationId,
      name: row.name,
      roomNights: 0,
      monthRoomNights: 0,
    };

    months.forEach((month, index) => {
      const nights = rooms * overlapDays(stayStart, stayEnd, month.start, month.end);
      roomNightsByMonth[index] += nights;
      property.roomNights += nights;

      if (reportMonth && index === reportMonth - 1) {
        property.monthRoomNights += nights;
      }
    });

    if (reportMonth) {
      for (let dayIndex = 0; dayIndex < periodDays; dayIndex += 1) {
        const dayStart = new Date(Date.parse(periodStart) + dayIndex * 86400000)
          .toISOString()
          .slice(0, 10);
        const dayEnd = new Date(Date.parse(periodStart) + (dayIndex + 1) * 86400000)
          .toISOString()
          .slice(0, 10);
        dailyRoomNights[dayIndex] += rooms * overlapDays(stayStart, stayEnd, dayStart, dayEnd);
      }
    }

    propertyRoomNights.set(accommodationId, property);
  });

  const totalRooms = Array.from(roomsById.values())
    .reduce((total, item) => total + item.rooms, 0);
  const totalRoomNights = roomNightsByMonth
    .reduce((total, nights) => total + nights, 0);
  const totalRevenue = Array.from(revenueByYear.values())
    .reduce((total, revenue) => total + revenue, 0);
  const monthRoomNights = Array.from(propertyRoomNights.values())
    .reduce((total, item) => total + item.monthRoomNights, 0);
  const monthRevenue = Array.from(revenueByMonth.values())
    .reduce((total, revenue) => total + revenue, 0);

  const monthly = months.map((month, index) => {
    const daysInMonth = daysBetween(month.start, month.end);
    const occupancy = totalRooms > 0
      ? roundTo1((roomNightsByMonth[index] / (totalRooms * daysInMonth)) * 100)
      : 0;

    return { month: index + 1, occupancy };
  });

  const properties = Array.from(propertyRoomNights.values())
    .map((item) => {
      const periodRoomNights = reportMonth ? item.monthRoomNights : item.roomNights;
      const rooms = roomsById.get(item.id)?.rooms || 0;
      const revenue = (reportMonth
        ? revenueByMonth.get(item.id)
        : revenueByYear.get(item.id)) || 0;

      return {
        id: item.id,
        name: item.name,
        rooms,
        roomNights: periodRoomNights,
        occupancy: rooms > 0
          ? roundTo1((periodRoomNights / (rooms * periodDays)) * 100)
          : 0,
        adr: periodRoomNights > 0 ? Math.round(revenue / periodRoomNights) : 0,
        revpar: rooms > 0 ? Math.round(revenue / (rooms * periodDays)) : 0,
      };
    })
    .filter((item) => item.roomNights > 0);

  properties.sort((a, b) => {
    if (scope.isAdmin && b.occupancy !== a.occupancy) {
      return b.occupancy - a.occupancy;
    }
    return a.name.localeCompare(b.name, "vi");
  });

  const monthTotals = reportMonth
    ? {
        totalRooms,
        roomNights: monthRoomNights,
        occupancy: totalRooms > 0
          ? roundTo1((monthRoomNights / (totalRooms * periodDays)) * 100)
          : 0,
        adr: monthRoomNights > 0 ? Math.round(monthRevenue / monthRoomNights) : 0,
        revpar: totalRooms > 0
          ? Math.round(monthRevenue / (totalRooms * periodDays))
          : 0,
      }
    : null;

  const daily = reportMonth
    ? dailyRoomNights.map((roomNights, index) => ({
        day: index + 1,
        roomNights,
        occupancy: totalRooms > 0
          ? roundTo1((roomNights / totalRooms) * 100)
          : 0,
      }))
    : [];

  return {
    year: reportYear,
    month: reportMonth,
    scope: {
      isAdmin: scope.isAdmin,
      propertyCount: properties.length,
    },
    totals: {
      totalRooms,
      roomNights: totalRoomNights,
      occupancy: totalRooms > 0
        ? roundTo1((totalRoomNights / (totalRooms * yearDays)) * 100)
        : 0,
      adr: totalRoomNights > 0 ? Math.round(totalRevenue / totalRoomNights) : 0,
      revpar: totalRooms > 0
        ? Math.round(totalRevenue / (totalRooms * yearDays))
        : 0,
    },
    monthTotals,
    monthly,
    daily,
    properties,
  };
}

async function getMonthlyOrders(currentUser = {}, year, month, query = {}) {
  const reportYear = normalizeReportYear(year);
  const reportMonth = normalizeReportMonth(month);

  if (!reportMonth) {
    const error = new Error("Vui lòng chọn tháng để xem chi tiết.");
    error.statusCode = 400;
    error.errorCode = "INVALID_MONTH";
    throw error;
  }

  const accommodationId = parseAccommodationId(query.accommodationId);
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  if (accommodationId) {
    await assertAccommodationAccess(accommodationId, currentUser, { pool });
  }

  const accommodationFilter = accommodationFilterClause(accommodationId);
  const { periodStart, periodEnd } = buildPeriodBounds(reportYear, reportMonth);
  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(100, Math.max(1, parsePositiveInt(query.limit, 10)));
  const offset = (page - 1) * limit;

  const countRequest = bindAccommodationFilter(
    bindScopeInputs(pool.request(), scope)
      .input("periodStart", sql.Date, periodStart)
      .input("periodEnd", sql.Date, periodEnd),
    accommodationId,
  );
  const countResult = await countRequest.query(`
    SELECT COUNT(*) AS total_orders
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
      AND b.created_at >= @periodStart
      AND b.created_at < @periodEnd
      ${accommodationFilter};
  `);
  const total = toNumber(countResult.recordset[0]?.total_orders);

  const itemsRequest = bindAccommodationFilter(
    bindScopeInputs(pool.request(), scope)
      .input("periodStart", sql.Date, periodStart)
      .input("periodEnd", sql.Date, periodEnd)
      .input("offset", sql.Int, offset)
      .input("limit", sql.Int, limit),
    accommodationId,
  );
  const itemsResult = await itemsRequest.query(`
    SELECT
      b.id,
      b.booking_code,
      b.contact_name,
      b.accommodation_id,
      a.accommodation_name,
      b.check_in_date,
      b.check_out_date,
      b.total_amount,
      b.status,
      b.created_at,
      latest_payment.status AS payment_status
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    OUTER APPLY (
      SELECT TOP 1 p.status
      FROM dbo.payments p
      WHERE p.booking_id = b.id
      ORDER BY p.created_at DESC, p.id DESC
    ) latest_payment
    WHERE ${scope.condition}
      AND b.created_at >= @periodStart
      AND b.created_at < @periodEnd
      ${accommodationFilter}
    ORDER BY b.created_at DESC, b.id DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
  `);

  return {
    items: itemsResult.recordset.map((row) => ({
      id: Number(row.id),
      code: row.booking_code,
      customerName: row.contact_name,
      accommodationId: Number(row.accommodation_id),
      accommodationName: row.accommodation_name,
      checkInDate: toDateOnly(row.check_in_date),
      checkOutDate: toDateOnly(row.check_out_date),
      totalAmount: toNumber(row.total_amount),
      status: row.status,
      paymentStatus: row.payment_status || null,
      createdAt: toIsoString(row.created_at),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

module.exports = {
  normalizeReportYear,
  normalizeReportMonth,
  getRevenueReport,
  getBookingsReport,
  getOccupancyReport,
  getMonthlyOrders,
};
