const { createHmac, timingSafeEqual } = require("node:crypto");
const QRCode = require("qrcode");

const VNPAY_ENCODE = (value) => encodeURIComponent(String(value)).replace(/%20/g, "+");

function formatVnStamp(date = new Date()) {
  const vnMillis = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(vnMillis);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function normalizeClientIp(ipAddress) {
  return String(ipAddress || "127.0.0.1")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "")
    .replace(/^::1$/, "127.0.0.1") || "127.0.0.1";
}

function getVnpayConfig() {
  const {
    VNPAY_PAYMENT_URL,
    VNPAY_TMN_CODE,
    VNPAY_HASH_SECRET,
    WEB_DOMAIN,
  } = process.env;

  if (!VNPAY_PAYMENT_URL || !VNPAY_TMN_CODE || !VNPAY_HASH_SECRET) {
    throw Object.assign(
      new Error("Thiếu cấu hình cổng thanh toán VNPay trên máy chủ."),
      { statusCode: 500, errorCode: "INTERNAL_ERROR" },
    );
  }

  const parsedUrl = new URL(VNPAY_PAYMENT_URL);
  if (parsedUrl.protocol !== "https:" || parsedUrl.search || parsedUrl.hash) {
    throw Object.assign(
      new Error("VNPAY_PAYMENT_URL không hợp lệ."),
      { statusCode: 500, errorCode: "INTERNAL_ERROR" },
    );
  }

  return {
    paymentUrl: parsedUrl.toString(),
    tmnCode: VNPAY_TMN_CODE,
    hashSecret: VNPAY_HASH_SECRET,
    defaultReturnUrl: `${String(WEB_DOMAIN || "http://localhost:5178").replace(/\/+$/, "")}/bookings/settlement-vnpay-return`,
  };
}

function signQueryString(query, secret) {
  return createHmac("sha512", secret).update(query, "utf8").digest("hex");
}

function buildSettlementVnpayUrl({
  txnRef,
  amountVnd,
  bookingCode,
  ipAddress,
  returnUrl,
  expireMinutes = 15,
}) {
  const cfg = getVnpayConfig();
  const amountInt = Math.round(Number(amountVnd));

  if (!Number.isFinite(amountInt) || amountInt <= 0) {
    throw Object.assign(
      new Error("Số tiền thanh toán phát sinh VNPay phải lớn hơn 0 đ."),
      { statusCode: 409, errorCode: "INVALID_STATE" },
    );
  }

  if (!/^[A-Za-z0-9]{4,100}$/.test(String(txnRef || ""))) {
    throw Object.assign(
      new Error("Mã tham chiếu vnp_TxnRef không hợp lệ."),
      { statusCode: 500, errorCode: "INTERNAL_ERROR" },
    );
  }

  const now = new Date();
  const expireAt = new Date(now.getTime() + expireMinutes * 60 * 1000);
  const cleanCode = String(bookingCode || "").replace(/[^A-Za-z0-9_-]/g, "");

  const params = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: cfg.tmnCode,
    vnp_Amount: String(BigInt(amountInt) * 100n),
    vnp_CurrCode: "VND",
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: `Thanh toan phat sinh tra phong ${cleanCode}`.trim(),
    vnp_OrderType: "other",
    vnp_Locale: "vn",
    vnp_ReturnUrl: returnUrl || cfg.defaultReturnUrl,
    vnp_IpAddr: normalizeClientIp(ipAddress),
    vnp_CreateDate: formatVnStamp(now),
    vnp_ExpireDate: formatVnStamp(expireAt),
  };

  const query = Object.keys(params)
    .sort()
    .map((key) => `${VNPAY_ENCODE(key)}=${VNPAY_ENCODE(params[key])}`)
    .join("&");

  const signature = signQueryString(query, cfg.hashSecret);

  return {
    paymentUrl: `${cfg.paymentUrl}?${query}&vnp_SecureHash=${signature}`,
    txnRef,
    amountVnd: amountInt,
    returnUrl: params.vnp_ReturnUrl,
    createDate: params.vnp_CreateDate,
    expireDate: params.vnp_ExpireDate,
  };
}

