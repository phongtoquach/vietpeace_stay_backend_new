const { getDBPool } = require("../configs/database");
const sql = require("mssql");

function toSlug(input) {
    const value = String(input || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 300);
    return value || `acc-${Date.now()}`;
}

async function ensureUniqueSlug(baseSlug, excludeId = null) {
    const pool = getDBPool();
    const base = toSlug(baseSlug);
    for (let suffix = 0; suffix <= 50; suffix += 1) {
        const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
        const result = await pool.request()
            .input("slug", sql.VarChar(350), candidate)
            .input("excludeId", sql.Int, excludeId)
            .query(`SELECT TOP 1 slug FROM dbo.accommodations WHERE slug = @slug AND (@excludeId IS NULL OR id <> @excludeId)`);
        if (result.recordset.length === 0) return candidate;
    }
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { toSlug, ensureUniqueSlug };
