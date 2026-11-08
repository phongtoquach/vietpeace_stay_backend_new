const ACCOMMODATION_STATUS = Object.freeze({
    DRAFT: 0,
    ACTIVE: 1,
    INACTIVE: 2
});

const ACCOMMODATION_STATUS_LABEL = Object.freeze({
    0: "Bản nháp",
    1: "Đang hoạt động",
    2: "Ngừng hoạt động"
});

const ACCOMMODATION_TYPE_CODE =  Object.freeze({
    HOTEL: "hotel",
    RESORT: "resort",
    HOMESTAY: "homestay"
});

const SORT_FIELD_MAP = Object.freeze({
    id: "a.id",
    name: "a.accommodation_name",
    starRating: "a.star_rating",
    status: "a.status",
    sortOrder: "a.sort_order",
    createdAt: "a.created_at",
    updatedAt: "a.updated_at"
});

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

module.exports = {
    ACCOMMODATION_STATUS,
    ACCOMMODATION_STATUS_LABEL,
    ACCOMMODATION_TYPE_CODE,
    SORT_FIELD_MAP,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
};