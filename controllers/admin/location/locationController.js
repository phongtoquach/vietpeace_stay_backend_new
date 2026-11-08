const { getDBPool } = require("../../../configs/database");
const sql = require("mssql");
const fs = require("fs");
const path = require("path");

// Hàm phụ lưu ảnh Base64 vào public/uploads/locations
function saveBase64Image(base64Str, slug) {
    if (!base64Str || typeof base64Str !== "string") return null;

    // Nếu đã là URL tĩnh (ví dụ: /uploads/locations/an-giang.jpg hoặc http...) thì giữ nguyên
    if (!base64Str.startsWith("data:image/")) {
        return base64Str;
    }

    const matches = base64Str.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        return null;
    }

    let ext = matches[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ext === "svg+xml") ext = "svg";

    const data = Buffer.from(matches[2], "base64");
    const uploadDir = path.join(__dirname, "../../../public/uploads/locations");

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const cleanSlug = slug ? slug.replace(/[^a-z0-9-]/g, "") : "location";
    const filename = `${cleanSlug}-${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, data);

    return `/uploads/locations/${filename}`;
}

// Hàm phụ tạo slug tiếng Việt không dấu
function generateSlug(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[đĐ]/g, "d")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}

// Hàm 1: Lấy danh sách điểm đến (kèm ảnh đại diện nếu có)
async function getLocationsList(req, res) {
    try {
        const pool = getDBPool();

        const result = await pool.request().query(`
            SELECT
                l.id,
                l.province_id,
                p.name AS province_name,
                l.parent_id,
                l.parent_id AS parent_location_id,
                l.name,
                l.slug,
                l.slug AS code,
                l.short_description,
                l.description,
                l.is_featured,
                l.sort_order,
                l.is_active,
                CASE WHEN l.is_active = 1 THEN 'Active' ELSE 'Inactive' END AS status,
                li.image_url,
                l.created_at
            FROM dbo.locations l
            LEFT JOIN dbo.provinces p ON l.province_id = p.id
            LEFT JOIN dbo.location_images li ON l.id = li.location_id AND li.is_cover = 1
            ORDER BY l.sort_order ASC, l.name ASC;
        `);

        return res.status(200).json({
            success: true,
            message: "Lấy danh sách điểm đến thành công",
            data: {
                locationsList: result.recordset
            }
        });
    } catch (error) {
        console.error("[getLocationsList] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi lấy danh sách điểm đến",
            error: error.message
        });
    }
}

// Hàm 2: Lấy chi tiết 1 điểm đến theo id (kèm ảnh đại diện)
async function getLocationDetail(req, res) {
    try {
        const { id } = req.params;
        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sql.Int, id)
            .query(`
                SELECT
                    l.*,
                    p.name AS province_name,
                    li.image_url
                FROM dbo.locations l
                LEFT JOIN dbo.provinces p ON l.province_id = p.id
                LEFT JOIN dbo.location_images li ON l.id = li.location_id AND li.is_cover = 1
                WHERE l.id = @id;
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm đến này!"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Lấy chi tiết điểm đến thành công",
            data: {
                location: result.recordset[0]
            }
        });
    } catch (error) {
        console.error("[getLocationDetail] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi lấy chi tiết điểm đến",
            error: error.message
        });
    }
}

