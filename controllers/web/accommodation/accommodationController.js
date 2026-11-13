const accommodationSearchService = require("../../../services/accommodation_daily_search_service");

async function searchAccommodations(req, res) {
    try {
        const body = req.body ?? {};

        if (typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({
                success: false,
                message: "Dữ liệu gửi lên phải là object.",
                errorCode: "DATA_INVALID",
                errors: {}
            });
        }

        const filters = {
            locationId: body.locationId,
            accommodationId: body.accommodationId,

            accommodationType: body.accommodationType,
            //accommodationTypeId: body.accommodationTypeId,
            accommodationTypeIds: body.accommodationTypeIds,

            checkinDate: body.checkinDate ?? body.checkin,
            checkoutDate: body.checkoutDate ?? body.checkout,

            rooms: body.rooms,

            priceFrom: body.priceFrom,
            priceTo: body.priceTo,

            amenityIds: body.amenityIds,
            starRatings: body.starRatings
        };

        const sort = body.sort;

        const pagination = {
            page: body.page,
            pageSize: body.pageSize
        };

        const result = await accommodationSearchService.searchAccommodationsByFilters(filters, sort, pagination);

        if (!result.success) {
            return res.status(200).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors
            });
        }

        return res.status(200).json({
            success: true,
            message: "Successful",
            data: result.data
        });
    } catch (error) {
        console.error("[accommodation.controller.search]", error);

        return res.status(200).json({
            success: false,
            message: "Không thể tìm kiếm cơ sở lưu trú lúc này. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_SERVER_ERROR",
            errors: {}
        });
  }
}


// export
module.exports = {
    searchAccommodations
};