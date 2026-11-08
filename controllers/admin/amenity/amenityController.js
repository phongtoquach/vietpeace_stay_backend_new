const { sqlObj, getDBPool } = require("../../../configs/database");
const crypto = require("crypto");

// Lấy danh sách tiện nghi từ SQL Server
async function getAmenitiesList(req, res) {
    try {
        const pool = getDBPool();

        const result = await pool.request().query(`
            SELECT
                a.id,
                a.code,
                a.name,
                a.amenity_scope,
                a.category_code,
                c.name AS category_name,
                a.icon_key,
                a.description,
                a.is_active,
                a.is_featured,
                a.sort_order,
                COUNT(DISTINCT aa.accommodation_id) AS usage_count
            FROM dbo.amenities a
            LEFT JOIN dbo.amenity_categories c
                ON a.category_code = c.code
            LEFT JOIN dbo.accommodation_amenities aa
                ON a.id = aa.amenity_id
            GROUP BY
                a.id,
                a.code,
                a.name,
                a.amenity_scope,
                a.category_code,
                c.name,
                a.icon_key,
                a.description,
                a.is_active,
                a.is_featured,
                a.sort_order
            ORDER BY a.sort_order, a.id;
        `);

        return res.json({
            success: true,
            message: "successful",
            data: {
                amenitiesList: result.recordset
            }
        });
    } catch (error) {
        console.error("getAmenitiesList error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể lấy danh sách tiện nghi."
        });
    }
}

// Lấy danh sách danh mục tiện nghi
async function getAmenityCategories(req, res) {
    try {
        const pool = getDBPool();

        const result = await pool.request().query(`
            SELECT
                code,
                name,
                is_active,
                sort_order
            FROM dbo.amenity_categories
            WHERE is_active = 1
            ORDER BY sort_order, code;
        `);

        return res.json({
            success: true,
            message: "successful",
            data: {
                categoriesList: result.recordset
            }
        });
    } catch (error) {
        console.error("getAmenityCategories error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể lấy danh sách danh mục tiện nghi."
        });
    }
}

// Cập nhật tiện nghi
async function updateAmenity(req, res) {
    try {
        const amenityId = Number(req.params.id);

        if (!Number.isInteger(amenityId) || amenityId <= 0) {
            return res.status(400).json({
                success: false,
                message: "ID tiện nghi không hợp lệ."
            });
        }

        const {
            name,
            category,
            category_code,
            icon,
            icon_key,
            description,
            status,
            is_active,
            amenity_scope
        } = req.body;

        const amenityName = typeof name === "string" ? name.trim() : "";
        const categoryCode = category_code || category;

        const scope = amenity_scope;
        if (!["accommodation", "room", "both"].includes(scope)) {
            return res.status(400).json({
                success: false,
                message: "Phạm vi tiện nghi không hợp lệ."
            });
        }
        if (!amenityName || !categoryCode) {
            return res.status(400).json({
                success: false,
                message: "Tên tiện nghi và danh mục là bắt buộc."
            });
        }

        let activeStatus;

        if (typeof is_active === "boolean") {
            activeStatus = is_active;
        } else {
            activeStatus = status === "Active";
        }

        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sqlObj.Int, amenityId)
            .input("name", sqlObj.NVarChar(255), amenityName)
            .input("category_code", sqlObj.VarChar(150), categoryCode)
            .input("amenity_scope", sqlObj.VarChar(20), scope)
            .input("icon_key", sqlObj.VarChar(150), icon_key || icon || null)
            .input(
                "description",
                sqlObj.NVarChar(1000),
                description?.trim() || null
            )
            .input("is_active", sqlObj.Bit, activeStatus)
            .query(`
                UPDATE dbo.amenities
                SET
                    name = @name,
                    category_code = @category_code,
                    amenity_scope = @amenity_scope,
                    icon_key = @icon_key,
                    description = @description,
                    is_active = @is_active
                WHERE id = @id;

                SELECT @@ROWCOUNT AS affectedRows;
            `);

        if (result.recordset[0].affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy tiện nghi."
            });
        }

        return res.json({
            success: true,
            message: "Cập nhật tiện nghi thành công."
        });
    } catch (error) {
        console.error("updateAmenity error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể cập nhật tiện nghi."
        });
    }
}

