const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const { getDBPool } = require("../configs/database");

const ROOM_TYPE_UPLOAD_DIR = path.join(
  __dirname,
  "..",
  "public",
  "uploads",
  "room_types",
);

// Ảnh upload từ form nằm trực tiếp trong /uploads/room_types/<file>,
// chưa có folder con theo id loại phòng.
const FLAT_IMAGE_URL_PATTERN = /^\/uploads\/room_types\/([^/\\]+)$/;

/**
 * Multer không biết id khi tạo mới nên ảnh được ghi file phẳng.
 * Hàm này di chuyển các ảnh đó vào /uploads/room_types/<id>/ và
 * cập nhật lại image_url trong DB để khớp đường dẫn mới.
 */
async function moveImagesIntoRoomTypeFolder(roomTypeId, imageUrls = []) {
  const flatUrls = [
    ...new Set(imageUrls.filter((url) => FLAT_IMAGE_URL_PATTERN.test(url))),
  ];
  if (flatUrls.length === 0) return;

  const pool = getDBPool();
  const targetDir = path.join(ROOM_TYPE_UPLOAD_DIR, String(roomTypeId));

  for (const oldUrl of flatUrls) {
    const fileName = path.basename(oldUrl);
    const sourcePath = path.join(ROOM_TYPE_UPLOAD_DIR, fileName);

    if (!fs.existsSync(sourcePath)) {
      // Client gửi lại URL cũ (vd double-submit) sau khi file đã được move:
      // chỉ cần sửa lại URL trong DB cho khớp vị trí file trên đĩa.
      if (fs.existsSync(path.join(targetDir, fileName))) {
        try {
          await pool
            .request()
            .input("roomTypeId", sql.Int, roomTypeId)
            .input("oldUrl", sql.NVarChar(1000), oldUrl)
            .input("newUrl", sql.NVarChar(1000), `/uploads/room_types/${roomTypeId}/${fileName}`)
            .query(`
              UPDATE dbo.room_type_images
              SET image_url = @newUrl
              WHERE room_type_id = @roomTypeId
                AND image_url = @oldUrl;
            `);
        } catch (error) {
          console.error(
            `[moveImagesIntoRoomTypeFolder] Không cập nhật được URL ${oldUrl}:`,
            error.message,
          );
        }
      }
      continue;
    }

    await fs.promises.mkdir(targetDir, { recursive: true });

    let newFileName = fileName;
    if (fs.existsSync(path.join(targetDir, newFileName))) {
      const ext = path.extname(fileName);
      const baseName = path.basename(fileName, ext);
      newFileName = `${baseName}-${crypto.randomUUID()}${ext}`;
    }
    const targetPath = path.join(targetDir, newFileName);
    const newUrl = `/uploads/room_types/${roomTypeId}/${newFileName}`;

    try {
      await fs.promises.rename(sourcePath, targetPath);
    } catch (error) {
      console.error(
        `[moveImagesIntoRoomTypeFolder] Không di chuyển được ${oldUrl}:`,
        error.message,
      );
      continue;
    }

    try {
      await pool
        .request()
        .input("roomTypeId", sql.Int, roomTypeId)
        .input("oldUrl", sql.NVarChar(1000), oldUrl)
        .input("newUrl", sql.NVarChar(1000), newUrl)
        .query(`
          UPDATE dbo.room_type_images
          SET image_url = @newUrl
          WHERE room_type_id = @roomTypeId
            AND image_url = @oldUrl;
        `);
    } catch (error) {
      // DB lỗi thì trả file về chỗ cũ để URL cũ trong DB vẫn còn hiệu lực.
      await fs.promises.rename(targetPath, sourcePath).catch(() => {});
      console.error(
        `[moveImagesIntoRoomTypeFolder] Không cập nhật được URL ${oldUrl}:`,
        error.message,
      );
    }
  }
}

module.exports = { moveImagesIntoRoomTypeFolder };
