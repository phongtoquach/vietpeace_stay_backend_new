require('dotenv').config();
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { connectDB, getDBPool } = require('../configs/database');

const VIETNAMESE_NAMES = [
  'Trần Minh Hoàng',
  'Lê Thị Bích Ngọc',
  'Phạm Đức Thắng',
  'Đỗ Thu Trang',
  'Hoàng Quốc Huy',
  'Vũ Thanh Thảo',
  'Bùi Quang Hải',
  'Đặng Lan Anh',
  'Ngô Tuấn Anh',
  'Dương Mai Phương',
  'Hồ Hồng Phúc',
  'Lý Văn Hưng',
  'Trịnh Kim Ngân',
  'Mai Đình Trọng',
  'Đinh Thùy Linh',
  'Đào Hữu Phước',
  'Phan Nhật Vy',
  'Võ Hoàng Long',
  'Huỳnh Diệu Linh',
  'Nguyễn Duy Khánh',
  'Trần Phương Nga',
  'Lê Anh Dũng',
  'Phạm Cẩm Tú',
  'Đỗ Minh Quân',
  'Hoàng Bảo Yến',
  'Vũ Tiến Đạt',
  'Bùi Khánh Huyền',
  'Đặng Thành Công',
  'Ngô Thúy An',
  'Dương Hùng Cường',
  'Hồ Ngọc Hân',
  'Lý Trọng Tấn',
  'Trịnh Minh Thư',
  'Mai Văn Kiên',
  'Đinh Tuyết Nhung',
  'Đào Bảo Long',
  'Phan Quỳnh Chi',
  'Võ Khắc Việt',
  'Huỳnh Kim Oanh',
  'Nguyễn Hải Đăng',
  'Trần Hương Giang',
  'Lê Tấn Phát',
  'Phạm Thảo My',
  'Đỗ Việt Hoàng',
  'Hoàng Như Quỳnh',
  'Vũ Thế Anh',
  'Bùi Hà My',
  'Đặng Hữu Thắng',
  'Ngô Yến Nhi',
  'Dương Quốc Bảo',
  'Nguyễn Thanh Tùng',
  'Trần Bích Thủy',
  'Lê Tuấn Kiệt',
  'Phạm Thảo Nguyên',
  'Hoàng Minh Khang',
  'Vũ Phương Thảo',
  'Bùi Gia Huy',
  'Đặng Khánh Linh',
  'Đỗ Văn Nam',
  'Hồ Thu Hằng',
  'Ngô Quang Minh',
  'Dương Kiều Oanh',
  'Lý Xuân Trường',
  'Trịnh Ánh Tuyết',
  'Mai Huy Hoàng',
  'Đinh Mai Anh',
  'Đào Trọng Nhân',
  'Phan Mỹ Duyên',
  'Võ Công Vinh',
  'Huỳnh Thanh Trúc',
];

