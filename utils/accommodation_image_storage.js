const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const { getDBPool } = require("../configs/database");

const ACCOMMODATION_UPLOAD_DIR = path.join(
  __dirname,
  "..",
  "public",
  "uploads",
  "accommodations",
);

// Ảnh upload từ form nằm trực tiếp trong /uploads/accommodations/<file>,
// chưa có folder con theo id cơ sở lưu trú.
const FLAT_IMAGE_URL_PATTERN = /^\/uploads\/accommodations\/([^/\\]+)$/;

/**
 * Multer không biết id khi tạo mới nên ảnh được ghi file phẳng.
 * Hàm này di chuyển các ảnh đó vào /uploads/accommodations/<id>/ và
 * cập nhật lại image_url trong DB để khớp đường dẫn mới.
 */
async function moveImagesIntoAccommodationFolder(accommodationId, imageUrls = []) {
  const flatUrls = [
    ...new Set(imageUrls.filter((url) => FLAT_IMAGE_URL_PATTERN.test(url))),
  ];
  if (flatUrls.length === 0) return;

  const pool = getDBPool();
  const targetDir = path.join(ACCOMMODATION_UPLOAD_DIR, String(accommodationId));

  for (const oldUrl of flatUrls) {
    const fileName = path.basename(oldUrl);
    const sourcePath = path.join(ACCOMMODATION_UPLOAD_DIR, fileName);

    if (!fs.existsSync(sourcePath)) continue;

    await fs.promises.mkdir(targetDir, { recursive: true });

    let newFileName = fileName;
    if (fs.existsSync(path.join(targetDir, newFileName))) {
      const ext = path.extname(fileName);
      const baseName = path.basename(fileName, ext);
      newFileName = `${baseName}-${crypto.randomUUID()}${ext}`;
    }
    const targetPath = path.join(targetDir, newFileName);
    const newUrl = `/uploads/accommodations/${accommodationId}/${newFileName}`;

    try {
      await fs.promises.rename(sourcePath, targetPath);
    } catch (error) {
      console.error(
        `[moveImagesIntoAccommodationFolder] Không di chuyển được ${oldUrl}:`,
        error.message,
      );
      continue;
    }

    try {
      await pool
        .request()
        .input("accommodationId", sql.Int, accommodationId)
        .input("oldUrl", sql.NVarChar(1000), oldUrl)
        .input("newUrl", sql.NVarChar(1000), newUrl)
        .query(`
          UPDATE dbo.accommodation_images
          SET image_url = @newUrl
          WHERE accommodation_id = @accommodationId
            AND image_url = @oldUrl;
        `);
    } catch (error) {
      // DB lỗi thì trả file về chỗ cũ để URL cũ trong DB vẫn còn hiệu lực.
      await fs.promises.rename(targetPath, sourcePath).catch(() => {});
      console.error(
        `[moveImagesIntoAccommodationFolder] Không cập nhật được URL ${oldUrl}:`,
        error.message,
      );
    }
  }
}

module.exports = { moveImagesIntoAccommodationFolder };
