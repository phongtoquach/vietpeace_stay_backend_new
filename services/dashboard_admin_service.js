const db = require("../configs/database");
const { getAccommodationScope } = require("./accommodation_access_service");
const { BOOKING_STATUSES } = require("../constants/booking");

const sql = db.sqlObj;

function toNumber(value) {
  return value === null || value === undefined ? 0 : Number(value);
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

function bindScopeInputs(request, scope) {
  scope.inputs.forEach((input) => {
    request.input(input.name, input.type, input.value);
  });
  return request;
}

async function getDashboardSummary(currentUser = {}) {
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();

  const statsRequest = bindScopeInputs(pool.request(), scope);
  const statsResult = await statsRequest.query(`
    SELECT
      (SELECT COUNT(*)
       FROM dbo.bookings b
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}) AS total_bookings,
      (SELECT COUNT(*)
       FROM dbo.bookings b
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}
         AND b.status = 'PENDING') AS pending_bookings,
      (SELECT COUNT(*)
       FROM dbo.bookings b
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}
         AND b.status = 'CONFIRMED'
         AND b.checked_in_at IS NULL
         AND b.check_in_date = CAST(SYSDATETIME() AS DATE)) AS checkins_today,
      (SELECT COUNT(*)
       FROM dbo.bookings b
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}
         AND b.checked_in_at IS NOT NULL
         AND b.checked_out_at IS NULL
         AND b.check_out_date = CAST(SYSDATETIME() AS DATE)) AS checkouts_today,
      (SELECT COUNT(DISTINCT b.user_id)
       FROM dbo.bookings b
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}) AS total_customers,
      (SELECT ISNULL(SUM(p.amount - p.refunded_amount), 0)
       FROM dbo.payments p
       JOIN dbo.bookings b ON b.id = p.booking_id
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}
         AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
         AND p.paid_at >= DATEFROMPARTS(YEAR(SYSDATETIME()), MONTH(SYSDATETIME()), 1)
         AND p.paid_at < DATEADD(MONTH, 1, DATEFROMPARTS(YEAR(SYSDATETIME()), MONTH(SYSDATETIME()), 1))) AS monthly_revenue,
      (SELECT COUNT(*)
       FROM dbo.booking_items i
       JOIN dbo.bookings b ON b.id = i.booking_id
       JOIN dbo.accommodations a ON a.id = b.accommodation_id
       WHERE ${scope.condition}
         AND b.checked_in_at IS NOT NULL
         AND b.checked_out_at IS NULL) AS occupied_rooms,
      (SELECT ISNULL(SUM(rt.quantity), 0)
       FROM dbo.room_types rt
       JOIN dbo.accommodations a ON a.id = rt.accommodation_id
       WHERE ${scope.condition}
         AND rt.status = 1
         AND rt.deleted_at IS NULL) AS total_rooms;
  `);

  const statsRow = statsResult.recordset[0] || {};
  const totalRooms = toNumber(statsRow.total_rooms);
  const occupiedRooms = toNumber(statsRow.occupied_rooms);

  const recentRequest = bindScopeInputs(pool.request(), scope);
  const recentResult = await recentRequest.query(`
    SELECT TOP 5
      b.id,
      b.booking_code,
      b.status,
      b.contact_name,
      a.accommodation_name,
      b.total_amount,
      b.check_in_date,
      b.check_out_date,
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
    ORDER BY b.created_at DESC, b.id DESC;
  `);

  const upcomingRequest = bindScopeInputs(pool.request(), scope);
  const upcomingResult = await upcomingRequest.query(`
    SELECT TOP 4
      b.id,
      b.booking_code,
      b.contact_name,
      a.accommodation_name,
      b.check_in_date,
      b.total_nights,
      b.total_rooms,
      b.total_adults,
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
    WHERE ${scope.condition}
      AND b.status = 'CONFIRMED'
      AND b.checked_in_at IS NULL
      AND b.check_in_date >= CAST(SYSDATETIME() AS DATE)
    ORDER BY b.check_in_date ASC, b.id ASC;
  `);

  return {
    stats: {
      totalBookings: toNumber(statsRow.total_bookings),
      pendingBookings: toNumber(statsRow.pending_bookings),
      checkinsToday: toNumber(statsRow.checkins_today),
      checkoutsToday: toNumber(statsRow.checkouts_today),
      totalCustomers: toNumber(statsRow.total_customers),
      monthlyRevenue: toNumber(statsRow.monthly_revenue),
      occupiedRooms,
      totalRooms,
      availableRooms: Math.max(0, totalRooms - occupiedRooms),
    },
    recentBookings: recentResult.recordset.map((row) => ({
      id: Number(row.id),
      code: row.booking_code,
      status: row.status,
      customerName: row.contact_name,
      accommodationName: row.accommodation_name,
      totalAmount: toNumber(row.total_amount),
      checkInDate: toDateOnly(row.check_in_date),
      checkOutDate: toDateOnly(row.check_out_date),
      paymentStatus: row.payment_status || null,
      createdAt: toIsoString(row.created_at),
    })),
    upcomingCheckins: upcomingResult.recordset.map((row) => ({
      id: Number(row.id),
      code: row.booking_code,
      customerName: row.contact_name,
      accommodationName: row.accommodation_name,
      checkInDate: toDateOnly(row.check_in_date),
      totalNights: row.total_nights,
      roomsCount: row.total_rooms,
      adultsCount: row.total_adults,
      roomTypeNames: row.room_type_names
        ? String(row.room_type_names).split(", ")
        : [],
    })),
  };
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

function overlapDays(stayStart, stayEnd, monthStart, monthEnd) {
  const start = Math.max(Date.parse(stayStart), Date.parse(monthStart));
  const end = Math.min(Date.parse(stayEnd), Date.parse(monthEnd));
  return Math.max(0, Math.round((end - start) / 86400000));
}

async function getDashboardCharts(currentUser = {}) {
  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  const revenueRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const revenueResult = await revenueRequest.query(`
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
    GROUP BY MONTH(p.paid_at);
  `);

  const bookingsRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const bookingsResult = await bookingsRequest.query(`
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

  const staysRequest = bindScopeInputs(pool.request(), scope)
    .input("yearStart", sql.Date, yearStart)
    .input("yearEnd", sql.Date, yearEnd);
  const staysResult = await staysRequest.query(`
    SELECT
      b.id,
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
    GROUP BY b.id, b.check_in_date, b.check_out_date;
  `);

  const roomsRequest = bindScopeInputs(pool.request(), scope);
  const roomsResult = await roomsRequest.query(`
    SELECT ISNULL(SUM(rt.quantity), 0) AS total_rooms
    FROM dbo.room_types rt
    JOIN dbo.accommodations a ON a.id = rt.accommodation_id
    WHERE ${scope.condition}
      AND rt.status = 1
      AND rt.deleted_at IS NULL;
  `);

  const statusRequest = bindScopeInputs(pool.request(), scope);
  const statusResult = await statusRequest.query(`
    SELECT b.status, COUNT(*) AS total
    FROM dbo.bookings b
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    WHERE ${scope.condition}
    GROUP BY b.status;
  `);

  const totalRooms = toNumber(roomsResult.recordset[0]?.total_rooms);

  const monthlyRevenue = Array(12).fill(0);
  revenueResult.recordset.forEach((row) => {
    monthlyRevenue[Number(row.month_index) - 1] = toNumber(row.revenue);
  });

  const monthlyBookings = Array(12).fill(0);
  bookingsResult.recordset.forEach((row) => {
    monthlyBookings[Number(row.month_index) - 1] = toNumber(row.total);
  });

  const months = buildMonthBounds(year);
  const roomNights = Array(12).fill(0);

  staysResult.recordset.forEach((row) => {
    const stayStart = toDateOnly(row.check_in_date);
    const stayEnd = toDateOnly(row.check_out_date);
    const rooms = toNumber(row.rooms);

    months.forEach((month, index) => {
      const days = overlapDays(stayStart, stayEnd, month.start, month.end);
      roomNights[index] += rooms * days;
    });
  });

  const monthlyOccupancy = months.map((month, index) => {
    if (totalRooms <= 0) {
      return 0;
    }

    const daysInMonth = Math.round(
      (Date.parse(month.end) - Date.parse(month.start)) / 86400000,
    );
    const ratio = roomNights[index] / (totalRooms * daysInMonth);

    return Number((ratio * 100).toFixed(1));
  });

  const statusCounts = new Map(
    statusResult.recordset.map((row) => [row.status, toNumber(row.total)]),
  );

  return {
    year,
    monthlyRevenue,
    monthlyBookings,
    monthlyOccupancy,
    statusDistribution: BOOKING_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) || 0,
    })),
  };
}

module.exports = {
  getDashboardSummary,
  getDashboardCharts,
};
