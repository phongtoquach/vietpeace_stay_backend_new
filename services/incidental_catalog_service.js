const db = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const {
  assertAccommodationAccess,
  getAccommodationScope,
  AccommodationAccessError,
} = require("./accommodation_access_service");

const sql = db.sqlObj;

const CATALOG_CATEGORIES = Object.freeze([
  "MINIBAR_FB",
  "EXTRA_SERVICE",
  "SPECIAL_CLEANING",
  "ROOM_ASSET",
]);

class IncidentalCatalogError extends Error {
  constructor(statusCode, errorCode, message, errors = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errors = errors;
  }
}

function validationError(message, errors) {
  return new IncidentalCatalogError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    message,
    errors,
  );
}

function normalizePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeNonNegativeInt(value, fieldLabel) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw validationError(`${fieldLabel} phải là số không âm.`);
  }
  return Math.round(n);
}

function normalizeItemCode(rawCode, fallbackPrefix = "ITEM") {
  const cleaned = String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (cleaned) {
    if (cleaned.length < 2 || cleaned.length > 40) {
      throw validationError("Mã hạng mục phải từ 2 đến 40 ký tự (chữ in hoa, số, _ hoặc -).", {
        itemCode: "Độ dài 2–40 ký tự.",
      });
    }
    return cleaned;
  }

  return `${fallbackPrefix}_${Date.now().toString(36).toUpperCase()}`;
}

