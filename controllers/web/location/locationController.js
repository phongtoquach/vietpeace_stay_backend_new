const locationService = require("../../../services/location_service");

async function listFeaturedLocations(req, res) {
    const featuredLocationsRes = await locationService.getFeaturedLocationsWithAccommodationsCount();

    res.json({
        success: true,
        message: "Successful",
        data: {
            featuredLocations: featuredLocationsRes.locations
        }
    });
}


// export
module.exports = {
    listFeaturedLocations
};