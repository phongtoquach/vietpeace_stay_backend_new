/**
 * Các hàm xử lý các API route về các booking của Customer (user) đã login vào web
 */


async function getCustomerBookings(req, res) {
    res.json({
        success: true,
        message: "Get successfully !",
        data: {
            bookingsList: [
                {
                    bookingId: 102,
                    accommodationName: "Hạ Long Luxury Riverside Hotel"
                },
                {
                    bookingId: 106,
                    accommodationName: "Cần Thơ Green Home"
                }
            ]
        }
    });
}



// export
module.exports = {
    getCustomerBookings
};