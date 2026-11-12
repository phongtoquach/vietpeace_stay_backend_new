const customerAdminService = require("../../../services/customer_admin_service");
const { ok, fail } = require("../../../utils/response");

// Lấy danh sách Customer
async function getCustomersList(req, res) {
    try {
        const result = await customerAdminService.getCustomerList(
            req.query,
            req.currentAdmin
        );

        return ok(
            res,
            result,
            "Lấy danh sách khách hàng thành công."
        );
    } catch (error) {
        console.error("[getCustomersList] Lỗi:", error);

        if (error.statusCode && error.errorCode) {
            return fail(
                res,
                error.statusCode,
                error.errorCode,
                error.message
            );
        }

        return fail(
            res,
            500,
            "INTERNAL_ERROR",
            "Đã xảy ra lỗi khi lấy danh sách khách hàng."
        );
    }
}

// Lấy thông tin chi tiết Customer
async function getCustomerDetail(req, res) {
    try {
        const result = await customerAdminService.getCustomerDetail(
            req.params.id,
            req.currentAdmin
        );

        return ok(
            res,
            result,
            "Lấy thông tin khách hàng thành công."
        );
    } catch (error) {
        console.error("[getCustomerDetail] Lỗi:", error);

        if (error.statusCode && error.errorCode) {
            return fail(
                res,
                error.statusCode,
                error.errorCode,
                error.message
            );
        }

        return fail(
            res,
            500,
            "INTERNAL_ERROR",
            "Đã xảy ra lỗi khi lấy thông tin khách hàng."
        );
    }
}

module.exports = {
    getCustomersList,
    getCustomerDetail
};