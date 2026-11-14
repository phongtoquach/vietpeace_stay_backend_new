const { getDBPool, sqlObj } = require("../configs/database");

const BOOKING_SUMMARY_SQL = `
  SELECT
    CONVERT(VARCHAR(19), b.id) AS id,
    b.booking_code AS bookingCode,
    b.user_id AS userId,
    b.accommodation_id AS accommodationId,
    a.accommodation_name AS accommodationName,
    a.address_line AS addressLine,
    l.name AS locationName,
    a.phone AS accommodationPhone,
    a.email AS accommodationEmail,
    a.website_url AS accommodationWebsite,
    CONVERT(VARCHAR(8), a.check_in_time, 108) AS checkInTime,
    CONVERT(VARCHAR(8), a.check_out_time, 108) AS checkOutTime,
    img.image_url AS coverImage,
    CONVERT(CHAR(10), b.check_in_date, 23) AS checkInDate,
    CONVERT(CHAR(10), b.check_out_date, 23) AS checkOutDate,
    b.total_nights AS totalNights,
    b.total_rooms AS totalRooms,
    b.total_adults AS totalAdults,
    b.total_children AS totalChildren,
    b.contact_name AS contactName,
    b.contact_email AS contactEmail,
    b.contact_phone AS contactPhone,
    b.is_booking_for_other AS isBookingForOther,
    b.guest_name AS guestName,
    b.guest_email AS guestEmail,
    b.guest_phone AS guestPhone,
    b.expected_arrival_time AS expectedArrivalTime,
    b.special_requests AS specialRequests,
    CAST(b.rooms_subtotal AS FLOAT) AS roomsSubtotal,
    CAST(b.extra_guest_total AS FLOAT) AS extraGuestTotal,
    CAST(b.room_discount_total AS FLOAT) AS roomDiscountTotal,
    CAST(b.discount_amount AS FLOAT) AS discountAmount,
    CAST(b.tax_amount AS FLOAT) AS taxAmount,
    CAST(b.service_fee AS FLOAT) AS serviceFee,
    CAST(b.total_amount AS FLOAT) AS totalAmount,
    b.currency,
    b.status,
    b.pending_expires_at AS pendingExpiresAt,
    b.confirmed_at AS confirmedAt,
    b.cancelled_at AS cancelledAt,
    b.cancellation_reason AS cancellationReason,
    b.failed_at AS failedAt,
    b.failure_code AS failureCode,
    b.failure_message AS failureMessage,
    b.created_at AS createdAt,
    b.updated_at AS updatedAt,
    pay.payment_code AS latestPaymentCode,
    pay.payment_method AS latestPaymentMethod,
    pay.status AS latestPaymentStatus,
    CAST(pay.amount AS FLOAT) AS latestPaymentAmount,
    CAST(pay.refunded_amount AS FLOAT) AS latestPaymentRefundedAmount,
    pay.paid_at AS latestPaidAt
  FROM dbo.bookings AS b
  INNER JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
  LEFT JOIN dbo.locations AS l ON l.id = a.location_id
  OUTER APPLY (
    SELECT TOP 1 image_url
    FROM dbo.accommodation_images AS ai
    WHERE ai.accommodation_id = a.id
    ORDER BY ai.is_cover DESC, ai.sort_order ASC, ai.id ASC
  ) AS img
  OUTER APPLY (
    SELECT TOP 1 p.payment_code, p.payment_method, p.status, p.amount, p.refunded_amount, p.paid_at
    FROM dbo.payments AS p
    WHERE p.booking_id = b.id
    ORDER BY p.created_at DESC, p.id DESC
  ) AS pay
`;

