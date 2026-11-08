const { sqlObj, getDBPool } = require("../configs/database");

// ============================================================
// Sort options
// ============================================================

const SORT_OPTIONS = {
	default: `
		is_featured DESC,
		id DESC
	`,

	price_asc: `
		CASE WHEN min_base_price IS NULL THEN 1 ELSE 0 END ASC,
		min_base_price ASC,
		id ASC
	`,

	price_desc: `
		CASE WHEN min_base_price IS NULL THEN 1 ELSE 0 END ASC,
		min_base_price DESC,
		id ASC
	`,

	star_rating_desc: `
		CASE WHEN star_rating IS NULL THEN 1 ELSE 0 END ASC,
		star_rating DESC,
		id ASC
	`,

	star_rating_asc: `
		CASE WHEN star_rating IS NULL THEN 1 ELSE 0 END ASC,
		star_rating ASC,
		id ASC
	`
};

// ============================================================
// Common helpers
// ============================================================

function failure(errorCode, errorMsg = "", errors = {}) {
	return {
		success: false,
		errorCode,
		errorMsg,
		errors
	};
}

function isMissing(value) {
	return value === undefined || value === null || value === "";
}

function isObject(value) {
	return (value !== null && typeof value === "object" && !Array.isArray(value));
}

function parseInteger(value, field, errors, defaultValue = null, min = 1) {
	if (isMissing(value)) {
		return defaultValue;
	}

	if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value))) {
		errors[field] = `${field} phải là số nguyên từ ${min} trở lên.`;
		return null;
	}

  	const number = Number(value);

	if (!Number.isSafeInteger(number) || number < min || number > 2147483647) {
		errors[field] = `${field} phải nằm trong khoảng ${min} đến 2147483647.`;
		return null;
	}

  	return number;
}

function parseDate(value, field, errors) {
	if (isMissing(value)) {
		return null;
	}

	if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
		errors[field] = `${field} phải có định dạng YYYY-MM-DD.`;
		return null;
	}

	const date = new Date(`${value}T00:00:00.000Z`);

	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
		errors[field] = `${field} không phải ngày hợp lệ.`;
		return null;
	}

	return value;
}

function parsePrice(value, field, errors) {
	if (isMissing(value)) {
		return null;
	}

	if (!["string", "number"].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) {
		errors[field] = `${field} phải là số không âm, tối đa 2 chữ số thập phân.`;
		return null;
	}

  	const price = Number(value);

	if (!Number.isFinite(price) || price > Number.MAX_SAFE_INTEGER) {
		errors[field] = `${field} vượt giới hạn cho phép.`;
		return null;
	}

  	return price;
}

function parseIdList(value, field, errors, maxValue = 2147483647) {
	if (value === undefined || value === null) {
		return [];
	}

	if (!Array.isArray(value)) {
		errors[field] = `${field} phải là mảng các số nguyên dương.`;
		return [];
	}

	const ids = [];

	for (const item of value) {
		if (!["string", "number"].includes(typeof item) || !/^\d+$/.test(String(item))) {
			errors[field] = `Mỗi phần tử trong ${field} phải là số nguyên từ 1 đến ${maxValue}.`;
			return [];
		}

		const id = Number(item);

		if (!Number.isSafeInteger(id) || id < 1 || id > maxValue) {
			errors[field] = `Mỗi phần tử trong ${field} phải là số nguyên từ 1 đến ${maxValue}.`;
			return [];
		}

		ids.push(id);
	}

	return [...new Set(ids)];
}

// ============================================================
// Validate filters
// ============================================================