function mapCatalogRow(row) {
  return {
    id: Number(row.id),
    accommodationId: Number(row.accommodation_id),
    category: row.category,
    itemCode: row.item_code,
    itemName: row.item_name,
    unitLabel: row.unit_label,
    unitPrice: Number(row.unit_price || 0),
    taxRate: Number(row.tax_rate || 0),
    isTaxInclusive: Boolean(row.is_tax_inclusive),
    purchaseYear:
      row.purchase_year === null || row.purchase_year === undefined
        ? null
        : Number(row.purchase_year),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function listCatalog(accommodationId, filters = {}, currentUser = {}) {
  const id = normalizePositiveInt(accommodationId);
  if (!id) {
    throw validationError("Mã cơ sở lưu trú không hợp lệ.");
  }

  let accommodation;
  try {
    accommodation = await assertAccommodationAccess(id, currentUser);
  } catch (error) {
    if (error instanceof AccommodationAccessError) {
      throw new IncidentalCatalogError(404, ERROR_CODES.NOT_FOUND, error.message);
    }
    throw error;
  }

  const category = filters.category ? String(filters.category).trim().toUpperCase() : null;
  if (category && !CATALOG_CATEGORIES.includes(category)) {
    throw validationError("Nhóm danh mục không hợp lệ.", {
      category: `Chỉ chấp nhận: ${CATALOG_CATEGORIES.join(", ")}`,
    });
  }

  const includeInactive =
    filters.includeInactive === true ||
    String(filters.includeInactive || "").toLowerCase() === "true";
  const q = typeof filters.q === "string" ? filters.q.trim() : "";

  const pool = db.getDBPool();
  const request = pool
    .request()
    .input("accommodationId", sql.Int, id)
    .input("category", sql.VarChar(30), category)
    .input("includeInactive", sql.Bit, includeInactive ? 1 : 0)
    .input("q", sql.NVarChar(150), q ? `%${q}%` : null);

  const result = await request.query(`
    SELECT
      id,
      accommodation_id,
      category,
      item_code,
      item_name,
      unit_label,
      unit_price,
      tax_rate,
      is_tax_inclusive,
      purchase_year,
      is_active,
      sort_order,
      created_at,
      updated_at
    FROM dbo.accommodation_incidental_catalog
    WHERE accommodation_id = @accommodationId
      AND (@category IS NULL OR category = @category)
      AND (@includeInactive = 1 OR is_active = 1)
      AND (@q IS NULL OR item_code LIKE @q OR item_name LIKE @q)
    ORDER BY
      CASE category
        WHEN 'MINIBAR_FB' THEN 1
        WHEN 'EXTRA_SERVICE' THEN 2
        WHEN 'SPECIAL_CLEANING' THEN 3
        WHEN 'ROOM_ASSET' THEN 4
        ELSE 9
      END ASC,
      sort_order ASC,
      id ASC;
  `);

  return {
    accommodation: {
      id: Number(accommodation.id),
      name: accommodation.name,
    },
    items: result.recordset.map(mapCatalogRow),
  };
}

function validateCatalogPayload(payload = {}, existing = null) {
  const categoryRaw = payload.category !== undefined ? payload.category : existing?.category;
  const category = String(categoryRaw || "").trim().toUpperCase();
  if (!CATALOG_CATEGORIES.includes(category)) {
    throw validationError("Nhóm danh mục không hợp lệ.", {
      category: `Chỉ chấp nhận: ${CATALOG_CATEGORIES.join(", ")}`,
    });
  }

  const itemNameRaw = payload.itemName !== undefined ? payload.itemName : existing?.item_name;
  const itemName = String(itemNameRaw || "").trim();
  if (!itemName || itemName.length > 150) {
    throw validationError("Tên hạng mục là bắt buộc và tối đa 150 ký tự.", {
      itemName: "Bắt buộc, tối đa 150 ký tự.",
    });
  }

  const unitLabelRaw = payload.unitLabel !== undefined ? payload.unitLabel : existing?.unit_label;
  const unitLabel = String(unitLabelRaw || "").trim();
  if (!unitLabel || unitLabel.length > 30) {
    throw validationError("Đơn vị tính là bắt buộc và tối đa 30 ký tự.", {
      unitLabel: "Bắt buộc, tối đa 30 ký tự.",
    });
  }

  const unitPriceRaw = payload.unitPrice !== undefined ? payload.unitPrice : existing?.unit_price;
  const unitPrice = normalizeNonNegativeInt(unitPriceRaw, "Đơn giá");

  const isAsset = category === "ROOM_ASSET";
  const taxRateRaw = payload.taxRate !== undefined ? payload.taxRate : (existing?.tax_rate ?? 0);
  const taxRate = isAsset ? 0 : Number(taxRateRaw);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw validationError("Thuế suất VAT phải nằm trong khoảng 0 - 100%.");
  }

  const isTaxInclusive = isAsset
    ? true
    : (payload.isTaxInclusive !== undefined
      ? Boolean(payload.isTaxInclusive)
      : (existing ? Boolean(existing.is_tax_inclusive) : true));

  let purchaseYear = null;
  if (isAsset) {
    const rawYear =
      payload.purchaseYear !== undefined
        ? payload.purchaseYear
        : (existing?.purchase_year ?? new Date().getFullYear());
    if (rawYear !== null && rawYear !== undefined && rawYear !== "") {
      const y = Number(rawYear);
      if (!Number.isInteger(y) || y < 1990 || y > 2100) {
        throw validationError("Năm trang bị tài sản phải từ 1990 đến 2100.");
      }
      purchaseYear = y;
    }
  }

  const sortOrderRaw = payload.sortOrder !== undefined ? payload.sortOrder : (existing?.sort_order ?? 0);
  const sortOrder = Number.isFinite(Number(sortOrderRaw)) ? Math.round(Number(sortOrderRaw)) : 0;

  const isActive =
    payload.isActive !== undefined
      ? Boolean(payload.isActive)
      : (existing ? Boolean(existing.is_active) : true);

  return {
    category,
    itemName,
    unitLabel,
    unitPrice,
    taxRate: Math.round(taxRate * 100) / 100,
    isTaxInclusive,
    purchaseYear,
    sortOrder,
    isActive,
  };
}

async function createCatalogItem(accommodationId, payload = {}, currentUser = {}) {
  const id = normalizePositiveInt(accommodationId);
  if (!id) {
    throw validationError("Mã cơ sở lưu trú không hợp lệ.");
  }

  try {
    await assertAccommodationAccess(id, currentUser);
  } catch (error) {
    if (error instanceof AccommodationAccessError) {
      throw new IncidentalCatalogError(404, ERROR_CODES.NOT_FOUND, error.message);
    }
    throw error;
  }

  const normalized = validateCatalogPayload(payload);
  const prefixMap = {
    MINIBAR_FB: "MB",
    EXTRA_SERVICE: "SVC",
    SPECIAL_CLEANING: "CLN",
    ROOM_ASSET: "ASSET",
  };
  const itemCode = normalizeItemCode(payload.itemCode, prefixMap[normalized.category]);

  const pool = db.getDBPool();
  try {
    const result = await pool
      .request()
      .input("accommodationId", sql.Int, id)
      .input("category", sql.VarChar(30), normalized.category)
      .input("itemCode", sql.VarChar(40), itemCode)
      .input("itemName", sql.NVarChar(150), normalized.itemName)
      .input("unitLabel", sql.NVarChar(30), normalized.unitLabel)
      .input("unitPrice", sql.Decimal(18, 0), normalized.unitPrice)
      .input("taxRate", sql.Decimal(5, 2), normalized.taxRate)
      .input("isTaxInclusive", sql.Bit, normalized.isTaxInclusive ? 1 : 0)
      .input("purchaseYear", sql.SmallInt, normalized.purchaseYear)
      .input("isActive", sql.Bit, normalized.isActive ? 1 : 0)
      .input("sortOrder", sql.Int, normalized.sortOrder)
      .input("createdBy", sql.UniqueIdentifier, currentUser.id ?? null)
      .query(`
        INSERT INTO dbo.accommodation_incidental_catalog (
          accommodation_id, category, item_code, item_name, unit_label,
          unit_price, tax_rate, is_tax_inclusive, purchase_year,
          is_active, sort_order, created_by, created_at
        )
        OUTPUT INSERTED.*
        VALUES (
          @accommodationId, @category, @itemCode, @itemName, @unitLabel,
          @unitPrice, @taxRate, @isTaxInclusive, @purchaseYear,
          @isActive, @sortOrder, @createdBy, SYSDATETIME()
        );
      `);

    return mapCatalogRow(result.recordset[0]);
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      throw new IncidentalCatalogError(
        409,
        ERROR_CODES.DUPLICATE_CODE,
        `Mã hạng mục "${itemCode}" đã tồn tại tại cơ sở này.`,
      );
    }
    throw error;
  }
}