function verifySettlementVnpayPayload(body) {
  const { VNPAY_TMN_CODE, VNPAY_HASH_SECRET } = process.env;
  if (!VNPAY_TMN_CODE || !VNPAY_HASH_SECRET) {
    throw Object.assign(new Error("Thiếu cấu hình VNPay."), { statusCode: 500 });
  }

  const invalid = (message) =>
    Object.assign(new Error(message), { statusCode: 400, errorCode: "VALIDATION_ERROR" });

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("Dữ liệu trả về từ VNPay không hợp lệ.");
  }

  const keys = Object.keys(body);
  if (
    keys.length > 32 ||
    keys.some(
      (key) =>
        !/^vnp_[A-Za-z0-9]+$/.test(key) ||
        typeof body[key] !== "string" ||
        body[key].length > 1024,
    )
  ) {
    throw invalid("Tham số trả về từ VNPay không hợp lệ.");
  }

  if (
    !/^[A-Za-z0-9]{4,100}$/.test(body.vnp_TxnRef || "") ||
    !/^[0-9]{1,12}$/.test(body.vnp_Amount || "") ||
    !/^[0-9]{2}$/.test(body.vnp_ResponseCode || "") ||
    !/^[0-9]{2}$/.test(body.vnp_TransactionStatus || "") ||
    body.vnp_TmnCode !== VNPAY_TMN_CODE
  ) {
    throw invalid("Thiếu thông tin giao dịch hoặc mã merchant VNPay không khớp.");
  }

  const signedString = keys
    .filter((key) => key !== "vnp_SecureHash" && key !== "vnp_SecureHashType")
    .sort()
    .map((key) => `${VNPAY_ENCODE(key)}=${VNPAY_ENCODE(body[key])}`)
    .join("&");

  const receivedHash = String(body.vnp_SecureHash || "");
  if (!/^[a-f0-9]{128}$/i.test(receivedHash)) {
    throw invalid("Chữ ký VNPay không hợp lệ.");
  }

  const expectedDigest = createHmac("sha512", VNPAY_HASH_SECRET)
    .update(signedString, "utf8")
    .digest();
  const receivedDigest = Buffer.from(receivedHash, "hex");
  if (!timingSafeEqual(expectedDigest, receivedDigest)) {
    throw invalid("Chữ ký xác thực VNPay không khớp.");
  }

  const paid =
    body.vnp_ResponseCode === "00" && body.vnp_TransactionStatus === "00";

  if (
    paid &&
    (!/^[0-9]{1,15}$/.test(body.vnp_TransactionNo || "") ||
      BigInt(body.vnp_TransactionNo) === 0n ||
      !/^[0-9]{14}$/.test(body.vnp_PayDate || ""))
  ) {
    throw invalid("Thiếu mã giao dịch hoặc thời điểm thanh toán VNPay.");
  }

  const amountX100 = BigInt(body.vnp_Amount);
  return {
    txnRef: body.vnp_TxnRef,
    amountX100,
    amountVnd: Number(amountX100 / 100n),
    transactionNo: body.vnp_TransactionNo || null,
    payDate: body.vnp_PayDate || null,
    responseCode: body.vnp_ResponseCode,
    transactionStatus: body.vnp_TransactionStatus,
    bankCode: body.vnp_BankCode || null,
    paid,
    failed: !paid,
  };
}

async function generateQrDataUrl(text) {
  if (!text) return null;
  try {
    return await QRCode.toDataURL(text, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: "M",
    });
  } catch {
    return null;
  }
}

async function buildVietQrInfo({ bookingCode, amountVnd }) {
  const bankBin = process.env.VIETQR_BANK_BIN || "970436";
  const bankName = process.env.VIETQR_BANK_NAME || "Vietcombank (VCB)";
  const accountNo = process.env.VIETQR_ACCOUNT_NO || "1028889999";
  const accountName = process.env.VIETQR_ACCOUNT_NAME || "VIETPEACE STAY";
  const amount = Math.max(0, Math.round(Number(amountVnd || 0)));
  const transferContent = `TT PHAT SINH ${String(bookingCode || "").trim()}`.trim();

  const imageUrl =
    amount > 0
      ? `https://img.vietqr.io/image/${encodeURIComponent(bankBin)}-${encodeURIComponent(accountNo)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(transferContent)}&accountName=${encodeURIComponent(accountName)}`
      : null;

  const fallbackText = amount > 0
    ? `BANK:${bankName}|STK:${accountNo}|CTK:${accountName}|AMOUNT:${amount}VND|ND:${transferContent}`
    : null;
  const qrDataUrl = await generateQrDataUrl(fallbackText);

  return {
    bankBin,
    bankName,
    accountNo,
    accountName,
    amount,
    transferContent,
    imageUrl,
    qrDataUrl,
  };
}

module.exports = {
  buildSettlementVnpayUrl,
  verifySettlementVnpayPayload,
  generateQrDataUrl,
  buildVietQrInfo,
  formatVnStamp,
};
