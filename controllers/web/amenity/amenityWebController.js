const amenityWebService = require("../../../services/amenity_web_service");

async function getFeaturedAmenities(req, res) {
    try {
        const amenitiesList = await amenityWebService.getFeaturedAmenities();

        return res.status(200).json({
            success: true,
            message: "Successfully",
            data: {
                amenities: amenitiesList
            }
        });
    } catch (error) {
        console.error("[amenity.web.getFeaturedAmenities]", error);

        return res.status(500).json({
            success: false,
            message: "Không thể tải danh sách tiện nghi.",
            errorCode: "INTERNAL_SERVER_ERROR"
        });
    }
}

module.exports = {
    getFeaturedAmenities
};