async function findScopedCatalogItem(itemId, currentUser = {}) {
  const id = normalizePositiveInt(itemId);
  if (!id) {
    throw validationError("Mã hạng mục không hợp lệ.");
  }

  const scope = getAccommodationScope(currentUser, "a");
  const pool = db.getDBPool();
  const request = pool.request().input("itemId", sql.Int, id);
  scope.inputs.forEach((inp) => request.input(inp.name, inp.type, inp.value));

  const res = await request.query(`
    SELECT c.*
    FROM dbo.accommodation_incidental_catalog c
    JOIN dbo.accommodations a ON a.id = c.accommodation_id
    WHERE c.id = @itemId
      AND a.deleted_at IS NULL
      AND ${scope.condition};
  `);

  const row = res.recordset[0];
  if (!row) {
    throw new IncidentalCatalogError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy hạng mục danh mục trong phạm vi quản lý.",
    );
  }
  return row;
}

async function updateCatalogItem(itemId, payload = {}, currentUser = {}) {
  const existing = await findScopedCatalogItem(itemId, currentUser);
  const normalized = validateCatalogPayload(payload, existing);

  const nextCode =
    payload.itemCode !== undefined
      ? normalizeItemCode(payload.itemCode)
      : existing.item_code;

  const pool = db.getDBPool();
  try {
    const result = await pool
      .request()
      .input("itemId", sql.Int, Number(existing.id))
      .input("category", sql.VarChar(30), normalized.category)
      .input("itemCode", sql.VarChar(40), nextCode)
      .input("itemName", sql.NVarChar(150), normalized.itemName)
      .input("unitLabel", sql.NVarChar(30), normalized.unitLabel)
      .input("unitPrice", sql.Decimal(18, 0), normalized.unitPrice)
      .input("taxRate", sql.Decimal(5, 2), normalized.taxRate)
      .input("isTaxInclusive", sql.Bit, normalized.isTaxInclusive ? 1 : 0)
      .input("purchaseYear", sql.SmallInt, normalized.purchaseYear)
      .input("isActive", sql.Bit, normalized.isActive ? 1 : 0)
      .input("sortOrder", sql.Int, normalized.sortOrder)
      .query(`
        UPDATE dbo.accommodation_incidental_catalog
        SET
          category = @category,
          item_code = @itemCode,
          item_name = @itemName,
          unit_label = @unitLabel,
          unit_price = @unitPrice,
          tax_rate = @taxRate,
          is_tax_inclusive = @isTaxInclusive,
          purchase_year = @purchaseYear,
          is_active = @isActive,
          sort_order = @sortOrder,
          updated_at = SYSDATETIME()
        OUTPUT INSERTED.*
        WHERE id = @itemId;
      `);

    return mapCatalogRow(result.recordset[0]);
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      throw new IncidentalCatalogError(
        409,
        ERROR_CODES.DUPLICATE_CODE,
        `Mã hạng mục "${nextCode}" đã tồn tại tại cơ sở này.`,
      );
    }
    throw error;
  }
}

async function deactivateCatalogItem(itemId, currentUser = {}) {
  const existing = await findScopedCatalogItem(itemId, currentUser);
  const pool = db.getDBPool();
  const result = await pool
    .request()
    .input("itemId", sql.Int, Number(existing.id))
    .query(`
      UPDATE dbo.accommodation_incidental_catalog
      SET is_active = 0, updated_at = SYSDATETIME()
      OUTPUT INSERTED.*
      WHERE id = @itemId;
    `);
  return mapCatalogRow(result.recordset[0]);
}

module.exports = {
  CATALOG_CATEGORIES,
  IncidentalCatalogError,
  listCatalog,
  createCatalogItem,
  updateCatalogItem,
  deactivateCatalogItem,
};