function mapBookingRow(row) {
  if (!row) return null;
  const checkInDate = row.checkInDate;
  const checkOutDate = row.checkOutDate;
  return {
    id: row.id,
    bookingCode: row.bookingCode,
    status: row.status,
    accommodationId: Number(row.accommodationId),
    accommodationName: row.accommodationName,
    locationName: row.locationName || null,
    address: row.addressLine,
    addressLine: row.addressLine,
    coverImage: row.coverImage || null,
    accommodationContact: {
      phone: row.accommodationPhone || null,
      email: row.accommodationEmail || null,
      websiteUrl: row.accommodationWebsite || null,
      checkInTime: row.checkInTime || null,
      checkOutTime: row.checkOutTime || null,
    },
    checkInDate,
    checkOutDate,
    checkinDate: checkInDate,
    checkoutDate: checkOutDate,
    totalNights: Number(row.totalNights),
    nights: Number(row.totalNights),
    totalRooms: Number(row.totalRooms),
    numberOfRooms: Number(row.totalRooms),
    totalAdults: Number(row.totalAdults),
    totalChildren: Number(row.totalChildren),
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    isBookingForOther: Boolean(row.isBookingForOther),
    guestName: row.guestName || null,
    guestEmail: row.guestEmail || null,
    guestPhone: row.guestPhone || null,
    expectedArrivalTime: row.expectedArrivalTime || null,
    specialRequests: row.specialRequests || null,
    roomsSubtotal: Number(row.roomsSubtotal || 0),
    roomSubtotal: Number(row.roomsSubtotal || 0),
    extraGuestTotal: Number(row.extraGuestTotal || 0),
    extraGuestsSubtotal: Number(row.extraGuestTotal || 0),
    roomDiscountTotal: Number(row.roomDiscountTotal || 0),
    discountAmount: Number(row.discountAmount || 0),
    taxAmount: Number(row.taxAmount || 0),
    serviceFee: Number(row.serviceFee || 0),
    totalAmount: Number(row.totalAmount || 0),
    currency: row.currency || "VND",
    pendingExpiresAt: row.pendingExpiresAt ? new Date(row.pendingExpiresAt).toISOString() : null,
    confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
    cancellationReason: row.cancellationReason || null,
    failedAt: row.failedAt ? new Date(row.failedAt).toISOString() : null,
    failureCode: row.failureCode || null,
    failureMessage: row.failureMessage || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    latestPayment: row.latestPaymentCode
      ? {
          paymentCode: row.latestPaymentCode,
          paymentMethod: row.latestPaymentMethod,
          status: row.latestPaymentStatus,
          amount: Number(row.latestPaymentAmount || 0),
          refundedAmount: Number(row.latestPaymentRefundedAmount || 0),
          paidAt: row.latestPaidAt ? new Date(row.latestPaidAt).toISOString() : null,
        }
      : null,
  };
}