// Hàm 3: Thêm mới 1 điểm đến (hỗ trợ lưu ảnh đại diện)
async function createLocation(req, res) {
    try {
        const {
            name,
            code,
            province_id,
            parent_id,
            parent_location_id,
            new_sub_region_name,
            short_description,
            description,
            is_featured,
            sort_order,
            is_active,
            status,
            image
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Vui lòng nhập tên điểm đến!"
            });
        }

        const pool = getDBPool();
        let finalParentId = parent_id !== undefined ? parent_id : (parent_location_id || null);

        let finalProvinceId = province_id;
        if (!finalProvinceId && finalParentId) {
            const parentRes = await pool.request()
                .input("parent_id", sql.Int, finalParentId)
                .query("SELECT province_id FROM dbo.locations WHERE id = @parent_id");
            if (parentRes.recordset.length > 0) {
                finalProvinceId = parentRes.recordset[0].province_id;
            }
        }

        if (!finalProvinceId) {
            const provCheck = await pool.request()
                .input("pname", sql.NVarChar(255), name.trim())
                .query("SELECT id FROM dbo.provinces WHERE name LIKE '%' + @pname + '%'");
            if (provCheck.recordset.length > 0) {
                finalProvinceId = provCheck.recordset[0].id;
            } else {
                finalProvinceId = 1; // Mặc định Hà Nội
            }
        }

        // Nếu người dùng chọn tạo kèm một khu vực con mới làm cha
        if (new_sub_region_name && new_sub_region_name.trim()) {
            const subName = new_sub_region_name.trim();
            const subSlug = generateSlug(subName);

            // Kiểm tra xem đã có khu vực con mang tên này chưa
            const checkSub = await pool.request()
                .input("sub_name", sql.NVarChar(255), subName)
                .input("parent_id", sql.Int, finalParentId)
                .query("SELECT id FROM dbo.locations WHERE name = @sub_name AND parent_id = @parent_id");

            if (checkSub.recordset.length > 0) {
                finalParentId = checkSub.recordset[0].id;
            } else {
                const createSub = await pool.request()
                    .input("province_id", sql.Int, finalProvinceId)
                    .input("parent_id", sql.Int, finalParentId)
                    .input("name", sql.NVarChar(255), subName)
                    .input("slug", sql.VarChar(255), subSlug)
                    .query(`
                        INSERT INTO dbo.locations (
                            province_id, parent_id, name, slug, is_featured, sort_order, is_active, created_at
                        )
                        OUTPUT INSERTED.id
                        VALUES (
                            @province_id, @parent_id, @name, @slug, 0, 1, 1, SYSDATETIME()
                        );
                    `);
                finalParentId = createSub.recordset[0].id;
            }
        }

        const slug = code ? generateSlug(code) : generateSlug(name);
        const isActive = is_active !== undefined ? (is_active ? 1 : 0) : (status === "Inactive" ? 0 : 1);

        // Lưu ảnh Base64 nếu có
        let savedImageUrl = null;
        if (image) {
            savedImageUrl = saveBase64Image(image, slug);
        }

        const result = await pool.request()
            .input("province_id", sql.Int, finalProvinceId)
            .input("parent_id", sql.Int, finalParentId || null)
            .input("name", sql.NVarChar(255), name.trim())
            .input("slug", sql.VarChar(255), slug)
            .input("short_description", sql.NVarChar(1000), short_description || null)
            .input("description", sql.NVarChar(sql.MAX), description || null)
            .input("is_featured", sql.Bit, is_featured ? 1 : 0)
            .input("sort_order", sql.Int, sort_order || 1)
            .input("is_active", sql.Bit, isActive)
            .query(`
                INSERT INTO dbo.locations (
                    province_id, parent_id, name, slug, short_description,
                    description, is_featured, sort_order, is_active, created_at
                )
                OUTPUT INSERTED.*
                VALUES (
                    @province_id, @parent_id, @name, @slug, @short_description,
                    @description, @is_featured, @sort_order, @is_active, SYSDATETIME()
                );
            `);

        const newLoc = result.recordset[0];

        // Nếu có ảnh -> lưu vào dbo.location_images
        if (savedImageUrl) {
            await pool.request()
                .input("location_id", sql.Int, newLoc.id)
                .input("image_url", sql.NVarChar(1000), savedImageUrl)
                .input("alt_text", sql.NVarChar(255), newLoc.name)
                .input("caption", sql.NVarChar(255), newLoc.name)
                .query(`
                    INSERT INTO dbo.location_images (location_id, image_url, alt_text, caption, is_cover, sort_order, created_at)
                    VALUES (@location_id, @image_url, @alt_text, @caption, 1, 1, SYSDATETIME());
                `);
            newLoc.image_url = savedImageUrl;
        }

        return res.status(201).json({
            success: true,
            message: "Tạo điểm đến mới thành công",
            data: {
                newLocation: {
                    ...newLoc,
                    code: newLoc.slug,
                    parent_location_id: newLoc.parent_id,
                    status: newLoc.is_active ? 'Active' : 'Inactive'
                }
            }
        });
    } catch (error) {
        console.error("[createLocation] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi tạo điểm đến",
            error: error.message
        });
    }
}

