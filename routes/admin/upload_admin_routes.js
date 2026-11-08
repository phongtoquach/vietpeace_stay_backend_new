const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  uploadAccommodationImage,
  uploadRoomTypeImage,
} = require("../../controllers/admin/upload/uploadController");

const router = express.Router();
const uploadDir = path.join(__dirname, "../../public/uploads/accommodations");
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)),
});

// Ảnh loại phòng lưu riêng để không lẫn với ảnh cơ sở lưu trú.
const roomTypeUploadDir = path.join(__dirname, "../../public/uploads/room_types");
fs.mkdirSync(roomTypeUploadDir, { recursive: true });
const roomTypeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, roomTypeUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const roomTypeUpload = multer({
  storage: roomTypeStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
      return cb(null, true);
    }

    const error = new Error("UNSUPPORTED_MEDIA_TYPE");
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    return cb(error);
  },
});

router.post("/accommodations", upload.single("file"), uploadAccommodationImage);
router.post("/room-types", roomTypeUpload.single("file"), uploadRoomTypeImage);

// Multer báo lỗi trước controller nên phải tự trả JSON đúng contract.
router.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "Ảnh vượt quá dung lượng tối đa 5MB.",
      errorCode: "FILE_TOO_LARGE",
    });
  }

  if (error?.code === "UNSUPPORTED_MEDIA_TYPE") {
    return res.status(415).json({
      success: false,
      message: "Chỉ nhận ảnh JPG, PNG hoặc WEBP.",
      errorCode: "UNSUPPORTED_MEDIA_TYPE",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Không thể tải ảnh lên.",
    errorCode: "INTERNAL_ERROR",
  });
});

module.exports = router;
