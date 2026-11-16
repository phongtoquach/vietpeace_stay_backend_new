const { randomBytes } = require("node:crypto");
const db = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const { getAccommodationScope } = require("./accommodation_access_service");
const {
  buildSettlementVnpayUrl,
  buildVietQrInfo,
  generateQrDataUrl,
} = require("./vnpay_checkout_settlement_helper");

const sql = db.sqlObj;

const CHARGE_CATEGORIES = Object.freeze([
  "MINIBAR_FB",
  "EXTRA_SERVICE",
  "SPECIAL_CLEANING",
  "DAMAGE_COMPENSATION",
]);

const COMPENSATION_MODES = Object.freeze([
  "NONE",
  "REPAIR",
  "DEPRECIATED_REPLACE",
  "FULL_REPLACE",
]);

const DIRECT_SETTLEMENT_METHODS = Object.freeze([
  "NO_EXTRA_CHARGE",
  "CASH",
  "BANK_TRANSFER",
  "POS_CARD",
]);

const MANAGER_DIRECT_ADJUSTMENT_MAX_VND = 500000;
const MANAGER_DIRECT_ADJUSTMENT_MAX_PCT = 15;

function getManagerDirectAdjustmentCap(grossBeforeDiscount) {
  const gross = Math.max(0, Math.round(Number(grossBeforeDiscount || 0)));
  return Math.min(
    MANAGER_DIRECT_ADJUSTMENT_MAX_VND,
    Math.round((gross * MANAGER_DIRECT_ADJUSTMENT_MAX_PCT) / 100),
  );
}

class CheckoutSettlementError extends Error {
  constructor(statusCode, errorCode, message, errors = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errors = errors;
  }
}

function validationError(message, errors) {
  return new CheckoutSettlementError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    message,
    errors,
  );
}

function invalidStateError(message) {
  return new CheckoutSettlementError(409, ERROR_CODES.INVALID_STATE, message);
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toIsoString(val) {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : String(val);
}

function toDateOnly(val) {
  if (!val) return null;
  return val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
}

function getSuggestedDepreciationPercent(
  purchaseYear,
  referenceYear = new Date().getFullYear(),
) {
  if (purchaseYear === null || purchaseYear === undefined || purchaseYear === "") {
    return 100;
  }
  const py = Number(purchaseYear);
  if (!Number.isInteger(py) || py <= 0) return 100;
  const age = Math.max(0, Number(referenceYear) - py);
  if (age < 1) return 100;
  if (age <= 2) return 75;
  if (age <= 4) return 55;
  return 35;
}

function calculateChargeAmounts(input = {}) {
  const category = String(input.category || "").trim().toUpperCase();
  if (!CHARGE_CATEGORIES.includes(category)) {
    throw validationError("Nhóm phát sinh không hợp lệ.", {
      category: `Chỉ chấp nhận: ${CHARGE_CATEGORIES.join(", ")}`,
    });
  }

  const quantity = Number(input.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    throw validationError("Số lượng phải là số nguyên từ 1 đến 9.999.", {
      quantity: "Số lượng không hợp lệ.",
    });
  }

  const unitPriceRaw = Number(input.unitPrice);
  if (!Number.isFinite(unitPriceRaw) || unitPriceRaw < 0) {
    throw validationError("Đơn giá phải là số không âm.", {
      unitPrice: "Đơn giá không hợp lệ.",
    });
  }
  const unitPrice = Math.round(unitPriceRaw);

  const adjustmentRaw = Number(input.adjustmentAmount ?? 0);
  if (!Number.isFinite(adjustmentRaw) || adjustmentRaw < 0) {
    throw validationError("Số tiền giảm trừ phải là số không âm.", {
      adjustmentAmount: "Giảm trừ không hợp lệ.",
    });
  }
  const adjustmentAmount = Math.round(adjustmentRaw);

  const isCompensation = category === "DAMAGE_COMPENSATION";
  let compensationMode = String(
    input.compensationMode || (isCompensation ? "REPAIR" : "NONE"),
  )
    .trim()
    .toUpperCase();

  if (isCompensation) {
    if (!["REPAIR", "DEPRECIATED_REPLACE", "FULL_REPLACE"].includes(compensationMode)) {
      throw validationError("Hình thức bồi thường thiết bị không hợp lệ.", {
        compensationMode: "Chọn Sửa chữa (REPAIR), Khấu hao (DEPRECIATED_REPLACE) hoặc Đền mới 100% (FULL_REPLACE).",
      });
    }
  } else {
    compensationMode = "NONE";
  }

  let depreciationPercent = 100;
  if (isCompensation) {
    if (compensationMode === "FULL_REPLACE") {
      depreciationPercent = 100;
    } else if (compensationMode === "REPAIR") {
      depreciationPercent = 100;
    } else {
      const depRaw = Number(input.depreciationPercent ?? 100);
      if (!Number.isFinite(depRaw) || depRaw < 0 || depRaw > 100) {
        throw validationError("Tỷ lệ khấu hao bồi thường phải từ 0% đến 100%.", {
          depreciationPercent: "Giá trị từ 0 - 100.",
        });
      }
      depreciationPercent = Math.round(depRaw * 100) / 100;
    }
  }

  const grossBeforeDiscount = Math.round(
    quantity * unitPrice * (depreciationPercent / 100),
  );
  if (adjustmentAmount > grossBeforeDiscount) {
    throw validationError(
      "Số tiền giảm trừ thiện chí không được vượt quá giá trị trước giảm trừ.",
      { adjustmentAmount: `Tối đa ${grossBeforeDiscount.toLocaleString("vi-VN")} đ.` },
    );
  }

  const subtotalAmount = Math.max(0, grossBeforeDiscount - adjustmentAmount);
  const taxRate = isCompensation
    ? 0
    : Math.round(Math.max(0, Math.min(100, Number(input.taxRate ?? 0))) * 100) / 100;
  const isTaxInclusive = isCompensation
    ? true
    : input.isTaxInclusive === undefined
      ? true
      : Boolean(input.isTaxInclusive);

  const taxAmount = isCompensation || isTaxInclusive
    ? 0
    : Math.round((subtotalAmount * taxRate) / 100);
  const totalAmount = subtotalAmount + taxAmount;

  return {
    category,
    quantity,
    unitPrice,
    compensationMode,
    depreciationPercent,
    adjustmentAmount,
    isTaxInclusive,
    taxRate,
    subtotalAmount,
    taxAmount,
    totalAmount,
  };
}

function computeFolioSummary({
  bookingOriginalTotal = 0,
  prepaidAmount = 0,
  charges = [],
}) {
  let minibarTotal = 0;
  let extraServiceTotal = 0;
  let specialCleaningTotal = 0;
  let compensationTotal = 0;
  let incidentalTaxTotal = 0;

  for (const ch of charges) {
    if (ch.status !== "ACTIVE") continue;
    const subtotal = Number(ch.subtotalAmount ?? ch.subtotal_amount ?? 0);
    const tax = Number(ch.taxAmount ?? ch.tax_amount ?? 0);
    if (ch.category === "MINIBAR_FB") {
      minibarTotal += subtotal;
      incidentalTaxTotal += tax;
    } else if (ch.category === "EXTRA_SERVICE") {
      extraServiceTotal += subtotal;
      incidentalTaxTotal += tax;
    } else if (ch.category === "SPECIAL_CLEANING") {
      specialCleaningTotal += subtotal;
      incidentalTaxTotal += tax;
    } else if (ch.category === "DAMAGE_COMPENSATION") {
      compensationTotal += subtotal;
    }
  }

  const origTotal = Math.round(Number(bookingOriginalTotal || 0));
  const prepaid = Math.round(Number(prepaidAmount || 0));
  const incidentalGrandTotal =
    minibarTotal +
    extraServiceTotal +
    specialCleaningTotal +
    incidentalTaxTotal +
    compensationTotal;
  const stayGrandTotal = origTotal + incidentalGrandTotal;
  const settlementDueAmount = stayGrandTotal - prepaid;

  return {
    bookingOriginalTotal: origTotal,
    prepaidAmount: prepaid,
    minibarTotal,
    extraServiceTotal,
    specialCleaningTotal,
    compensationTotal,
    incidentalTaxTotal,
    incidentalGrandTotal,
    stayGrandTotal,
    settlementDueAmount,
  };
}

function buildInvoiceCode(bookingId, date = new Date()) {
  const vnMillis = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(vnMillis);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `INV-${yy}${mm}${dd}-${String(bookingId).padStart(6, "0")}`;
}

function buildSettlementCode(date = new Date()) {
  const vnMillis = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(vnMillis);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rand = randomBytes(4).toString("hex").toUpperCase();
  return `STL-${yy}${mm}${dd}-${rand}`;
}

function buildVnpTxnRef(date = new Date()) {
  const vnMillis = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(vnMillis);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `STL${yy}${mm}${dd}${randomBytes(6).toString("hex").toUpperCase()}`;
}

function mapChargeRow(row) {
  return {
    id: Number(row.id),
    bookingId: Number(row.booking_id),
    accommodationId: Number(row.accommodation_id),
    catalogItemId: row.catalog_item_id === null || row.catalog_item_id === undefined
      ? null
      : Number(row.catalog_item_id),
    category: row.category,
    itemName: row.item_name,
    unitLabel: row.unit_label || "Lần",
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price || 0),
    compensationMode: row.compensation_mode || "NONE",
    depreciationPercent: Number(row.depreciation_percent ?? 100),
    adjustmentAmount: Number(row.adjustment_amount || 0),
    isTaxInclusive: Boolean(row.is_tax_inclusive),
    subtotalAmount: Number(row.subtotal_amount || 0),
    taxRate: Number(row.tax_rate || 0),
    taxAmount: Number(row.tax_amount || 0),
    totalAmount: Number(row.total_amount || 0),
    note: row.note || null,
    evidenceImageUrl: row.evidence_image_url || null,
    status: row.status,
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || null,
    voidedBy: row.voided_by || null,
    voidedByName: row.voided_by_name || null,
    voidedAt: toIsoString(row.voided_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapSettlementPaymentRow(row) {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    bookingId: Number(row.booking_id),
    settlementCode: row.settlement_code,
    paymentMethod: row.payment_method,
    amount: Number(row.amount || 0),
    cashReceived: row.cash_received === null || row.cash_received === undefined
      ? null
      : Number(row.cash_received),
    cashChange: row.cash_change === null || row.cash_change === undefined
      ? null
      : Number(row.cash_change),
    providerRef: row.provider_ref || null,
    vnpTxnRef: row.vnp_txn_ref || null,
    status: row.status,
    confirmedBy: row.confirmed_by || null,
    confirmedByName: row.confirmed_by_name || null,
    paidAt: toIsoString(row.paid_at),
    note: row.note || null,
    createdAt: toIsoString(row.created_at),
  };
}

function parseEvidenceImagesJson(rawJson) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed)
      ? parsed.filter((u) => typeof u === "string" && u.trim())
      : [];
  } catch {
    return [];
  }
}

