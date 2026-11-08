const { getDBPool, sqlObj: sql } = require("../configs/database");

function getRequest() {
    return getDBPool().request();
}

async function getAccommodationTypes() {
    const result = await getRequest().query(`
        SELECT id, code, name, sort_order AS sortOrder
        FROM dbo.accommodation_types
        WHERE is_active = 1
        ORDER BY sort_order, id;
    `);
    return result.recordset;
}

async function getProvinces() {
    const result = await getRequest().query(`
        SELECT id, code, name, full_name AS fullName, administrative_type AS administrativeType
        FROM dbo.provinces
        WHERE is_active = 1
        ORDER BY name;
    `);
    return result.recordset;
}

async function getWards(provinceId) {
    const result = await getRequest()
        .input("provinceId", sql.Int, provinceId)
        .query(`
            SELECT id, code, name, full_name AS fullName, administrative_type AS administrativeType
            FROM dbo.wards
            WHERE province_id = @provinceId AND is_active = 1
            ORDER BY name;
        `);
    return result.recordset;
}

async function getLocations({ provinceId = null, parentId = null, q = null } = {}) {
    const result = await getRequest()
        .input("provinceId", sql.Int, provinceId)
        .input("parentId", sql.Int, parentId)
        .input("q", sql.NVarChar(255), q)
        .query(`
            SELECT l.id, l.parent_id AS parentId, l.province_id AS provinceId,
                   l.name, l.slug, p.name AS provinceName
            FROM dbo.locations l
            JOIN dbo.provinces p ON p.id = l.province_id
            WHERE l.is_active = 1
              AND (@provinceId IS NULL OR l.province_id = @provinceId)
              AND (@parentId IS NULL OR l.parent_id = @parentId)
              AND (@q IS NULL OR l.name LIKE N'%' + @q + N'%')
            ORDER BY l.sort_order, l.name;
        `);
    return result.recordset;
}

async function getAmenities(scope = "accommodation") {
    const normalizedScope = ["accommodation", "room", "both"].includes(scope)
        ? scope
        : "accommodation";
    const scopeCondition = normalizedScope === "accommodation"
        ? "a.amenity_scope IN ('accommodation', 'both')"
        : "a.amenity_scope = @scope";

    const request = getRequest().input("scope", sql.VarChar(20), normalizedScope);
    const result = await request.query(`
        SELECT a.id, a.code, a.name, a.amenity_scope AS amenityScope,
               a.category_code AS categoryCode, c.name AS categoryName,
               a.icon_key AS iconKey, a.description,
               a.sort_order AS sortOrder
        FROM dbo.amenities a
        JOIN dbo.amenity_categories c ON c.code = a.category_code
        WHERE a.is_active = 1
          AND c.is_active = 1
          AND ${scopeCondition}
        ORDER BY c.sort_order, a.sort_order, a.id;
    `);
    return result.recordset;
}

async function getAttractions(locationId, includeInactive = false) {
    const result = await getRequest()
        .input("locationId", sql.Int, locationId)
        .input("includeInactive", sql.Bit, includeInactive)
        .query(`
            SELECT id, name, address_line AS addressLine, image_url AS imageUrl,
                   is_active AS isActive, latitude, longitude
            FROM dbo.attractions
            WHERE location_id = @locationId
              AND (@includeInactive = 1 OR is_active = 1)
            ORDER BY name, id;
        `);
    return result.recordset;
}

module.exports = {
    getAccommodationTypes,
    getProvinces,
    getWards,
    getLocations,
    getAmenities,
    getAttractions
};
