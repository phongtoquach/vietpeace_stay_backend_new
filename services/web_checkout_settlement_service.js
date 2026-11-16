const db = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const {
  computeFolioSummary,
  fetchPrepaidSummary,
  fetchChargesForBooking,
  fetchInvoiceRow,
  buildInvoiceCode,
  buildSettlementCode,
  buildVnpTxnRef,
} = require("./checkout_settlement_service");
const {
  buildSettlementVnpayUrl,
  verifySettlementVnpayPayload,
} = require("./vnpay_checkout_settlement_helper");

const sql = db.sqlObj;

class WebSettlementError extends Error {
  constructor(statusCode, errorCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
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
      // ignore rollback secondary failure
    }
    throw error;
  }
}

async function createCustomerVnpaySettlement(customerId, bookingIdentifier, ipAddress = "127.0.0.1") {
  if (!customerId) {
    throw new WebSettlementError(401, ERROR_CODES.UNAUTHENTICATED, "Vui lòng đăng nhập.");
  }

  const rawParam = String(bookingIdentifier || "").trim();
  const isNumericId = /^[1-9]\d{0,18}$/.test(rawParam);
  const pool = db.getDBPool();

  return runInTransaction(pool, async (tx) => {
    const req = new sql.Request(tx)
      .input("customerId", sql.UniqueIdentifier, customerId)
      .input("bookingId", sql.BigInt, isNumericId ? rawParam : null)
      .input("bookingCode", sql.VarChar(50), rawParam.toUpperCase());

    const bRes = await req.query(`
      SELECT TOP 1
        b.id,
        b.booking_code,
        b.accommodation_id,
        b.status,
        b.total_amount,
        b.checked_in_at,
        b.checked_out_at
      FROM dbo.bookings b WITH (UPDLOCK, HOLDLOCK)
      WHERE b.user_id = @customerId
        AND (
          (@bookingId IS NOT NULL AND b.id = @bookingId)
          OR UPPER(b.booking_code) = @bookingCode
        );
    `);

    const bookingRow = bRes.recordset[0];
    if (!bookingRow) {
      throw new WebSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy đơn đặt phòng của bạn.");
    }

    const bookingId = Number(bookingRow.id);
    if (bookingRow.status !== "CONFIRMED" || !bookingRow.checked_in_at) {
      throw new WebSettlementError(
        409,
        ERROR_CODES.INVALID_STATE,
        "Đơn đặt phòng chưa ở trạng thái đang lưu trú nên chưa thể thanh toán phát sinh.",
      );
    }

    const invoiceRow = await fetchInvoiceRow(tx, bookingId, { lock: true });
    if (bookingRow.checked_out_at || invoiceRow?.settlement_status === "SETTLED") {
      throw new WebSettlementError(
        409,
        ERROR_CODES.INVALID_STATE,
        "Hóa đơn trả phòng của đơn này đã được tất toán xong.",
      );
    }

    if (!invoiceRow || invoiceRow.settlement_status !== "PENDING_PAYMENT") {
      throw new WebSettlementError(
        409,
        ERROR_CODES.INVALID_STATE,
        "Quản lý cơ sở chưa chốt bảng kê yêu cầu thanh toán trực tuyến.",
      );
    }

    const prepaidInfo = await fetchPrepaidSummary(tx, bookingId);
    const activeCharges = await fetchChargesForBooking(tx, bookingId, { includeVoided: false });

    const summary = computeFolioSummary({
      bookingOriginalTotal: Number(bookingRow.total_amount || 0),
      prepaidAmount: prepaidInfo.prepaidAmount,
      charges: activeCharges,
    });

    if (summary.settlementDueAmount <= 0) {
      throw new WebSettlementError(
        409,
        ERROR_CODES.INVALID_STATE,
        "Không có khoản phát sinh cần thanh toán.",
      );
    }

    await new sql.Request(tx)
      .input("bookingId", sql.BigInt, bookingId)
      .query(`
        UPDATE dbo.checkout_settlement_payments
        SET status = 'CANCELLED', updated_at = SYSDATETIME()
        WHERE booking_id = @bookingId AND status = 'PENDING';
      `);

    const settlementCode = buildSettlementCode();
    const vnpTxnRef = buildVnpTxnRef();
    const invoiceCode = invoiceRow.invoice_code || buildInvoiceCode(bookingId);

    await new sql.Request(tx)
      .input("invoiceId", sql.BigInt, Number(invoiceRow.id))
      .input("bookingId", sql.BigInt, bookingId)
      .input("settlementCode", sql.VarChar(40), settlementCode)
      .input("amount", sql.Decimal(18, 0), summary.settlementDueAmount)
      .input("vnpTxnRef", sql.VarChar(100), vnpTxnRef)
      .input("note", sql.NVarChar(300), "Khách hàng thanh toán phát sinh trả phòng từ Đặt phòng của tôi.")
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

    const vnp = buildSettlementVnpayUrl({
      txnRef: vnpTxnRef,
      amountVnd: summary.settlementDueAmount,
      bookingCode: bookingRow.booking_code,
      ipAddress,
    });

    return {
      vnpayUrl: vnp.paymentUrl,
      txnRef: vnpTxnRef,
      settlementCode,
      invoiceCode,
      amount: summary.settlementDueAmount,
      bookingCode: bookingRow.booking_code,
    };
  });
}