function mapNegotiationRow(row) {
  return {
    id: Number(row.id),
    negotiationCode: row.negotiation_code,
    chargeId: Number(row.charge_id),
    bookingId: Number(row.booking_id),
    bookingCode: row.booking_code || null,
    accommodationId: Number(row.accommodation_id),
    accommodationName: row.accommodation_name || null,
    customerName: row.contact_name || null,
    customerPhone: row.contact_phone || null,
    itemName: row.item_name,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price || 0),
    compensationMode: row.compensation_mode,
    depreciationPercent: Number(row.depreciation_percent ?? 100),
    originalGrossAmount: Number(row.original_gross_amount || 0),
    previousAdjustmentAmount: Number(row.previous_adjustment_amount || 0),
    previousFinalAmount: Number(row.previous_final_amount || 0),
    requestedExtraReduction: Number(row.requested_extra_reduction || 0),
    proposedFinalAmount: Number(row.proposed_final_amount || 0),
    guestOpinion: row.guest_opinion,
    managerNote: row.manager_note || null,
    evidenceImages: parseEvidenceImagesJson(row.evidence_images_json),
    isUrgent: Boolean(row.is_urgent),
    status: row.status,
    approvedExtraReduction:
      row.approved_extra_reduction === null || row.approved_extra_reduction === undefined
        ? null
        : Number(row.approved_extra_reduction),
    finalApprovedAmount:
      row.final_approved_amount === null || row.final_approved_amount === undefined
        ? null
        : Number(row.final_approved_amount),
    adminDecisionNote: row.admin_decision_note || null,
    requestedBy: row.requested_by || null,
    requestedByName: row.requested_by_name || null,
    reviewedBy: row.reviewed_by || null,
    reviewedByName: row.reviewed_by_name || null,
    reviewedAt: toIsoString(row.reviewed_at),
    managerAckAt: toIsoString(row.manager_ack_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    versionToken: row.version_token || null,
  };
}

async function fetchNegotiationsForBooking(executor, bookingId) {
  const res = await new sql.Request(executor)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT
        n.*,
        CONVERT(VARCHAR(18), n.version, 1) AS version_token,
        b.booking_code,
        b.contact_name,
        b.contact_phone,
        a.accommodation_name,
        ru.full_name AS requested_by_name,
        vu.full_name AS reviewed_by_name
      FROM dbo.compensation_negotiations n
      JOIN dbo.bookings b ON b.id = n.booking_id
      JOIN dbo.accommodations a ON a.id = n.accommodation_id
      LEFT JOIN dbo.users ru ON ru.id = n.requested_by
      LEFT JOIN dbo.users vu ON vu.id = n.reviewed_by
      WHERE n.booking_id = @bookingId
      ORDER BY n.created_at DESC, n.id DESC;
    `);
  return res.recordset.map(mapNegotiationRow);
}

async function fetchPrepaidSummary(executor, bookingId) {
  const res = await new sql.Request(executor)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT
        id,
        payment_code,
        payment_method,
        provider_transaction_id,
        amount,
        refunded_amount,
        status,
        paid_at,
        created_at
      FROM dbo.payments
      WHERE booking_id = @bookingId
      ORDER BY id ASC;
    `);

  const rows = res.recordset;
  let prepaidAmount = 0;
  for (const p of rows) {
    if (["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status)) {
      const net = Number(p.amount || 0) - Number(p.refunded_amount || 0);
      if (net > 0) prepaidAmount += net;
    }
  }

  return {
    prepaidAmount: Math.round(prepaidAmount),
    payments: rows.map((p) => ({
      id: Number(p.id),
      paymentCode: p.payment_code,
      paymentMethod: p.payment_method,
      providerTransactionId: p.provider_transaction_id || null,
      amount: Number(p.amount || 0),
      refundedAmount: Number(p.refunded_amount || 0),
      status: p.status,
      paidAt: toIsoString(p.paid_at),
    })),
  };
}

async function fetchChargesForBooking(executor, bookingId, { includeVoided = true } = {}) {
  const res = await new sql.Request(executor)
    .input("bookingId", sql.BigInt, bookingId)
    .input("includeVoided", sql.Bit, includeVoided ? 1 : 0)
    .query(`
      SELECT
        c.*,
        cu.full_name AS created_by_name,
        vu.full_name AS voided_by_name
      FROM dbo.booking_incidental_charges c
      LEFT JOIN dbo.users cu ON cu.id = c.created_by
      LEFT JOIN dbo.users vu ON vu.id = c.voided_by
      WHERE c.booking_id = @bookingId
        AND (@includeVoided = 1 OR c.status = 'ACTIVE')
      ORDER BY CASE WHEN c.status = 'ACTIVE' THEN 0 ELSE 1 END, c.created_at ASC, c.id ASC;
    `);
  return res.recordset.map(mapChargeRow);
}

