const { getDBPool } = require("../configs/database");

async function getFeaturedLocationsWithAccommodationsCount() {
    const pool = await getDBPool();

    const result = await pool.request().query(`
        ;WITH LocationTree AS (
        -- Mỗi location nổi bật là gốc của một cây.
        SELECT l.id AS featured_location_id, l.id AS location_id
        FROM dbo.locations AS l
        WHERE l.is_active = 1 AND l.is_featured = 1

        UNION ALL

        -- Lấy tiếp các location con, cháu... đang active.
        SELECT
            tree.featured_location_id,
            child.id AS location_id
        FROM dbo.locations AS child
        INNER JOIN LocationTree AS tree ON child.parent_id = tree.location_id
        WHERE child.is_active = 1
        )

        SELECT
        l.id,
        l.parent_id,
        l.name,
        cover_image.image_url AS cover_image_url,

        accommodation_type.id AS accommodation_type_id,
        accommodation_type.code AS accommodation_type_code,
        accommodation_type.name AS accommodation_type_name,

        COUNT(*) AS accommodation_count

        FROM LocationTree AS tree

        INNER JOIN dbo.locations AS l ON l.id = tree.featured_location_id

        INNER JOIN dbo.accommodations AS a
        ON a.location_id = tree.location_id
        AND a.status = 1
        AND a.deleted_at IS NULL

        INNER JOIN dbo.accommodation_types AS accommodation_type
        ON accommodation_type.id = a.accommodation_type_id

        OUTER APPLY (
        SELECT TOP (1) li.image_url
        FROM dbo.location_images AS li
        WHERE li.location_id = l.id AND li.is_cover = 1
        ORDER BY li.id ASC
        ) AS cover_image

        GROUP BY
        l.id,
        l.parent_id,
        l.name,
        cover_image.image_url,
        accommodation_type.id,
        accommodation_type.code,
        accommodation_type.name,
        accommodation_type.sort_order

        ORDER BY l.id ASC, accommodation_type.sort_order ASC, accommodation_type.id ASC

        OPTION (MAXRECURSION 100);
    `);

    //console.log(result.recordset);

    const locations = [];
    const locationsById = {};

    for (const row of result.recordset) {
        // if (!locationsById[row.id])
        if (!locationsById.hasOwnProperty(row.id)) {
            const location = {
                id: row.id,
                parent_id: row.parent_id,
                name: row.name,
                cover_image_url: row.cover_image_url,
                total_accommodations: 0,
                accommodation_types: []
            };

            locationsById[row.id] = location;
            locations.push(location);
        }

        const location = locationsById[row.id];

        location.total_accommodations += row.accommodation_count;

        location.accommodation_types.push({
            id: row.accommodation_type_id,
            code: row.accommodation_type_code,
            name: row.accommodation_type_name,
            count: row.accommodation_count
        });
    }

    console.log("[getFeaturedLocationsWithAccommodationsCount] Data của locations sau cùng : ");
    console.log(locations);

    return {
        success: true,
        locations: locations
    };
}


module.exports = {
    getFeaturedLocationsWithAccommodationsCount,
};