function normalizeFilters(filters) {
	if (!isObject(filters)) {
		return failure(
		"DATA_INVALID",
		"filters phải là object."
		);
	}

	const errors = {};

	const normalized = {
		locationId: parseInteger(
		filters.locationId,
		"locationId",
		errors
		),

		accommodationId: parseInteger(
		filters.accommodationId,
		"accommodationId",
		errors
		),

		//accommodationTypeId: parseInteger(filters.accommodationTypeId, "accommodationTypeId", errors),

		accommodationTypeIds: parseIdList(filters.accommodationTypeIds, "accommodationTypeIds", errors),

		accommodationType: null,

		checkinDate: parseDate(
		filters.checkinDate,
		"checkinDate",
		errors
		),

		checkoutDate: parseDate(
		filters.checkoutDate,
		"checkoutDate",
		errors
		),

		rooms: parseInteger(
		filters.rooms,
		"rooms",
		errors
		),

		priceFrom: parsePrice(
		filters.priceFrom,
		"priceFrom",
		errors
		),

		priceTo: parsePrice(
		filters.priceTo,
		"priceTo",
		errors
		),

		amenityIds: parseIdList(
		filters.amenityIds,
		"amenityIds",
		errors
		),

		starRatings: parseIdList(
		filters.starRatings,
		"starRatings",
		errors,
		5
		),
	};

	if (!isMissing(filters.accommodationType)) {
		if (typeof filters.accommodationType !== "string") {
			errors.accommodationType = "accommodationType phải là chuỗi.";
		} else {
			const code = filters.accommodationType.trim().toLowerCase();

			if (!/^[a-z0-9_-]{1,100}$/.test(code)) {
				errors.accommodationType = "accommodationType không hợp lệ.";
			} else {
				normalized.accommodationType = code;
			}
		}
	}

	if (Object.keys(errors).length > 0) {
		return failure("DATA_INVALID", "Tiêu chí tìm kiếm không hợp lệ.", errors);
	}

	// Phải có cả hai ngày hoặc không có ngày nào.
	if (Boolean(normalized.checkinDate) !== Boolean(normalized.checkoutDate)) {
		const missingField = normalized.checkinDate ? "checkoutDate" : "checkinDate";

		errors[missingField] = "Phải truyền đồng thời checkinDate và checkoutDate.";
	}

	if (normalized.checkinDate && normalized.checkoutDate) {
		if (normalized.checkoutDate <= normalized.checkinDate) {
			errors.checkoutDate = "checkoutDate phải sau checkinDate.";
		}

		// Có đủ ngày, thiếu rooms thì mặc định 1.
		normalized.rooms ??= 1;
	}

	if (
		!normalized.checkinDate &&
		!normalized.checkoutDate &&
		normalized.rooms !== null
	) {
		errors.rooms = "Cần checkinDate và checkoutDate khi tìm theo số phòng.";
	}

	if (
		normalized.priceFrom !== null &&
		normalized.priceTo !== null &&
		normalized.priceFrom > normalized.priceTo
	) {
		errors.priceTo = "priceTo phải lớn hơn hoặc bằng priceFrom.";
	}

	if (Object.keys(errors).length > 0) {
		return failure("DATA_INVALID", "Tiêu chí tìm kiếm không hợp lệ.", errors);
	}

	return {
		success: true,
		filters: normalized,
	};
}

// ============================================================
// Validate sort
// ============================================================

function normalizeSort(sort) {
	if (isMissing(sort)) {
		return {
			success: true,
			sort: "default"
		};
	}

	if (typeof sort !== "string") {
		return failure("DATA_INVALID", "Lựa chọn sắp xếp không hợp lệ.", {
				sort: "sort phải là chuỗi.",
			}
		);
	}

  	const normalized = sort.trim().toLowerCase();

	if (!Object.hasOwn(SORT_OPTIONS, normalized)) {
		return failure("DATA_INVALID", "Lựa chọn sắp xếp không hợp lệ.", {
			sort: "sort chỉ nhận: default, price_asc, price_desc, " + "star_rating_desc, star_rating_asc."
		});
	}

	return {
		success: true,
		sort: normalized,
	};
}

// ============================================================
// Validate pagination
// ============================================================