async function fetchInvoiceRow(executor, bookingId, { lock = false } = {}) {
  const lockHint = lock ? "WITH (UPDLOCK, HOLDLOCK)" : "";
  const res = await new sql.Request(executor)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT
        inv.*,
        su.full_name AS settled_by_name
      FROM dbo.booking_checkout_invoices inv ${lockHint}
      LEFT JOIN dbo.users su ON su.id = inv.settled_by
      WHERE inv.booking_id = @bookingId;
    `);
  return res.recordset[0] || null;
}

async function fetchSettlementPayments(executor, bookingId) {
  const res = await new sql.Request(executor)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT
        sp.*,
        cu.full_name AS confirmed_by_name
      FROM dbo.checkout_settlement_payments sp
      LEFT JOIN dbo.users cu ON cu.id = sp.confirmed_by
      WHERE sp.booking_id = @bookingId
      ORDER BY sp.created_at DESC, sp.id DESC;
    `);
  return res.recordset.map(mapSettlementPaymentRow);
}

async function buildFolioResponseFromParts({
  executor,
  bookingRow,
  includeVoided = false,
}) {
  const bookingId = Number(bookingRow.id);

  const [itemsRes, prepaidInfo, charges, invoiceRow, settlementPayments, negotiations] =
    await Promise.all([
      new sql.Request(executor)
        .input("bookingId", sql.BigInt, bookingId)
        .query(`
          SELECT
            id,
            room_type_name,
            adults,
            children,
            base_price,
            room_subtotal,
            extra_adult_total,
            extra_child_total,
            discount_amount,
            total_amount
          FROM dbo.booking_items
          WHERE booking_id = @bookingId
          ORDER BY id ASC;
        `),
      fetchPrepaidSummary(executor, bookingId),
      fetchChargesForBooking(executor, bookingId, { includeVoided }),
      fetchInvoiceRow(executor, bookingId),
      fetchSettlementPayments(executor, bookingId),
      fetchNegotiationsForBooking(executor, bookingId),
    ]);

  const activeCharges = charges.filter((c) => c.status === "ACTIVE");
  const liveSummary = computeFolioSummary({
    bookingOriginalTotal: Number(bookingRow.total_amount || 0),
    prepaidAmount: prepaidInfo.prepaidAmount,
    charges: activeCharges,
  });

  const isSettled =
    invoiceRow?.settlement_status === "SETTLED" || Boolean(bookingRow.checked_out_at);

  const summary = invoiceRow && invoiceRow.settlement_status === "SETTLED"
    ? {
        bookingOriginalTotal: Number(invoiceRow.booking_original_total),
        prepaidAmount: Number(invoiceRow.prepaid_amount),
        minibarTotal: Number(invoiceRow.minibar_total),
        extraServiceTotal: Number(invoiceRow.extra_service_total),
        specialCleaningTotal: Number(invoiceRow.special_cleaning_total),
        compensationTotal: Number(invoiceRow.compensation_total),
        incidentalTaxTotal: Number(invoiceRow.incidental_tax_total),
        incidentalGrandTotal: Number(invoiceRow.incidental_grand_total),
        stayGrandTotal: Number(invoiceRow.stay_grand_total),
        settlementDueAmount: Number(invoiceRow.settlement_due_amount),
        settlementPaidAmount: Number(invoiceRow.settlement_paid_amount),
      }
    : {
        ...liveSummary,
        settlementPaidAmount: invoiceRow
          ? Number(invoiceRow.settlement_paid_amount || 0)
          : 0,
      };

  const vietQr =
    !isSettled && summary.settlementDueAmount > 0
      ? await buildVietQrInfo({
          bookingCode: bookingRow.booking_code,
          amountVnd: summary.settlementDueAmount,
        })
      : null;

  const canModifyCharges =
    bookingRow.status === "CONFIRMED" &&
    Boolean(bookingRow.checked_in_at) &&
    !bookingRow.checked_out_at &&
    invoiceRow?.settlement_status !== "SETTLED";

  const canSettle =
    bookingRow.status === "CONFIRMED" &&
    Boolean(bookingRow.checked_in_at) &&
    !bookingRow.checked_out_at &&
    invoiceRow?.settlement_status !== "SETTLED";

  const settledPayment =
    settlementPayments.find((p) => p.status === "SUCCESS") || null;

  const pendingNegotiationsCount = negotiations.filter((n) => n.status === "PENDING").length;
  const unacknowledgedDecisionsCount = negotiations.filter(
    (n) => ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"].includes(n.status) && !n.managerAckAt,
  ).length;

  return {
    booking: {
      id: bookingId,
      code: bookingRow.booking_code,
      status: bookingRow.status,
      checkInDate: toDateOnly(bookingRow.check_in_date),
      checkOutDate: toDateOnly(bookingRow.check_out_date),
      totalNights: Number(bookingRow.total_nights),
      roomsCount: Number(bookingRow.total_rooms),
      adultsCount: Number(bookingRow.total_adults),
      childrenCount: Number(bookingRow.total_children),
      checkedInAt: toIsoString(bookingRow.checked_in_at),
      checkedOutAt: toIsoString(bookingRow.checked_out_at),
      checkedOutByName: bookingRow.checked_out_by_name || null,
      customer: {
        name: bookingRow.contact_name,
        email: bookingRow.contact_email,
        phone: bookingRow.contact_phone,
        guestName: bookingRow.guest_name || null,
        guestPhone: bookingRow.guest_phone || null,
      },
      accommodation: {
        id: Number(bookingRow.accommodation_id),
        name: bookingRow.accommodation_name,
        phone: bookingRow.accommodation_phone || null,
        email: bookingRow.accommodation_email || null,
        addressLine: bookingRow.accommodation_address || null,
        managerName: bookingRow.manager_full_name || null,
      },
      pricing: {
        roomsSubtotal: Number(bookingRow.rooms_subtotal || 0),
        extraGuestTotal: Number(bookingRow.extra_guest_total || 0),
        roomDiscountTotal: Number(bookingRow.room_discount_total || 0),
        discountAmount: Number(bookingRow.discount_amount || 0),
        taxAmount: Number(bookingRow.tax_amount || 0),
        serviceFee: Number(bookingRow.service_fee || 0),
        totalAmount: Number(bookingRow.total_amount || 0),
        currency: bookingRow.currency || "VND",
      },
      items: itemsRes.recordset.map((item) => ({
        id: Number(item.id),
        roomTypeName: item.room_type_name,
        adults: Number(item.adults),
        children: Number(item.children),
        basePrice: Number(item.base_price || 0),
        roomSubtotal: Number(item.room_subtotal || 0),
        extraAdultTotal: Number(item.extra_adult_total || 0),
        extraChildTotal: Number(item.extra_child_total || 0),
        discountAmount: Number(item.discount_amount || 0),
        totalAmount: Number(item.total_amount || 0),
      })),
    },
    prepaidPayments: prepaidInfo.payments,
    charges,
    summary,
    invoice: invoiceRow
      ? {
          id: Number(invoiceRow.id),
          invoiceCode: invoiceRow.invoice_code,
          settlementStatus: invoiceRow.settlement_status,
          guestConfirmed: Boolean(invoiceRow.guest_confirmed),
          note: invoiceRow.note || null,
          settledBy: invoiceRow.settled_by || null,
          settledByName: invoiceRow.settled_by_name || null,
          settledAt: toIsoString(invoiceRow.settled_at),
          createdAt: toIsoString(invoiceRow.created_at),
          updatedAt: toIsoString(invoiceRow.updated_at),
        }
      : {
          id: null,
          invoiceCode: buildInvoiceCode(bookingId),
          settlementStatus: bookingRow.checked_out_at ? "SETTLED" : "DRAFT",
          guestConfirmed: Boolean(bookingRow.checked_out_at),
          note: null,
          settledBy: null,
          settledByName: bookingRow.checked_out_by_name || null,
          settledAt: toIsoString(bookingRow.checked_out_at),
          createdAt: null,
          updatedAt: null,
        },
    settlementPayments,
    settledPayment,
    negotiations,
    pendingNegotiationsCount,
    unacknowledgedDecisionsCount,
    vietQr,
    permissions: {
      canModifyCharges,
      canSettle: canSettle && pendingNegotiationsCount === 0,
      hasPendingNegotiation: pendingNegotiationsCount > 0,
      managerDirectAdjustmentLimit: {
        maxAmountVnd: MANAGER_DIRECT_ADJUSTMENT_MAX_VND,
        maxPercent: MANAGER_DIRECT_ADJUSTMENT_MAX_PCT,
      },
    },
  };
}

