const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
require('dotenv').config({ quiet: true });

const enabled = process.env.RUN_DB_PRICING_TESTS === '1';

const dailySearchService = require('../services/accommodation_daily_search_service');
const accommodationController = require('../controllers/web/accommodation/accommodationController');
const accommodationWebRoutes = require('../routes/web/accommodation_web_routes');

let sql;
let db;
let pool;
let RealRequest;
let RealTransaction;
let active;
let pricingService;
let bookingWebService;
let admin;

function addDaysIso(baseIso, offsetDays) {
  const dt = new Date(`${baseIso}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

async function callSearchControllerHttp(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/web/accommodations', accommodationWebRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/web/accommodations/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

before(async () => {
  if (!enabled) return;
  db = require('../configs/database');
  sql = db.sqlObj;
  pool = await db.connectDB();
  RealRequest = sql.Request;
  RealTransaction = sql.Transaction;

  class SavepointTransaction {
    constructor() {
      this.name = 'search_' + crypto.randomBytes(6).toString('hex');
    }
    async begin() {
      await new RealRequest(active).query(`SAVE TRANSACTION ${this.name};`);
    }
    async commit() {}
    async rollback() {
      await new RealRequest(active).query(`ROLLBACK TRANSACTION ${this.name};`);
    }
  }

  class TestRequest extends RealRequest {
    constructor() {
      super(active);
    }
  }

  sql.Transaction = SavepointTransaction;
  sql.Request = TestRequest;
  db.getDBPool = () => ({
    request: () => new RealRequest(active),
  });

  pricingService = require('../services/pricing_service');
  bookingWebService = require('../services/booking_web_service');
});

after(async () => {
  if (enabled && pool) {
    sql.Request = RealRequest;
    sql.Transaction = RealTransaction;
    await pool.close();
  }
});

async function fixture(run) {
  active = new RealTransaction(pool);
  await active.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const adminRes = await new RealRequest(active).query(
      "SELECT TOP(1) id, role FROM dbo.users WHERE role = 'ADMIN' AND status = 1 ORDER BY created_at;"
    );
    admin = adminRes.recordset[0];
    assert.ok(admin, 'An active ADMIN user is required for rollback fixtures');
    await run();
  } finally {
    await active.rollback();
    active = null;
  }
}

function dbTest(name, fn) {
  test(name, { skip: !enabled }, () => fixture(fn));
}

async function applyDailyOverride({ accId, roomIds, start, end, price, reason = 'Test daily override' }) {
  const payload = {
    accommodationId: accId,
    roomIds,
    start,
    end,
    action: 'fixed_price',
    value: price,
    conflictHandling: 'replace',
    reason,
  };
  const preview = await pricingService.change(payload, admin, false);
  assert.ok(preview.previewToken, 'Expected previewToken from pricing_service.change');
  await pricingService.change({ ...payload, previewToken: preview.previewToken }, admin, true);
}

// ============================================================
// Always-run validation & controller wiring tests (no DB hit)
// ============================================================

test('validation rejects stays over 90 nights and invalid date or price combinations', async () => {
  const over90 = await dailySearchService.searchAccommodationsByFilters({
    checkinDate: '2027-01-01',
    checkoutDate: addDaysIso('2027-01-01', 91),
  });
  assert.equal(over90.success, false);
  assert.equal(over90.errorCode, 'DATA_INVALID');
  assert.equal(over90.errors.checkoutDate, 'Kỳ lưu trú tối đa 90 đêm.');

  const sameDay = await dailySearchService.searchAccommodationsByFilters({
    checkinDate: '2027-01-01',
    checkoutDate: '2027-01-01',
  });
  assert.equal(sameDay.success, false);
  assert.equal(sameDay.errors.checkoutDate, 'checkoutDate phải sau checkinDate.');

  const missingCheckout = await dailySearchService.searchAccommodationsByFilters({
    checkinDate: '2027-01-01',
  });
  assert.equal(missingCheckout.success, false);
  assert.equal(missingCheckout.errors.checkoutDate, 'Phải truyền đồng thời checkinDate và checkoutDate.');

  const roomsWithoutDates = await dailySearchService.searchAccommodationsByFilters({ rooms: 2 });
  assert.equal(roomsWithoutDates.success, false);
  assert.equal(roomsWithoutDates.errors.rooms, 'Cần checkinDate và checkoutDate khi tìm theo số phòng.');

  const invertedPriceRange = await dailySearchService.searchAccommodationsByFilters({
    priceFrom: 2000000,
    priceTo: 1000000,
  });
  assert.equal(invertedPriceRange.success, false);
  assert.equal(invertedPriceRange.errors.priceTo, 'priceTo phải lớn hơn hoặc bằng priceFrom.');
});

test('accommodationController uses daily search service and rejects > 90 nights and non-object bodies', async () => {
  const invalidBodyRes = await new Promise((resolve) => {
    let statusCode;
    accommodationController.searchAccommodations(
      { body: [] },
      {
        status(code) {
          statusCode = code;
          return {
            json(payload) {
              resolve({ statusCode, payload });
            },
          };
        },
      }
    );
  });
  assert.equal(invalidBodyRes.statusCode, 400);
  assert.equal(invalidBodyRes.payload.errorCode, 'DATA_INVALID');

  const over90Http = await callSearchControllerHttp({
    checkinDate: '2027-02-01',
    checkoutDate: addDaysIso('2027-02-01', 91),
    rooms: 1,
  });
  assert.equal(over90Http.status, 200);
  assert.equal(over90Http.json.success, false);
  assert.equal(over90Http.json.errorCode, 'DATA_INVALID');
  assert.equal(over90Http.json.errors.checkoutDate, 'Kỳ lưu trú tối đa 90 đêm.');
});

// ============================================================
// DB rollback integration tests (RUN_DB_PRICING_TESTS=1)
// ============================================================

dbTest('search calculates weekly + period + daily override average matching booking preview roomSubtotal/nights', async () => {
  const r = await new RealRequest(active).query(`
    SELECT TOP(1) a.id AS acc_id
    FROM dbo.accommodations a
    JOIN dbo.room_types rt ON rt.accommodation_id = a.id AND rt.status = 1 AND rt.deleted_at IS NULL
    WHERE a.status = 1 AND a.deleted_at IS NULL
    GROUP BY a.id
    HAVING COUNT(rt.id) >= 2
    ORDER BY a.id;
  `);
  const accId = Number(r.recordset[0]?.acc_id);
  assert.ok(accId > 0);

  const roomsRes = await new RealRequest(active)
    .input('accId', sql.BigInt, accId)
    .query('SELECT id, base_price FROM dbo.room_types WHERE accommodation_id = @accId AND status = 1 AND deleted_at IS NULL ORDER BY id;');
  const roomRows = roomsRes.recordset;
  const targetRoomId = Number(roomRows[0].id);
  const otherRoomIds = roomRows.slice(1).map((row) => Number(row.id));

  const d1 = addDaysIso(pricingService.today(), 150);
  const d2 = addDaysIso(d1, 1);
  const d3 = addDaysIso(d1, 2);
  const d4 = addDaysIso(d1, 3);

  // Night 1: weekday price = 1,110,000; other rooms priced higher so targetRoomId sets min_base_price.
  await new RealRequest(active)
    .input('rtId', sql.BigInt, targetRoomId)
    .input('d1', sql.Date, d1)
    .input('d4', sql.Date, d4)
    .query('DELETE FROM dbo.room_daily_rate_overrides WHERE room_type_id = @rtId AND stay_date >= @d1 AND stay_date < @d4;');

  const weekdayPayload = {
    accommodationId: accId,
    roomIds: [targetRoomId],
    start: d1,
    end: d4,
    action: 'weekday',
    prices: Array(7).fill(1110000),
    conflictHandling: 'replace',
    reason: 'Test weekly schedule',
  };
  const weekdayPreview = await pricingService.change(weekdayPayload, admin, false);
  assert.ok(weekdayPreview.previewToken, 'Expected previewToken for weekday schedule');
  await pricingService.change({ ...weekdayPayload, previewToken: weekdayPreview.previewToken }, admin, true);

  await applyDailyOverride({ accId, roomIds: otherRoomIds, start: d1, end: d4, price: 6000000, reason: 'Higher rooms' });

  // Night 2: special period = 1,440,000
  const periodRes = await pricingService.savePeriod(
    { name: `Search Test Period ${d2}`, start_date: d2, end_date: d3, adjustment_direction: 'increase', description: 'Test' },
    admin
  );
  const periodPayload = {
    accommodationId: accId,
    roomIds: [targetRoomId],
    start: d2,
    end: d3,
    periodId: Number(periodRes.id),
    action: 'period',
    adjustmentType: 'fixed_price',
    value: 1440000,
    priority: 10,
    conflictHandling: 'replace',
    reason: 'Test period rate',
  };
  const periodPreview = await pricingService.change(periodPayload, admin, false);
  assert.ok(periodPreview.previewToken, 'Expected previewToken for period rate');
  await pricingService.change({ ...periodPayload, previewToken: periodPreview.previewToken }, admin, true);

  // Night 3: daily override = 1,770,000
  await applyDailyOverride({ accId, roomIds: [targetRoomId], start: d3, end: d4, price: 1770000, reason: 'Override night 3' });

  const expectedAvg = (1110000 + 1440000 + 1770000) / 3; // 1,440,000

  const httpRes = await callSearchControllerHttp({
    accommodationId: accId,
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 1,
  });
  assert.equal(httpRes.status, 200);
  assert.equal(httpRes.json.success, true);
  const data = httpRes.json.data;
  assert.equal(data.availabilityChecked, true);
  assert.equal(data.items.length, 1);
  assert.equal(Number(data.items[0].id), accId);
  assert.equal(Number(data.items[0].min_base_price), expectedAvg);
  assert.equal(data.items[0].is_available, true);
  assert.ok(Number(data.items[0].available_rooms) >= 1);
  assert.ok('loc_province_fullname' in data.items[0]);
  assert.ok('loc_ward_fullname' in data.items[0]);

  // Verify parity with booking_web_service roomSubtotal / nights (before surcharge & tax)
  const preview = await bookingWebService.getBookingPreview({
    accommodationId: accId,
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 1,
  });
  const roomQuote = preview.allRoomTypes.find((rm) => Number(rm.id) === targetRoomId);
  assert.ok(roomQuote);
  assert.equal(Number(data.items[0].min_base_price), roomQuote.roomSubtotal / 3);
});

dbTest('90-night search boundary succeeds and no-date search keeps static rt.base_price behavior', async () => {
  const r = await new RealRequest(active).query(`
    SELECT TOP(1) a.id AS acc_id, MIN(rt.base_price) AS min_static_price
    FROM dbo.accommodations a
    JOIN dbo.room_types rt ON rt.accommodation_id = a.id AND rt.status = 1 AND rt.deleted_at IS NULL
    WHERE a.status = 1 AND a.deleted_at IS NULL
    GROUP BY a.id
    ORDER BY a.id;
  `);
  const accId = Number(r.recordset[0].acc_id);
  const minStatic = Number(r.recordset[0].min_static_price);

  const noDateRes = await dailySearchService.searchAccommodationsByFilters({ accommodationId: accId });
  assert.equal(noDateRes.success, true);
  assert.equal(noDateRes.data.availabilityChecked, false);
  assert.equal(noDateRes.data.items.length, 1);
  assert.equal(noDateRes.data.items[0].available_rooms, null);
  assert.equal(noDateRes.data.items[0].is_available, null);
  assert.equal(Number(noDateRes.data.items[0].min_base_price), minStatic);

  const start90 = addDaysIso(pricingService.today(), 160);
  const end90 = addDaysIso(start90, 90);
  const ninetyRes = await dailySearchService.searchAccommodationsByFilters({
    accommodationId: accId,
    checkinDate: start90,
    checkoutDate: end90,
    rooms: 1,
  });
  assert.equal(ninetyRes.success, true);
  assert.equal(ninetyRes.data.availabilityChecked, true);
  assert.equal(ninetyRes.data.items.length, 1);
});

dbTest('multi-night bottleneck inventory excludes sold-out rooms from min_base_price and honors explicit accommodationId', async () => {
  const r = await new RealRequest(active).query(`
    SELECT TOP(1) a.id AS acc_id
    FROM dbo.accommodations a
    JOIN dbo.room_types rt ON rt.accommodation_id = a.id AND rt.status = 1 AND rt.deleted_at IS NULL
    WHERE a.status = 1 AND a.deleted_at IS NULL
    GROUP BY a.id
    HAVING COUNT(rt.id) >= 2
    ORDER BY a.id;

    SELECT TOP(1) b.id AS booking_id
    FROM dbo.bookings b
    JOIN dbo.booking_items bi ON bi.booking_id = b.id
    WHERE b.status = 'CONFIRMED'
    GROUP BY b.id
    HAVING COUNT(bi.id) >= 2
    ORDER BY b.id;
  `);
  const accId = Number(r.recordset[0]?.acc_id);
  const bookingId = r.recordsets[1][0]?.booking_id;
  assert.ok(accId > 0 && bookingId, 'Need an active accommodation (>=2 room types) and a confirmed booking (>=2 items)');

  const roomsRes = await new RealRequest(active)
    .input('accId', sql.BigInt, accId)
    .query('SELECT id FROM dbo.room_types WHERE accommodation_id = @accId AND status = 1 AND deleted_at IS NULL ORDER BY id;');
  const roomRows = roomsRes.recordset.map((row) => Number(row.id));
  const cheapRoom = roomRows[0];
  const openRoom = roomRows[1];
  const restRooms = roomRows.slice(2);

  // Keep only 2 active room types for accId, each with quantity = 2
  await new RealRequest(active)
    .input('r0', sql.BigInt, cheapRoom)
    .input('r1', sql.BigInt, openRoom)
    .query('UPDATE dbo.room_types SET quantity = 2 WHERE id IN (@r0, @r1);');
  if (restRooms.length > 0) {
    await new RealRequest(active)
      .input('accId', sql.BigInt, accId)
      .input('r0', sql.BigInt, cheapRoom)
      .input('r1', sql.BigInt, openRoom)
      .query('UPDATE dbo.room_types SET status = 0 WHERE accommodation_id = @accId AND id NOT IN (@r0, @r1);');
  }

  const d1 = addDaysIso(pricingService.today(), 170);
  const d2 = addDaysIso(d1, 1);
  const d3 = addDaysIso(d1, 2);
  const d4 = addDaysIso(d1, 3);

  await applyDailyOverride({ accId, roomIds: [cheapRoom], start: d1, end: d4, price: 18100000, reason: 'Cheaper sold-out room' });
  await applyDailyOverride({ accId, roomIds: [openRoom], start: d1, end: d4, price: 18500000, reason: 'Available room' });

  // Clear interfering bookings on [d1, d4] for accId except the fixture booking we occupy on Night 2 ([d2, d3))
  await new RealRequest(active)
    .input('accId', sql.BigInt, accId)
    .input('d1', sql.Date, d1)
    .input('d2', sql.Date, d2)
    .input('d3', sql.Date, d3)
    .input('d4', sql.Date, d4)
    .input('r0', sql.BigInt, cheapRoom)
    .input('bId', sql.BigInt, bookingId)
    .query(`
      UPDATE dbo.bookings SET status = 'CANCELLED' WHERE accommodation_id = @accId AND id <> @bId AND check_in_date < @d4 AND check_out_date > @d1;
      DELETE r FROM dbo.booking_item_nightly_rates r
      INNER JOIN dbo.booking_items bi ON bi.id = r.booking_item_id
      WHERE bi.booking_id = @bId AND bi.id NOT IN (SELECT TOP(2) id FROM dbo.booking_items WHERE booking_id = @bId ORDER BY id);
      DELETE bi FROM dbo.booking_items bi
      WHERE bi.booking_id = @bId AND bi.id NOT IN (SELECT TOP(2) id FROM dbo.booking_items WHERE booking_id = @bId ORDER BY id);
      UPDATE dbo.bookings SET accommodation_id = @accId, check_in_date = @d2, check_out_date = @d3, total_nights = 1, status = 'CONFIRMED' WHERE id = @bId;
      UPDATE dbo.booking_items SET room_type_id = @r0 WHERE booking_id = @bId;
    `);

  // With rooms=1: cheapRoom has MIN(2, 0, 2) = 0 available_to_sell, so min_base_price must ignore 18,100,000 and pick openRoom (18,500,000)
  const searchOne = await callSearchControllerHttp({
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 1,
    priceFrom: 18000000,
    priceTo: 18600000,
  });
  const hitOne = searchOne.json.data.items.find((i) => Number(i.id) === accId);
  assert.ok(hitOne);
  assert.equal(Number(hitOne.available_rooms), 2);
  assert.equal(hitOne.is_available, true);
  assert.equal(Number(hitOne.min_base_price), 18500000);

  // With rooms=3 (no accommodationId): accId only has 2 available rooms -> excluded
  const searchThree = await dailySearchService.searchAccommodationsByFilters({
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 3,
    priceFrom: 18000000,
    priceTo: 18600000,
  });
  assert.equal(searchThree.data.items.some((i) => Number(i.id) === accId), false);

  // Explicit accommodationId with rooms=3: kept in result with is_available = false
  const explicitThree = await dailySearchService.searchAccommodationsByFilters({
    accommodationId: accId,
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 3,
  });
  assert.equal(explicitThree.success, true);
  assert.equal(explicitThree.data.items.length, 1);
  assert.equal(Number(explicitThree.data.items[0].available_rooms), 2);
  assert.equal(explicitThree.data.items[0].is_available, false);

  // Full sell-out across all rooms + explicit accommodationId: keeps property with available_rooms=0, is_available=false, min_base_price=null
  await new RealRequest(active)
    .input('r0', sql.BigInt, cheapRoom)
    .input('r1', sql.BigInt, openRoom)
    .input('bId', sql.BigInt, bookingId)
    .query(`
      UPDATE dbo.room_types SET quantity = 1 WHERE id IN (@r0, @r1);
      WITH TopItem AS (SELECT TOP(1) id FROM dbo.booking_items WHERE booking_id = @bId ORDER BY id)
      UPDATE dbo.booking_items
      SET room_type_id = CASE WHEN id IN (SELECT id FROM TopItem) THEN @r0 ELSE @r1 END
      WHERE booking_id = @bId;
    `);
  const explicitSoldOut = await dailySearchService.searchAccommodationsByFilters({
    accommodationId: accId,
    checkinDate: d1,
    checkoutDate: d4,
    rooms: 1,
  });
  assert.equal(explicitSoldOut.data.items.length, 1);
  assert.equal(Number(explicitSoldOut.data.items[0].available_rooms), 0);
  assert.equal(explicitSoldOut.data.items[0].is_available, false);
  assert.equal(explicitSoldOut.data.items[0].min_base_price, null);
});

dbTest('daily prices govern priceFrom/priceTo filtering, sorting, total, totalPages and pagination in order', async () => {
  const r = await new RealRequest(active).query(`
    SELECT TOP(3) a.id AS acc_id
    FROM dbo.accommodations a
    JOIN dbo.room_types rt ON rt.accommodation_id = a.id AND rt.status = 1 AND rt.deleted_at IS NULL
    WHERE a.status = 1 AND a.deleted_at IS NULL
    GROUP BY a.id
    ORDER BY a.id;
  `);
  assert.equal(r.recordset.length, 3, 'Need at least 3 active accommodations with active room types');
  const [acc1, acc2, acc3] = r.recordset.map((row) => Number(row.acc_id));

  const d1 = addDaysIso(pricingService.today(), 180);
  const d2 = addDaysIso(d1, 1);

  for (const [accId, price] of [[acc1, 19100000], [acc2, 19200000], [acc3, 19300000]]) {
    const roomsRes = await new RealRequest(active)
      .input('accId', sql.BigInt, accId)
      .query('SELECT id FROM dbo.room_types WHERE accommodation_id = @accId AND status = 1 AND deleted_at IS NULL ORDER BY id;');
    const roomIds = roomsRes.recordset.map((row) => Number(row.id));
    await applyDailyOverride({ accId, roomIds, start: d1, end: d2, price, reason: `Band test ${price}` });
  }

  // Without dates, none of these properties have base_price in [19,050,000..19,350,000]
  const staticCheck = await dailySearchService.searchAccommodationsByFilters({
    priceFrom: 19050000,
    priceTo: 19350000,
  });
  assert.equal(staticCheck.data.pagination.total, 0);

  // Price filter + price_desc + pagination(page 1, pageSize 1): acc3 excluded -> total = 2, page 1 = acc2, page 2 = acc1
  const page1Desc = await callSearchControllerHttp({
    checkinDate: d1,
    checkoutDate: d2,
    rooms: 1,
    priceFrom: 19050000,
    priceTo: 19250000,
    sort: 'price_desc',
    page: 1,
    pageSize: 1,
  });
  assert.equal(page1Desc.status, 200);
  assert.equal(page1Desc.json.success, true);
  assert.deepEqual(page1Desc.json.data.pagination, {
    enabled: true,
    page: 1,
    pageSize: 1,
    total: 2,
    totalPages: 2,
  });
  assert.deepEqual(page1Desc.json.data.items.map((i) => Number(i.id)), [acc2]);
  assert.equal(Number(page1Desc.json.data.items[0].min_base_price), 19200000);

  const page2Desc = await callSearchControllerHttp({
    checkinDate: d1,
    checkoutDate: d2,
    rooms: 1,
    priceFrom: 19050000,
    priceTo: 19250000,
    sort: 'price_desc',
    page: 2,
    pageSize: 1,
  });
  assert.deepEqual(page2Desc.json.data.items.map((i) => Number(i.id)), [acc1]);
  assert.equal(Number(page2Desc.json.data.items[0].min_base_price), 19100000);

  // Full band [19,050,000..19,350,000] + price_asc + page 2 (pageSize 2): total = 3, page 2 = [acc3]
  const page2Asc = await callSearchControllerHttp({
    checkinDate: d1,
    checkoutDate: d2,
    rooms: 1,
    priceFrom: 19050000,
    priceTo: 19350000,
    sort: 'price_asc',
    page: 2,
    pageSize: 2,
  });
  assert.deepEqual(page2Asc.json.data.pagination, {
    enabled: true,
    page: 2,
    pageSize: 2,
    total: 3,
    totalPages: 2,
  });
  assert.deepEqual(page2Asc.json.data.items.map((i) => Number(i.id)), [acc3]);
  assert.equal(Number(page2Asc.json.data.items[0].min_base_price), 19300000);
});