function normalizePagination(pagination) {
	if (!isObject(pagination)) {
		return failure("DATA_INVALID", "pagination phải là object.");
	}

	const errors = {};

	const page = parseInteger(pagination.page, "page", errors, 1);

	// Thiếu pageSize hoặc pageSize = 0: không phân trang.
	const pageSize = parseInteger(pagination.pageSize, "pageSize", errors, 0, 0);

	if (Object.keys(errors).length > 0) {
		return failure("DATA_INVALID", "Thông tin phân trang không hợp lệ.", errors);
	}

	if (pageSize > 100) {
		errors.pageSize = "pageSize không được lớn hơn 100; dùng 0 để không phân trang.";
	}

	const enabled = pageSize > 0;
	const offset = enabled ? (page - 1) * pageSize : 0;

	if (!Number.isSafeInteger(offset) || offset > 2147483647) {
		errors.page = "page vượt giới hạn cho phép.";
	}

	if (Object.keys(errors).length > 0) {
		return failure("DATA_INVALID", "Thông tin phân trang không hợp lệ.", errors);
	}

	return {
		success: true,
		pagination: {
			enabled,
			page: enabled ? page : 1,
			pageSize,
			offset
		}
	};
}

// ============================================================
// Search accommodation
// ============================================================

/**
 * @param {Object} filters
 * @param {number|string} [filters.locationId]
 * @param {number|string} [filters.accommodationId]
 * @param {string} [filters.accommodationType]
 * @param {number|string} [filters.accommodationTypeId]
 * @param {Array<number|string>} [filters.accommodationTypeIds]
 * @param {string} [filters.checkinDate]  YYYY-MM-DD
 * @param {string} [filters.checkoutDate] YYYY-MM-DD
 * @param {number|string} [filters.rooms]
 * @param {number|string} [filters.priceFrom]
 * @param {number|string} [filters.priceTo]
 * @param {Array<number|string>} [filters.amenityIds]
 * @param {Array<number|string>} [filters.starRatings]
 *
 * @param {string} sort
 * default | price_asc | price_desc |
 * star_rating_desc | star_rating_asc
 *
 * @param {Object} pagination
 * @param {number|string} [pagination.page=1]
 * @param {number|string} [pagination.pageSize=0]
 */