async function fetchBookingCoreFixedSql(executor, bookingId, currentUser, { lock = false } = {}) {
  const scope = getAccommodationScope(currentUser, "a");
  const req = new sql.Request(executor).input("bookingId", sql.BigInt, bookingId);
  scope.inputs.forEach((inp) => req.input(inp.name, inp.type, inp.value));

  const lockHint = lock ? "WITH (UPDLOCK, HOLDLOCK)" : "";

  const res = await req.query(`
    SELECT
      b.id,
      b.booking_code,
      b.accommodation_id,
      b.status,
      b.check_in_date,
      b.check_out_date,
      b.total_nights,
      b.total_rooms,
      b.total_adults,
      b.total_children,
      b.contact_name,
      b.contact_email,
      b.contact_phone,
      b.guest_name,
      b.guest_phone,
      b.rooms_subtotal,
      b.extra_guest_total,
      b.room_discount_total,
      b.discount_amount,
      b.tax_amount,
      b.service_fee,
      b.total_amount,
      b.currency,
      b.checked_in_at,
      b.checked_out_at,
      checkedOutBy.full_name AS checked_out_by_name,
      a.accommodation_name,
      a.phone AS accommodation_phone,
      a.email AS accommodation_email,
      a.address_line AS accommodation_address,
      manager.full_name AS manager_full_name
    FROM dbo.bookings b ${lockHint}
    JOIN dbo.accommodations a ON a.id = b.accommodation_id
    OUTER APPLY (
      SELECT TOP 1 am.user_id
      FROM dbo.accommodation_managers am
      WHERE am.accommodation_id = a.id
      ORDER BY am.assigned_at DESC, am.user_id ASC
    ) am
    LEFT JOIN dbo.users manager ON manager.id = am.user_id
    LEFT JOIN dbo.users checkedOutBy ON checkedOutBy.id = b.checked_out_by
    WHERE b.id = @bookingId
      AND ${scope.condition};
  `);

  return res.recordset[0] || null;
}

async function getCheckoutFolio(bookingId, currentUser = {}, options = {}) {
  const id = parsePositiveInt(bookingId);
  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.", { id: "Phải là số nguyên dương." });
  }

  const pool = db.getDBPool();
  const bookingRow = await fetchBookingCoreFixedSql(pool, id, currentUser);
  if (!bookingRow) {
    throw new CheckoutSettlementError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng trong phạm vi quản lý.",
    );
  }

  return buildFolioResponseFromParts({
    executor: pool,
    bookingRow,
    includeVoided: Boolean(options.includeVoided),
  });
}

async function cancelPendingOnlineSettlementsInTx(tx, bookingId) {
  await new sql.Request(tx)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      UPDATE dbo.checkout_settlement_payments
      SET status = 'CANCELLED', updated_at = SYSDATETIME()
      WHERE booking_id = @bookingId
        AND status = 'PENDING';

      UPDATE dbo.booking_checkout_invoices
      SET settlement_status = 'DRAFT', updated_at = SYSDATETIME()
      WHERE booking_id = @bookingId
        AND settlement_status = 'PENDING_PAYMENT';
    `);
}

function assertStayEditableForCharges(bookingRow, invoiceRow) {
  if (!bookingRow) {
    throw new CheckoutSettlementError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy đặt phòng trong phạm vi quản lý.",
    );
  }
  if (bookingRow.status !== "CONFIRMED") {
    throw invalidStateError(
      `Chỉ được ghi nhận phát sinh cho đơn đã xác nhận (hiện tại: ${bookingRow.status}).`,
    );
  }
  if (!bookingRow.checked_in_at) {
    throw invalidStateError("Khách chưa nhận phòng, chưa thể ghi nhận phát sinh lưu trú.");
  }
  if (bookingRow.checked_out_at || invoiceRow?.settlement_status === "SETTLED") {
    throw invalidStateError(
      "Đơn đặt phòng đã kết toán và trả phòng, không thể chỉnh sửa phát sinh.",
    );
  }
}

async function runInTransaction(pool, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Bỏ qua lỗi rollback phụ
    }
    throw error;
  }
}

function assertManagerDirectAdjustmentWithinCap(calc, currentUser) {
  if (calc.category !== "DAMAGE_COMPENSATION") return;
  if (currentUser?.role === "ADMIN") return;
  if (calc.adjustmentAmount <= 0) return;

  const grossBeforeDiscount = calc.subtotalAmount + calc.adjustmentAmount;
  const cap = getManagerDirectAdjustmentCap(grossBeforeDiscount);
  if (calc.adjustmentAmount > cap) {
    throw validationError(
      `Giảm trừ trực tiếp tại quầy vượt quá hạn mức tự quyết của Quản lý cơ sở (tối đa ${cap.toLocaleString("vi-VN")} đ — không quá 500.000 đ và ${MANAGER_DIRECT_ADJUSTMENT_MAX_PCT}% giá trị bồi thường). Vui lòng ghi nhận khoản bồi thường và gửi Phiếu thương lượng lên Admin duyệt.`,
      {
        adjustmentAmount: `Hạn mức Quản lý tối đa ${cap.toLocaleString("vi-VN")} đ; mức giảm cao hơn cần gửi Admin phê duyệt.`,
      },
    );
  }
}

async function fetchChargeNegotiationLockState(tx, chargeId) {
  const negRes = await new sql.Request(tx)
    .input("chargeId", sql.BigInt, chargeId)
    .query(`
      SELECT status
      FROM dbo.compensation_negotiations WITH (UPDLOCK, HOLDLOCK)
      WHERE charge_id = @chargeId;
    `);
  const statuses = negRes.recordset.map((r) => r.status);
  if (statuses.includes("PENDING")) {
    throw invalidStateError(
      "Khoản bồi thường này đang có phiếu thương lượng chờ Admin phê duyệt. Vui lòng đợi Admin phản hồi hoặc hủy phiếu thương lượng trước.",
    );
  }
  return {
    hasAdminRuling: statuses.some((s) =>
      ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"].includes(s),
    ),
  };
}

async function assertChargeCanBeVoided(tx, chargeId, currentUser) {
  const { hasAdminRuling } = await fetchChargeNegotiationLockState(tx, chargeId);
  if (hasAdminRuling && currentUser?.role !== "ADMIN") {
    throw invalidStateError(
      "Khoản bồi thường này đã được Admin thẩm định kết quả thương lượng, Quản lý cơ sở không được tự ý hủy.",
    );
  }
}

async function assertNoPendingNegotiationOnBooking(tx, bookingId) {
  const res = await new sql.Request(tx)
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.compensation_negotiations WITH (UPDLOCK, HOLDLOCK)
      WHERE booking_id = @bookingId
        AND status = 'PENDING';
    `);
  if (Number(res.recordset[0]?.cnt || 0) > 0) {
    throw invalidStateError(
      "Đơn đặt phòng đang có phiếu đề xuất thương lượng bồi thường chờ Admin xác nhận. Vui lòng đợi Admin phản hồi hoặc hủy đề xuất trước khi kết toán.",
    );
  }
}

