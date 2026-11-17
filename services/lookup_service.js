const { getDBPool } = require("../configs/database");
const { activeManagerAssignedSql } = require("./accommodation_manager_guard");

const activeLocationsCte = `
    ;WITH ActiveLocations AS (
        SELECT l.id
        FROM dbo.locations AS l
        WHERE l.parent_id IS NULL
            AND l.is_active = 1

        UNION ALL

        SELECT child.id
        FROM dbo.locations AS child
        INNER JOIN ActiveLocations AS parent ON parent.id = child.parent_id
        WHERE child.is_active = 1
    )
`;

async function getAllLocationsAndAccommodations() {
    const pool = await getDBPool();

    const locationResults = await pool.request().query(`
        ${activeLocationsCte}
        SELECT
            l.id,
            l.parent_id,
            l.name,
            COALESCE(l.search_keywords, N'') AS search_keywords,
            l.is_featured
        FROM dbo.locations AS l
        INNER JOIN ActiveLocations AS active ON active.id = l.id
        WHERE EXISTS (
            SELECT 1
            FROM dbo.accommodations AS a
            WHERE a.location_id = l.id
                AND a.status = 1
                AND a.deleted_at IS NULL
                AND ${activeManagerAssignedSql("a")}
        )
        ORDER BY l.id ASC
        OPTION (MAXRECURSION 0);
    `);

    const accomResults = await pool.request().query(`
        ${activeLocationsCte}
        SELECT
            a.id,
            a.location_id,
            a.accommodation_name
        FROM dbo.accommodations AS a
        INNER JOIN ActiveLocations AS active ON active.id = a.location_id
        WHERE a.status = 1 AND a.deleted_at IS NULL AND ${activeManagerAssignedSql("a")}
        ORDER BY a.id ASC
        OPTION (MAXRECURSION 0);
    `);

    return {
        success: true,
        data: {
            locations: locationResults.recordset,
            accommodations: accomResults.recordset
        }
    };
}

module.exports = {
    getAllLocationsAndAccommodations
};