async function searchAccommodationsByFilters(filters = {}, sort = "default", pagination = {}) {
	// ----------------------------------------------------------
	// 1. Validate và chuẩn hóa ba tham số riêng biệt
	// ----------------------------------------------------------

	const filterValidation = normalizeFilters(filters);

	if (!filterValidation.success) {
		return filterValidation;
	}

	const sortValidation = normalizeSort(sort);

	if (!sortValidation.success) {
		return sortValidation;
	}

	const paginationValidation = normalizePagination(pagination);

	if (!paginationValidation.success) {
		return paginationValidation;
	}

	// Chỉ thay biến cục bộ, không sửa object của bên gọi.
	filters = filterValidation.filters;
	sort = sortValidation.sort;
	pagination = paginationValidation.pagination;

	const hasDates = filters.checkinDate !== null;
	//const hasDates = filters.checkinDate !== null && filters.checkoutDate !== null;
	const hasAccommodationId = filters.accommodationId !== null;

	// Tìm đích danh accommodation: không loại vì thiếu phòng.
	const onlyAvailable = hasDates && !hasAccommodationId;

	// ----------------------------------------------------------
	// 2. Điều kiện lọc accommodation
	// ----------------------------------------------------------

	const conditions = [
		"a.status = 1",
		"a.deleted_at IS NULL",
	];

	if (filters.locationId !== null) {
		conditions.push(`
		a.location_id IN (
			SELECT id
			FROM LocationTree
		)
		`);
	}

	if (hasAccommodationId) {
		conditions.push("a.id = @accommodationId");
	}

	// if (filters.accommodationTypeId !== null) {
	// 	conditions.push("a.accommodation_type_id = @accommodationTypeId");
	// }

	if (filters.accommodationTypeIds.length > 0) {
		conditions.push(`
			a.accommodation_type_id IN (
				SELECT selectedType.accommodation_type_id
				FROM OPENJSON(@accommodationTypeIds)
				WITH (
					accommodation_type_id INT '$'
				) AS selectedType
			)
		`);
	}

	if (filters.accommodationType !== null) {
		conditions.push("at.code = @accommodationType");
	}

	// Phải có TẤT CẢ tiện nghi được chọn.
	if (filters.amenityIds.length > 0) {
		conditions.push(`
			NOT EXISTS (
				SELECT 1
				FROM OPENJSON(@amenityIds)
				WITH (
				amenity_id INT '$'
				) AS requiredAmenity

				WHERE NOT EXISTS (
				SELECT 1
				FROM dbo.accommodation_amenities AS aa
				WHERE aa.accommodation_id = a.id
					AND aa.amenity_id = requiredAmenity.amenity_id
				)
			)
		`);
	}

	// Hạng sao khớp MỘT TRONG các hạng được chọn.
	if (filters.starRatings.length > 0) {
		conditions.push(`
			a.star_rating IN (
				SELECT selectedStar.star_rating
				FROM OPENJSON(@starRatings)
				WITH (
				star_rating INT '$'
				) AS selectedStar
			)
		`);
	}

	// ----------------------------------------------------------
	// 3. Location được chọn và toàn bộ location con
	// ----------------------------------------------------------

	const locationCte = filters.locationId !== null
		? `
		LocationTree AS (
			SELECT id
			FROM dbo.locations
			WHERE id = @locationId

			UNION ALL

			SELECT child.id
			FROM dbo.locations AS child
			INNER JOIN LocationTree AS parent
			ON child.parent_id = parent.id
		),
		` : "";

	// ----------------------------------------------------------
	// 4. Tính tồn phòng nếu có ngày
	//
	// Không có ngày: SQL không tham chiếu bookings/booking_items.
	// ----------------------------------------------------------

	const inventoryCtes = hasDates
		? `
		-- Mỗi dòng booking_items tương ứng một phòng.
		-- Chỉ lấy booking CONFIRMED giao với kỳ tìm kiếm.
		OverlappingBookings AS (
			SELECT
			rt.id AS room_type_id,

			CASE
				WHEN b.check_in_date < @stayStart
				THEN @stayStart
				ELSE b.check_in_date
			END AS start_date,

			CASE
				WHEN b.check_out_date > @stayEnd
				THEN @stayEnd
				ELSE b.check_out_date
			END AS end_date,

			COUNT_BIG(*) AS booked_rooms

			FROM ActiveRoomTypes AS rt

			INNER JOIN dbo.booking_items AS bi
			ON bi.room_type_id = rt.id

			INNER JOIN dbo.bookings AS b
			ON b.id = bi.booking_id
			AND b.accommodation_id = rt.accommodation_id

			WHERE b.status = 'CONFIRMED'
			AND b.check_in_date < @stayEnd
			AND b.check_out_date > @stayStart

			GROUP BY
			rt.id,
			b.check_in_date,
			b.check_out_date
		),

		-- Checkin tăng, checkout giảm số phòng bị chiếm.
		BookingEvents AS (
			SELECT
			room_type_id,
			start_date AS event_date,
			booked_rooms AS delta
			FROM OverlappingBookings

			UNION ALL

			SELECT
			room_type_id,
			end_date AS event_date,
			-booked_rooms AS delta
			FROM OverlappingBookings
		),

		-- Gộp checkin và checkout cùng ngày trước khi cộng dồn.
		DailyEvents AS (
			SELECT
			room_type_id,
			event_date,
			SUM(delta) AS delta

			FROM BookingEvents

			GROUP BY
			room_type_id,
			event_date
		),

		-- Số phòng bị chiếm sau mỗi mốc biến động.
		RunningOccupancy AS (
			SELECT
			room_type_id,
			event_date,

			SUM(delta) OVER (
				PARTITION BY room_type_id
				ORDER BY event_date
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			) AS occupied_rooms

			FROM DailyEvents
		),

		-- Cao điểm số phòng bị chiếm trong kỳ lưu trú.
		PeakOccupancy AS (
			SELECT
			room_type_id,
			MAX(occupied_rooms) AS peak_rooms

			FROM RunningOccupancy

			WHERE event_date < @stayEnd

			GROUP BY room_type_id
		),

		-- Phòng trống xuyên suốt kỳ lưu trú của từng room type.
		RoomInventory AS (
			SELECT
			rt.id,
			rt.accommodation_id,
			rt.base_price,

			CASE
				WHEN rt.quantity > COALESCE(p.peak_rooms, 0)
				THEN rt.quantity - COALESCE(p.peak_rooms, 0)
				ELSE CAST(0 AS BIGINT)
			END AS available_rooms

			FROM ActiveRoomTypes AS rt

			LEFT JOIN PeakOccupancy AS p
			ON p.room_type_id = rt.id
		),
		`
		: `
			RoomInventory AS (
				SELECT
				id,
				accommodation_id,
				base_price,
				CAST(NULL AS BIGINT) AS available_rooms

				FROM ActiveRoomTypes
			),
		`;

	// ----------------------------------------------------------
	// 5. Lọc sau khi đã tính tồn phòng và giá thấp nhất
	// ----------------------------------------------------------

	const resultConditions = [];

	if (onlyAvailable) {
		resultConditions.push("COALESCE(i.available_rooms, 0) >= @rooms");
	}

	if (filters.priceFrom !== null) {
		resultConditions.push("i.min_base_price >= @priceFrom");
	}

	if (filters.priceTo !== null) {
		resultConditions.push("i.min_base_price <= @priceTo");
	}

	const resultWhere = resultConditions.length > 0
		? `WHERE ${resultConditions.join("\n AND ")}`
		: "";

	// ORDER BY chỉ lấy từ whitelist của backend.
	const orderBy = SORT_OPTIONS[sort];

	// Không phân trang thì bỏ hoàn toàn OFFSET/FETCH.
	const paginationSql = pagination.enabled
		? `
		OFFSET @offset ROWS
		FETCH NEXT @pageSize ROWS ONLY
		`
		: "";

	// ----------------------------------------------------------
	// 6. SQL batch
	// ----------------------------------------------------------
	const query = `
		${
		hasDates
			? `
			DECLARE @stayStart DATE =
				CONVERT(DATE, @checkinDate, 23);

			DECLARE @stayEnd DATE =
				CONVERT(DATE, @checkoutDate, 23);
			`
			: ""
		}

		;WITH
		${locationCte}

		CandidateAccommodations AS (
		SELECT
			a.id,
			a.accommodation_code,
			a.accommodation_name,
			a.slug,
			a.accommodation_type_id,

			at.code AS accommodation_type_code,
			at.name AS accommodation_type_name,

			a.location_id,
			loc.name AS location_name,
			loc.province_id AS loc_province_id,
			province.full_name AS loc_province_fullname,
			a.ward_id AS loc_ward_id,
			ward.full_name AS loc_ward_fullname,

			a.address_line,
			a.short_description,
			a.star_rating,
			a.is_featured

		FROM dbo.accommodations AS a

		INNER JOIN dbo.accommodation_types AS at ON at.id = a.accommodation_type_id
		
		LEFT JOIN dbo.locations AS loc ON loc.id = a.location_id
      	LEFT JOIN dbo.provinces AS province ON province.id = loc.province_id
      	LEFT JOIN dbo.wards AS ward ON ward.id = a.ward_id

		WHERE ${conditions.join("\n AND ")}
		),

		ActiveRoomTypes AS (
		SELECT
			rt.id,
			rt.accommodation_id,
			rt.quantity,
			rt.base_price

		FROM dbo.room_types AS rt

		INNER JOIN CandidateAccommodations AS a
			ON a.id = rt.accommodation_id

		WHERE rt.status = 1
			AND rt.deleted_at IS NULL
		),

		${inventoryCtes}

		AccommodationInventory AS (
		SELECT
			accommodation_id,

			SUM(available_rooms) AS available_rooms,

			MIN(
			${
				hasDates
				? `
					CASE
					WHEN available_rooms > 0
						THEN base_price
					END
				`
				: "base_price"
			}
			) AS min_base_price

		FROM RoomInventory

		GROUP BY accommodation_id
		)

		SELECT
		a.*,

		${
			hasDates
			? "COALESCE(i.available_rooms, CAST(0 AS BIGINT))"
			: "CAST(NULL AS BIGINT)"
		} AS available_rooms,

		${
			hasDates
			? `
				CAST(
				CASE
					WHEN COALESCE(i.available_rooms, 0) >= @rooms
					THEN 1
					ELSE 0
				END
				AS BIT
				)
			`
			: "CAST(NULL AS BIT)"
		} AS is_available,

		i.min_base_price

		INTO #SearchResults

		FROM CandidateAccommodations AS a

		LEFT JOIN AccommodationInventory AS i
		ON i.accommodation_id = a.id

		${resultWhere}

		OPTION (MAXRECURSION 100);

		-- Recordset 1: tổng số kết quả sau khi lọc.
		SELECT COUNT(*) AS total
		FROM #SearchResults;

		-- Recordset 2: danh sách đã sort, phân trang nếu có.
		SELECT *
		FROM #SearchResults

		ORDER BY ${orderBy}

		${paginationSql};

		DROP TABLE #SearchResults;
	`;

	// ----------------------------------------------------------
	// 7. Bind SQL parameters
	// ----------------------------------------------------------

	const pool = await getDBPool();
	const request = pool.request();

	request
		.input(
			"locationId",
			sqlObj.Int,
			filters.locationId
		)
		.input(
			"accommodationId",
			sqlObj.Int,
			filters.accommodationId
		)
		//.input("accommodationTypeId", sqlObj.Int, filters.accommodationTypeId)
		.input("accommodationTypeIds", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(filters.accommodationTypeIds))
		.input(
			"accommodationType",
			sqlObj.VarChar(100),
			filters.accommodationType
		)
		.input(
			"rooms",
			sqlObj.Int,
			filters.rooms
		)
		.input(
			"priceFrom",
			sqlObj.Decimal(18, 2),
			filters.priceFrom
		)
		.input(
			"priceTo",
			sqlObj.Decimal(18, 2),
			filters.priceTo
		)
		.input(
			"amenityIds",
			sqlObj.NVarChar(sqlObj.MAX),
			JSON.stringify(filters.amenityIds)
		)
		.input(
			"starRatings",
			sqlObj.NVarChar(sqlObj.MAX),
			JSON.stringify(filters.starRatings)
		);

	if (hasDates) {
		// Date-only được chuyển sang DATE bên SQL.
		request
		.input(
			"checkinDate",
			sqlObj.VarChar(10),
			filters.checkinDate
		)
		.input(
			"checkoutDate",
			sqlObj.VarChar(10),
			filters.checkoutDate
		);
	}

	if (pagination.enabled) {
		request
		.input(
			"offset",
			sqlObj.Int,
			pagination.offset
		)
		.input(
			"pageSize",
			sqlObj.Int,
			pagination.pageSize
		);
	}

	// ----------------------------------------------------------
	// 8. Thực thi và trả kết quả
	// ----------------------------------------------------------

	const result = await request.query(query);

	//console.log("[searchAccommodationsByFilters] data cua result.recordsets[0] : ");
	//console.log(result.recordsets[0]);
	//console.log("[searchAccommodationsByFilters] data cua result.recordsets[1] : ");
	//console.log(result.recordsets[1]);

	const total = result.recordsets[0][0].total;
	//const items = result.recordsets[1];

	const accommodationRows = result.recordsets[1];

	// Chỉ lấy dữ liệu liên quan cho các accommodation đã được lọc, sort và phân trang ở query chính
	const imagesByAccommodation = {};
	const amenitiesByAccommodation = {};

	if (accommodationRows.length > 0) {
		const accommodationIds = accommodationRows.map((accommodation) => accommodation.id);

		const relatedResult = await pool.request()
		.input(
			"accommodationIds",
			sqlObj.NVarChar(sqlObj.MAX),
			JSON.stringify(accommodationIds)
		)
		.query(`
			-- Recordset 1: các hình ảnh.
			SELECT image.accommodation_id, image.id AS image_id, image.image_url, image.alt_text, image.caption, image.is_cover
			FROM dbo.accommodation_images AS image

			INNER JOIN OPENJSON(@accommodationIds)
			WITH (accommodation_id INT '$') AS selectedAccommodation
			ON selectedAccommodation.accommodation_id = image.accommodation_id

			ORDER BY image.accommodation_id;

			-- Recordset 2: các tiện nghi và thông tin gắn với
			-- accommodation như phụ thu/ghi chú.
			SELECT aa.accommodation_id, aa.amenity_id, amenity.name, amenity.code, amenity.category_code, amenity.icon_key, amenity.description, aa.is_chargeable, aa.note AS accommodation_note
			FROM dbo.accommodation_amenities AS aa

			INNER JOIN dbo.amenities AS amenity ON amenity.id = aa.amenity_id

			INNER JOIN OPENJSON(@accommodationIds)
			WITH (accommodation_id INT '$') AS selectedAccommodation
			ON selectedAccommodation.accommodation_id = aa.accommodation_id

			ORDER BY aa.accommodation_id, amenity.id;
		`);

		const imageRows = relatedResult.recordsets[0];
		const amenityRows = relatedResult.recordsets[1];

		//console.log("Data của imageRows : ");
		//console.log(imageRows);

		for (const image of imageRows) {
			const accommodationId = image.accommodation_id;
			if (!imagesByAccommodation[accommodationId]) {
				imagesByAccommodation[accommodationId] = [];
			}

			const imageObj = {
				image_id: Number(image.image_id),
				image_url: image.image_url,
				alt_text: image.alt_text,
				caption: image.caption,
				is_cover: image.is_cover
			}

			imagesByAccommodation[accommodationId].push(imageObj);
		}

		//console.log("Data của amenityRows : ");
		//console.log(amenityRows);

		for (const row of amenityRows) {
			// accommodation_id dùng để gom nhóm.
			// Các field còn lại là dữ liệu tiện nghi trả frontend.
			const { accommodation_id: accommodationId, ...amenity } = row;

			if (!amenitiesByAccommodation[accommodationId]) {
				amenitiesByAccommodation[accommodationId] = [];
			}

			amenitiesByAccommodation[accommodationId].push(amenity);
		}
	}

	const items = accommodationRows.map((accommodation) => ({
		...accommodation,

		available_rooms: accommodation.available_rooms === null ? null : Number(accommodation.available_rooms),

		images: imagesByAccommodation[accommodation.id] ?? [],
		amenities: amenitiesByAccommodation[accommodation.id] ?? []
	}));

	const totalPages = pagination.enabled ? Math.ceil(total / pagination.pageSize) : (total > 0 ? 1 : 0);

	return {
		success: true,
		data: {
			filters,
			sort,
			availabilityChecked: hasDates,
			items,
			pagination: {
				enabled: pagination.enabled,
				page: pagination.page,
				pageSize: pagination.pageSize,
				total,
				totalPages,
			}
		}
	};
}

module.exports = {
    searchAccommodationsByFilters
};