const { sqlObj, getDBPool } = require("../configs/database");

async function getAccommodationDetailById(accommodationId) {
    console.log("[getAccommodationDetailById service] chuan bi chạy query lấy accommodation data cho accommodationId : " + accommodationId);

    const pool = await getDBPool();

    const result = await pool.request()
        .input("accommodationId", sqlObj.Int, accommodationId)
        .query(`
            SELECT
                a.id,
                a.accommodation_code,
                a.accommodation_name,
                a.slug,
                a.accommodation_type_id,
                t.code AS accommodation_type_code,
                t.name AS accommodation_type_name,
                a.location_id,
                loc.name AS location_name,
                loc.province_id AS loc_province_id,
                p.full_name AS loc_province_fullname,
                a.ward_id AS loc_ward_id,
                w.full_name AS loc_ward_fullname,
                a.address_line,
                a.postal_code,
                a.latitude,
                a.longitude,
                a.directions,
                a.short_description,
                a.description,
                a.phone,
                a.email,
                a.website_url,
                a.star_rating,
                a.is_featured,
                CONVERT(char(5), a.check_in_time, 108) AS check_in_time,
                CONVERT(char(5), a.check_out_time, 108) AS check_out_time,
                a.check_in_instructions,
                a.house_rules,
                a.children_policy,
                a.pet_policy,
                a.smoking_policy
            FROM dbo.accommodations AS a
            JOIN dbo.accommodation_types AS t ON t.id = a.accommodation_type_id
            LEFT JOIN dbo.locations AS loc ON loc.id = a.location_id
            LEFT JOIN dbo.provinces AS p ON p.id = loc.province_id
            LEFT JOIN dbo.wards AS w ON w.id = a.ward_id
            WHERE a.id = @accommodationId
              AND a.status = 1
              AND a.deleted_at IS NULL;

            SELECT
                i.id AS image_id,
                i.image_url,
                i.alt_text,
                i.caption,
                i.is_cover
            FROM dbo.accommodation_images AS i
            WHERE i.accommodation_id = @accommodationId
            ORDER BY i.is_cover DESC, i.sort_order, i.id;

            SELECT
                am.id AS amenity_id,
                am.name,
                am.code,
                am.category_code,
                am.icon_key,
                am.description,
                aa.is_chargeable,
                aa.note AS accommodation_note
            FROM dbo.accommodation_amenities AS aa
            JOIN dbo.amenities AS am ON am.id = aa.amenity_id
            WHERE aa.accommodation_id = @accommodationId AND am.is_active = 1
            ORDER BY am.id;

            SELECT aa.attraction_id, at.name, at.description, at.address_line, at.image_url,
            aa.distance_meters, aa.note AS accommodation_note
            FROM accommodation_attractions aa
            JOIN attractions at ON at.id = aa.attraction_id
            WHERE aa.accommodation_id = @accommodationId AND at.is_active = 1
            ORDER BY at.id;
        `);

    //console.log("[getAccommodationDetailById] Data cua result.recordsets sau khi query : ", result.recordsets);

    const [[accommodation], images, amenities, attractions] = result.recordsets;

    return accommodation ? { ...accommodation, images, amenities, attractions } : null;
}


module.exports = {
    getAccommodationDetailById
};