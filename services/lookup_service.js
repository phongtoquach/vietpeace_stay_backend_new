const { getDBPool } = require("../configs/database");

async function getAllLocationsAndAccommodations() {
    const pool = await getDBPool();

    const locationResults = await pool.request().query(`
        SELECT
            l.id,
            l.parent_id,
            l.name,
            COALESCE(l.search_keywords, N'') AS search_keywords,
            l.is_featured
        FROM dbo.locations AS l
        WHERE l.is_active = 1
        AND EXISTS (
            SELECT 1
            FROM dbo.accommodations AS a
            WHERE
                a.location_id = l.id
                AND a.status = 1
                AND a.deleted_at IS NULL
        )
        ORDER BY l.id ASC;
    `);

    const accomResults = await pool.request().query(`
        SELECT a.id, a.location_id, a.accommodation_name
        FROM dbo.accommodations AS a
        INNER JOIN dbo.locations AS l ON l.id = a.location_id
        WHERE a.status = 1 AND a.deleted_at IS NULL
        ORDER BY a.id ASC;
    `);

    return {
        success: true,
        data: {
            locations: locationResults.recordset,
            accommodations: accomResults.recordset
        },
    };
}

module.exports = {
    getAllLocationsAndAccommodations,
};