async function addIncidentalCharge(bookingId, payload = {}, currentUser = {}) {
  const id = parsePositiveInt(bookingId);
  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.");
  }

  const pool = db.getDBPool();

  await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, id, currentUser, { lock: true });
    const invoiceRow = bookingRow ? await fetchInvoiceRow(tx, id, { lock: true }) : null;
    assertStayEditableForCharges(bookingRow, invoiceRow);

    let catalogItem = null;
    if (payload.catalogItemId !== undefined && payload.catalogItemId !== null && payload.catalogItemId !== "") {
      const catId = parsePositiveInt(payload.catalogItemId);
      if (!catId) {
        throw validationError("Mã hạng mục danh mục không hợp lệ.");
      }
      const catRes = await new sql.Request(tx)
        .input("catId", sql.Int, catId)
        .input("accId", sql.Int, Number(bookingRow.accommodation_id))
        .query(`
          SELECT *
          FROM dbo.accommodation_incidental_catalog
          WHERE id = @catId
            AND accommodation_id = @accId
            AND is_active = 1;
        `);
      catalogItem = catRes.recordset[0];
      if (!catalogItem) {
        throw new CheckoutSettlementError(
          404,
          ERROR_CODES.NOT_FOUND,
          "Không tìm thấy hạng mục đang hoạt động trong danh mục của cơ sở này.",
        );
      }
    }

    const derivedCategory = payload.category
      ? String(payload.category).trim().toUpperCase()
      : (catalogItem?.category === "ROOM_ASSET"
        ? "DAMAGE_COMPENSATION"
        : catalogItem?.category);

    const itemName = String(
      payload.itemName !== undefined && String(payload.itemName).trim()
        ? payload.itemName
        : (catalogItem?.item_name || ""),
    ).trim();
    if (!itemName || itemName.length > 200) {
      throw validationError("Tên khoản phát sinh là bắt buộc và tối đa 200 ký tự.", {
        itemName: "Tên khoản phát sinh không hợp lệ.",
      });
    }

    const unitLabel = String(
      payload.unitLabel !== undefined && String(payload.unitLabel).trim()
        ? payload.unitLabel
        : (catalogItem?.unit_label || "Lần"),
    ).trim().slice(0, 30);

    const note = payload.note !== undefined && payload.note !== null
      ? String(payload.note).trim()
      : null;

    if (
      (derivedCategory === "SPECIAL_CLEANING" ||
        derivedCategory === "DAMAGE_COMPENSATION" ||
        !catalogItem) &&
      (!note || note.length < 3)
    ) {
      throw validationError(
        "Vui lòng nhập ghi chú / lý do chi tiết (tối thiểu 3 ký tự) cho phí vệ sinh, bồi thường hoặc mục nhập ngoài danh mục.",
        { note: "Bắt buộc nhập lý do rõ ràng để hiển thị trên hóa đơn." },
      );
    }

    const compensationMode = payload.compensationMode || (derivedCategory === "DAMAGE_COMPENSATION" ? "DEPRECIATED_REPLACE" : "NONE");
    const defaultDepreciation = catalogItem
      ? getSuggestedDepreciationPercent(catalogItem.purchase_year)
      : 100;

    const unitPrice =
      payload.unitPrice !== undefined && payload.unitPrice !== null && payload.unitPrice !== ""
        ? Number(payload.unitPrice)
        : (catalogItem ? Number(catalogItem.unit_price) : NaN);

    const calc = calculateChargeAmounts({
      category: derivedCategory,
      quantity: payload.quantity ?? 1,
      unitPrice,
      compensationMode,
      depreciationPercent:
        payload.depreciationPercent !== undefined && payload.depreciationPercent !== null && payload.depreciationPercent !== ""
          ? Number(payload.depreciationPercent)
          : defaultDepreciation,
      adjustmentAmount: payload.adjustmentAmount ?? 0,
      taxRate:
        payload.taxRate !== undefined && payload.taxRate !== null && payload.taxRate !== ""
          ? Number(payload.taxRate)
          : (catalogItem ? Number(catalogItem.tax_rate) : 0),
      isTaxInclusive:
        payload.isTaxInclusive !== undefined
          ? Boolean(payload.isTaxInclusive)
          : (catalogItem ? Boolean(catalogItem.is_tax_inclusive) : true),
    });

    if (calc.category === "SPECIAL_CLEANING" && calc.totalAmount <= 0) {
      throw validationError("Nếu áp dụng phí vệ sinh đặc biệt thì số tiền phải lớn hơn 0 đ. Nếu phòng sạch sẽ, không cần thêm mục này.");
    }

    assertManagerDirectAdjustmentWithinCap(calc, currentUser);

    const evidenceImageUrl = payload.evidenceImageUrl
      ? String(payload.evidenceImageUrl).trim().slice(0, 500)
      : null;

    await cancelPendingOnlineSettlementsInTx(tx, id);

    await new sql.Request(tx)
      .input("bookingId", sql.BigInt, id)
      .input("accommodationId", sql.Int, Number(bookingRow.accommodation_id))
      .input("catalogItemId", sql.Int, catalogItem ? Number(catalogItem.id) : null)
      .input("category", sql.VarChar(30), calc.category)
      .input("itemName", sql.NVarChar(200), itemName)
      .input("unitLabel", sql.NVarChar(30), unitLabel)
      .input("quantity", sql.Int, calc.quantity)
      .input("unitPrice", sql.Decimal(18, 0), calc.unitPrice)
      .input("compensationMode", sql.VarChar(30), calc.compensationMode)
      .input("depreciationPercent", sql.Decimal(5, 2), calc.depreciationPercent)
      .input("adjustmentAmount", sql.Decimal(18, 0), calc.adjustmentAmount)
      .input("isTaxInclusive", sql.Bit, calc.isTaxInclusive ? 1 : 0)
      .input("subtotalAmount", sql.Decimal(18, 0), calc.subtotalAmount)
      .input("taxRate", sql.Decimal(5, 2), calc.taxRate)
      .input("taxAmount", sql.Decimal(18, 0), calc.taxAmount)
      .input("totalAmount", sql.Decimal(18, 0), calc.totalAmount)
      .input("note", sql.NVarChar(500), note)
      .input("evidenceImageUrl", sql.NVarChar(500), evidenceImageUrl)
      .input("createdBy", sql.UniqueIdentifier, currentUser.id)
      .query(`
        INSERT INTO dbo.booking_incidental_charges (
          booking_id, accommodation_id, catalog_item_id, category, item_name, unit_label,
          quantity, unit_price, compensation_mode, depreciation_percent, adjustment_amount,
          is_tax_inclusive, subtotal_amount, tax_rate, tax_amount, total_amount,
          note, evidence_image_url, status, created_by, created_at
        )
        VALUES (
          @bookingId, @accommodationId, @catalogItemId, @category, @itemName, @unitLabel,
          @quantity, @unitPrice, @compensationMode, @depreciationPercent, @adjustmentAmount,
          @isTaxInclusive, @subtotalAmount, @taxRate, @taxAmount, @totalAmount,
          @note, @evidenceImageUrl, 'ACTIVE', @createdBy, SYSDATETIME()
        );
      `);
  });

  return getCheckoutFolio(id, currentUser);
}

