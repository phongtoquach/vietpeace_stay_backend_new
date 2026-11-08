/**
 * Các route này đều dùng cho các API có prefix /api/web/test/* : là các API để test
 */

const express = require("express");
const router = express.Router();

const bcrypt = require("bcryptjs");


// API generate password duoc ma hoa bằng bcryptjs
router.post("/generateHashedPassword", async (req, res) => {
    console.log("[generateHashedPassword] body data : ", req.body);
    const oriPassword = req.body.password.trim();

    const hashedPassword = await bcrypt.hash(oriPassword, 12);

    res.json({
        password: oriPassword,
        hashedPassword: hashedPassword
    });
});




// export
module.exports = router;