// Hàm 4: Cập nhật điểm đến (hỗ trợ cập nhật / thay đổi ảnh đại diện)
async function updateLocation(req, res) {
    try {
        const { id } = req.params;
        const {
            name,
            code,
            province_id,
            parent_id,
            parent_location_id,
            new_sub_region_name,
            short_description,
            description,
            is_featured,
            sort_order,
            is_active,
            status,
            image
        } = req.body;

        let finalParentId = parent_id !== undefined ? parent_id : (parent_location_id !== undefined ? parent_location_id : null);

        if (finalParentId && Number(finalParentId) === Number(id)) {
            return res.status(400).json({
                success: false,
                message: "Một điểm đến không thể chọn chính nó làm điểm đến cha!"
            });
        }

        const pool = getDBPool();

        // Nếu người dùng chọn tạo kèm một khu vực con mới làm cha
        if (new_sub_region_name && new_sub_region_name.trim()) {
            const subName = new_sub_region_name.trim();
            const subSlug = generateSlug(subName);

            const checkSub = await pool.request()
                .input("sub_name", sql.NVarChar(255), subName)
                .input("parent_id", sql.Int, finalParentId)
                .query("SELECT id FROM dbo.locations WHERE name = @sub_name AND parent_id = @parent_id");

            if (checkSub.recordset.length > 0) {
                finalParentId = checkSub.recordset[0].id;
            } else {
                const provId = province_id || 1;
                const createSub = await pool.request()
                    .input("province_id", sql.Int, provId)
                    .input("parent_id", sql.Int, finalParentId)
                    .input("name", sql.NVarChar(255), subName)
                    .input("slug", sql.VarChar(255), subSlug)
                    .query(`
                        INSERT INTO dbo.locations (
                            province_id, parent_id, name, slug, is_featured, sort_order, is_active, created_at
                        )
                        OUTPUT INSERTED.id
                        VALUES (
                            @province_id, @parent_id, @name, @slug, 0, 1, 1, SYSDATETIME()
                        );
                    `);
                finalParentId = createSub.recordset[0].id;
            }
        }
        const existingLoc = await pool.request()
            .input("id", sql.Int, id)
            .query("SELECT * FROM dbo.locations WHERE id = @id");

        if (existingLoc.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm đến để cập nhật!"
            });
        }

        const curr = existingLoc.recordset[0];
        const finalProvinceId = province_id || curr.province_id || 1;
        const slug = code ? generateSlug(code) : (name ? generateSlug(name) : curr.slug);
        const isActive = is_active !== undefined ? (is_active ? 1 : 0) : (status ? (status === "Active" ? 1 : 0) : curr.is_active);

        const result = await pool.request()
            .input("id", sql.Int, id)
            .input("province_id", sql.Int, finalProvinceId)
            .input("parent_id", sql.Int, finalParentId || null)
            .input("name", sql.NVarChar(255), (name || curr.name).trim())
            .input("slug", sql.VarChar(255), slug)
            .input("short_description", sql.NVarChar(1000), short_description !== undefined ? short_description : curr.short_description)
            .input("description", sql.NVarChar(sql.MAX), description !== undefined ? description : curr.description)
            .input("is_featured", sql.Bit, is_featured !== undefined ? (is_featured ? 1 : 0) : curr.is_featured)
            .input("sort_order", sql.Int, sort_order !== undefined ? sort_order : curr.sort_order)
            .input("is_active", sql.Bit, isActive)
            .query(`
                UPDATE dbo.locations
                SET
                    province_id = @province_id,
                    parent_id = @parent_id,
                    name = @name,
                    slug = @slug,
                    short_description = @short_description,
                    description = @description,
                    is_featured = @is_featured,
                    sort_order = @sort_order,
                    is_active = @is_active,
                    updated_at = SYSDATETIME()
                OUTPUT INSERTED.*
                WHERE id = @id;
            `);

        const updatedLoc = result.recordset[0];

        // Xử lý ảnh nếu có truyền lên
        if (image !== undefined) {
            let savedImageUrl = null;
            if (image) {
                savedImageUrl = saveBase64Image(image, slug);
            }

            if (savedImageUrl) {
                const checkImg = await pool.request()
                    .input("location_id", sql.Int, id)
                    .query("SELECT id FROM dbo.location_images WHERE location_id = @location_id AND is_cover = 1");

                if (checkImg.recordset.length > 0) {
                    await pool.request()
                        .input("location_id", sql.Int, id)
                        .input("image_url", sql.NVarChar(1000), savedImageUrl)
                        .input("alt_text", sql.NVarChar(255), updatedLoc.name)
                        .query(`
                            UPDATE dbo.location_images
                            SET image_url = @image_url, alt_text = @alt_text, caption = @alt_text
                            WHERE location_id = @location_id AND is_cover = 1;
                        `);
                } else {
                    await pool.request()
                        .input("location_id", sql.Int, id)
                        .input("image_url", sql.NVarChar(1000), savedImageUrl)
                        .input("alt_text", sql.NVarChar(255), updatedLoc.name)
                        .input("caption", sql.NVarChar(255), updatedLoc.name)
                        .query(`
                            INSERT INTO dbo.location_images (location_id, image_url, alt_text, caption, is_cover, sort_order, created_at)
                            VALUES (@location_id, @image_url, @alt_text, @caption, 1, 1, SYSDATETIME());
                        `);
                }
                updatedLoc.image_url = savedImageUrl;
            } else if (image === '') {
                // Người dùng xóa ảnh
                await pool.request()
                    .input("location_id", sql.Int, id)
                    .query("DELETE FROM dbo.location_images WHERE location_id = @location_id AND is_cover = 1");
                updatedLoc.image_url = null;
            }
        }

        return res.status(200).json({
            success: true,
            message: "Cập nhật điểm đến thành công",
            data: {
                updatedLocation: {
                    ...updatedLoc,
                    code: updatedLoc.slug,
                    parent_location_id: updatedLoc.parent_id,
                    status: updatedLoc.is_active ? 'Active' : 'Inactive'
                }
            }
        });
    } catch (error) {
        console.error("[updateLocation] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi cập nhật điểm đến",
            error: error.message
        });
    }
}

