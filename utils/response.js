function ok(res, data = null, message = "Thành công", statusCode = 200) {
    return res.status(statusCode).json({ success: true, message, data });
}

function fail(res, statusCode, errorCode, message, errors = undefined) {
    const body = { success: false, message, errorCode };
    if (errors) body.errors = errors;
    return res.status(statusCode).json(body);
}

function paginated(res, items, { page, limit, total }) {
    return ok(res, {
        items,
        pagination: {
            page,
            limit,
            total,
            totalPages: limit > 0 ? Math.ceil(total / limit) : 0
        }
    }, "Lấy danh sách thành công.");
}

module.exports = { ok, fail, paginated };