async function createAmenity(req, res) {
    try {
        const {
            name,
            category_code,
            icon,
            icon_key,
            description,
            amenity_scope
        } = req.body;

        if (
            typeof name !== "string" ||
            !name.trim() ||
            typeof category_code !== "string" ||
            !category_code.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Tên tiện nghi và danh mục là bắt buộc."
            });
        }

        const amenityName = name.trim();
        const categoryCode = category_code.trim();
        const scope = amenity_scope || "both";

        if (!["accommodation", "room", "both"].includes(scope)) {
            return res.status(400).json({
                success: false,
                message: "Phạm vi tiện nghi không hợp lệ."
            });
        }

        const pool = getDBPool();

        // Kiểm tra danh mục tồn tại và đang hoạt động
        const categoryResult = await pool.request()
            .input("category_code", sqlObj.VarChar(150), categoryCode)
            .query(`
                SELECT code
                FROM dbo.amenity_categories
                WHERE code = @category_code
                  AND is_active = 1;
            `);

        if (categoryResult.recordset.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Danh mục không tồn tại hoặc đã ngừng hoạt động."
            });
        }

        // Tạo mã tiện nghi duy nhất
        const slug = amenityName
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[đĐ]/g, "d")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 100);

        const code = `${slug || "amenity"}_${crypto.randomUUID().slice(0, 8)}`;

        const result = await pool.request()
            .input("code", sqlObj.VarChar(150), code)
            .input("name", sqlObj.NVarChar(255), amenityName)
            .input("amenity_scope", sqlObj.VarChar(20), scope)
            .input("category_code", sqlObj.VarChar(150), categoryCode)
            .input(
                "icon_key",
                sqlObj.VarChar(150),
                (icon_key || icon || "").trim() || null
            )
            .input(
                "description",
                sqlObj.NVarChar(1000),
                description?.trim() || null
            )
            .query(`
                INSERT INTO dbo.amenities (
                    code,
                    name,
                    amenity_scope,
                    category_code,
                    icon_key,
                    description,
                    is_active,
                    sort_order
                )
                OUTPUT INSERTED.id, INSERTED.code
                VALUES (
                    @code,
                    @name,
                    @amenity_scope,
                    @category_code,
                    @icon_key,
                    @description,
                    1,
                    999
                );
            `);

        return res.status(201).json({
            success: true,
            message: "Thêm tiện nghi thành công.",
            data: {
                id: result.recordset[0].id,
                code: result.recordset[0].code
            }
        });
    } catch (error) {
        console.error("createAmenity error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể thêm tiện nghi."
        });
    }
}

async function toggleAmenityStatus(req, res) {
    try {
        const amenityId = Number(req.params.id);

        if (!Number.isInteger(amenityId) || amenityId <= 0) {
            return res.status(400).json({
                success: false,
                message: "ID tiện nghi không hợp lệ."
            });
        }

        const { is_active } = req.body;

        if (typeof is_active !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "Trạng thái không hợp lệ."
            });
        }

        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sqlObj.Int, amenityId)
            .input("is_active", sqlObj.Bit, is_active)
            .query(`
                UPDATE dbo.amenities
                SET is_active = @is_active
                WHERE id = @id;

                SELECT @@ROWCOUNT AS affectedRows;
            `);

        if (result.recordset[0].affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy tiện nghi."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Cập nhật trạng thái thành công."
        });

    } catch (error) {
        console.error("toggleAmenityStatus Error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể cập nhật trạng thái tiện nghi."
        });
    }
}

// Đánh dấu / bỏ đánh dấu tiện nghi nổi bật
async function toggleAmenityFeatured(req, res) {
    try {
        const amenityId = Number(req.params.id);

        if (!Number.isInteger(amenityId) || amenityId <= 0) {
            return res.status(400).json({
                success: false,
                message: "ID tiện nghi không hợp lệ."
            });
        }

        const { is_featured } = req.body;

        if (typeof is_featured !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "Trạng thái nổi bật không hợp lệ."
            });
        }

        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sqlObj.Int, amenityId)
            .input("is_featured", sqlObj.Bit, is_featured)
            .query(`
                UPDATE dbo.amenities
                SET is_featured = @is_featured
                WHERE id = @id;

                SELECT @@ROWCOUNT AS affectedRows;
            `);

        if (result.recordset[0].affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy tiện nghi."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Cập nhật trạng thái nổi bật thành công."
        });

    } catch (error) {
        console.error("toggleAmenityFeatured Error:", error);

        return res.status(500).json({
            success: false,
            message: "Không thể cập nhật trạng thái nổi bật."
        });
    }
}

module.exports = {
    getAmenitiesList,
    getAmenityCategories,
    updateAmenity,
    createAmenity,
    toggleAmenityStatus,
    toggleAmenityFeatured
};
