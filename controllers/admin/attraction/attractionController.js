const { getDBPool } = require("../../../configs/database");
const sql = require("mssql");
const fs = require("fs");
const path = require("path");

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

function saveBase64AttractionImage(base64Str, slug) {
    if (!base64Str || typeof base64Str !== "string") return null;

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
    const uploadDir = path.join(__dirname, "../../../public/uploads/attractions");

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const cleanSlug = slug ? slug.replace(/[^a-z0-9-]/g, "") : "attraction";
    const filename = `${cleanSlug}-${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, data);

    return `/uploads/attractions/${filename}`;
}


// Hàm 1: Lấy danh sách điểm tham quan (Hỗ trợ lọc theo location_id, tìm kiếm theo tên và trạng thái)
async function getAttractionsList(req, res) {
    try {
        const { locationId, search, status } = req.query;
        const pool = getDBPool();

        const request = pool.request();

        // Xây dựng câu truy vấn động có điều kiện lọc
        let queryStr = `
            SELECT
                a.id,
                a.location_id,
                l.name AS location_name,
                a.name,
                a.address_line,
                a.description,
                a.image_url,
                a.is_active,
                a.created_at,
                (SELECT COUNT(1) FROM dbo.accommodation_attractions aa WHERE aa.attraction_id = a.id) AS linked_accommodations_count
            FROM dbo.attractions a
            INNER JOIN dbo.locations l ON a.location_id = l.id
            WHERE 1=1
        `;

        // Nếu có lọc theo điểm đến (locationId)
        if (locationId) {
            request.input("locationId", sql.Int, locationId);
            queryStr += " AND a.location_id = @locationId";
        }

        // Nếu có tìm kiếm từ khóa theo tên hoặc địa chỉ
        if (search && search.trim()) {
            request.input("search", sql.NVarChar(255), `%${search.trim()}%`);
            queryStr += " AND (a.name LIKE @search OR a.address_line LIKE @search)";
        }

        // Nếu có lọc theo trạng thái hoạt động (status = 1 hoặc 0)
        if (status !== undefined && status !== "" && status !== "ALL") {
            const isActive = (status === "ACTIVE" || status === "1" || status === true) ? 1 : 0;
            request.input("isActive", sql.Bit, isActive);
            queryStr += " AND a.is_active = @isActive";
        }

        queryStr += " ORDER BY a.id ASC;";

        const result = await request.query(queryStr);

        return res.status(200).json({
            success: true,
            message: "Lấy danh sách điểm tham quan thành công",
            data: {
                attractionsList: result.recordset
            }
        });
    } catch (error) {
        console.error("[getAttractionsList] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi lấy danh sách điểm tham quan",
            error: error.message
        });
    }
}

// Hàm 2: Lấy chi tiết 1 điểm tham quan theo id
async function getAttractionDetail(req, res) {
    try {
        const { id } = req.params;
        const pool = getDBPool();

        // 1. Lấy thông tin chi tiết điểm tham quan
        const result = await pool.request()
            .input("id", sql.Int, id)
            .query(`
                SELECT
                    a.*,
                    l.name AS location_name
                FROM dbo.attractions a
                INNER JOIN dbo.locations l ON a.location_id = l.id
                WHERE a.id = @id;
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm tham quan này!"
            });
        }

        const attraction = result.recordset[0];

        // 2. Lấy thêm các cơ sở lưu trú lân cận có liên kết với điểm tham quan này
        const linkedResult = await pool.request()
            .input("attractionId", sql.Int, id)
            .query(`
                SELECT
                    aa.accommodation_id,
                    acc.accommodation_name,
                    aa.distance_meters,
                    aa.note
                FROM dbo.accommodation_attractions aa
                INNER JOIN dbo.accommodations acc ON aa.accommodation_id = acc.id
                WHERE aa.attraction_id = @attractionId
                ORDER BY aa.sort_order ASC;
            `);

        attraction.linked_accommodations = linkedResult.recordset;

        return res.status(200).json({
            success: true,
            message: "Lấy chi tiết điểm tham quan thành công",
            data: {
                attractionDetail: attraction
            }
        });
    } catch (error) {
        console.error("[getAttractionDetail] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi lấy chi tiết điểm tham quan",
            error: error.message
        });
    }
}

