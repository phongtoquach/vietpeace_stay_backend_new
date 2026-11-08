// Nhãn trạng thái dùng chung enum 0/1/2 giống accommodations.
const ROOM_TYPE_STATUS_LABEL = Object.freeze({
  0: "Bản nháp",
  1: "Đang hoạt động",
  2: "Ngừng hoạt động",
});

// Whitelist sort: client gửi camelCase, SQL chỉ nhận cột trong bảng này.
// Không bao giờ nối thẳng query.sortBy vào SQL.
const ROOM_TYPE_SORT_FIELD_MAP = Object.freeze({
  id: "rt.id",
  name: "rt.name",
  accommodationId: "rt.accommodation_id",
  bedDescription: "rt.bed_description",
  includedAdults: "rt.included_adults",
  maxOccupancy: "rt.max_occupancy",
  basePrice: "rt.base_price",
  quantity: "rt.quantity",
  status: "rt.status",
  sortOrder: "rt.sort_order",
  createdAt: "rt.created_at",
  updatedAt: "rt.updated_at",
});

const ROOM_TYPE_DEFAULT_PAGE_SIZE = 10;
const ROOM_TYPE_MAX_PAGE_SIZE = 100;

module.exports = {
  ROOM_TYPE_STATUS_LABEL,
  ROOM_TYPE_SORT_FIELD_MAP,
  ROOM_TYPE_DEFAULT_PAGE_SIZE,
  ROOM_TYPE_MAX_PAGE_SIZE,
};