// Hàm 5: Xóa điểm đến (kiểm tra an toàn dữ liệu)
async function deleteLocation(req, res) {
    try {
        const { id } = req.params;
        const pool = getDBPool();

        // 1. Kiểm tra có điểm đến con hay không
        const checkChildren = await pool.request()
            .input("id", sql.Int, id)
            .query("SELECT COUNT(1) AS count FROM dbo.locations WHERE parent_id = @id;");

        if (checkChildren.recordset[0].count > 0) {
            return res.status(400).json({
                success: false,
                message: "Không thể xóa vì điểm đến này đang chứa các điểm đến con trực thuộc!"
            });
        }

        // 2. Kiểm tra có khách sạn/resort nào thuộc điểm đến này không
        const checkAccommodations = await pool.request()
            .input("id", sql.Int, id)
            .query("SELECT COUNT(1) AS count FROM dbo.accommodations WHERE location_id = @id;");

        if (checkAccommodations.recordset[0].count > 0) {
            return res.status(400).json({
                success: false,
                message: "Không thể xóa vì có cơ sở lưu trú đang đăng ký thuộc điểm đến này!"
            });
        }

        // 3. Kiểm tra có điểm tham quan nào thuộc điểm đến này không
        const checkAttractions = await pool.request()
            .input("id", sql.Int, id)
            .query("SELECT COUNT(1) AS count FROM dbo.attractions WHERE location_id = @id;");

        if (checkAttractions.recordset[0].count > 0) {
            return res.status(400).json({
                success: false,
                message: "Không thể xóa vì có điểm tham quan đang gắn với điểm đến này!"
            });
        }

        // Xóa ảnh liên kết trong dbo.location_images trước để tránh vi phạm foreign key
        await pool.request()
            .input("id", sql.Int, id)
            .query("DELETE FROM dbo.location_images WHERE location_id = @id;");

        // 4. Nếu an toàn -> tiến hành xóa điểm đến
        const deleteResult = await pool.request()
            .input("id", sql.Int, id)
            .query("DELETE FROM dbo.locations WHERE id = @id;");

        if (deleteResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm đến để xóa!"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Xóa điểm đến thành công"
        });
    } catch (error) {
        console.error("[deleteLocation] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi xóa điểm đến",
            error: error.message
        });
    }
}

module.exports = {
    getLocationsList,
    getLocationDetail,
    createLocation,
    updateLocation,
    deleteLocation
};