// Hàm 3: Thêm mới 1 điểm tham quan
async function createAttraction(req, res) {
    try {
        const {
            location_id,
            name,
            address_line,
            description,
            image_url,
            is_active
        } = req.body;

        // 1. Validate dữ liệu
        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Vui lòng nhập tên điểm tham quan!"
            });
        }
        if (!location_id) {
            return res.status(400).json({
                success: false,
                message: "Vui lòng chọn Điểm đến trực thuộc!"
            });
        }

        const pool = getDBPool();

        // 2. Kiểm tra xem location_id có tồn tại trong bảng dbo.locations không
        const checkLoc = await pool.request()
            .input("locationId", sql.Int, location_id)
            .query("SELECT COUNT(1) AS count FROM dbo.locations WHERE id = @locationId;");

        if (checkLoc.recordset[0].count === 0) {
            return res.status(400).json({
                success: false,
                message: "Điểm đến được chọn không tồn tại trong hệ thống!"
            });
        }

        // 3. Thực thi INSERT
        const result = await pool.request()
            .input("location_id", sql.Int, location_id)
            .input("name", sql.NVarChar(255), name.trim())
            .input("address_line", sql.NVarChar(400), address_line || null)
            .input("description", sql.NVarChar(sql.MAX), description || null)
            .input("image_url", sql.NVarChar(500), image_url || null)
            .input("is_active", sql.Bit, is_active !== undefined ? (is_active ? 1 : 0) : 1)
            .query(`
                INSERT INTO dbo.attractions (
                    location_id, name, address_line, description,
                    image_url, is_active, created_at
                )
                OUTPUT INSERTED.*
                VALUES (
                    @location_id, @name, @address_line, @description,
                    @image_url, @is_active, SYSDATETIME()
                );
            `);

        return res.status(201).json({
            success: true,
            message: "Thêm điểm tham quan thành công",
            data: {
                newAttraction: result.recordset[0]
            }
        });
    } catch (error) {
        console.error("[createAttraction] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi thêm điểm tham quan",
            error: error.message
        });
    }
}

// Hàm 4: Cập nhật thông tin điểm tham quan
async function updateAttraction(req, res) {
    try {
        const { id } = req.params;
        const {
            location_id,
            name,
            address_line,
            description,
            image_url,
            is_active
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Tên điểm tham quan không được để trống!"
            });
        }

        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sql.Int, id)
            .input("location_id", sql.Int, location_id)
            .input("name", sql.NVarChar(255), name.trim())
            .input("address_line", sql.NVarChar(400), address_line || null)
            .input("description", sql.NVarChar(sql.MAX), description || null)
            .input("image_url", sql.NVarChar(500), image_url || null)
            .input("is_active", sql.Bit, is_active !== undefined ? (is_active ? 1 : 0) : 1)
            .query(`
                UPDATE dbo.attractions
                SET
                    location_id = @location_id,
                    name = @name,
                    address_line = @address_line,
                    description = @description,
                    image_url = @image_url,
                    is_active = @is_active,
                    updated_at = SYSDATETIME()
                OUTPUT INSERTED.*
                WHERE id = @id;
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm tham quan để cập nhật!"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Cập nhật điểm tham quan thành công",
            data: {
                updatedAttraction: result.recordset[0]
            }
        });
    } catch (error) {
        console.error("[updateAttraction] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi cập nhật điểm tham quan",
            error: error.message
        });
    }
}

// Hàm 5: Bật/tắt nhanh trạng thái hoạt động (Active <-> Inactive)
async function toggleAttractionStatus(req, res) {
    try {
        const { id } = req.params;
        const pool = getDBPool();

        const result = await pool.request()
            .input("id", sql.Int, id)
            .query(`
                UPDATE dbo.attractions
                SET
                    is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
                    updated_at = SYSDATETIME()
                OUTPUT INSERTED.id, INSERTED.name, INSERTED.is_active
                WHERE id = @id;
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm tham quan để đổi trạng thái!"
            });
        }

        const updated = result.recordset[0];
        const statusText = updated.is_active ? "Kích hoạt" : "Tạm ngưng";

        return res.status(200).json({
            success: true,
            message: `Đã ${statusText} điểm tham quan "${updated.name}" thành công`,
            data: {
                attraction: updated
            }
        });
    } catch (error) {
        console.error("[toggleAttractionStatus] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi đổi trạng thái điểm tham quan",
            error: error.message
        });
    }
}

// Hàm 6: Xóa điểm tham quan (kiểm tra an toàn liên kết)
async function deleteAttraction(req, res) {
    try {
        const { id } = req.params;
        const pool = getDBPool();

        // 1. Kiểm tra xem có khách sạn/resort nào đang liên kết với điểm tham quan này không
        const checkLinked = await pool.request()
            .input("id", sql.Int, id)
            .query("SELECT COUNT(1) AS count FROM dbo.accommodation_attractions WHERE attraction_id = @id;");

        if (checkLinked.recordset[0].count > 0) {
            return res.status(400).json({
                success: false,
                message: "Không thể xóa vì điểm tham quan này đang được liên kết với một số cơ sở lưu trú!"
            });
        }

        // 2. Tiến hành xóa nếu không có liên kết
        const deleteResult = await pool.request()
            .input("id", sql.Int, id)
            .query("DELETE FROM dbo.attractions WHERE id = @id;");

        if (deleteResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy điểm tham quan để xóa!"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Xóa điểm tham quan thành công"
        });
    } catch (error) {
        console.error("[deleteAttraction] Lỗi:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi xóa điểm tham quan",
            error: error.message
        });
    }
}


module.exports = {
    getAttractionsList,
    getAttractionDetail,
    createAttraction,
    updateAttraction,
    toggleAttractionStatus,
    deleteAttraction
};
