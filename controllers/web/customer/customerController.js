const authService = require("../../../services/auth_service");

const CUSTOMER_ERROR_HTTP_STATUS = {
    NO_USER_SESSION: 401,
    USER_NOT_EXISTED: 404,
    ACCOUNT_IS_NOT_CUSTOMER: 403,
    ACCOUNT_INACTIVE: 403,
    DATA_INVALID: 400,
    WRONG_CURRENT_PASSWORD: 400,
};

function sendFailure(res, result) {
    const statusCode = CUSTOMER_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
    return res.status(statusCode).json({
        success: false,
        message: result.errorMsg,
        errorCode: result.errorCode,
        errors: result.errors || {},
    });
}

async function getCustomerProfile(req, res) {
    try {
        const userId = req.session?.customer?.id;
        const result = await authService.getCustomerProfileById(userId);
        if (!result.success) {
            return sendFailure(res, result);
        }

        const customer = result.data.customer;
        return res.status(200).json({
            success: true,
            message: "Lấy thông tin tài khoản thành công.",
            data: {
                ...customer,
                customerInfo: req.session.customer,
            },
        });
    } catch (error) {
        console.error("[customerController - getCustomerProfile] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi tải thông tin tài khoản.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

async function updateCustomerProfile(req, res) {
    try {
        const userId = req.session?.customer?.id;
        const result = await authService.updateCustomerProfile(userId, req.body);
        if (!result.success) {
            return sendFailure(res, result);
        }

        const customer = result.data.customer;
        req.session.customer = {
            id: customer.id,
            email: customer.email,
            fullName: customer.fullName,
            displayName: customer.displayName,
            phoneNumber: customer.phoneNumber,
            role: customer.role,
            status: customer.status,
        };

        await new Promise((resolve, reject) => {
            req.session.save((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                ...customer,
                customerInfo: req.session.customer,
            },
        });
    } catch (error) {
        console.error("[customerController - updateCustomerProfile] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi cập nhật hồ sơ.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

async function changeAccountPassword(req, res) {
    try {
        const userId = req.session?.customer?.id;
        const result = await authService.changeCustomerPassword(userId, req.body);
        if (!result.success) {
            return sendFailure(res, result);
        }

        return res.status(200).json({
            success: true,
            message: result.message,
            data: result.data,
        });
    } catch (error) {
        console.error("[customerController - changeAccountPassword] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi đổi mật khẩu.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

// export
module.exports = {
    getCustomerProfile,
    updateCustomerProfile,
    changeAccountPassword,
};