async function updateIncidentalCharge(bookingId, chargeId, payload = {}, currentUser = {}) {
  const bId = parsePositiveInt(bookingId);
  const cId = parsePositiveInt(chargeId);
  if (!bId || !cId) {
    throw validationError("Mã đặt phòng hoặc mã khoản phát sinh không hợp lệ.");
  }

  const pool = db.getDBPool();

  await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, bId, currentUser, { lock: true });
    const invoiceRow = bookingRow ? await fetchInvoiceRow(tx, bId, { lock: true }) : null;
    assertStayEditableForCharges(bookingRow, invoiceRow);

    const existingRes = await new sql.Request(tx)
      .input("bookingId", sql.BigInt, bId)
      .input("chargeId", sql.BigInt, cId)
      .query(`
        SELECT *
        FROM dbo.booking_incidental_charges WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @chargeId AND booking_id = @bookingId;
      `);

    const existing = existingRes.recordset[0];
    if (!existing) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy khoản phát sinh.");
    }
    if (existing.status !== "ACTIVE") {
      throw invalidStateError("Không thể chỉnh sửa khoản phát sinh đã hủy.");
    }

    const { hasAdminRuling } = await fetchChargeNegotiationLockState(tx, cId);

    const nextItemName = payload.itemName !== undefined
      ? String(payload.itemName || "").trim()
      : existing.item_name;
    if (!nextItemName || nextItemName.length > 200) {
      throw validationError("Tên khoản phát sinh không hợp lệ.");
    }

    const nextNote = payload.note !== undefined
      ? (payload.note ? String(payload.note).trim() : null)
      : existing.note;

    if (
      (existing.category === "SPECIAL_CLEANING" ||
        existing.category === "DAMAGE_COMPENSATION" ||
        !existing.catalog_item_id) &&
      (!nextNote || nextNote.length < 3)
    ) {
      throw validationError("Vui lòng nhập lý do/ghi chú tối thiểu 3 ký tự.", {
        note: "Bắt buộc nhập lý do rõ ràng.",
      });
    }

    if (hasAdminRuling && currentUser?.role !== "ADMIN") {
      const requestedFinChange =
        (payload.quantity !== undefined && Number(payload.quantity) !== Number(existing.quantity)) ||
        (payload.unitPrice !== undefined && Number(payload.unitPrice) !== Number(existing.unit_price)) ||
        (payload.compensationMode !== undefined && String(payload.compensationMode).trim().toUpperCase() !== existing.compensation_mode) ||
        (payload.depreciationPercent !== undefined && Number(payload.depreciationPercent) !== Number(existing.depreciation_percent)) ||
        (payload.adjustmentAmount !== undefined && Number(payload.adjustmentAmount) !== Number(existing.adjustment_amount)) ||
        nextItemName !== existing.item_name;
      if (requestedFinChange) {
        throw invalidStateError(
          "Khoản bồi thường này đã có quyết định thẩm định từ Admin, Quản lý không thể tự ý chỉnh sửa giá trị đền.",
        );
      }
    }

    const calc = calculateChargeAmounts({
      category: existing.category,
      quantity: payload.quantity !== undefined ? payload.quantity : existing.quantity,
      unitPrice: payload.unitPrice !== undefined ? payload.unitPrice : existing.unit_price,
      compensationMode: payload.compensationMode !== undefined ? payload.compensationMode : existing.compensation_mode,
      depreciationPercent: payload.depreciationPercent !== undefined ? payload.depreciationPercent : existing.depreciation_percent,
      adjustmentAmount: payload.adjustmentAmount !== undefined ? payload.adjustmentAmount : existing.adjustment_amount,
      taxRate: payload.taxRate !== undefined ? payload.taxRate : existing.tax_rate,
      isTaxInclusive: payload.isTaxInclusive !== undefined ? payload.isTaxInclusive : existing.is_tax_inclusive,
    });

    assertManagerDirectAdjustmentWithinCap(calc, currentUser);

    const nextEvidence = payload.evidenceImageUrl !== undefined
      ? (payload.evidenceImageUrl ? String(payload.evidenceImageUrl).trim().slice(0, 500) : null)
      : existing.evidence_image_url;

    await cancelPendingOnlineSettlementsInTx(tx, bId);

    await new sql.Request(tx)
      .input("chargeId", sql.BigInt, cId)
      .input("itemName", sql.NVarChar(200), nextItemName)
      .input("quantity", sql.Int, calc.quantity)
      .input("unitPrice", sql.Decimal(18, 0), calc.unitPrice)
      .input("compensationMode", sql.VarChar(30), calc.compensationMode)
      .input("depreciationPercent", sql.Decimal(5, 2), calc.depreciationPercent)
      .input("adjustmentAmount", sql.Decimal(18, 0), calc.adjustmentAmount)
      .input("isTaxInclusive", sql.Bit, calc.isTaxInclusive ? 1 : 0)
      .input("subtotalAmount", sql.Decimal(18, 0), calc.subtotalAmount)
      .input("taxRate", sql.Decimal(5, 2), calc.taxRate)
      .input("taxAmount", sql.Decimal(18, 0), calc.taxAmount)
      .input("totalAmount", sql.Decimal(18, 0), calc.totalAmount)
      .input("note", sql.NVarChar(500), nextNote)
      .input("evidenceImageUrl", sql.NVarChar(500), nextEvidence)
      .query(`
        UPDATE dbo.booking_incidental_charges
        SET
          item_name = @itemName,
          quantity = @quantity,
          unit_price = @unitPrice,
          compensation_mode = @compensationMode,
          depreciation_percent = @depreciationPercent,
          adjustment_amount = @adjustmentAmount,
          is_tax_inclusive = @isTaxInclusive,
          subtotal_amount = @subtotalAmount,
          tax_rate = @taxRate,
          tax_amount = @taxAmount,
          total_amount = @totalAmount,
          note = @note,
          evidence_image_url = @evidenceImageUrl,
          updated_at = SYSDATETIME()
        WHERE id = @chargeId;
      `);
  });

  return getCheckoutFolio(bId, currentUser);
}

async function voidIncidentalCharge(bookingId, chargeId, currentUser = {}) {
  const bId = parsePositiveInt(bookingId);
  const cId = parsePositiveInt(chargeId);
  if (!bId || !cId) {
    throw validationError("Mã đặt phòng hoặc mã khoản phát sinh không hợp lệ.");
  }

  const pool = db.getDBPool();

  await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, bId, currentUser, { lock: true });
    const invoiceRow = bookingRow ? await fetchInvoiceRow(tx, bId, { lock: true }) : null;
    assertStayEditableForCharges(bookingRow, invoiceRow);

    const existingRes = await new sql.Request(tx)
      .input("bookingId", sql.BigInt, bId)
      .input("chargeId", sql.BigInt, cId)
      .query(`
        SELECT id, status
        FROM dbo.booking_incidental_charges WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @chargeId AND booking_id = @bookingId;
      `);

    const existing = existingRes.recordset[0];
    if (!existing) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy khoản phát sinh.");
    }
    if (existing.status !== "ACTIVE") {
      throw invalidStateError("Khoản phát sinh này đã được hủy trước đó.");
    }

    await assertChargeCanBeVoided(tx, cId, currentUser);

    await cancelPendingOnlineSettlementsInTx(tx, bId);

    await new sql.Request(tx)
      .input("chargeId", sql.BigInt, cId)
      .input("actorId", sql.UniqueIdentifier, currentUser.id)
      .query(`
        UPDATE dbo.booking_incidental_charges
        SET
          status = 'VOIDED',
          voided_by = @actorId,
          voided_at = SYSDATETIME(),
          updated_at = SYSDATETIME()
        WHERE id = @chargeId;
      `);
  });

  return getCheckoutFolio(bId, currentUser);
}