function toSlug(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function getUniqueInternalEmail(pool, prefix) {
  let unique = false;
  let email = '';
  while (!unique) {
    const num = crypto.randomInt(1000, 9999);
    email = `mgr.${prefix}.${num}@vietpeacestay.vn`;
    const check = await pool
      .request()
      .input('email', sql.VarChar(255), email)
      .query('SELECT TOP 1 id FROM dbo.users WHERE email = @email');
    if (check.recordset.length === 0) {
      unique = true;
    }
  }
  return email;
}

async function getUniquePersonalEmail(pool, nameSlug) {
  let unique = false;
  let email = '';
  while (!unique) {
    const num = crypto.randomInt(1000, 9999);
    email = `${nameSlug}.${num}@gmail.com`;
    const check = await pool
      .request()
      .input('email', sql.VarChar(255), email)
      .query('SELECT TOP 1 id FROM dbo.users WHERE personal_email = @email');
    if (check.recordset.length === 0) {
      unique = true;
    }
  }
  return email;
}

async function finishSeed() {
  await connectDB();
  const pool = getDBPool();

  const adminRes = await pool.request().query("SELECT TOP 1 id FROM dbo.users WHERE role = 'ADMIN' ORDER BY created_at ASC");
  const adminId = adminRes.recordset[0].id;

  const existingUsers = await pool.request().query("SELECT full_name FROM dbo.users WHERE role = 'ACCOMMODATION_MANAGER'");
  const existingNameSet = new Set(existingUsers.recordset.map((u) => u.full_name));

  const salt = await bcrypt.genSalt(10);
  const defaultPasswordHash = await bcrypt.hash('VietPeace@2026', salt);

  // Lấy các cơ sở còn trống
  const unassignedAccomRes = await pool.request().query(`
    SELECT a.id, a.accommodation_code, a.accommodation_name
    FROM dbo.accommodations a
    LEFT JOIN dbo.accommodation_managers am ON am.accommodation_id = a.id
    WHERE a.deleted_at IS NULL AND am.accommodation_id IS NULL
    ORDER BY a.sort_order ASC, a.id ASC;
  `);

  const availableAccommodations = unassignedAccomRes.recordset;

  let accomIndex = 0;
  for (let i = 0; i < VIETNAMESE_NAMES.length; i++) {
    const fullName = VIETNAMESE_NAMES[i];
    if (existingNameSet.has(fullName)) {
      continue;
    }

    const nameSlug = toSlug(fullName);
    const personalEmail = await getUniquePersonalEmail(pool, nameSlug);

    const phonePrefixes = ['090', '091', '098', '097', '093', '086', '089', '077', '070', '038'];
    const prefix = phonePrefixes[i % phonePrefixes.length];
    const phoneSuffix = String(1000000 + i * 13757).slice(1, 8);
    const phoneNumber = `${prefix}${phoneSuffix}`;

    const isAssigned = i < 50 && accomIndex < availableAccommodations.length;
    let internalEmail = '';
    let targetAccom = null;

    if (isAssigned) {
      targetAccom = availableAccommodations[accomIndex++];
      const cleanCode = (targetAccom.accommodation_code || 'accom')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 10);
      internalEmail = await getUniqueInternalEmail(pool, cleanCode);
    } else {
      internalEmail = await getUniqueInternalEmail(pool, 'pool');
    }

    const insertUserRes = await pool
      .request()
      .input('email', sql.VarChar(255), internalEmail)
      .input('personalEmail', sql.VarChar(255), personalEmail)
      .input('fullName', sql.NVarChar(255), fullName)
      .input('displayName', sql.NVarChar(255), fullName)
      .input('passwordHash', sql.VarChar(255), defaultPasswordHash)
      .input('phoneNumber', sql.VarChar(20), phoneNumber)
      .input('role', sql.VarChar(30), 'ACCOMMODATION_MANAGER')
      .input('status', sql.TinyInt, 1)
      .input('mustChangePassword', sql.Bit, 0)
      .query(`
        INSERT INTO dbo.users (
          email, personal_email, full_name, display_name,
          password_hash, phone_number, role, status,
          must_change_password, email_verified_at, created_at, updated_at
        )
        OUTPUT INSERTED.id
        VALUES (
          @email, @personalEmail, @fullName, @displayName,
          @passwordHash, @phoneNumber, @role, @status,
          @mustChangePassword, SYSDATETIME(),
          DATEADD(DAY, -${Math.floor((70 - i) * 1.5)}, SYSDATETIME()),
          SYSDATETIME()
        );
      `);

    const newUserId = insertUserRes.recordset[0].id;

    if (isAssigned && targetAccom) {
      await pool
        .request()
        .input('accommodationId', sql.Int, targetAccom.id)
        .input('userId', sql.UniqueIdentifier, newUserId)
        .input('assignedByUserId', sql.UniqueIdentifier, adminId)
        .query(`
          INSERT INTO dbo.accommodation_managers (accommodation_id, user_id, assigned_by_user_id, assigned_at)
          VALUES (@accommodationId, @userId, @assignedByUserId, DATEADD(DAY, -${Math.floor((50 - i) * 1.2)}, SYSDATETIME()));
        `);
      console.log(`[Bổ sung phân công] ${fullName} -> ${targetAccom.accommodation_name}`);
    } else {
      console.log(`[Bổ sung chưa phân công] ${fullName} (Gmail: ${personalEmail})`);
    }
  }

  const finalUsers = await pool.request().query("SELECT COUNT(*) as total FROM dbo.users WHERE role = 'ACCOMMODATION_MANAGER'");
  const finalAssigned = await pool.request().query('SELECT COUNT(*) as total FROM dbo.accommodation_managers');
  const finalUnassigned = finalUsers.recordset[0].total - finalAssigned.recordset[0].total;

  console.log('--- KẾT QUẢ CUỐI CÙNG ---');
  console.log(`Tổng số Manager: ${finalUsers.recordset[0].total}`);
  console.log(`Đã phân công cơ sở: ${finalAssigned.recordset[0].total}`);
  console.log(`Chưa phân công: ${finalUnassigned}`);

  process.exit(0);
}

finishSeed().catch((err) => {
  console.error('Lỗi finishSeed:', err);
  process.exit(1);
});
