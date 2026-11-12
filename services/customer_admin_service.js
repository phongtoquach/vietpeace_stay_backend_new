const db = require("../configs/database");
const { getAccommodationScope } = require("./accommodation_access_service");

const sql = db.sqlObj;

class CustomerAdminServiceError extends Error {
    constructor(statusCode, errorCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
    }
}

// Lấy danh sách Customer dành cho Admin Panel
async function getCustomerList(query = {}, currentAdmin = {}) {
    // Kiểm tra quyền truy cập
    if (!["ADMIN", "ACCOMMODATION_MANAGER"].includes(currentAdmin.role)) {
        throw new CustomerAdminServiceError(
            403,
            "FORBIDDEN",
            "Bạn không có quyền xem danh sách khách hàng."
        );
    }

    // Phân trang
    const pageValue = Number.parseInt(query.page, 10);
    const limitValue = Number.parseInt(query.limit, 10);

    const page = Number.isInteger(pageValue) && pageValue > 0
        ? pageValue
        : 1;

    const limit = Number.isInteger(limitValue) && limitValue > 0
        ? Math.min(limitValue, 100)
        : 10;

    const offset = (page - 1) * limit;

    // Tìm kiếm
    const search = typeof query.search === "string"
        ? query.search.trim()
        : "";

        // Sắp xếp Customer
        const sortColumns = {
            id: "u.id",
            fullName: "u.full_name",
            email: "u.email",
            phoneNumber: "u.phone_number",
            bookingCount: "booking_stats.booking_count",
            status: "u.status",
            createdAt: "u.created_at"
        };

        const sortColumn = sortColumns[query.sortField] || "u.created_at";

        const sortDirection = String(query.sortDirection).toLowerCase() === "asc"
            ? "ASC"
            : "DESC";

    // Lấy phạm vi cơ sở theo tài khoản đang đăng nhập
    const scope = getAccommodationScope(currentAdmin, "a");

    const pool = db.getDBPool();

    // Điều kiện lọc Customer
    // ADMIN: lấy tất cả Customer.
    // MANAGER: chỉ lấy Customer có ít nhất một Booking tại cơ sở mình quản lý.
    let whereSql = `
        WHERE u.role = 'CUSTOMER'
        AND (
            @isAdmin = 1
            OR EXISTS (
                SELECT 1
                FROM dbo.bookings b_scope
                INNER JOIN dbo.accommodations a
                    ON a.id = b_scope.accommodation_id
                WHERE b_scope.user_id = u.id
                    AND ${scope.condition}
            )
        )
    `;

    const request = pool.request();

    // Truyền tham số phân quyền
    scope.inputs.forEach((input) => {
        request.input(input.name, input.type, input.value);
    });

    // Tìm theo tên, email, số điện thoại
    if (search) {
        request.input("search", sql.NVarChar(255), `%${search}%`);

        whereSql += `
            AND (
                u.full_name LIKE @search
                OR u.email LIKE @search
                OR u.phone_number LIKE @search
            )
        `;
    }

    // Đếm tổng Customer để phân trang
    const countResult = await request.query(`
        SELECT COUNT(*) AS total
        FROM dbo.users u
        ${whereSql};
    `);

    const total = Number(countResult.recordset[0]?.total || 0);

    if (total === 0) {
        return {
            items: [],
            pagination: {
                page,
                limit,
                total: 0,
                totalPages: 0
            }
        };
    }

    // Lấy danh sách Customer và số lượt Booking
    const dataRequest = pool.request();

    scope.inputs.forEach((input) => {
        dataRequest.input(input.name, input.type, input.value);
    });

    if (search) {
        dataRequest.input("search", sql.NVarChar(255), `%${search}%`);
    }

    dataRequest
        .input("offset", sql.Int, offset)
        .input("limit", sql.Int, limit);

    const dataResult = await dataRequest.query(`
        SELECT
            u.id,
            u.full_name,
            u.display_name,
            u.email,
            u.phone_number,
            u.avatar_url,
            u.status,
            u.created_at,

            booking_stats.booking_count

        FROM dbo.users u

        OUTER APPLY (
            SELECT COUNT(*) AS booking_count
            FROM dbo.bookings b
            INNER JOIN dbo.accommodations a
                ON a.id = b.accommodation_id
            WHERE b.user_id = u.id
                AND b.status IN ('CONFIRMED', 'CANCELLED')
                AND ${scope.condition}
        ) booking_stats

        ${whereSql}

        ORDER BY ${sortColumn} ${sortDirection}

        OFFSET @offset ROWS
        FETCH NEXT @limit ROWS ONLY;
    `);

    return {
        items: dataResult.recordset.map((row) => ({
            id: row.id,
            fullName: row.full_name,
            displayName: row.display_name,
            email: row.email,
            phoneNumber: row.phone_number || "",
            avatarUrl: row.avatar_url || null,
            status: "active",
            bookingCount: Number(row.booking_count || 0),
            createdAt: row.created_at
                ? row.created_at.toISOString()
                : null
        })),

        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

// Lấy thông tin chi tiết Customer
async function getCustomerDetail(customerId, currentAdmin = {}) {
    // Kiểm tra quyền truy cập
    if (!["ADMIN", "ACCOMMODATION_MANAGER"].includes(currentAdmin.role)) {
        throw new CustomerAdminServiceError(
            403,
            "FORBIDDEN",
            "Bạn không có quyền xem thông tin khách hàng."
        );
    }

    // Kiểm tra định dạng GUID
    const guidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(String(customerId))) {
        throw new CustomerAdminServiceError(
            400,
            "INVALID_CUSTOMER_ID",
            "Mã khách hàng không hợp lệ."
        );
    }

    const pool = db.getDBPool();

    // Lấy phạm vi cơ sở theo tài khoản đang đăng nhập
    const scope = getAccommodationScope(currentAdmin, "a");

    // Lấy thông tin Customer
    const customerRequest = pool.request();

    customerRequest.input(
        "customerId",
        sql.UniqueIdentifier,
        customerId
    );

    scope.inputs.forEach((input) => {
        customerRequest.input(input.name, input.type, input.value);
    });

    const customerResult = await customerRequest.query(`
        SELECT
            u.id,
            u.full_name,
            u.display_name,
            u.email,
            u.phone_number,
            u.avatar_url,
            u.status,
            u.created_at
        FROM dbo.users u
        WHERE u.id = @customerId
            AND u.role = 'CUSTOMER'
            AND (
                @isAdmin = 1
                OR EXISTS (
                    SELECT 1
                    FROM dbo.bookings b
                    INNER JOIN dbo.accommodations a
                        ON a.id = b.accommodation_id
                    WHERE b.user_id = u.id
                        AND ${scope.condition}
                )
            );
    `);

    const customer = customerResult.recordset[0];

    if (!customer) {
        throw new CustomerAdminServiceError(
            404,
            "CUSTOMER_NOT_FOUND",
            "Không tìm thấy thông tin khách hàng."
        );
    }

    // Lấy thống kê Booking và tổng chi tiêu
    const statsRequest = pool.request();

    statsRequest.input(
        "customerId",
        sql.UniqueIdentifier,
        customerId
    );

    scope.inputs.forEach((input) => {
        statsRequest.input(input.name, input.type, input.value);
    });

    const statsResult = await statsRequest.query(`
        SELECT
            COUNT(
                CASE
                    WHEN b.status IN ('CONFIRMED', 'CANCELLED')
                    THEN 1
                END
            ) AS total_bookings,

            COALESCE(
                SUM(
                    CASE
                        WHEN b.status = 'CONFIRMED'
                        THEN b.total_amount
                        ELSE 0
                    END
                ),
                0
            ) AS total_spent

        FROM dbo.bookings b
        INNER JOIN dbo.accommodations a
            ON a.id = b.accommodation_id

        WHERE b.user_id = @customerId
            AND ${scope.condition};
    `);

    // Lấy lịch sử Booking
    const bookingsRequest = pool.request();

    bookingsRequest.input(
        "customerId",
        sql.UniqueIdentifier,
        customerId
    );

    scope.inputs.forEach((input) => {
        bookingsRequest.input(input.name, input.type, input.value);
    });

    const bookingsResult = await bookingsRequest.query(`
        SELECT
            b.id,
            b.booking_code,
            a.accommodation_name,
            (
                SELECT STRING_AGG(
                    bi.room_type_name,
                    N', '
                )
                FROM dbo.booking_items bi
                WHERE bi.booking_id = b.id
            ) AS room_type_names,
            b.check_in_date,
            b.check_out_date,
            b.total_amount,
            b.status,
            b.created_at

        FROM dbo.bookings b
        INNER JOIN dbo.accommodations a
            ON a.id = b.accommodation_id

        WHERE b.user_id = @customerId
            AND ${scope.condition}

        ORDER BY b.created_at DESC;
    `);

    const stats = statsResult.recordset[0];

    return {
        customer: {
            id: customer.id,
            fullName: customer.full_name,
            displayName: customer.display_name,
            email: customer.email,
            phoneNumber: customer.phone_number || "",
            avatarUrl: customer.avatar_url || null,
            status: "active",
            createdAt: customer.created_at
                ? customer.created_at.toISOString()
                : null,
            totalBookings: Number(stats.total_bookings || 0),
            totalSpent: Number(stats.total_spent || 0)
        },

        bookings: bookingsResult.recordset.map((row) => ({
            id: row.id,
            bookingCode: row.booking_code,
            accommodationName: row.accommodation_name,
            roomTypeNames: row.room_type_names || "",
            checkInDate: row.check_in_date,
            checkOutDate: row.check_out_date,
            totalAmount: Number(row.total_amount || 0),
            status: row.status,
            createdAt: row.created_at
                ? row.created_at.toISOString()
                : null
        }))
    };
}

module.exports = {
    CustomerAdminServiceError,
    getCustomerList,
    getCustomerDetail
};