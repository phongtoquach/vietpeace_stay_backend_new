const crypto = require('node:crypto');
const {
  sqlObj: sql,
  getDBPool
} = require('../configs/database');
const {
  getAccommodationScope
} = require('./accommodation_access_service');
const previewKey = crypto.randomBytes(32);
const TYPES = ['fixed_price', 'increase_percent', 'decrease_percent', 'increase_amount', 'decrease_amount'];
const BULK_ACTIONS = ['increase_percent','decrease_percent','increase_amount','decrease_amount','period','remove_period','restore'];
const DAY = 86400000;
function error(message, statusCode = 400) {
  return Object.assign(new Error(message), {
    statusCode,
    errorCode: statusCode === 409 ? 'CONFLICT' : statusCode === 403 ? 'FORBIDDEN' : 'PRICING_ERROR'
  });
}
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw error('Ngày không hợp lệ.');
  return value;
}
function dates(start, end, max = 731) {
  date(start);
  date(end);
  const n = (Date.parse(end) - Date.parse(start)) / DAY;
  if (n < 1 || n > max) throw error(`Khoảng ngày phải từ 1 đến ${max} đêm.`);
  return Array.from({
    length: n
  }, (_, i) => new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10));
}
function shift(d, n) {
  return new Date(Date.parse(date(d)) + n * DAY).toISOString().slice(0, 10);
}
function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw error('Mã không hợp lệ.');
  return n;
}
function money(value, zero = false) {
  if (value === '' || value === null || value === undefined) throw error('Vui lòng nhập số tiền.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < (zero ? 0 : 0.01) || n > 1e12 || Math.abs(n * 100 - Math.round(n * 100)) > 0.001) throw error('Số tiền phải hợp lệ, tối đa hai chữ số thập phân.');
  return n;
}
function hash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
function req(db, inputs = {}) {
  const r = new sql.Request(db);
  for (const [k, v] of Object.entries(inputs)) {
    if (['price', 'adjustment_value', ].includes(k)) r.input(k, sql.Decimal(18, 2), v);else r.input(k, v);
  }
  return r;
}
async function lock(tx) {
  await req(tx).query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource='vietpeace-pricing',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; IF @r<0 THROW 50001,N'Hệ thống giá đang bận, vui lòng thử lại.',1;");
}
async function access(db, accId, user, write = false) {
  const r = await req(db, {
    accId: id(accId),
    uid: user.id
  }).query(`SELECT a.id FROM dbo.accommodations a WITH (HOLDLOCK) WHERE a.id=@accId AND a.deleted_at IS NULL ${user.role === 'ADMIN' ? '' : `AND EXISTS(SELECT 1 FROM dbo.accommodation_managers WITH (HOLDLOCK) WHERE accommodation_id=a.id AND user_id=@uid)`};`);
  if (!r.recordset.length) throw error('Không tìm thấy cơ sở được phân công.', 404);
  if (write && user.role !== 'ADMIN') {
    const p = await req(db, {
      role: user.role
    }).query("SELECT 1 AS granted FROM dbo.role_permissions WITH (HOLDLOCK) WHERE role=@role AND permission_key='pricing.write' AND is_granted=1;");
    if (!p.recordset.length) throw error('Bạn không có quyền cập nhật giá.', 403);
  }
}
async function bootstrap(user) {
  const scope = getAccommodationScope(user);
  const r = new sql.Request(getDBPool());
  for (const p of scope.inputs) r.input(p.name, p.type, p.value);
  const result = await r.query(`SELECT a.id,a.accommodation_name AS name,l.name AS locationName FROM dbo.accommodations a LEFT JOIN dbo.locations l ON l.id=a.location_id WHERE a.deleted_at IS NULL AND ${scope.condition} ORDER BY a.accommodation_name;
 SELECT p.*,CONVERT(varchar(18),p.version,1) AS versionToken,
 CAST(CASE WHEN p.first_applied_at IS NULL THEN 1 ELSE 0 END AS bit) AS canModify,
 (SELECT COUNT(*) FROM dbo.accommodations WHERE deleted_at IS NULL) AS totalPropertyCount,
 (SELECT COUNT(*) FROM dbo.accommodation_rate_periods ar JOIN dbo.accommodations a ON a.id=ar.accommodation_id WHERE ar.rate_period_id=p.id AND ar.is_active=1 AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM dbo.room_period_rates r WHERE r.accommodation_rate_period_id=ar.id) AND ${scope.condition}) AS propertyCount
 FROM dbo.rate_periods p WHERE p.deleted_at IS NULL ORDER BY p.start_date DESC;`);
  return {
    accommodations: result.recordsets[0],
    periods: result.recordsets[1].map(p => ({
      ...p,
      id: Number(p.id),
      start_date: p.start_date.toISOString().slice(0, 10),
      end_date: p.end_date.toISOString().slice(0, 10),
      version: undefined
    })),
    today: today()
  };
}
async function state(db, accId) {
  const r = await req(db, {
    accId
  }).query(`SELECT id,name,code,quantity,base_price,status,included_adults,included_children,extra_adult_fee,extra_child_fee,updated_at FROM dbo.room_types WHERE accommodation_id=@accId AND deleted_at IS NULL ORDER BY sort_order,id;
 SELECT w.* FROM dbo.room_weekday_rates w JOIN dbo.room_types rt ON rt.id=w.room_type_id WHERE rt.accommodation_id=@accId ORDER BY w.room_type_id,w.day_of_week;
 SELECT s.* FROM dbo.room_weekday_rate_schedules s JOIN dbo.room_types rt ON rt.id=s.room_type_id WHERE rt.accommodation_id=@accId ORDER BY s.id;
 SELECT CAST(ar.id AS int) AS id,CAST(ar.rate_period_id AS int) AS rate_period_id,ar.is_active,ar.priority,p.name,p.start_date,p.end_date,p.deleted_at,r.room_type_id,r.adjustment_type,r.adjustment_value FROM dbo.accommodation_rate_periods ar JOIN dbo.rate_periods p ON p.id=ar.rate_period_id LEFT JOIN dbo.room_period_rates r ON r.accommodation_rate_period_id=ar.id WHERE ar.accommodation_id=@accId ORDER BY ar.id,r.id;
 SELECT ov.id,ov.room_type_id,ov.stay_date,ov.price,ov.reason FROM dbo.room_daily_rate_overrides ov JOIN dbo.room_types rt ON rt.id=ov.room_type_id WHERE rt.accommodation_id=@accId ORDER BY ov.id;
`);
  return Object.fromEntries(['rooms', 'weekdays', 'schedules', 'periodConfigs', 'overrides'].map((k, i) => [k, r.recordsets[i]]));
}
async function offers(db, roomIds, dayList) {
  if (!roomIds.length || !dayList.length) return [];
  return (await req(db, {
    rooms: JSON.stringify(roomIds),
    days: JSON.stringify(dayList)
  }).query(`SELECT f.*,CAST(CASE f.adjustment_type
    WHEN 'fixed_price' THEN f.adjustment_value
    WHEN 'increase_percent' THEN ROUND(f.normal_price*(1+f.adjustment_value/100),2)
    WHEN 'decrease_percent' THEN ROUND(f.normal_price*(1-f.adjustment_value/100),2)
    WHEN 'increase_amount' THEN f.normal_price+f.adjustment_value
    WHEN 'decrease_amount' THEN f.normal_price-f.adjustment_value ELSE f.normal_price END AS decimal(18,2)) AS rule_price
    FROM OPENJSON(@rooms) WITH(id int '$') r CROSS JOIN OPENJSON(@days) WITH(d date '$') d CROSS APPLY dbo.fn_room_daily_offer(r.id,d.d) f ORDER BY f.room_type_id,f.stay_date;`)).recordset.map(c => ({
    ...c,
    stay_date: c.stay_date.toISOString().slice(0, 10)
  }));
}
async function calendar(query, user) {
  const db = getDBPool(),
    accId = id(query.accommodationId);
  await access(db, accId, user);
  const start = date(query.start || today()),
    end = query.end || shift(start, 14),
    dayList = dates(start, end, 31);
  const data = await state(db, accId);
  return {
    ...data,
    cells: await offers(db, data.rooms.map(r => r.id), dayList),
    dates: dayList
  };
}
async function audit(tx, user, accId, action, reason, before, after, batch = crypto.randomUUID()) {
  await req(tx, {
    actor: user.id,
    accId,
    action,
    reason,
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    batch
  }).query(`INSERT dbo.pricing_inventory_audit_logs(batch_id,accommodation_id,actor_user_id,action,reason,before_json,after_json) VALUES(CONVERT(uniqueidentifier,@batch),@accId,CONVERT(uniqueidentifier,@actor),@action,@reason,@before,@after);`);
  return batch;
}
async function validate(tx, accId, roomIds, start, end) {
  // Explicitly reject ambiguous periods, including changes to shared period dates.
  const conflict = await req(tx, {
    accId
  }).query(`SELECT TOP(1) p.name FROM dbo.room_period_rates r JOIN dbo.accommodation_rate_periods ar ON ar.id=r.accommodation_rate_period_id JOIN dbo.rate_periods p ON p.id=ar.rate_period_id JOIN dbo.room_period_rates r2 ON r2.room_type_id=r.room_type_id AND r2.id>r.id JOIN dbo.accommodation_rate_periods ar2 ON ar2.id=r2.accommodation_rate_period_id JOIN dbo.rate_periods p2 ON p2.id=ar2.rate_period_id WHERE ar.accommodation_id=@accId AND ar2.accommodation_id=@accId AND ar.priority=ar2.priority AND ar.is_active=1 AND ar2.is_active=1 AND p.deleted_at IS NULL AND p2.deleted_at IS NULL AND p.start_date<p2.end_date AND p2.start_date<p.end_date;`);
  if (conflict.recordset.length) throw error('Hai kỳ giá cùng ưu tiên bị chồng ngày trên cùng loại phòng. Hãy đổi ưu tiên hoặc gỡ cấu hình.', 409);
  const cells = await offers(tx, roomIds, dates(start, end, 1096));
  if (cells.some(c => c.effective_price <= 0)) throw error('Có giá sau điều chỉnh bằng 0 hoặc âm.');
  if (cells.some(c => c.booked > c.quantity)) throw error('Số phòng đã đặt vượt tổng phòng.');
  return cells;
}
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', previewKey).update(b).digest('hex');
}
function verify(token) {
  try {
    const [b, s] = String(token).split('.');
    const expected = crypto.createHmac('sha256', previewKey).update(b).digest('hex');
    if (!s || s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) throw 0;
    const p = JSON.parse(Buffer.from(b, 'base64url'));
    if (p.expires < Date.now()) throw 0;
    return p;
  } catch {
    throw error('Bản xem trước đã hết hạn. Vui lòng xem trước lại.', 409);
  }
}
async function upsert(tx, table, keys, values) {
  const all = {
    ...keys,
    ...values
  };
  const where = Object.keys(keys).map(k => `${k}=@${k}`).join(' AND ');
  await req(tx, all).query(`UPDATE dbo.${table} SET ${Object.keys(values).map(k => `${k}=@${k}`).join(',')} WHERE ${where}; IF @@ROWCOUNT=0 INSERT dbo.${table}(${Object.keys(all).join(',')}) VALUES(${Object.keys(all).map(k => '@' + k).join(',')});`);
}
const CONFLICT_ACTIONS=['increase_percent','decrease_percent','increase_amount','decrease_amount','period'];
function conflictPayload(body) {
  const {previewToken,conflictToken,conflictHandling,...payload}=body;
  return hash(payload);
}
function conflictResponse(body,user,fingerprint,conflicts,commit) {
  if(!body.conflictHandling || !CONFLICT_ACTIONS.includes(body.action) || !conflicts.length) return null;
  if(commit) {
    if(body.conflictHandling==='ask') throw error('Có điều chỉnh theo ngày mới phát sinh. Vui lòng xem trước và chọn cách xử lý.',409);
    return null; // The final preview token already binds the complete scope and selected policy.
  }
  if(body.conflictHandling!=='ask') {
    try {
      const token=verify(body.conflictToken);
      if(token.purpose==='pricing_conflicts' && token.uid===user.id && token.payload===conflictPayload(body) && token.state===fingerprint) return null;
    } catch { /* Present current conflicts again when the previous check is stale. */ }
  }
  const groups=new Map();
  for(const c of conflicts) {
    const key=`${c.accommodationId}:${c.roomTypeId}:${c.price}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(c);
  }
  const items=[];
  for(const rows of groups.values()) {
    rows.sort((a,b)=>a.date.localeCompare(b.date));
    let range=null;
    for(const row of rows) {
      if(range && shift(range.end,1)===row.date) range.end=row.date;
      else { range={...row,start:row.date,end:row.date};items.push(range); }
    }
  }
  items.sort((a,b)=>a.accommodationId-b.accommodationId || a.roomTypeId-b.roomTypeId || a.start.localeCompare(b.start));
  return { needsConflictResolution:true, refreshed:body.conflictHandling!=='ask',
    propertyCount:new Set(conflicts.map(c=>c.accommodationId)).size,
    roomCount:new Set(conflicts.map(c=>c.roomTypeId)).size,
    dateCount:new Set(conflicts.map(c=>c.date)).size,conflictCount:conflicts.length,items,
    conflictToken:sign({purpose:'pricing_conflicts',uid:user.id,payload:conflictPayload(body),state:fingerprint,expires:Date.now()+300000}) };
}
async function bulkChange(body, user, commit) {
  if (user.role !== 'ADMIN') throw error('Chỉ admin được cập nhật nhiều cơ sở.', 403);
  if(body.allRooms && !BULK_ACTIONS.includes(body.action)) throw error('Thao tác không còn hỗ trợ trong cập nhật hàng loạt.');
  const scope = body.propertyScope;
  if (!scope || !['single', 'all', 'multiple'].includes(scope.mode)) throw error('Phạm vi cơ sở không hợp lệ.');
  if (!Array.isArray(scope.ids) || (scope.mode === 'all' ? scope.ids.length !== 0 : scope.mode === 'single' ? scope.ids.length !== 1 : scope.ids.length < 1)) throw error('Chọn cơ sở theo một phạm vi duy nhất.');
  const requested = [...new Set(scope.ids.map(id))].sort((a,b) => a-b);
  if (!body.allRooms && (!Array.isArray(body.roomIds) || !body.roomIds.length)) throw error('Chọn ít nhất một loại phòng.');
  let roomIds = body.allRooms ? [] : [...new Set(body.roomIds.map(id))];
  const dayCount = dates(date(body.start), date(body.end), body.action==='remove_period'?1096:body.action==='period'?731:366).length;
  if (roomIds.length * dayCount > 120000) throw error('Phạm vi quá lớn. Hãy chia nhỏ khoảng ngày.');
  const tx = new sql.Transaction(getDBPool());
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await lock(tx);
    const properties = (await req(tx, { ids: JSON.stringify(requested), all: scope.mode === 'all' }).query(`SELECT id,accommodation_name AS name FROM dbo.accommodations
      WHERE deleted_at IS NULL AND (@all=1 OR id IN(SELECT value FROM OPENJSON(@ids))) ORDER BY id;`)).recordset;
    if (scope.mode !== 'all' && properties.length !== requested.length) throw error('Có cơ sở không còn tồn tại. Vui lòng chọn lại.', 409);
    const rooms = (await req(tx, { ids: JSON.stringify(properties.map(p => p.id)) }).query(`SELECT id,accommodation_id,name FROM dbo.room_types WHERE deleted_at IS NULL AND accommodation_id IN(SELECT value FROM OPENJSON(@ids)) ORDER BY id;`)).recordset;
    if(body.allRooms) roomIds=rooms.map(r=>r.id);
    if(roomIds.length*dayCount>120000) throw error('Phạm vi quá lớn. Hãy chia nhỏ khoảng ngày.');
    if (roomIds.some(r => !rooms.some(x => x.id === r))) throw error('Loại phòng nằm ngoài phạm vi cơ sở đã chọn.', 400);
    const { previewToken, propertyScope, ...rest } = body;
    const payload = { ...rest, propertyScope };
    if(body.conflictHandling && CONFLICT_ACTIONS.includes(body.action) && !commit) {
      const scans=[];
      for(const property of properties) {
        const selected=rooms.filter(r=>r.accommodation_id===property.id && roomIds.includes(r.id));
        if(!selected.length)continue;
        const scan=await change({...rest,accommodationId:property.id,roomIds:selected.map(r=>r.id)},user,false,tx,true,true);
        scans.push({...scan,property});
      }
      const snapshot=hash({properties,rooms,states:scans.map(s=>s.fingerprint)});
      const conflicts=scans.flatMap(s=>s.conflicts.map(c=>({...c,accommodationName:s.property.name})));
      const warning=conflictResponse(body,user,snapshot,conflicts,false);
      if(warning) {await tx.rollback();return warning;}
    }
    const results = [];
    const fingerprints=[];
    for (const property of properties) {
      const selected = rooms.filter(r => r.accommodation_id === property.id && roomIds.includes(r.id));
      if (!selected.length) continue;
      const result = await change({ ...rest, accommodationId: property.id, roomIds: selected.map(r => r.id) }, user, false, tx, true);
      fingerprints.push(result.fingerprint);
      if(!result.noop) results.push({ ...result, property });
    }
    if (!results.length) throw error(body.action==='remove_period'?'Không có kỳ giá đang áp dụng trong phạm vi đã chọn.':'Không có loại phòng phù hợp.');
    const fingerprint = hash({ properties, rooms, states: fingerprints });
    if (commit) {
      const token = verify(previewToken);
      if (token.uid !== user.id || token.payload !== hash(payload) || token.state !== fingerprint) throw error('Dữ liệu hoặc phạm vi đã thay đổi. Vui lòng xem trước lại.', 409);
    }
    const batchId = crypto.randomUUID();
    if(commit && body.action==='period') await req(tx,{periodId:id(body.periodId)}).query('UPDATE dbo.rate_periods SET first_applied_at=SYSUTCDATETIME() WHERE id=@periodId AND first_applied_at IS NULL;');
    if (commit) for (const r of results) await audit(tx,user,r.property.id,body.action,String(body.reason).trim(),r.before,r.after,batchId);
    const changes = results.flatMap(r => r.changes.map(c => ({ ...c, accommodationId: r.property.id, accommodationName: r.property.name, roomName: rooms.find(x => x.id === c.roomTypeId)?.name })));
    const periodOverlaps = results.flatMap(r => r.periodOverlaps.map(overlap => ({ ...overlap, accommodationId: r.property.id, accommodationName: r.property.name })));
    const summary = { changes: changes.slice(0,80), periodOverlaps, count: changes.length, ...changeCounts(changes), skipped: results.reduce((n,r) => n+r.skipped,0), propertyCount: results.length, roomCount: roomIds.length };
    if (commit) {
      await tx.commit();
      return { ...summary, batchId };
    }
    await tx.rollback();
    return { ...summary, previewToken: sign({ uid:user.id,payload:hash(payload),state:fingerprint,expires:Date.now()+300000 }) };
  } catch (e) {
    try { await tx.rollback(); } catch { /* transaction already ended */ }
    throw e;
  }
}
function changeCounts(changes) {
  const counts={changedCount:0,keptCount:0,unchangedCount:0};
  for(const c of changes) {
    const status=c.changeStatus || (c.oldPrice!==c.newPrice || c.oldSource!==c.newSource || c.oldAvailable!==c.newAvailable ? 'changed':'unchanged');
    counts[status==='kept_existing'?'keptCount':status==='changed'?'changedCount':'unchangedCount']++;
  }
  return counts;
}
function periodOverlapRanges(oldCells, newCells, periodId, rooms) {
  const groups = new Map();
  for (let i = 0; i < oldCells.length; i++) {
    const old = oldCells[i], current = newCells[i];
    if (!old.period_id || old.period_id === periodId || current.period_id !== periodId) continue;
    const key = `${old.room_type_id}:${old.period_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(old);
  }
  const ranges = [];
  for (const cells of groups.values()) {
    cells.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
    let range;
    for (const cell of cells) {
      if (range && shift(range.end, 1) === cell.stay_date) range.end = cell.stay_date;
      else {
        range = { roomTypeId: cell.room_type_id, roomName: rooms.find(r => r.id === cell.room_type_id)?.name, previousPeriodId: cell.period_id, previousPeriodName: cell.period_name, start: cell.stay_date, end: cell.stay_date };
        ranges.push(range);
      }
    }
  }
  return ranges;
}
async function change(body, user, commit = false, sharedTx = null, deferPeriodLock = false, scanOnly = false) {
  if (!sharedTx && Object.prototype.hasOwnProperty.call(body,'propertyScope')) return bulkChange(body,user,commit);
  if (!body.allRooms && !Array.isArray(body.roomIds)) throw error('Danh sách loại phòng không hợp lệ.');
  const accId = id(body.accommodationId),
    requestedRooms = body.allRooms ? [] : [...new Set(body.roomIds.map(id))];
  let roomIds=requestedRooms;
  if (!body.allRooms && (!roomIds.length || roomIds.length > 50)) throw error('Chọn từ 1 đến 50 loại phòng.');
  const reason = String(body.reason || '').trim();
  if (reason.length < 3 || reason.length > 500) throw error('Lý do phải từ 3 đến 500 ký tự.');
  const action = body.action;
  if(body.conflictHandling!==undefined && !['ask','keep','replace'].includes(body.conflictHandling)) throw error('Cách xử lý giá trùng không hợp lệ.');
  if(body.replaceDailyAdjustments!==undefined && typeof body.replaceDailyAdjustments!=='boolean') throw error('Lựa chọn thay thế điều chỉnh theo ngày không hợp lệ.');
  const keepOverrides=body.conflictHandling!==undefined ? body.conflictHandling!=='replace' : body.replaceDailyAdjustments===undefined ? body.skipOverrides!==false : !body.replaceDailyAdjustments;
  if(body.allRooms && !BULK_ACTIONS.includes(action)) throw error('Thao tác không còn hỗ trợ trong cập nhật hàng loạt.');
  if (!['fixed_price', 'increase_percent', 'decrease_percent', 'increase_amount', 'decrease_amount', 'restore', 'weekday', 'period','remove_period'].includes(action)) throw error('Thao tác không hợp lệ.');
  let start = date(body.start || today()),
    end = date(body.end || shift(start, 1));
  if (start < today() && !['period','remove_period'].includes(action)) throw error('Không được thay đổi ngày quá khứ.');
  if (start > shift(today(), 730) || end > shift(today(), 1096)) throw error('Chỉ cấu hình trong vòng 2 năm tới, tối đa đến 3 năm.');
  let dayList = dates(start, end, action==='remove_period'?1096:action==='period'?731:366);
  const selectedDays = body.allRooms ? [1,2,3,4,5,6,7] : body.weekdays || [1, 2, 3, 4, 5, 6, 7];
  if (!Array.isArray(selectedDays) || selectedDays.some(x => !Number.isInteger(x) || x < 1 || x > 7)) throw error('Thứ áp dụng không hợp lệ.');
  dayList = dayList.filter(d => selectedDays.includes(new Date(d).getUTCDay() || 7));
  if (!dayList.length) throw error('Không có ngày phù hợp.');
  const tx = sharedTx || new sql.Transaction(getDBPool());
  if (!sharedTx) await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await lock(tx);
    await access(tx, accId, user, true);
    if (commit && user.role === 'ACCOMMODATION_MANAGER' && !sharedTx) await req(tx).query('SAVE TRANSACTION manager_price_proposal;');
    const before = await state(tx, accId);
    if(body.allRooms) roomIds=before.rooms.map(r=>r.id);
    if(!roomIds.length) throw error('Cơ sở chưa có loại phòng.');
    if (roomIds.some(r => !before.rooms.some(x => x.id === r))) throw error('Loại phòng không thuộc cơ sở được phân công.', 404);
    let affectedRooms = roomIds;
    let periodVersion = null;
    if (action === 'period') {
      const p = (await req(tx, {
        p: id(body.periodId)
      }).query('SELECT start_date,end_date,CONVERT(varchar(18),version,1) AS versionToken FROM dbo.rate_periods WHERE id=@p AND deleted_at IS NULL;')).recordset[0];
      if (!p) throw error('Kỳ giá không tồn tại.', 404);
      const periodStart = p.start_date.toISOString().slice(0, 10),
        periodEnd = p.end_date.toISOString().slice(0, 10);
      periodVersion = p.versionToken;
      if(body.catalogPeriod && (body.start!==periodStart || body.end!==periodEnd)) throw error('Ngày áp dụng phải trùng với thời gian của kỳ giá.');
      dayList = dates(periodStart < today() ? today() : periodStart, periodEnd, 731);
      start=periodStart<today()?today():periodStart;
      end=periodEnd;
      affectedRooms = [...new Set([...roomIds, ...before.periodConfigs.filter(c => c.rate_period_id === Number(body.periodId) && c.room_type_id).map(c => c.room_type_id)])].sort((a, b) => a - b);
    }
    let removedConfigs=[];
    if(action==='remove_period') {
      removedConfigs=before.periodConfigs.filter(c=>c.room_type_id && roomIds.includes(c.room_type_id) && c.is_active && !c.deleted_at && c.end_date.toISOString().slice(0,10)>today() && (!body.periodId || c.rate_period_id===id(body.periodId)));
      if(!removedConfigs.length) {
        if(!sharedTx) throw error('Cơ sở chưa áp dụng kỳ giá phù hợp.');
        dayList=[];
      } else {
        const starts=removedConfigs.map(c=>c.start_date.toISOString().slice(0,10));
        const ends=removedConfigs.map(c=>c.end_date.toISOString().slice(0,10));
        start=starts.sort()[0]; if(start<today())start=today();
        end=ends.sort().at(-1); dayList=dates(start,end,1096);
      }
    }
    const oldCells = await offers(tx, affectedRooms, dayList),
      fingerprint = hash({
        before,
        // This derived field must not invalidate proposals submitted before the UI update.
        oldCells: oldCells.map(cell => { const snapshot={...cell}; delete snapshot.rule_price; return snapshot; }),
        periodVersion
      });
    const {
      previewToken,
      ...payload
    } = body;
    const conflicts=CONFLICT_ACTIONS.includes(action)?oldCells.filter(c=>c.price_source==='override').map(c=>({accommodationId:accId,roomTypeId:c.room_type_id,roomName:before.rooms.find(r=>r.id===c.room_type_id)?.name,date:c.stay_date,price:c.effective_price})):[];
    if(scanOnly) return {fingerprint,conflicts};
    if(!sharedTx) {
      const warning=conflictResponse(body,user,fingerprint,conflicts,commit);
      if(warning) {
        const property=(await req(tx,{accId}).query('SELECT accommodation_name AS name FROM dbo.accommodations WHERE id=@accId;')).recordset[0];
        warning.items=warning.items.map(c=>({...c,accommodationName:property.name}));
        await tx.rollback();return warning;
      }
    }
    if (commit) {
      const p = verify(previewToken);
      if (p.uid !== user.id || p.payload !== hash(payload) || p.state !== fingerprint) throw error('Dữ liệu đã thay đổi từ lần xem trước. Vui lòng tải lại và xem trước.', 409);
    }
    const uid = user.id;
    let validateStart = start,
      validateEnd = end;
    if(action==='remove_period') {
      for(const c of removedConfigs) await req(tx,{configId:c.id,room:c.room_type_id}).query('DELETE dbo.room_period_rates WHERE accommodation_rate_period_id=@configId AND room_type_id=@room;');
      await req(tx,{accId}).query('DELETE ar FROM dbo.accommodation_rate_periods ar WHERE ar.accommodation_id=@accId AND NOT EXISTS(SELECT 1 FROM dbo.room_period_rates r WHERE r.accommodation_rate_period_id=ar.id);');
    } else if (action === 'weekday') {
      if (!Array.isArray(body.prices) || body.prices.length !== 7) throw error('Cần đủ 7 giá trong tuần.');
      for (const room of roomIds) for (let d = 1; d <= 7; d++) await upsert(tx, 'room_weekday_rate_schedules', {
        room_type_id: room,
        effective_from: start,
        day_of_week: d
      }, {
        price: money(body.prices[d - 1]),
        updated_by_user_id: uid,
        updated_at: new Date()
      });
      validateEnd = shift(today(), 1096);
    } else if (action === 'period') {
      const p = (await req(tx, {
        p: id(body.periodId)
      }).query('SELECT * FROM dbo.rate_periods WHERE id=@p AND deleted_at IS NULL;')).recordset[0];
      if (!p) throw error('Kỳ giá không tồn tại.', 404);
      const pidNum = Number(p.id);
      const priority = Number(body.catalogPeriod ? Math.min(1000,Math.max(0,...before.periodConfigs.filter(c=>c.rate_period_id!==pidNum).map(c=>c.priority))+1) : body.priority ?? 50);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw error('Ưu tiên từ 0 đến 1000.');
      let adjustmentType=body.adjustmentType;
      if(body.catalogPeriod) {
        if(!['increase','decrease'].includes(p.adjustment_direction)) throw error('Kỳ giá chưa chọn tăng hoặc giảm. Hãy cập nhật kỳ giá trước.');
        adjustmentType=p.adjustment_direction+(Number(body.value)<=100?'_percent':'_amount');
      }
      if (!TYPES.includes(adjustmentType)) throw error('Loại điều chỉnh không hợp lệ.');
      const value = money(body.value, adjustmentType !== 'fixed_price');
      if (adjustmentType === 'decrease_percent' && value >= 100) throw error('Phần trăm giảm phải nhỏ hơn 100.');
      await upsert(tx, 'accommodation_rate_periods', {
        accommodation_id: accId,
        rate_period_id: pidNum
      }, {
        priority,
        is_active: body.active !== false,
        updated_by_user_id: uid,
        updated_at: new Date()
      });
      const ar = Number((await req(tx, {
        accId,
        p: pidNum
      }).query('SELECT id FROM dbo.accommodation_rate_periods WHERE accommodation_id=@accId AND rate_period_id=@p;')).recordset[0].id);
      for (const room of roomIds) {
        if (body.remove) await req(tx, {
          ar,
          room
        }).query('DELETE dbo.room_period_rates WHERE accommodation_rate_period_id=@ar AND room_type_id=@room;');else await upsert(tx, 'room_period_rates', {
          accommodation_rate_period_id: ar,
          room_type_id: room
        }, {
          adjustment_type: adjustmentType,
          adjustment_value: value,
          updated_by_user_id: uid,
          updated_at: new Date()
        });
      }
      validateStart = p.start_date.toISOString().slice(0, 10);
      validateEnd = p.end_date.toISOString().slice(0, 10);
      if (validateStart < today()) validateStart = today();
      if (validateEnd <= validateStart) throw error('Kỳ giá đã kết thúc.');
      if(!deferPeriodLock) await req(tx,{periodId:pidNum}).query(`UPDATE p SET first_applied_at=SYSUTCDATETIME() FROM dbo.rate_periods p WHERE p.id=@periodId AND p.first_applied_at IS NULL AND EXISTS(SELECT 1 FROM dbo.accommodation_rate_periods ar WHERE ar.rate_period_id=p.id AND ar.is_active=1 AND EXISTS(SELECT 1 FROM dbo.room_period_rates r WHERE r.accommodation_rate_period_id=ar.id));`);
      if(body.catalogPeriod && !keepOverrides) for(const room of roomIds) for(const day of dayList) await req(tx,{room,day}).query('DELETE dbo.room_daily_rate_overrides WHERE room_type_id=@room AND stay_date=@day;');
    } else {
      for (const cell of oldCells) {
        const keys = {
          room_type_id: cell.room_type_id,
          stay_date: cell.stay_date
        };
        if (keepOverrides && cell.price_source === 'override' && TYPES.includes(action)) continue;
        if (action === 'restore') await req(tx, keys).query('DELETE dbo.room_daily_rate_overrides WHERE room_type_id=@room_type_id AND stay_date=@stay_date;');else {
          const v = money(body.value, action !== 'fixed_price');
          if (action === 'decrease_percent' && v >= 100) throw error('Phần trăm giảm phải nhỏ hơn 100.');
          // A replacement starts from the weekly/period price, preventing repeated compounding.
          const base=cell.price_source==='override' ? cell.rule_price : cell.effective_price;
          const p = action === 'fixed_price' ? v : action === 'increase_percent' ? base * (1 + v / 100) : action === 'decrease_percent' ? base * (1 - v / 100) : action === 'increase_amount' ? base + v : base - v;
          await upsert(tx, 'room_daily_rate_overrides', keys, {
            price: money(Math.round(p * 100) / 100),
            reason,
            updated_by_user_id: uid,
            updated_at: new Date()
          });
        }
      }
    }
    await validate(tx, accId, affectedRooms, validateStart, validateEnd);
    const after = await state(tx, accId),
      newCells = await offers(tx, affectedRooms, dayList);
    const periodOverlaps = action === 'period' ? periodOverlapRanges(oldCells, newCells, Number(body.periodId), before.rooms) : [];
    const changes = newCells.map((c, i) => ({
      roomTypeId: c.room_type_id,
      roomName: before.rooms.find(r=>r.id===c.room_type_id)?.name,
      date: c.stay_date,
      oldPrice: oldCells[i].effective_price,
      newPrice: c.effective_price,
      oldAvailable: oldCells[i].available_to_sell,
      newAvailable: c.available_to_sell,
      oldSource: oldCells[i].price_source,
      newSource: c.price_source,
      changeStatus:keepOverrides && oldCells[i].price_source==='override' && (TYPES.includes(action)||action==='period') ? 'kept_existing' : c.effective_price!==oldCells[i].effective_price || c.price_source!==oldCells[i].price_source || c.available_to_sell!==oldCells[i].available_to_sell ? 'changed' : 'unchanged',
      stopSell: c.stop_sell
    }));
    if (sharedTx) return { before, after, fingerprint, changes, periodOverlaps, noop:action==='remove_period'&&!removedConfigs.length, skipped: oldCells.filter(c => keepOverrides && c.price_source === 'override' && TYPES.includes(action)).length };
    if (commit && user.role === 'ACCOMMODATION_MANAGER') {
      // Keep the validation and proposal insertion atomic without publishing tentative prices.
      await req(tx).query('ROLLBACK TRANSACTION manager_price_proposal;');
      const {conflictToken,...proposalPayload}=payload;
      const duplicate = await req(tx,{accId,uid:user.id,payload:JSON.stringify(proposalPayload)}).query(`SELECT TOP(1) id FROM dbo.pricing_proposals WHERE accommodation_id=@accId AND requested_by_user_id=CONVERT(uniqueidentifier,@uid) AND status='PENDING' AND payload_json=@payload;`);
      if (duplicate.recordset.length) throw error('Đề xuất này đã được gửi và đang chờ duyệt.',409);
      const proposal = await req(tx,{accId,uid:user.id,payload:JSON.stringify(proposalPayload),fingerprint,changes:JSON.stringify(changes.map(c=>({...c,roomName:before.rooms.find(r=>r.id===c.roomTypeId)?.name}))),reason}).query(`INSERT dbo.pricing_proposals(accommodation_id,requested_by_user_id,payload_json,base_fingerprint,changes_json,reason) OUTPUT inserted.id VALUES(@accId,CONVERT(uniqueidentifier,@uid),@payload,@fingerprint,@changes,@reason);`);
      await tx.commit();
      return { proposalId:proposal.recordset[0].id,status:'PENDING',count:changes.length };
    }
    if (commit) {
      const batchId = await audit(tx, user, accId, action, reason, before, after);
      await tx.commit();
      return {
        batchId,
        changes,
        periodOverlaps,
        ...changeCounts(changes),
        count: changes.length
      };
    }
    await tx.rollback();
    return {
      previewToken: sign({
        uid: user.id,
        payload: hash(payload),
        state: fingerprint,
        expires: Date.now() + 300000
      }),
      changes,
      periodOverlaps,
      ...changeCounts(changes),
      count: changes.length,
      skipped: oldCells.filter(c => keepOverrides && c.price_source === 'override' && TYPES.includes(action)).length
    };
  } catch (e) {
    if (sharedTx) throw e;
    try {
      await tx.rollback();
    } catch {/* transaction already ended */}
    throw e;
  }
}
async function savePeriod(body, user, periodId = null, remove = false) {
  if (user.role !== 'ADMIN') throw error('Chỉ admin được quản lý danh mục kỳ giá dùng chung.', 403);
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) throw error('Kỳ giá không còn trạng thái bật/tắt toàn hệ thống. Vui lòng tải lại biểu mẫu.');
  const tx = new sql.Transaction(getDBPool());
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await lock(tx);
    const before = periodId ? (await req(tx, {
      id: id(periodId)
    }).query('SELECT *,CONVERT(varchar(18),version,1) AS versionToken FROM dbo.rate_periods WHERE id=@id AND deleted_at IS NULL;')).recordset[0] : null;
    if (periodId && !before) throw error('Không tìm thấy kỳ giá.', 404);
    if (before?.first_applied_at) throw error('Kỳ giá đã được áp dụng nên không thể sửa hoặc xóa.', 409);
    if (before && body.versionToken !== before.versionToken) throw error('Kỳ giá đã thay đổi. Vui lòng tải lại.', 409);
    if (remove) {
      await req(tx, {
        id: id(periodId),
        uid: user.id
      }).query('UPDATE dbo.rate_periods SET deleted_at=SYSUTCDATETIME(),updated_by_user_id=@uid,updated_at=SYSUTCDATETIME() WHERE id=@id;');
      const accs = (await req(tx, {
        id: periodId
      }).query('SELECT DISTINCT accommodation_id FROM dbo.accommodation_rate_periods WHERE rate_period_id=@id;')).recordset;
      const start = before.start_date.toISOString().slice(0, 10),
        end = before.end_date.toISOString().slice(0, 10);
      if (end > today()) for (const a of accs) {
        const s = await state(tx, a.accommodation_id);
        await validate(tx, a.accommodation_id, s.rooms.map(r => r.id), start < today() ? today() : start, end);
      }
    } else {
      const name = String(body.name || '').trim(),
        start = date(body.start_date),
        end = date(body.end_date);
      dates(start, end, 731);
      if (!name || name.length > 200) throw error('Tên kỳ giá từ 1 đến 200 ký tự.');
      if (end <= today() || end > shift(today(), 1096) || start > shift(today(), 730)) throw error('Kỳ phải bắt đầu trong vòng 2 năm, còn hiệu lực và kết thúc trong vòng 3 năm.');
      const p = {
        name,
        start,
        end,
        direction: body.adjustment_direction,
        description: String(body.description || '').slice(0, 1000),
        uid: user.id
      };
      if(!['increase','decrease'].includes(p.direction)) throw error('Chọn tăng giá hoặc giảm giá cho kỳ giá.');
      if (before) await req(tx, {
        ...p,
        id: id(periodId)
      }).query('UPDATE dbo.rate_periods SET name=@name,start_date=@start,end_date=@end,adjustment_direction=@direction,description=@description,updated_by_user_id=@uid,updated_at=SYSUTCDATETIME() WHERE id=@id;');else periodId = Number((await req(tx, p).query('INSERT dbo.rate_periods(name,start_date,end_date,adjustment_direction,description,created_by_user_id) OUTPUT inserted.id VALUES(@name,@start,@end,@direction,@description,@uid);')).recordset[0].id);
      const accs = (await req(tx, {
        id: periodId
      }).query('SELECT DISTINCT accommodation_id FROM dbo.accommodation_rate_periods WHERE rate_period_id=@id;')).recordset;
      for (const a of accs) {
        const s = await state(tx, a.accommodation_id);
        await validate(tx, a.accommodation_id, s.rooms.map(r => r.id), start < today() ? today() : start, end);
      }
    }
    const after = (await req(tx, {
      id: periodId
    }).query('SELECT CAST(id AS int) AS id,name,start_date,end_date,adjustment_direction,description,deleted_at FROM dbo.rate_periods WHERE id=@id;')).recordset[0];
    const affected = (await req(tx, {
      id: periodId
    }).query('SELECT DISTINCT accommodation_id FROM dbo.accommodation_rate_periods WHERE rate_period_id=@id;')).recordset;
    const batch = crypto.randomUUID();
    for (const acc of affected.length ? affected : [{
      accommodation_id: null
    }]) await audit(tx, user, acc.accommodation_id, remove ? 'archive_period' : before ? 'update_period' : 'create_period', String(body.reason || 'Quản lý kỳ giá dùng chung').slice(0, 500), before, after, batch);
    await tx.commit();
    return {
      id: Number(periodId)
    };
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    throw e;
  }
}
async function proposals(query,user) {
  if (!['ADMIN','ACCOMMODATION_MANAGER'].includes(user.role)) throw error('Bạn không có quyền xem đề xuất giá.',403);
  const accId=query.accommodationId?id(query.accommodationId):null;
  if(accId) await access(getDBPool(),accId,user);
  const status=query.status||'PENDING';
  if(!['ALL','PENDING','APPROVED','REJECTED'].includes(status)) throw error('Trạng thái không hợp lệ.');
  const beforeId=String(query.beforeId||'9223372036854775807');
  if(!/^[1-9]\d{0,18}$/.test(beforeId)||BigInt(beforeId)>9223372036854775807n) throw error('Mốc đề xuất không hợp lệ.');
  const scope=`(@accId IS NULL OR p.accommodation_id=@accId) ${user.role==='ADMIN'?'':`AND p.requested_by_user_id=CONVERT(uniqueidentifier,@uid) AND EXISTS(SELECT 1 FROM dbo.accommodation_managers m WHERE m.accommodation_id=p.accommodation_id AND m.user_id=CONVERT(uniqueidentifier,@uid))`}`;
  const r=await req(getDBPool(),{accId,uid:user.id,status,beforeId}).query(`SELECT TOP(51) p.*,CONVERT(varchar(18),p.version,1) AS versionToken,a.accommodation_name AS accommodationName,u.full_name AS requestedByName,v.full_name AS reviewedByName
    FROM dbo.pricing_proposals p JOIN dbo.accommodations a ON a.id=p.accommodation_id JOIN dbo.users u ON u.id=p.requested_by_user_id LEFT JOIN dbo.users v ON v.id=p.reviewed_by_user_id
    WHERE ${scope} AND (@status='ALL' OR p.status=@status) AND p.id<CONVERT(bigint,@beforeId) ORDER BY p.id DESC;
    SELECT status,COUNT_BIG(*) AS n FROM dbo.pricing_proposals p WHERE ${scope} GROUP BY status;`);
  const counts={PENDING:0,APPROVED:0,REJECTED:0,ALL:0};
  for(const row of r.recordsets[1]) { counts[row.status]=Number(row.n); counts.ALL+=Number(row.n); }
  return { items:r.recordset.slice(0,50).map(p=>{
    const changes=JSON.parse(p.changes_json);
    const {payload_json,changes_json,base_fingerprint,version,...visible}=p;
    return {...visible,payload:JSON.parse(payload_json),changes:changes.slice(0,80),count:changes.length,...changeCounts(changes)};
  }),hasMore:r.recordset.length>50,counts };
}
async function reviewProposal(proposalId,body,user,decision='preview') {
  if(user.role!=='ADMIN') throw error('Chỉ admin được duyệt đề xuất giá.',403);
  if(!['preview','approve','reject'].includes(decision)) throw error('Thao tác duyệt không hợp lệ.');
  const pid=String(proposalId);
  if(!/^[1-9]\d{0,18}$/.test(pid)||BigInt(pid)>9223372036854775807n) throw error('Mã đề xuất không hợp lệ.');
  const tx=new sql.Transaction(getDBPool());
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await lock(tx);
    const p=(await req(tx,{pid}).query(`SELECT *,CONVERT(varchar(18),version,1) AS versionToken FROM dbo.pricing_proposals WITH(UPDLOCK,HOLDLOCK) WHERE id=CONVERT(bigint,@pid);`)).recordset[0];
    if(!p) throw error('Không tìm thấy đề xuất.',404);
    if(p.status!=='PENDING') throw error('Đề xuất đã được xử lý.',409);
    if(body.versionToken!==p.versionToken) throw error('Đề xuất đã thay đổi. Vui lòng tải lại.',409);
    if(decision==='reject') {
      const reason=String(body.reason||'').trim();
      if(reason.length<3||reason.length>500) throw error('Lý do từ chối phải từ 3 đến 500 ký tự.');
      await req(tx,{pid,uid:user.id,reason}).query(`UPDATE dbo.pricing_proposals SET status='REJECTED',reviewed_by_user_id=CONVERT(uniqueidentifier,@uid),review_reason=@reason,reviewed_at=SYSUTCDATETIME() WHERE id=CONVERT(bigint,@pid);`);
      await tx.commit();
      return {status:'REJECTED'};
    }
    const manager=(await req(tx,{uid:p.requested_by_user_id}).query("SELECT id,role FROM dbo.users WHERE id=CONVERT(uniqueidentifier,@uid) AND role='ACCOMMODATION_MANAGER' AND status=1;")).recordset[0];
    if(!manager) throw error('Manager gửi đề xuất không còn hoạt động.',409);
    const result=await change(JSON.parse(p.payload_json),manager,false,tx);
    if(result.fingerprint!==p.base_fingerprint) throw error('Giá hoặc dữ liệu cơ sở đã thay đổi từ lúc gửi đề xuất. Manager cần gửi đề xuất mới.',409);
    if(decision==='preview') {
      await tx.rollback();
      return {changes:result.changes.slice(0,80).map(c=>({...c,roomName:result.before.rooms.find(r=>r.id===c.roomTypeId)?.name})),count:result.changes.length,...changeCounts(result.changes),approvalToken:sign({purpose:'approve_proposal',uid:user.id,pid,version:p.versionToken,state:result.fingerprint,expires:Date.now()+300000})};
    }
    const token=verify(body.approvalToken);
    if(token.purpose!=='approve_proposal'||token.uid!==user.id||token.pid!==pid||token.version!==p.versionToken||token.state!==result.fingerprint) throw error('Bản kiểm tra duyệt không hợp lệ. Vui lòng kiểm tra lại.',409);
    const batchId=await audit(tx,user,p.accommodation_id,'approve_price_proposal',`Duyệt đề xuất #${pid}: ${p.reason}`.slice(0,500),result.before,result.after);
    await req(tx,{pid,uid:user.id,batchId}).query(`UPDATE dbo.pricing_proposals SET status='APPROVED',reviewed_by_user_id=CONVERT(uniqueidentifier,@uid),reviewed_at=SYSUTCDATETIME(),applied_batch_id=CONVERT(uniqueidentifier,@batchId) WHERE id=CONVERT(bigint,@pid);`);
    await tx.commit();
    return {status:'APPROVED',batchId};
  } catch(e) {
    try {await tx.rollback();} catch { /* transaction already ended */ }
    throw e;
  }
}
async function history(query, user) {
  const db = getDBPool();
  const accId = query.accommodationId ? id(query.accommodationId) : null;
  if (accId) await access(db, accId, user);
  const range = query.range || 'all';
  if (!['all', 'today', 'week', 'month', 'custom'].includes(range)) throw error('Bộ lọc thời gian không hợp lệ.');
  const currentDay = today();
  let start = null, end = null;
  if (range === 'custom') {
    start = date(query.start);
    end = date(query.end || query.start);
    if (end < start) throw error('Ngày kết thúc phải từ ngày bắt đầu trở đi.');
    end = shift(end, 1);
  } else if (range !== 'all') {
    start = shift(currentDay, range === 'week' ? -6 : range === 'month' ? -29 : 0);
    end = shift(currentDay, 1);
  }
  const utc = d => d ? new Date(`${d}T00:00:00+07:00`) : null;
  const beforeId = String(query.beforeId || '9223372036854775807');
  if (!/^[1-9]\d{0,18}$/.test(beforeId) || BigInt(beforeId) > 9223372036854775807n) throw error('Mốc lịch sử không hợp lệ.');
  // Scope counts and rows identically, including when a manager selects all properties.
  const scope = `(@accId IS NULL OR l.accommodation_id=@accId) ${user.role === 'ADMIN' ? '' : `AND EXISTS(SELECT 1 FROM dbo.accommodation_managers m WHERE m.accommodation_id=l.accommodation_id AND m.user_id=CONVERT(uniqueidentifier,@uid))`}`;
  const timeFilter = '(@startAt IS NULL OR l.created_at>=@startAt) AND (@endAt IS NULL OR l.created_at<@endAt)';
  const result = await req(db, {
    accId,
    uid: user.id, beforeId,
    startAt: utc(start), endAt: utc(end),
    todayAt: utc(currentDay), tomorrowAt: utc(shift(currentDay, 1)),
    weekAt: utc(shift(currentDay, -6)), monthAt: utc(shift(currentDay, -29))
  }).query(`SELECT TOP(${query.includeSummary === 'true' ? 51 : 50}) l.*,u.full_name AS actorName,a.accommodation_name AS accommodationName
    FROM dbo.pricing_inventory_audit_logs l JOIN dbo.users u ON u.id=l.actor_user_id
    LEFT JOIN dbo.accommodations a ON a.id=l.accommodation_id
    WHERE ${scope} AND ${timeFilter} AND l.id<CONVERT(bigint,@beforeId) ORDER BY l.id DESC;
    ${query.includeSummary === 'true' ? `SELECT COUNT_BIG(*) AS [all],
      COUNT_BIG(CASE WHEN l.created_at>=@todayAt AND l.created_at<@tomorrowAt THEN 1 END) AS today,
      COUNT_BIG(CASE WHEN l.created_at>=@weekAt AND l.created_at<@tomorrowAt THEN 1 END) AS week,
      COUNT_BIG(CASE WHEN l.created_at>=@monthAt AND l.created_at<@tomorrowAt THEN 1 END) AS month,
      COUNT_BIG(CASE WHEN ${timeFilter} THEN 1 END) AS filtered
      FROM dbo.pricing_inventory_audit_logs l WHERE ${scope};` : ''}`);
  if (query.includeSummary !== 'true') return result.recordset;
  const counts = result.recordsets[1][0];
  return { items: result.recordset.slice(0, 50), hasMore: result.recordset.length > 50, counts };
}
module.exports = {
  proposals,
  reviewProposal,
  bootstrap,
  calendar,
  change,
  savePeriod,
  history,
  offers,
  state,
  validate,
  today,
  dates,
  shift,
  error,
  lock,
  access,
  audit
};
