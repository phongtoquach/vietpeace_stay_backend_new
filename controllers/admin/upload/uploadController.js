const fs = require("fs");
const path = require("path");

function uploadAccommodationImage(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: "Vui lòng chọn ảnh." });
  }

  const relativeUrl = `/uploads/accommodations/${req.file.filename}`;
  return res.status(201).json({ data: { url: relativeUrl } });
}

function uploadRoomTypeImage(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng chọn ảnh.",
      errorCode: "VALIDATION_ERROR",
    });
  }

  const relativeUrl = `/uploads/room_types/${req.file.filename}`;
  return res.status(201).json({ data: { url: relativeUrl } });
}

function uploadCheckoutEvidenceImage(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng chọn ảnh bằng chứng kiểm phòng hoặc hư hỏng thiết bị.",
      errorCode: "VALIDATION_ERROR",
    });
  }

  const relativeUrl = `/uploads/checkout_evidence/${req.file.filename}`;
  return res.status(201).json({
    success: true,
    data: { url: relativeUrl },
  });
}

module.exports = {
  uploadAccommodationImage,
  uploadRoomTypeImage,
  uploadCheckoutEvidenceImage,
};
