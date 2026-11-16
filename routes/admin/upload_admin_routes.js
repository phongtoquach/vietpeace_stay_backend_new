const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  uploadAccommodationImage,
  uploadRoomTypeImage,
  uploadCheckoutEvidenceImage,
} = require("../../controllers/admin/upload/uploadController");
const requirePermission = require("../../middlewares/requirePermission");

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

const SAFE_IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function createStrictImageUpload(subFolder) {
  const dir = path.join(__dirname, "../../public/uploads", subFolder);
  fs.mkdirSync(dir, { recursive: true });
  const targetStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const extFromName = path.extname(file.originalname || "").toLowerCase();
      const safeExt = SAFE_IMAGE_EXTENSIONS.has(file.mimetype) && [".jpg", ".jpeg", ".png", ".webp"].includes(extFromName)
        ? extFromName
        : (SAFE_IMAGE_EXTENSIONS.get(file.mimetype) || ".jpg");
      cb(null, `${crypto.randomUUID()}${safeExt}`);
    },
  });

  return multer({
    storage: targetStorage,
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
}

// Ảnh loại phòng và ảnh bằng chứng trả phòng lưu tách riêng theo từng folder.
const roomTypeUpload = createStrictImageUpload("room_types");
const checkoutEvidenceUpload = createStrictImageUpload("checkout_evidence");

router.post("/accommodations", requirePermission("accommodations.write"), upload.single("file"), uploadAccommodationImage);
router.post("/room-types", requirePermission("accommodations.write"), roomTypeUpload.single("file"), uploadRoomTypeImage);
router.post(
  "/checkout-evidence",
  requirePermission("bookings.write"),
  checkoutEvidenceUpload.single("file"),
  uploadCheckoutEvidenceImage,
);

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