async function upsertInvoiceSnapshotInTx(tx, {
  bookingRow,
  existingInvoice,
  summary,
  status,
  guestConfirmed,
  note,
  settledBy,
  paidAmount,
}) {
  const bookingId = Number(bookingRow.id);
  const accommodationId = Number(bookingRow.accommodation_id);
  const invoiceCode = existingInvoice?.invoice_code || buildInvoiceCode(bookingId);

  if (existingInvoice) {
    const res = await new sql.Request(tx)
      .input("id", sql.BigInt, Number(existingInvoice.id))
      .input("bookingOriginalTotal", sql.Decimal(18, 0), summary.bookingOriginalTotal)
      .input("prepaidAmount", sql.Decimal(18, 0), summary.prepaidAmount)
      .input("minibarTotal", sql.Decimal(18, 0), summary.minibarTotal)
      .input("extraServiceTotal", sql.Decimal(18, 0), summary.extraServiceTotal)
      .input("specialCleaningTotal", sql.Decimal(18, 0), summary.specialCleaningTotal)
      .input("compensationTotal", sql.Decimal(18, 0), summary.compensationTotal)
      .input("incidentalTaxTotal", sql.Decimal(18, 0), summary.incidentalTaxTotal)
      .input("incidentalGrandTotal", sql.Decimal(18, 0), summary.incidentalGrandTotal)
      .input("stayGrandTotal", sql.Decimal(18, 0), summary.stayGrandTotal)
      .input("settlementDueAmount", sql.Decimal(18, 0), summary.settlementDueAmount)
      .input("settlementPaidAmount", sql.Decimal(18, 0), paidAmount)
      .input("settlementStatus", sql.VarChar(25), status)
      .input("guestConfirmed", sql.Bit, guestConfirmed ? 1 : 0)
      .input("note", sql.NVarChar(500), note || null)
      .input("settledBy", sql.UniqueIdentifier, settledBy || null)
      .query(`
        UPDATE dbo.booking_checkout_invoices
        SET
          booking_original_total = @bookingOriginalTotal,
          prepaid_amount = @prepaidAmount,
          minibar_total = @minibarTotal,
          extra_service_total = @extraServiceTotal,
          special_cleaning_total = @specialCleaningTotal,
          compensation_total = @compensationTotal,
          incidental_tax_total = @incidentalTaxTotal,
          incidental_grand_total = @incidentalGrandTotal,
          stay_grand_total = @stayGrandTotal,
          settlement_due_amount = @settlementDueAmount,
          settlement_paid_amount = @settlementPaidAmount,
          settlement_status = @settlementStatus,
          guest_confirmed = @guestConfirmed,
          note = @note,
          settled_by = @settledBy,
          settled_at = CASE WHEN @settlementStatus = 'SETTLED' THEN SYSDATETIME() ELSE NULL END,
          updated_at = SYSDATETIME()
        OUTPUT INSERTED.*
        WHERE id = @id;
      `);
    return res.recordset[0];
  }

  const res = await new sql.Request(tx)
    .input("invoiceCode", sql.VarChar(40), invoiceCode)
    .input("bookingId", sql.BigInt, bookingId)
    .input("accommodationId", sql.Int, accommodationId)
    .input("bookingOriginalTotal", sql.Decimal(18, 0), summary.bookingOriginalTotal)
    .input("prepaidAmount", sql.Decimal(18, 0), summary.prepaidAmount)
    .input("minibarTotal", sql.Decimal(18, 0), summary.minibarTotal)
    .input("extraServiceTotal", sql.Decimal(18, 0), summary.extraServiceTotal)
    .input("specialCleaningTotal", sql.Decimal(18, 0), summary.specialCleaningTotal)
    .input("compensationTotal", sql.Decimal(18, 0), summary.compensationTotal)
    .input("incidentalTaxTotal", sql.Decimal(18, 0), summary.incidentalTaxTotal)
    .input("incidentalGrandTotal", sql.Decimal(18, 0), summary.incidentalGrandTotal)
    .input("stayGrandTotal", sql.Decimal(18, 0), summary.stayGrandTotal)
    .input("settlementDueAmount", sql.Decimal(18, 0), summary.settlementDueAmount)
    .input("settlementPaidAmount", sql.Decimal(18, 0), paidAmount)
    .input("settlementStatus", sql.VarChar(25), status)
    .input("guestConfirmed", sql.Bit, guestConfirmed ? 1 : 0)
    .input("note", sql.NVarChar(500), note || null)
    .input("settledBy", sql.UniqueIdentifier, settledBy || null)
    .query(`
      INSERT INTO dbo.booking_checkout_invoices (
        invoice_code, booking_id, accommodation_id,
        booking_original_total, prepaid_amount,
        minibar_total, extra_service_total, special_cleaning_total,
        compensation_total, incidental_tax_total, incidental_grand_total,
        stay_grand_total, settlement_due_amount, settlement_paid_amount,
        settlement_status, guest_confirmed, note, settled_by, settled_at, created_at
      )
      OUTPUT INSERTED.*
      VALUES (
        @invoiceCode, @bookingId, @accommodationId,
        @bookingOriginalTotal, @prepaidAmount,
        @minibarTotal, @extraServiceTotal, @specialCleaningTotal,
        @compensationTotal, @incidentalTaxTotal, @incidentalGrandTotal,
        @stayGrandTotal, @settlementDueAmount, @settlementPaidAmount,
        @settlementStatus, @guestConfirmed, @note, @settledBy,
        CASE WHEN @settlementStatus = 'SETTLED' THEN SYSDATETIME() ELSE NULL END,
        SYSDATETIME()
      );
    `);

  return res.recordset[0];
}

async function settleCheckout(bookingId, payload = {}, currentUser = {}) {
  const id = parsePositiveInt(bookingId);
  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.");
  }

  const paymentMethod = String(payload.paymentMethod || "").trim().toUpperCase();
  if (!DIRECT_SETTLEMENT_METHODS.includes(paymentMethod)) {
    throw validationError("Phương thức thanh toán tại quầy không hợp lệ.", {
      paymentMethod: `Chỉ chấp nhận: ${DIRECT_SETTLEMENT_METHODS.join(", ")}`,
    });
  }

  const guestConfirmed = Boolean(payload.guestConfirmed);
  const note = payload.note ? String(payload.note).trim().slice(0, 500) : null;
  const providerRef = payload.providerRef ? String(payload.providerRef).trim().slice(0, 100) : null;
  const paymentNote = payload.paymentNote ? String(payload.paymentNote).trim().slice(0, 300) : null;

  const pool = db.getDBPool();

  await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, id, currentUser, { lock: true });
    if (!bookingRow) {
      throw new CheckoutSettlementError(
        404,
        ERROR_CODES.NOT_FOUND,
        "Không tìm thấy đặt phòng trong phạm vi quản lý.",
      );
    }
    if (bookingRow.status !== "CONFIRMED") {
      throw invalidStateError("Chỉ booking đã xác nhận mới được phép kết toán trả phòng.");
    }
    if (!bookingRow.checked_in_at) {
      throw invalidStateError("Khách chưa nhận phòng, chưa thể kết toán trả phòng.");
    }

    const existingInvoice = await fetchInvoiceRow(tx, id, { lock: true });
    if (bookingRow.checked_out_at || existingInvoice?.settlement_status === "SETTLED") {
      throw invalidStateError("Đơn đặt phòng đã kết toán và trả phòng trước đó.");
    }

    await assertNoPendingNegotiationOnBooking(tx, id);

    const prepaidInfo = await fetchPrepaidSummary(tx, id);
    const activeCharges = await fetchChargesForBooking(tx, id, { includeVoided: false });

    const summary = computeFolioSummary({
      bookingOriginalTotal: Number(bookingRow.total_amount || 0),
      prepaidAmount: prepaidInfo.prepaidAmount,
      charges: activeCharges,
    });

    const dueAmount = summary.settlementDueAmount;

    if (dueAmount <= 0 && paymentMethod !== "NO_EXTRA_CHARGE") {
      throw validationError(
        "Số tiền cần thanh toán thêm đang bằng 0 đ. Vui lòng chọn 'Không phát sinh (0 đ)' để tất toán.",
        { paymentMethod: "Chọn NO_EXTRA_CHARGE khi phát sinh bằng 0 đ." },
      );
    }
    if (dueAmount > 0 && paymentMethod === "NO_EXTRA_CHARGE") {
      throw validationError(
        `Khách còn cần thanh toán ${dueAmount.toLocaleString("vi-VN")} đ. Vui lòng chọn Tiền mặt, Chuyển khoản VietQR hoặc POS.`,
        { paymentMethod: "Không thể chọn tất toán 0 đ khi vẫn còn công nợ phát sinh." },
      );
    }

    let cashReceived = null;
    let cashChange = null;
    if (paymentMethod === "CASH") {
      cashReceived =
        payload.cashReceived !== undefined && payload.cashReceived !== null && payload.cashReceived !== ""
          ? Math.round(Number(payload.cashReceived))
          : dueAmount;

      if (!Number.isFinite(cashReceived) || cashReceived < dueAmount) {
        throw validationError(
          `Tiền mặt khách đưa phải lớn hơn hoặc bằng ${dueAmount.toLocaleString("vi-VN")} đ.`,
          { cashReceived: "Số tiền khách đưa chưa đủ." },
        );
      }
      cashChange = cashReceived - dueAmount;
    }

    await cancelPendingOnlineSettlementsInTx(tx, id);

    const invoice = await upsertInvoiceSnapshotInTx(tx, {
      bookingRow,
      existingInvoice,
      summary,
      status: "SETTLED",
      guestConfirmed,
      note,
      settledBy: currentUser.id,
      paidAmount: Math.max(0, dueAmount),
    });

    await new sql.Request(tx)
      .input("invoiceId", sql.BigInt, Number(invoice.id))
      .input("bookingId", sql.BigInt, id)
      .input("settlementCode", sql.VarChar(40), buildSettlementCode())
      .input("paymentMethod", sql.VarChar(30), paymentMethod)
      .input("amount", sql.Decimal(18, 0), Math.max(0, dueAmount))
      .input("cashReceived", sql.Decimal(18, 0), cashReceived)
      .input("cashChange", sql.Decimal(18, 0), cashChange)
      .input("providerRef", sql.VarChar(100), providerRef)
      .input("confirmedBy", sql.UniqueIdentifier, currentUser.id)
      .input("note", sql.NVarChar(300), paymentNote)
      .query(`
        INSERT INTO dbo.checkout_settlement_payments (
          invoice_id, booking_id, settlement_code, payment_method,
          amount, cash_received, cash_change, provider_ref,
          status, confirmed_by, paid_at, note, created_at
        )
        VALUES (
          @invoiceId, @bookingId, @settlementCode, @paymentMethod,
          @amount, @cashReceived, @cashChange, @providerRef,
          'SUCCESS', @confirmedBy, SYSDATETIME(), @note, SYSDATETIME()
        );
      `);

    const updateBookingRes = await new sql.Request(tx)
      .input("bookingId", sql.BigInt, id)
      .input("actorId", sql.UniqueIdentifier, currentUser.id)
      .query(`
        UPDATE dbo.bookings
        SET
          checked_out_at = SYSDATETIME(),
          checked_out_by = @actorId,
          updated_at = SYSDATETIME()
        OUTPUT INSERTED.id
        WHERE id = @bookingId
          AND status = 'CONFIRMED'
          AND checked_in_at IS NOT NULL
          AND checked_out_at IS NULL;
      `);

    if (!updateBookingRes.recordset[0]) {
      throw invalidStateError("Đơn đặt phòng vừa được trả phòng bởi phiên khác.");
    }
  });

  return getCheckoutFolio(id, currentUser);
}

