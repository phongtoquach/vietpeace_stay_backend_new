const lookupService = require("../../services/lookup_service");

async function getLocationsAndAccommdations(req, res) {
    const getResult = await lookupService.getAllLocationsAndAccommodations();
    console.log("[getAllLocationsAndAccommdations] Ket qua hàm getAllLocationsAndAccommdations() : ");
    
    res.json({
        success: true,
        message: "successful",
        data: getResult.data
    });
}


// export
module.exports = {
    getLocationsAndAccommdations
};