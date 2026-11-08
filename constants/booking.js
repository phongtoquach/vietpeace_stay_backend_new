// Status booking theo đúng CHECK constraint của bảng dbo.bookings.
const BOOKING_STATUS_LABEL = Object.freeze({
  PENDING: "Chờ xử lý",
  PAYMENT_PROCESSING: "Đang thanh toán",
  CONFIRMED: "Đã xác nhận",
  EXPIRED: "Hết hạn",
  CANCELLED: "Đã hủy",
  FAILED: "Thất bại",
});

const BOOKING_STATUSES = Object.freeze(Object.keys(BOOKING_STATUS_LABEL));

// Whitelist sort: client gửi camelCase, SQL chỉ nhận cột trong bảng này.
const BOOKING_SORT_FIELD_MAP = Object.freeze({
  code: "b.booking_code",
  status: "b.status",
  createdAt: "b.created_at",
  checkInDate: "b.check_in_date",
  checkOutDate: "b.check_out_date",
  totalAmount: "b.total_amount",
});

const BOOKING_DEFAULT_PAGE_SIZE = 10;
const BOOKING_MAX_PAGE_SIZE = 100;
const BOOKING_DEFAULT_SORT_BY = "createdAt";
const BOOKING_DEFAULT_SORT_DIR = "desc";

module.exports = {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUSES,
  BOOKING_SORT_FIELD_MAP,
  BOOKING_DEFAULT_PAGE_SIZE,
  BOOKING_MAX_PAGE_SIZE,
  BOOKING_DEFAULT_SORT_BY,
  BOOKING_DEFAULT_SORT_DIR,
};
