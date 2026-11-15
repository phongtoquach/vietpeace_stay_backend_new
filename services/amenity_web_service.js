const { getDBPool } = require("../configs/database");

async function getFeaturedAmenities() {
    const pool = await getDBPool();

    const result = await pool.request().query(`
        ;WITH EligibleAmenities AS (
            SELECT id, code, name, category_code, is_featured, sort_order
            FROM dbo.amenities
            WHERE is_active = 1
                AND amenity_scope IN ('both', 'accommodation')
        ),
        FallbackAmenities AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY category_code
                    ORDER BY id ASC
                ) AS category_rank
            FROM EligibleAmenities
            WHERE category_code IN (
                'activities',
                'common_spaces',
                'food_drink',
                'parking_transport',
                'guest_service',
                'pool_wellness',
                'others'
            )
        )
        SELECT a.id, a.code, a.name, a.category_code, a.is_featured
        FROM EligibleAmenities AS a
        WHERE a.is_featured = 1
            OR (
                NOT EXISTS (
                    SELECT 1
                    FROM EligibleAmenities
                    WHERE is_featured = 1
                )
                AND a.id IN (
                    SELECT id
                    FROM FallbackAmenities
                    WHERE category_rank <= 3
                )
            )
        ORDER BY
            CASE WHEN a.is_featured = 1 THEN a.sort_order END ASC,
            CASE WHEN a.is_featured = 0 THEN a.category_code END ASC,
            a.id ASC;
    `);

    return result.recordset;
}

module.exports = {
    getFeaturedAmenities,
};