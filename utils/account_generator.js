const crypto = require("crypto");
const sql = require("mssql");
const { getDBPool } = require("../configs/database");

/**
 * Sinh mật khẩu tạm thời ngẫu nhiên độ dài n ký tự (mặc định 10 ký tự)
 * Bao gồm chữ hoa, chữ thường và chữ số để đảm bảo tính an toàn.
 */
function generateTemporaryPassword(length = 10) {
    const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // bỏ I, O để tránh nhầm
    const lowercase = "abcdefghijkmnpqrstuvwxyz"; // bỏ l, o để tránh nhầm
    const numbers = "23456789";                   // bỏ 0, 1 để tránh nhầm
    const allChars = uppercase + lowercase + numbers;

    let password = "";
    // Đảm bảo có ít nhất 1 chữ hoa, 1 chữ thường, 1 số
    password += uppercase[crypto.randomInt(0, uppercase.length)];
    password += lowercase[crypto.randomInt(0, lowercase.length)];
    password += numbers[crypto.randomInt(0, numbers.length)];

    for (let i = 3; i < length; i++) {
        password += allChars[crypto.randomInt(0, allChars.length)];
    }

    // Xáo trộn ngẫu nhiên các ký tự
    return password.split("").sort(() => 0.5 - Math.random()).join("");
}

/**
 * Sinh Email nội bộ ngẫu nhiên dạng:
 * {rolePrefix}.{cleanCode}.{random3Digits}@vietpeacestay.vn
 * Ví dụ:
 * - Manager: mgr.hllux.482@vietpeacestay.vn
 * - Lễ tân: rec.hllux.109@vietpeacestay.vn
 *
 * Hàm tự động kiểm tra trong DB để đảm bảo không bao giờ trùng lặp.
 */
async function generateUniqueInternalEmail(rolePrefix, accomCodeOrSlug) {
    const pool = getDBPool();
    const cleanCode = (accomCodeOrSlug || "accom")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 10);

    let isUnique = false;
    let internalEmail = "";

    while (!isUnique) {
        const randomSuffix = crypto.randomInt(100, 999);
        internalEmail = `${rolePrefix}.${cleanCode}.${randomSuffix}@vietpeacestay.vn`;

        // Quét toàn bộ bảng users để đảm bảo không trùng
        const check = await pool
            .request()
            .input("email", sql.VarChar(255), internalEmail)
            .query("SELECT TOP 1 id FROM dbo.users WHERE email = @email");

        if (check.recordset.length === 0) {
            isUnique = true;
        }
    }

    return internalEmail;
}

module.exports = {
    generateTemporaryPassword,
    generateUniqueInternalEmail,
};