async function listCustomerBookings(customerId, options = {}) {
  if (!customerId) return [];
  const pool = getDBPool();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const rawStatus = options.status ? String(options.status).trim().toUpperCase() : "";
  const statusFilter = rawStatus && rawStatus !== "ALL" ? rawStatus : null;

  const request = pool
    .request()
    .input("customerId", sqlObj.UniqueIdentifier, customerId)
    .input("limit", sqlObj.Int, limit)
    .input("offset", sqlObj.Int, offset)
    .input("status", sqlObj.VarChar(30), statusFilter);

  const result = await request.query(`
    ${BOOKING_SUMMARY_SQL}
    WHERE b.user_id = @customerId
      AND (@status IS NULL OR b.status = @status)
    ORDER BY b.created_at DESC, b.id DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
  `);

  const bookings = result.recordset.map(mapBookingRow);
  if (bookings.length === 0) return [];

  const bookingIds = bookings.map((b) => Number(b.id));
  const itemsRes = await pool
    .request()
    .input("idsJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(bookingIds))
    .query(`
      SELECT
        CONVERT(VARCHAR(19), bi.booking_id) AS bookingId,
        CONVERT(VARCHAR(19), bi.id) AS id,
        bi.room_type_id AS roomTypeId,
        bi.room_type_name AS roomName,
        bi.adults,
        bi.children,
        bi.included_adults AS includedAdults,
        bi.included_children AS includedChildren,
        CAST(bi.base_price AS FLOAT) AS basePrice,
        CAST(bi.room_subtotal AS FLOAT) AS roomSubtotal,
        CAST(bi.extra_adult_total AS FLOAT) AS extraAdultTotal,
        CAST(bi.extra_child_total AS FLOAT) AS extraChildTotal,
        CAST(bi.discount_amount AS FLOAT) AS discountAmount,
        CAST(bi.total_amount AS FLOAT) AS totalAmount
      FROM dbo.booking_items AS bi
      INNER JOIN OPENJSON(@idsJson) WITH (id BIGINT '$') AS j ON j.id = bi.booking_id
      ORDER BY bi.id ASC;
    `);

  const byBooking = new Map();
  for (const item of itemsRes.recordset) {
    const list = byBooking.get(item.bookingId) || [];
    list.push({
      id: item.id,
      roomTypeId: Number(item.roomTypeId),
      roomName: item.roomName,
      adults: Number(item.adults),
      children: Number(item.children),
      includedAdults: Number(item.includedAdults),
      includedChildren: Number(item.includedChildren),
      basePrice: Number(item.basePrice || 0),
      roomSubtotal: Number(item.roomSubtotal || 0),
      extraAdultTotal: Number(item.extraAdultTotal || 0),
      extraChildTotal: Number(item.extraChildTotal || 0),
      discountAmount: Number(item.discountAmount || 0),
      totalAmount: Number(item.totalAmount || 0),
    });
    byBooking.set(item.bookingId, list);
  }

  return bookings.map((b) => ({
    ...b,
    items: byBooking.get(b.id) || [],
  }));
}

async function getCustomerBookingByCodeOrId(customerId, { bookingId, bookingCode } = {}) {
  if (!customerId) return null;
  const pool = getDBPool();

  const normalizedId =
    bookingId !== undefined && bookingId !== null && /^[1-9]\d{0,18}$/.test(String(bookingId).trim())
      ? String(bookingId).trim()
      : null;
  const normalizedCode =
    bookingCode !== undefined && bookingCode !== null && String(bookingCode).trim()
      ? String(bookingCode).trim().toUpperCase()
      : null;

  if (!normalizedId && !normalizedCode) return null;

  const request = pool
    .request()
    .input("customerId", sqlObj.UniqueIdentifier, customerId)
    .input("bookingId", sqlObj.VarChar(19), normalizedId)
    .input("bookingCode", sqlObj.VarChar(255), normalizedCode);

  const result = await request.query(`
    ${BOOKING_SUMMARY_SQL}
    WHERE b.user_id = @customerId
      AND (
        (@bookingId IS NOT NULL AND b.id = CONVERT(BIGINT, @bookingId))
        OR (@bookingCode IS NOT NULL AND UPPER(b.booking_code) = @bookingCode)
      );
  `);

  const booking = mapBookingRow(result.recordset[0]);
  if (!booking) return null;

  const detailRes = await pool
    .request()
    .input("bookingId", sqlObj.BigInt, Number(booking.id))
    .query(`
      SELECT
        CONVERT(VARCHAR(19), i.id) AS id,
        i.room_type_id AS roomTypeId,
        i.room_type_name AS roomName,
        i.adults,
        i.children,
        i.included_adults AS includedAdults,
        i.included_children AS includedChildren,
        CAST(i.base_price AS FLOAT) AS basePrice,
        CAST(i.room_subtotal AS FLOAT) AS roomSubtotal,
        CAST(i.extra_adult_fee AS FLOAT) AS extraAdultFee,
        CAST(i.extra_child_fee AS FLOAT) AS extraChildFee,
        CAST(i.extra_adult_total AS FLOAT) AS extraAdultTotal,
        CAST(i.extra_child_total AS FLOAT) AS extraChildTotal,
        CAST(i.discount_amount AS FLOAT) AS discountAmount,
        CAST(i.total_amount AS FLOAT) AS totalAmount
      FROM dbo.booking_items AS i
      WHERE i.booking_id = @bookingId
      ORDER BY i.id ASC;

      SELECT
        CONVERT(VARCHAR(19), p.id) AS id,
        p.payment_code AS paymentCode,
        p.payment_method AS paymentMethod,
        p.provider_order_id AS providerOrderId,
        p.provider_transaction_id AS providerTransactionId,
        CAST(p.amount AS FLOAT) AS amount,
        CAST(p.refunded_amount AS FLOAT) AS refundedAmount,
        p.currency,
        p.status,
        p.failure_code AS failureCode,
        p.failure_message AS failureMessage,
        p.paid_at AS paidAt,
        p.refunded_at AS refundedAt,
        p.created_at AS createdAt
      FROM dbo.payments AS p
      WHERE p.booking_id = @bookingId
      ORDER BY p.created_at DESC, p.id DESC;
    `);

  const [itemRows, paymentRows] = detailRes.recordsets;

  return {
    ...booking,
    items: itemRows.map((i) => ({
      id: i.id,
      roomTypeId: Number(i.roomTypeId),
      roomName: i.roomName,
      adults: Number(i.adults),
      children: Number(i.children),
      includedAdults: Number(i.includedAdults),
      includedChildren: Number(i.includedChildren),
      basePrice: Number(i.basePrice || 0),
      roomSubtotal: Number(i.roomSubtotal || 0),
      extraAdultFee: Number(i.extraAdultFee || 0),
      extraChildFee: Number(i.extraChildFee || 0),
      extraAdultTotal: Number(i.extraAdultTotal || 0),
      extraChildTotal: Number(i.extraChildTotal || 0),
      discountAmount: Number(i.discountAmount || 0),
      totalAmount: Number(i.totalAmount || 0),
    })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      paymentCode: p.paymentCode,
      paymentMethod: p.paymentMethod,
      providerOrderId: p.providerOrderId || null,
      providerTransactionId: p.providerTransactionId || null,
      amount: Number(p.amount || 0),
      refundedAmount: Number(p.refundedAmount || 0),
      currency: p.currency || "VND",
      status: p.status,
      failureCode: p.failureCode || null,
      failureMessage: p.failureMessage || null,
      paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
      refundedAt: p.refundedAt ? new Date(p.refundedAt).toISOString() : null,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    })),
  };
}

module.exports = {
  listCustomerBookings,
  getCustomerBookingByCodeOrId,
};