async function createVnpaySettlementSession(bookingId, payload = {}, ipAddress = "127.0.0.1", currentUser = {}) {
  const id = parsePositiveInt(bookingId);
  if (!id) {
    throw validationError("Mã đặt phòng không hợp lệ.");
  }

  const pool = db.getDBPool();
  const note = payload.note ? String(payload.note).trim().slice(0, 500) : null;
  const guestConfirmed = payload.guestConfirmed !== undefined ? Boolean(payload.guestConfirmed) : true;

  const sessionData = await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, id, currentUser, { lock: true });
    if (!bookingRow) {
      throw new CheckoutSettlementError(
        404,
        ERROR_CODES.NOT_FOUND,
        "Không tìm thấy đặt phòng trong phạm vi quản lý.",
      );
    }
    if (bookingRow.status !== "CONFIRMED") {
      throw invalidStateError("Chỉ booking đã xác nhận mới có thể tạo liên kết VNPay kết toán.");
    }
    if (!bookingRow.checked_in_at) {
      throw invalidStateError("Khách chưa nhận phòng, chưa thể tạo liên kết VNPay trả phòng.");
    }

    const existingInvoice = await fetchInvoiceRow(tx, id, { lock: true });
    if (bookingRow.checked_out_at || existingInvoice?.settlement_status === "SETTLED") {
      throw invalidStateError("Đơn đặt phòng đã hoàn tất trả phòng trước đó.");
    }

    await assertNoPendingNegotiationOnBooking(tx, id);

    const prepaidInfo = await fetchPrepaidSummary(tx, id);
    const activeCharges = await fetchChargesForBooking(tx, id, { includeVoided: false });

    const summary = computeFolioSummary({
      bookingOriginalTotal: Number(bookingRow.total_amount || 0),
      prepaidAmount: prepaidInfo.prepaidAmount,
      charges: activeCharges,
    });

    if (summary.settlementDueAmount <= 0) {
      throw invalidStateError("Không có chi phí phát sinh cần thanh toán qua VNPay (công nợ = 0 đ).");
    }

    await cancelPendingOnlineSettlementsInTx(tx, id);

    const invoice = await upsertInvoiceSnapshotInTx(tx, {
      bookingRow,
      existingInvoice,
      summary,
      status: "PENDING_PAYMENT",
      guestConfirmed,
      note,
      settledBy: null,
      paidAmount: 0,
    });

    const settlementCode = buildSettlementCode();
    const vnpTxnRef = buildVnpTxnRef();

    await new sql.Request(tx)
      .input("invoiceId", sql.BigInt, Number(invoice.id))
      .input("bookingId", sql.BigInt, id)
      .input("settlementCode", sql.VarChar(40), settlementCode)
      .input("amount", sql.Decimal(18, 0), summary.settlementDueAmount)
      .input("vnpTxnRef", sql.VarChar(100), vnpTxnRef)
      .input("note", sql.NVarChar(300), "Khởi tạo cổng VNPay cho phần chi phí phát sinh trả phòng.")
      .query(`
        INSERT INTO dbo.checkout_settlement_payments (
          invoice_id, booking_id, settlement_code, payment_method,
          amount, vnp_txn_ref, status, note, created_at
        )
        VALUES (
          @invoiceId, @bookingId, @settlementCode, 'VNPAY',
          @amount, @vnpTxnRef, 'PENDING', @note, SYSDATETIME()
        );
      `);

    const vnpInfo = buildSettlementVnpayUrl({
      txnRef: vnpTxnRef,
      amountVnd: summary.settlementDueAmount,
      bookingCode: bookingRow.booking_code,
      ipAddress,
    });

    return {
      invoiceCode: invoice.invoice_code,
      settlementCode,
      txnRef: vnpTxnRef,
      amount: summary.settlementDueAmount,
      vnpayUrl: vnpInfo.paymentUrl,
      returnUrl: vnpInfo.returnUrl,
      expireDate: vnpInfo.expireDate,
    };
  });

  const qrDataUrl = await generateQrDataUrl(sessionData.vnpayUrl);
  const folio = await getCheckoutFolio(id, currentUser);

  return {
    vnpaySession: {
      ...sessionData,
      qrDataUrl,
    },
    folio,
  };
}

module.exports = {
  CHARGE_CATEGORIES,
  COMPENSATION_MODES,
  DIRECT_SETTLEMENT_METHODS,
  MANAGER_DIRECT_ADJUSTMENT_MAX_VND,
  MANAGER_DIRECT_ADJUSTMENT_MAX_PCT,
  CheckoutSettlementError,
  getSuggestedDepreciationPercent,
  getManagerDirectAdjustmentCap,
  calculateChargeAmounts,
  computeFolioSummary,
  getCheckoutFolio,
  addIncidentalCharge,
  updateIncidentalCharge,
  voidIncidentalCharge,
  settleCheckout,
  createVnpaySettlementSession,
  fetchPrepaidSummary,
  fetchChargesForBooking,
  fetchInvoiceRow,
  fetchSettlementPayments,
  fetchNegotiationsForBooking,
  fetchBookingCoreFixedSql,
  assertStayEditableForCharges,
  cancelPendingOnlineSettlementsInTx,
  runInTransaction,
  mapNegotiationRow,
  parsePositiveInt,
  validationError,
  invalidStateError,
  buildInvoiceCode,
  buildSettlementCode,
  buildVnpTxnRef,
};
