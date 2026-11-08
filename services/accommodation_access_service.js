const sql = require("mssql");

const { getDBPool } = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");

class AccommodationAccessError extends Error {
    constructor(message = "Không tìm thấy cơ sở lưu trú.") {
        super(message);
        this.statusCode = 404;
        this.errorCode = ERROR_CODES.NOT_FOUND;
    }
}

function isAdminUser(currentUser = {}) {
    return currentUser.role === "ADMIN";
}

function getAccommodationScope(currentUser = {}, alias = "a") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
        throw new Error("SQL alias không hợp lệ.");
    }

    const isAdmin = isAdminUser(currentUser);

    return {
        isAdmin,
        condition: `(
            @isAdmin = 1
            OR EXISTS (
                SELECT 1
                FROM dbo.accommodation_managers manager
                WHERE manager.accommodation_id = ${alias}.id
                  AND manager.user_id = @userId
            )
        )`,
        inputs: [
            { name: "isAdmin", type: sql.Bit, value: isAdmin ? 1 : 0 },
            {
                name: "userId",
                type: sql.UniqueIdentifier,
                value: currentUser.id ?? null,
            },
        ],
    };
}

async function findAccessibleAccommodation(
    accommodationId,
    currentUser = {},
    options = {},
) {
    const id = Number(accommodationId);

    if (!Number.isInteger(id) || id <= 0) {
        return null;
    }

    const { includeDeleted = false, pool = getDBPool() } = options;
    const isAdmin = isAdminUser(currentUser);
    const includeDeletedForAdmin = isAdmin && includeDeleted;
    const scope = getAccommodationScope(currentUser);
    const request = pool.request().input("accommodationId", sql.Int, id);

    for (const input of scope.inputs) {
        request.input(input.name, input.type, input.value);
    }

    const result = await request.query(`
        SELECT a.id
        FROM dbo.accommodations a
        WHERE a.id = @accommodationId
          ${includeDeletedForAdmin ? "" : "AND a.deleted_at IS NULL"}
          AND ${scope.condition};
    `);

    return result.recordset[0] ?? null;
}

async function assertAccommodationAccess(
    accommodationId,
    currentUser = {},
    options = {},
) {
    const accommodation = await findAccessibleAccommodation(
        accommodationId,
        currentUser,
        options,
    );

    if (!accommodation) {
        throw new AccommodationAccessError();
    }

    return accommodation;
}

module.exports = {
    AccommodationAccessError,
    isAdminUser,
    getAccommodationScope,
    findAccessibleAccommodation,
    assertAccommodationAccess,
};
