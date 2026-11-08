const authService = require("../services/auth_service");

/**
 * Hàm xóa session va clear cookie lưu Session ID
 */
async function revokeCustomerSession(req, res) {
    await new Promise((resolve) => {
        req.session.destroy(() => resolve());
    });

    res.clearCookie("vietpeace.customer.sid", {
        path: "/api/web",
    });
}


async function requireCustomerLogin(req, res, next) {
    console.log("[requireCustomerLogin] req.session : ", req.session);

    if (!req.session.customer) {
        return res.status(401).json({
            success: false,
            message: "Vui lòng đăng nhập vào website",
            errorCode: "NO_USER_SESSION"
        });
    }

    // check dòng user có id là req.session.customer.id trong bảng users
    const currentCustomer_res = await authService.getCustomerDataById(req.session.customer.id);
    console.log("[requireCustomerLogin] Data của currentCustomer_res : ", currentCustomer_res);
    if (!currentCustomer_res.success) {
        console.log("[requireCustomerLogin] currentCustomer_res.success = false ! Thu hồi session authen của user !");

        // thu hồi session của user đang login
        await revokeCustomerSession(req, res);

        return res.status(401).json({
            success: false,
            message: currentCustomer_res.errorMsg,
            errorCode: currentCustomer_res.errorCode
        });
    }

    const currentCustomer = currentCustomer_res.data.customer;
    console.log("[requireCustomerLogin] Data của currentCustomer : ", currentCustomer);

    // check status của customer
    if (currentCustomer.status !== 1) {
        console.log("[requireCustomerLogin] currentCustomer.status != 1 ! Thu hồi session authen của user !");

        // thu hồi session của user đang login
        await revokeCustomerSession(req, res);

        return res.status(401).json({
            success: false,
            message: "Tài khoản không hợp lệ",
            errorCode: "ACCOUNT_INVALID"
        });
    }

    console.log("[requireCustomerLogin] currentCustomer hop le ! Cho di tiep !");

    req.session.customer.fullName = currentCustomer.full_name;
    req.session.customer.displayName = currentCustomer.display_name;
    //req.session.customer.phoneNumber = currentCustomer.phone_number;

    next();
}


module.exports = requireCustomerLogin;