async function verifyCustomerSettlementVnpayReturn(queryPayload) {
  const verified = verifySettlementVnpayPayload(queryPayload);
  const pool = db.getDBPool();

  return runInTransaction(pool, async (tx) => {
    const payRes = await new sql.Request(tx)
      .input("txnRef", sql.VarChar(100), verified.txnRef)
      .query(`
        SELECT TOP 1
          sp.id AS payment_id,
          sp.invoice_id,
          sp.booking_id,
          sp.settlement_code,
          sp.amount,
          sp.status AS payment_status,
          sp.provider_ref,
          sp.paid_at,
          inv.invoice_code,
          inv.settlement_status,
          b.booking_code,
          b.checked_out_at
        FROM dbo.checkout_settlement_payments sp WITH (UPDLOCK, HOLDLOCK)
        JOIN dbo.booking_checkout_invoices inv WITH (UPDLOCK, HOLDLOCK) ON inv.id = sp.invoice_id
        JOIN dbo.bookings b WITH (UPDLOCK, HOLDLOCK) ON b.id = sp.booking_id
        WHERE sp.vnp_txn_ref = @txnRef;
      `);

    const row = payRes.recordset[0];
    if (!row) {
      throw new WebSettlementError(
        404,
        ERROR_CODES.NOT_FOUND,
        "Không tìm thấy giao dịch thanh toán phát sinh tương ứng.",
      );
    }

    const expectedAmountX100 = BigInt(Math.round(Number(row.amount || 0))) * 100n;
    if (expectedAmountX100 !== verified.amountX100) {
      throw new WebSettlementError(
        409,
        ERROR_CODES.INVALID_STATE,
        "Số tiền trả về từ VNPay không khớp với số tiền trên hóa đơn phát sinh.",
      );
    }

    if (row.payment_status === "SUCCESS" || row.settlement_status === "SETTLED") {
      return {
        paid: true,
        alreadyProcessed: true,
        bookingId: String(row.booking_id),
        bookingCode: row.booking_code,
        invoiceCode: row.invoice_code,
        settlementCode: row.settlement_code,
        amount: Number(row.amount || 0),
        transactionNo: row.provider_ref || verified.transactionNo,
        responseCode: verified.responseCode,
        payDate: verified.payDate,
      };
    }

    if (verified.paid) {
      await new sql.Request(tx)
        .input("paymentId", sql.BigInt, Number(row.payment_id))
        .input("invoiceId", sql.BigInt, Number(row.invoice_id))
        .input("bookingId", sql.BigInt, Number(row.booking_id))
        .input("amount", sql.Decimal(18, 0), Number(row.amount || 0))
        .input("providerRef", sql.VarChar(100), verified.transactionNo)
        .query(`
          UPDATE dbo.checkout_settlement_payments
          SET
            status = 'SUCCESS',
            provider_ref = @providerRef,
            paid_at = SYSDATETIME(),
            updated_at = SYSDATETIME()
          WHERE id = @paymentId;

          UPDATE dbo.checkout_settlement_payments
          SET status = 'CANCELLED', updated_at = SYSDATETIME()
          WHERE invoice_id = @invoiceId
            AND id <> @paymentId
            AND status = 'PENDING';

          UPDATE dbo.booking_checkout_invoices
          SET
            settlement_status = 'SETTLED',
            settlement_paid_amount = @amount,
            settled_at = COALESCE(settled_at, SYSDATETIME()),
            updated_at = SYSDATETIME()
          WHERE id = @invoiceId;

          UPDATE dbo.bookings
          SET
            checked_out_at = COALESCE(checked_out_at, SYSDATETIME()),
            updated_at = SYSDATETIME()
          WHERE id = @bookingId
            AND status = 'CONFIRMED'
            AND checked_in_at IS NOT NULL;
        `);

      return {
        paid: true,
        alreadyProcessed: false,
        bookingId: String(row.booking_id),
        bookingCode: row.booking_code,
        invoiceCode: row.invoice_code,
        settlementCode: row.settlement_code,
        amount: Number(row.amount || 0),
        transactionNo: verified.transactionNo,
        responseCode: verified.responseCode,
        payDate: verified.payDate,
      };
    }

    await new sql.Request(tx)
      .input("paymentId", sql.BigInt, Number(row.payment_id))
      .input("providerRef", sql.VarChar(100), verified.transactionNo)
      .input(
        "note",
        sql.NVarChar(300),
        `VNPay không thành công (Mã ${verified.responseCode}/${verified.transactionStatus}).`,
      )
      .query(`
        UPDATE dbo.checkout_settlement_payments
        SET
          status = 'FAILED',
          provider_ref = COALESCE(@providerRef, provider_ref),
          note = @note,
          updated_at = SYSDATETIME()
        WHERE id = @paymentId
          AND status = 'PENDING';
      `);

    return {
      paid: false,
      alreadyProcessed: false,
      bookingId: String(row.booking_id),
      bookingCode: row.booking_code,
      invoiceCode: row.invoice_code,
      settlementCode: row.settlement_code,
      amount: Number(row.amount || 0),
      transactionNo: verified.transactionNo,
      responseCode: verified.responseCode,
      payDate: verified.payDate,
    };
  });
}

module.exports = {
  WebSettlementError,
  createCustomerVnpaySettlement,
  verifyCustomerSettlementVnpayReturn,
};
