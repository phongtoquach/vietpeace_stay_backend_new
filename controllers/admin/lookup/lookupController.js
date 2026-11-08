const service = require("../../../services/accommodation_lookup_service");
const { ok, fail } = require("../../../utils/response");

function int(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }

async function getAccommodationTypes(req, res) { return ok(res, { items: await service.getAccommodationTypes() }); }
async function getProvinces(req, res) { return ok(res, { items: await service.getProvinces() }); }
async function getWards(req, res) {
    const provinceId = int(req.query.provinceId);
    if (!provinceId) return fail(res, 400, "VALIDATION_ERROR", "provinceId là bắt buộc.", { provinceId: "Vui lòng chọn tỉnh/thành phố." });
    return ok(res, { items: await service.getWards(provinceId) });
}
async function getLocations(req, res) { return ok(res, { items: await service.getLocations({ provinceId: int(req.query.provinceId), parentId: int(req.query.parentId), q: req.query.q ? String(req.query.q).trim() : null }) }); }
async function getAmenities(req, res) { return ok(res, { items: await service.getAmenities(req.query.scope || "accommodation") }); }
async function getAttractions(req, res) {
    const locationId = int(req.query.locationId);
    if (!locationId) return fail(res, 400, "VALIDATION_ERROR", "locationId là bắt buộc.", { locationId: "Vui lòng chọn điểm đến." });
    return ok(res, { items: await service.getAttractions(locationId, req.query.includeInactive === "true") });
}

module.exports = { getAccommodationTypes, getProvinces, getWards, getLocations, getAmenities, getAttractions };
