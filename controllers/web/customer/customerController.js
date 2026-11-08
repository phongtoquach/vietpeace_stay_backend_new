async function getCustomerProfile(req, res) {
    res.json({
        success: true,
        message: "Get profile successfully !",
        data: {
            userId: 101,
            fullName: "Nguyễn Văn Lam",
            email: "lamnv@gmail.com"
        }
    });
}


async function updateCustomerProfile(req, res) {
    res.status(201).json({
        success: true,
        message: "Update profile successfully !",
        data: {
            userId: 101
        }
    });
}


async function changeAccountPassword(req, res) {
    res.status(201).json({
        success: true,
        message: "Change password successfully !",
        data: {
            userId: 101
        }
    });
}


// export
module.exports = {
    getCustomerProfile,
    updateCustomerProfile,
    changeAccountPassword
};