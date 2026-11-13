const {
  test,
  before,
  after
} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('dotenv').config({
  quiet: true
});
const enabled = process.env.RUN_DB_PRICING_TESTS === '1';
let sql, db, pool, RealRequest, RealTransaction, active, service, admin, manager, accId, roomId, otherRoomId;
before(async () => {
  if (!enabled) return;
  db = require('../configs/database');
  sql = db.sqlObj;
  pool = await db.connectDB();
  RealRequest = sql.Request;
  RealTransaction = sql.Transaction;
  class SavepointTransaction {
    constructor() {
      this.name = 'pricing_' + crypto.randomBytes(6).toString('hex');
    }
    async begin() {
      await new RealRequest(active).query(`SAVE TRANSACTION ${this.name};`);
    }
    async commit() {}
    async rollback() {
      await new RealRequest(active).query(`ROLLBACK TRANSACTION ${this.name};`);
    }
  }
  class TestRequest extends RealRequest {
    constructor() {
      super(active);
    }
  }
  sql.Transaction = SavepointTransaction;
  sql.Request = TestRequest;
  db.getDBPool = () => ({
    request: () => new RealRequest(active)
  });
  service = require('../services/pricing_service');
});
after(async () => {
  if (enabled) {
    sql.Request = RealRequest;
    sql.Transaction = RealTransaction;
    await pool.close();
  }
});
async function fixture(run) {
  active = new RealTransaction(pool);
  await active.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const r = await new RealRequest(active).query(`SELECT TOP(1) id,role FROM dbo.users WHERE role='ADMIN' AND status=1;
   SELECT TOP(1) m.accommodation_id,m.user_id,rt.id AS room_id FROM dbo.accommodation_managers m JOIN dbo.room_types rt ON rt.accommodation_id=m.accommodation_id JOIN dbo.accommodations a ON a.id=m.accommodation_id WHERE rt.status=1 AND rt.deleted_at IS NULL AND a.deleted_at IS NULL ORDER BY rt.id;
   SELECT TOP(1) id,accommodation_id FROM dbo.room_types WHERE deleted_at IS NULL ORDER BY id DESC;`);
    admin = r.recordsets[0][0];
    const f = r.recordsets[1][0];
    assert.ok(f && admin);
    manager = {
      id: f.user_id,
      role: 'ACCOMMODATION_MANAGER'
    };
    accId = f.accommodation_id;
    roomId = f.room_id;
    otherRoomId = r.recordsets[2][0].id;
    await run();
  } finally {
    await active.rollback();
    active = null;
  }
}
function dbTest(name, fn) {
  test(name, {
    skip: !enabled
  }, () => fixture(fn));
}
function body(extra = {}) {
  const start = service.shift(service.today(), 30);
  return {
    accommodationId: accId,
    roomIds: [roomId],
    start,
    end: service.shift(start, 3),
    reason: 'Integration test rollback',
    action: 'fixed_price',
    value: 1234567,
    skipOverrides: false,
    ...extra
  };
}
async function bulkBody(extra = {}) {
  const other = (await new RealRequest(active).input('accId',sql.Int,accId).query(`SELECT TOP(1) rt.id,rt.accommodation_id FROM dbo.room_types rt JOIN dbo.accommodations a ON a.id=rt.accommodation_id WHERE rt.accommodation_id<>@accId AND rt.status=1 AND rt.deleted_at IS NULL AND a.deleted_at IS NULL ORDER BY rt.id DESC;`)).recordset[0];
  assert.ok(other);
  return body({ roomIds:[roomId,other.id],propertyScope:{mode:'multiple',ids:[accId,other.accommodation_id]},...extra });
}
dbTest('conflict check only warns for overlapping daily prices and never publishes tentative rates',async()=>{
  const b=body({allRooms:true,action:'increase_percent',value:10,conflictHandling:'ask'});
  const clean=await service.change(b,admin);
  assert.ok(clean.previewToken);assert.ok(!clean.needsConflictResolution);
  await apply(body({end:service.shift(b.start,2),value:1234567}),admin);
  await apply(body({start:service.shift(b.start,5),end:service.shift(b.start,6),value:2222222}),admin);
  const before=await cells(b);
  const warning=await service.change(b,admin);
  assert.equal(warning.needsConflictResolution,true);assert.equal(warning.propertyCount,1);assert.equal(warning.roomCount,1);
  assert.equal(warning.conflictCount,2);assert.equal(warning.dateCount,2);assert.equal(warning.items.length,1);
  assert.equal(warning.items[0].start,b.start);assert.equal(warning.items[0].end,service.shift(b.start,1));
  assert.ok(warning.items[0].accommodationName&&warning.items[0].roomName);
  assert.ok(!warning.previewToken);assert.deepEqual(await cells(b),before);
  await assert.rejects(service.change(b,admin,true),e=>e.statusCode===409);
});
dbTest('conflict keep and replace choices require a current check and remain bound to the final preview',async()=>{
  const b=body({allRooms:true,action:'increase_percent',value:10,conflictHandling:'ask'});
  const baseline=await cells(b);
  await apply(body({end:service.shift(b.start,2),value:1234567}),admin);
  const warning=await service.change(b,admin);
  const unchecked=await service.change({...b,conflictHandling:'keep'},admin);
  assert.equal(unchecked.needsConflictResolution,true);
  const keep={...b,conflictHandling:'keep',conflictToken:warning.conflictToken};
  const preview=await service.change(keep,admin);
  assert.ok(preview.previewToken);assert.equal(preview.keptCount,2);
  await assert.rejects(service.change({...keep,conflictHandling:'replace',previewToken:preview.previewToken},admin,true),e=>e.statusCode===409);
  await service.change({...keep,previewToken:preview.previewToken},admin,true);
  assert.equal((await cells(b))[0].effective_price,1234567);
  const currentWarning=await service.change(b,admin);
  const replace={...b,conflictHandling:'replace',conflictToken:currentWarning.conflictToken};
  const replacement=await service.change(replace,admin);
  await service.change({...replace,previewToken:replacement.previewToken},admin,true);
  assert.ok((await cells(b)).every((c,i)=>c.effective_price===Math.round(baseline[i].rule_price*1.1*100)/100));
});
dbTest('conflict warning refreshes when dates or prices change before a choice',async()=>{
  const b=body({allRooms:true,action:'decrease_amount',value:10000,conflictHandling:'ask'});
  await apply(body({end:service.shift(b.start,1),value:1234567}),admin);
  const warning=await service.change(b,admin);
  await apply(body({start:service.shift(b.start,1),end:service.shift(b.start,2),value:765432}),admin);
  const old=await cells(b);
  const stale=await service.change({...b,conflictHandling:'replace',conflictToken:warning.conflictToken},admin);
  assert.equal(stale.needsConflictResolution,true);assert.equal(stale.refreshed,true);assert.equal(stale.conflictCount,2);
  assert.deepEqual(await cells(b),old);
  const changedPayload=await service.change({...b,value:20000,conflictHandling:'keep',conflictToken:stale.conflictToken},admin);
  assert.equal(changedPayload.needsConflictResolution,true);
  await assert.rejects(service.change({...b,conflictHandling:'unknown'},admin),e=>e.statusCode===400);
});
dbTest('bulk special-period conflicts cover every chosen property and preserve or replace only matching dates',async()=>{
  const b=await bulkBody();
  await apply(body({end:service.shift(b.start,2),value:1234567}),admin);
  await apply(body({accommodationId:b.propertyScope.ids[1],roomIds:[b.roomIds[1]],end:service.shift(b.start,1),value:2345678}),admin);
  const p=await service.savePeriod({name:'Conflict period',start_date:b.start,end_date:b.end,adjustment_direction:'increase'},admin);
  const payload={...b,allRooms:true,action:'period',catalogPeriod:true,periodId:p.id,value:20,conflictHandling:'ask'};
  const warning=await service.change(payload,admin);
  assert.equal(warning.propertyCount,2);assert.equal(warning.conflictCount,3);
  assert.equal((await service.bootstrap(admin)).periods.find(x=>x.id===p.id).first_applied_at,null);
  const keep={...payload,conflictHandling:'keep',conflictToken:warning.conflictToken};
  const preview=await service.change(keep,admin);assert.equal(preview.keptCount,3);
  await service.change({...keep,previewToken:preview.previewToken},admin,true);
  assert.equal((await cells(b))[0].effective_price,1234567);
  const next=await service.change(payload,admin);
  const replace={...payload,conflictHandling:'replace',conflictToken:next.conflictToken};
  const checked=await service.change(replace,admin);
  await service.change({...replace,previewToken:checked.previewToken},admin,true);
  assert.ok((await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end))).every(c=>c.price_source==='period'));
});
dbTest('manager conflict choices are submitted for approval without saving temporary check tokens',async()=>{
  const b=body({allRooms:true,action:'decrease_percent',value:10,conflictHandling:'ask'});
  await apply(body({value:1234567}),admin);
  const before=await cells(b);
  const warning=await service.change(b,manager);
  const choice={...b,conflictHandling:'replace',conflictToken:warning.conflictToken};
  const preview=await service.change(choice,manager);
  const saved=await service.change({...choice,previewToken:preview.previewToken},manager,true);
  assert.equal(saved.status,'PENDING');assert.deepEqual(await cells(b),before);
  const row=await proposalRow(saved.proposalId);const payload=JSON.parse(row.payload_json);
  assert.equal(payload.conflictHandling,'replace');assert.ok(!payload.conflictToken);
  await approveProposal(saved.proposalId);
  assert.ok((await cells(b)).every(c=>c.effective_price===Math.round(c.rule_price*.9*100)/100));
});
dbTest('daily adjustments keep existing dates by default and preview counts cover every selected room',async()=>{
  const b=body({allRooms:true,action:'increase_percent',value:10,replaceDailyAdjustments:false});
  await apply(body({end:service.shift(b.start,1),value:1234567}),admin);
  const preview=await service.change(b,admin);
  const keep=preview.changes.find(c=>c.roomTypeId===roomId&&c.date===b.start);
  assert.equal(keep.changeStatus,'kept_existing');assert.equal(keep.oldPrice,keep.newPrice);
  assert.equal(preview.keptCount,1);assert.equal(preview.changedCount,preview.count-1);
  await service.change({...b,previewToken:preview.previewToken},admin,true);
  const again=await service.change(b,admin);
  assert.equal(again.changedCount,0);assert.equal(again.keptCount,again.count);
  assert.equal((await cells(b))[0].effective_price,1234567);
});
dbTest('derived daily rule prices preserve the existing proposal fingerprint format',async()=>{
  const b=body({action:'increase_percent',value:10});
  const before=await service.state(db.getDBPool(),accId);
  const oldCells=(await cells(b)).map(c=>{const snapshot={...c};delete snapshot.rule_price;return snapshot;});
  const expected=crypto.createHash('sha256').update(JSON.stringify({before,oldCells,periodVersion:null})).digest('hex');
  const preview=await service.change(b,manager);
  const token=JSON.parse(Buffer.from(preview.previewToken.split('.')[0],'base64url'));
  assert.equal(token.state,expected);
});
dbTest('daily replacement recalculates from the rule price and never compounds repeated changes',async()=>{
  const b=body({allRooms:true,action:'decrease_percent',value:10,replaceDailyAdjustments:true});
  const baseline=await cells(b);
  await apply(body({value:1234567}),admin);
  for(let i=0;i<2;i++) {
    const preview=await service.change(b,admin);
    await service.change({...b,previewToken:preview.previewToken},admin,true);
    const current=await cells(b);
    assert.ok(current.every((c,j)=>c.effective_price===Math.round(baseline[j].rule_price*.9*100)/100));
  }
  await assert.rejects(service.change({...b,replaceDailyAdjustments:'true'},admin),e=>e.statusCode===400);
});
dbTest('daily replacement uses the active special period and manager approval preserves that calculation',async()=>{
  const b=body();
  const p=await service.savePeriod({name:'Daily replacement base',start_date:b.start,end_date:b.end,adjustment_direction:'increase'},admin);
  await apply({...b,action:'period',periodId:p.id,catalogPeriod:true,value:20},admin);
  const periodPrice=await cells(b);
  await apply(body({value:1234567}),admin);
  const old=await cells(b);
  const payload={...b,allRooms:true,action:'decrease_amount',value:10000,replaceDailyAdjustments:true};
  const pending=await sendProposal(payload);
  assert.deepEqual(await cells(b),old);
  const row=await proposalRow(pending.proposalId);
  assert.equal(JSON.parse(row.payload_json).replaceDailyAdjustments,true);
  await approveProposal(pending.proposalId);
  assert.ok((await cells(b)).every((c,i)=>c.effective_price===periodPrice[i].rule_price-10000));
});
dbTest('catalog bulk periods infer percent and amount, publish all rooms atomically and can be removed',async()=>{
  const b=await bulkBody();
  const p=await service.savePeriod({name:'Bulk catalog period',start_date:b.start,end_date:b.end,adjustment_direction:'increase'},admin);
  const payload={...b,allRooms:true,roomIds:[roomId],action:'period',periodId:p.id,catalogPeriod:true,value:100};
  const original=await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end));
  const preview=await service.change(payload,admin);
  assert.equal(preview.propertyCount,2);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end)),original);
  await service.change({...payload,previewToken:preview.previewToken},admin,true);
  const rules=(await new RealRequest(active).input('p',sql.Int,p.id).query(`SELECT r.* FROM dbo.room_period_rates r JOIN dbo.accommodation_rate_periods ar ON ar.id=r.accommodation_rate_period_id WHERE ar.rate_period_id=@p;`)).recordset;
  const expected=(await new RealRequest(active).input('ids',sql.NVarChar(sql.MAX),JSON.stringify(b.propertyScope.ids)).query('SELECT COUNT(*) AS n FROM dbo.room_types WHERE deleted_at IS NULL AND accommodation_id IN(SELECT value FROM OPENJSON(@ids));')).recordset[0].n;
  assert.equal(rules.length,expected);
  assert.ok(rules.every(r=>r.adjustment_type==='increase_percent'&&r.adjustment_value===100));
  const amounts={...payload,value:100.01};
  const next=await service.change(amounts,admin);await service.change({...amounts,previewToken:next.previewToken},admin,true);
  const changed=await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end));
  assert.ok(changed.every((c,i)=>c.effective_price===original[i].normal_price+100.01));
  const remove={...payload,action:'remove_period'};
  const removal=await service.change(remove,admin);await service.change({...remove,previewToken:removal.previewToken},admin,true);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end)),original);
  assert.ok((await service.bootstrap(admin)).periods.find(x=>x.id===p.id).first_applied_at);
});
dbTest('catalog direction is enforced by backend and period dates cannot be overridden',async()=>{
  const b=body();
  await assert.rejects(service.savePeriod({name:'Missing direction',start_date:b.start,end_date:b.end},admin),e=>e.statusCode===400);
  const p=await service.savePeriod({name:'Decreasing period',start_date:b.start,end_date:b.end,adjustment_direction:'decrease'},admin);
  const payload={...b,allRooms:true,action:'period',catalogPeriod:true,periodId:p.id,value:20,adjustmentType:'increase_amount'};
  await assert.rejects(service.change({...payload,start:service.shift(b.start,1)},admin),e=>e.statusCode===400);
  const old=await cells(b);await apply(payload,admin);
  assert.ok((await cells(b)).every((c,i)=>c.effective_price===Math.round(old[i].normal_price*.8*100)/100));
  await assert.rejects(service.change({...payload,value:100},admin),e=>e.statusCode===400);
  for(const action of ['fixed_price','close','open','weekday']) await assert.rejects(service.change({...b,allRooms:true,action},admin),e=>e.statusCode===400);
});

dbTest('single-room daily changes never update another room in the same property',async()=>{
  const b=body({action:'increase_amount',value:10000,allRooms:false,conflictHandling:'ask'});
  const other=(await new RealRequest(active).input('accId',sql.Int,accId).input('roomId',sql.Int,roomId).query('SELECT TOP(1) id FROM dbo.room_types WHERE accommodation_id=@accId AND id<>@roomId AND deleted_at IS NULL ORDER BY id;')).recordset[0];
  assert.ok(other);
  const before=await service.offers(db.getDBPool(),[other.id],service.dates(b.start,b.end));
  const preview=await service.change(b,admin);
  assert.ok(preview.changes.every(c=>c.roomTypeId===roomId));
  await service.change({...b,previewToken:preview.previewToken},admin,true);
  assert.deepEqual(await service.offers(db.getDBPool(),[other.id],service.dates(b.start,b.end)),before);
});

dbTest('period overlap preview names the previous winning period and stays bound to current data',async()=>{
  const b=await bulkBody();
  const old=await service.savePeriod({name:'Existing period',start_date:b.start,end_date:b.end,adjustment_direction:'increase'},admin);
  await apply({...b,allRooms:true,action:'period',catalogPeriod:true,periodId:old.id,value:10},admin);
  const next=await service.savePeriod({name:'New overlapping period',start_date:b.start,end_date:service.shift(b.end,1),adjustment_direction:'increase'},admin);
  const payload={...b,allRooms:true,action:'period',catalogPeriod:true,periodId:next.id,value:20,end:service.shift(b.end,1),conflictHandling:'ask'};
  const original=await service.offers(db.getDBPool(),b.roomIds,service.dates(payload.start,payload.end));
  const preview=await service.change(payload,admin);
  assert.ok(preview.previewToken);
  assert.equal(new Set(preview.periodOverlaps.map(r=>r.accommodationId)).size,2);
  assert.ok(preview.periodOverlaps.every(r=>r.previousPeriodId===old.id&&r.previousPeriodName==='Existing period'&&r.accommodationName&&r.roomName&&r.start===b.start&&r.end===service.shift(b.end,-1)));
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(payload.start,payload.end)),original);
  const direct={...payload}; delete direct.propertyScope;
  const directPreview=await service.change(direct,admin);
  assert.ok(directPreview.periodOverlaps.length>0);
  await service.change({...payload,previewToken:preview.previewToken},admin,true);
  assert.ok((await service.offers(db.getDBPool(),b.roomIds,service.dates(payload.start,payload.end))).every(c=>c.period_id===next.id));
  const again=await service.change(payload,admin);
  assert.deepEqual(again.periodOverlaps,[]);
});
dbTest('bulk removes only matching periods and retains private prices until those are explicitly removed',async()=>{
  const b=await bulkBody();const p=await service.savePeriod({name:'Period cleanup',start_date:b.start,end_date:b.end,adjustment_direction:'increase'},admin);
  const period={...b,roomIds:undefined,allRooms:true,action:'period',catalogPeriod:true,periodId:p.id,value:10};
  const checked=await service.change(period,admin);await service.change({...period,previewToken:checked.previewToken},admin,true);
  await apply(body({value:1234567}),admin);
  const remove={...period,action:'remove_period',propertyScope:{mode:'all',ids:[]}};
  const removed=await service.change(remove,admin);assert.equal(removed.propertyCount,2);
  await service.change({...remove,previewToken:removed.previewToken},admin,true);
  assert.ok((await cells(b)).every(c=>c.effective_price===1234567));
  const restore={...b,allRooms:true,action:'restore'};const restored=await service.change(restore,admin);await service.change({...restore,previewToken:restored.previewToken},admin,true);
  assert.ok((await cells(b)).every(c=>c.price_source!=='override'&&c.price_source!=='period'));
});
dbTest('bulk preview rolls back and apply affects only selected properties with a shared audit batch', async () => {
  const b=await bulkBody();
  const days=service.dates(b.start,b.end);
  const before=await service.offers(db.getDBPool(),b.roomIds,days);
  const preview=await service.change(b,admin);
  assert.equal(preview.propertyCount,2);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,days),before);
  const outside=(await new RealRequest(active).input('ids',sql.NVarChar(sql.MAX),JSON.stringify(b.roomIds)).query(`SELECT TOP(1) id FROM dbo.room_types WHERE deleted_at IS NULL AND id NOT IN(SELECT value FROM OPENJSON(@ids)) ORDER BY id;`)).recordset[0].id;
  const outsideBefore=await service.offers(db.getDBPool(),[outside],days);
  const saved=await service.change({...b,previewToken:preview.previewToken},admin,true);
  assert.equal(saved.propertyCount,2);
  assert.ok((await service.offers(db.getDBPool(),b.roomIds,days)).every(c=>c.effective_price===b.value));
  assert.deepEqual(await service.offers(db.getDBPool(),[outside],days),outsideBefore);
  const logs=(await new RealRequest(active).input('batch',sql.UniqueIdentifier,saved.batchId).query('SELECT accommodation_id FROM dbo.pricing_inventory_audit_logs WHERE batch_id=@batch')).recordset;
  assert.deepEqual(logs.map(l=>l.accommodation_id).sort((a,b)=>a-b),[...b.propertyScope.ids].sort((a,b)=>a-b));
});
dbTest('bulk rejects a changed scope, unauthorized manager and rooms outside the chosen property',async()=>{
  const b=await bulkBody();
  await assert.rejects(service.change(b,manager),e=>e.statusCode===403);
  await assert.rejects(service.change({...b,propertyScope:{mode:'single',ids:[accId]}},admin),e=>e.statusCode===400);
  const preview=await service.change(b,admin);
  const before=await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end));
  await assert.rejects(service.change({...b,value:b.value+1,previewToken:preview.previewToken},admin,true),e=>e.statusCode===409);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end)),before);
  await new RealRequest(active).input('id',sql.Int,b.roomIds[1]).query('UPDATE dbo.room_types SET quantity=quantity+1 WHERE id=@id;');
  const changed=await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end));
  await assert.rejects(service.change({...b,previewToken:preview.previewToken},admin,true),e=>e.statusCode===409);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end)),changed);
});
dbTest('bulk rolls back earlier properties if a later property has an invalid resulting price',async()=>{
  const b=await bulkBody({action:'decrease_amount',value:1000000});
  const rooms=(await new RealRequest(active).input('ids',sql.NVarChar(sql.MAX),JSON.stringify(b.roomIds)).query('SELECT id,accommodation_id FROM dbo.room_types WHERE id IN(SELECT value FROM OPENJSON(@ids)) ORDER BY accommodation_id')).recordset;
  await new RealRequest(active).input('high',sql.Int,rooms[0].id).input('low',sql.Int,rooms[1].id).query('UPDATE dbo.room_weekday_rates SET price=CASE WHEN room_type_id=@high THEN 2000000 ELSE 500000 END WHERE room_type_id IN(@high,@low);');
  const before=await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end));
  await assert.rejects(service.change(b,admin),e=>e.statusCode===400);
  assert.deepEqual(await service.offers(db.getDBPool(),b.roomIds,service.dates(b.start,b.end)),before);
});
dbTest('bulk all-properties scope resolves the current database properties and previews every selected room',async()=>{
  const targets=(await new RealRequest(active).query('SELECT rt.id,rt.accommodation_id FROM dbo.room_types rt JOIN dbo.accommodations a ON a.id=rt.accommodation_id WHERE rt.deleted_at IS NULL AND a.deleted_at IS NULL;')).recordset;
  const b=body({action:'restore',roomIds:targets.map(r=>r.id),propertyScope:{mode:'all',ids:[]}});
  const preview=await service.change(b,admin);
  assert.equal(preview.propertyCount,new Set(targets.map(r=>r.accommodation_id)).size);
  assert.equal(preview.roomCount,targets.length);
  assert.equal(preview.count,targets.length*service.dates(b.start,b.end).length);
  assert.ok(preview.changes.every(c=>c.accommodationName&&c.roomName));
});
async function apply(payload, user = payload.action === 'period' ? manager : admin) {
  const preview = await service.change(payload, user);
  const saved=await service.change({
    ...payload,
    previewToken: preview.previewToken
  }, user, true);
  if(saved.status==='PENDING') return approveProposal(saved.proposalId);
  return saved;
}
async function sendProposal(payload=body()) {
  const preview=await service.change(payload,manager);
  return service.change({...payload,previewToken:preview.previewToken},manager,true);
}
async function proposalRow(pid) {
  return (await new RealRequest(active).input('pid',sql.BigInt,pid).query('SELECT *,CONVERT(varchar(18),version,1) AS versionToken FROM dbo.pricing_proposals WHERE id=@pid;')).recordset[0];
}
async function approveProposal(pid) {
  const row=await proposalRow(pid);
  const checked=await service.reviewProposal(pid,{versionToken:row.versionToken},admin,'preview');
  return service.reviewProposal(pid,{versionToken:row.versionToken,approvalToken:checked.approvalToken},admin,'approve');
}
dbTest('proposal pending and rejected preserve selling prices and never write a pricing audit',async()=>{
  const b=body();
  const before=await cells(b);
  const auditBefore=(await new RealRequest(active).query('SELECT COUNT(*) AS n FROM dbo.pricing_inventory_audit_logs;')).recordset[0].n;
  const saved=await sendProposal(b);
  assert.equal(saved.status,'PENDING');
  assert.deepEqual(await cells(b),before);
  const row=await proposalRow(saved.proposalId);
  await assert.rejects(service.reviewProposal(row.id,{versionToken:row.versionToken},manager,'approve'),e=>e.statusCode===403);
  await assert.rejects(service.reviewProposal(row.id,{versionToken:row.versionToken,reason:''},admin,'reject'),e=>e.statusCode===400);
  await service.reviewProposal(row.id,{versionToken:row.versionToken,reason:'Needs a revised rate'},admin,'reject');
  assert.equal((await proposalRow(row.id)).status,'REJECTED');
  assert.deepEqual(await cells(b),before);
  assert.equal((await new RealRequest(active).query('SELECT COUNT(*) AS n FROM dbo.pricing_inventory_audit_logs;')).recordset[0].n,auditBefore);
});
dbTest('proposal approval checks current data and publishes once with admin audit',async()=>{
  const b=body();const old=await cells(b);const saved=await sendProposal(b);const row=await proposalRow(saved.proposalId);
  const preview=await service.reviewProposal(row.id,{versionToken:row.versionToken},admin,'preview');
  assert.deepEqual(await cells(b),old);
  await assert.rejects(service.reviewProposal(row.id,{versionToken:row.versionToken,approvalToken:'bad'},admin,'approve'),e=>e.statusCode===409);
  assert.deepEqual(await cells(b),old);
  const approved=await service.reviewProposal(row.id,{versionToken:row.versionToken,approvalToken:preview.approvalToken},admin,'approve');
  assert.equal(approved.status,'APPROVED');
  assert.ok((await cells(b)).every(c=>c.effective_price===b.value));
  await assert.rejects(service.reviewProposal(row.id,{versionToken:row.versionToken,approvalToken:preview.approvalToken},admin,'approve'),e=>e.statusCode===409);
  const logs=(await new RealRequest(active).input('batch',sql.UniqueIdentifier,approved.batchId).query('SELECT * FROM dbo.pricing_inventory_audit_logs WHERE batch_id=@batch;')).recordset;
  assert.equal(logs.length,1);assert.equal(logs[0].actor_user_id,admin.id);assert.equal(logs[0].action,'approve_price_proposal');
});
dbTest('proposal approval rejects stale prices and a revoked manager assignment',async()=>{
  const saved=await sendProposal();const row=await proposalRow(saved.proposalId);
  await apply(body({value:765432}));
  const changed=await cells(body());
  await assert.rejects(service.reviewProposal(row.id,{versionToken:row.versionToken},admin,'preview'),e=>e.statusCode===409);
  assert.deepEqual(await cells(body()),changed);assert.equal((await proposalRow(row.id)).status,'PENDING');
  const saved2=await sendProposal(body({value:1000000}));const row2=await proposalRow(saved2.proposalId);
  await new RealRequest(active).input('uid',sql.UniqueIdentifier,manager.id).query('DELETE dbo.accommodation_managers WHERE user_id=@uid;');
  await assert.rejects(service.reviewProposal(row2.id,{versionToken:row2.versionToken},admin,'preview'),e=>e.statusCode===404);
});
dbTest('proposal lists remain scoped and direct room price writes cannot bypass approval',async()=>{
  const saved=await sendProposal();
  const other=(await new RealRequest(active).input('accId',sql.Int,accId).query('SELECT TOP(1) user_id FROM dbo.accommodation_managers WHERE accommodation_id<>@accId;')).recordset[0];
  assert.ok(!(await service.proposals({}, {id:other.user_id,role:'ACCOMMODATION_MANAGER'})).items.some(p=>p.id===saved.proposalId));
  assert.ok((await service.proposals({},manager)).items.some(p=>p.id===saved.proposalId));
  const before=await cells(body());
  await assert.rejects(require('../services/room_type_service').updateRoomType(roomId,{basePrice:1234567},manager),e=>e.errorCode==='PRICE_APPROVAL_REQUIRED');
  assert.deepEqual(await cells(body()),before);
});
dbTest('proposal pending period leaves period locks and active rates untouched until approved',async()=>{
  const b=body();const before=await cells(b);
  const p=await service.savePeriod({adjustment_direction:'increase',name:'Pending period proposal',start_date:b.start,end_date:b.end},admin);
  const saved=await sendProposal({...b,action:'period',periodId:p.id,adjustmentType:'increase_percent',value:20,priority:80});
  assert.deepEqual(await cells(b),before);
  assert.equal((await service.bootstrap(admin)).periods.find(x=>x.id===p.id).first_applied_at,null);
  await approveProposal(saved.proposalId);
  assert.ok((await cells(b)).every(c=>c.price_source==='period'));
  assert.ok((await service.bootstrap(admin)).periods.find(x=>x.id===p.id).first_applied_at);
});
dbTest('proposal pending weekly schedule never becomes live before admin approval',async()=>{
  const b=body({action:'weekday',prices:Array(7).fill(1500000)});
  const before=await cells(b);
  const saved=await sendProposal(b);
  assert.deepEqual(await cells(b),before);
  await approveProposal(saved.proposalId);
  assert.ok((await cells(b)).every(c=>c.effective_price===1500000));
});
async function cells(payload) {
  return service.offers(db.getDBPool(), [roomId], service.dates(payload.start, payload.end));
}
async function period(name, priority, value) {
  const p = await service.savePeriod({adjustment_direction:'increase',
    name,
    start_date: body().start,
    end_date: body().end
  }, admin);
  await apply(body({
    action: 'period',
    periodId: p.id,
    adjustmentType: 'increase_percent',
    value,
    priority
  }));
  return p.id;
}
dbTest('preview rolls back; apply changes real offers and writes one audit batch', async () => {
  const b = body();
  const old = await cells(b);
  const count = await new RealRequest(active).query('SELECT COUNT(*) AS n FROM dbo.pricing_inventory_audit_logs');
  await service.change(b, admin);
  assert.deepEqual(await cells(b), old);
  const result = await apply(b);
  assert.ok(result.batchId);
  assert.ok((await cells(b)).every(c => c.effective_price === 1234567));
  const after = await new RealRequest(active).query('SELECT COUNT(*) AS n FROM dbo.pricing_inventory_audit_logs');
  assert.equal(after.recordset[0].n, count.recordset[0].n + 1);
});
dbTest('creating a period only prepares catalog data; there is no global active flag or automatic application', async () => {
  const before=await cells(body());
  const created=await service.savePeriod({adjustment_direction:'increase',name:'Prepared period',start_date:body().start,end_date:body().end,description:'Catalog only'},admin);
  const catalog=(await service.bootstrap(admin)).periods.find(p=>p.id===created.id);
  assert.ok(catalog);
  assert.equal(Object.hasOwn(catalog,'is_active'),false);
  assert.equal(catalog.propertyCount,0);
  const links=await new RealRequest(active).input('periodId',sql.Int,created.id).query('SELECT COUNT(*) AS n FROM dbo.accommodation_rate_periods WHERE rate_period_id=@periodId;');
  assert.equal(links.recordset[0].n,0);
  assert.deepEqual(await cells(body()),before);
  const column=await new RealRequest(active).query("SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.rate_periods') AND name='is_active';");
  assert.equal(column.recordset.length,0);
  await assert.rejects(service.savePeriod({adjustment_direction:'increase',name:'Old payload',start_date:body().start,end_date:body().end,is_active:false},admin),e=>e.statusCode===400);
});
dbTest('only the assigned manager can configure property periods; ADMIN retains shared-period management', async () => {
  const periodId=await service.savePeriod({adjustment_direction:'increase',name:'Manager-owned configuration',start_date:body().start,end_date:body().end},admin);
  const payload=body({action:'period',periodId:periodId.id,adjustmentType:'increase_percent',value:20,priority:70});
  assert.ok((await service.change(payload,admin)).previewToken);
  await assert.rejects(service.change({...payload,previewToken:'invalid'},admin,true),e=>e.statusCode===409);
  const other=(await new RealRequest(active).input('accId',sql.Int,accId).query('SELECT TOP(1) user_id FROM dbo.accommodation_managers WHERE accommodation_id<>@accId;')).recordset[0];
  assert.ok(other);
  await assert.rejects(service.change(payload,{id:other.user_id,role:'ACCOMMODATION_MANAGER'}),e=>e.statusCode===404);
  await apply(payload,manager);
  assert.equal((await cells(body()))[0].price_source,'period');
  const preview=await service.change({...payload,value:25},manager);
  await new RealRequest(active).input('uid',sql.UniqueIdentifier,manager.id).query('DELETE dbo.accommodation_managers WHERE user_id=@uid;');
  await assert.rejects(service.change({...payload,value:25,previewToken:preview.previewToken},manager,true),e=>e.statusCode===404);
});
dbTest('stale preview, changed payload and malformed token are rejected', async () => {
  const b = body(),
    p = await service.change(b, admin);
  await apply(body({
    value: 1111111
  }));
  await assert.rejects(service.change({
    ...b,
    previewToken: p.previewToken
  }, admin, true), e => e.statusCode === 409);
  await assert.rejects(service.change({
    ...b,
    value: 999999,
    previewToken: p.previewToken
  }, admin, true), e => e.statusCode === 409);
  await assert.rejects(service.change({
    ...b,
    previewToken: 'invalid'
  }, admin, true), e => e.statusCode === 409);
});
dbTest('manager scope, shared period ownership, revoked assignment and write permission', async () => {
  const b = body();
  await service.change(b, manager);
  await assert.rejects(service.change(body({
    roomIds: [otherRoomId]
  }), manager));
  await assert.rejects(service.savePeriod({adjustment_direction:'increase',
    name: 'forbidden'
  }, manager), e => e.statusCode === 403);
  const preview = await service.change(b, manager);
  await new RealRequest(active).input('uid', sql.UniqueIdentifier, manager.id).query('DELETE dbo.accommodation_managers WHERE user_id=@uid');
  await assert.rejects(service.change({
    ...b,
    previewToken: preview.previewToken
  }, manager, true), e => e.statusCode === 404);
});
dbTest('revoking pricing.write rejects a previously valid manager preview', async () => {
  const b = body(),
    p = await service.change(b, manager);
  await new RealRequest(active).query("UPDATE dbo.role_permissions SET is_granted=0 WHERE role='ACCOMMODATION_MANAGER' AND permission_key='pricing.write'");
  await assert.rejects(service.change({
    ...b,
    previewToken: p.previewToken
  }, manager, true), e => e.statusCode === 403);
});
dbTest('unused period updates reject stale rowversions and can be deleted', async () => {
  const p = (await service.savePeriod({adjustment_direction:'increase',name:'Versioned unused period',start_date:body().start,end_date:body().end},admin)).id;
  const data = await service.bootstrap(admin),
    current = data.periods.find(x => x.id === p);
  await service.savePeriod({adjustment_direction:'increase',
    ...current,
    name: 'Updated period'
  }, admin, p);
  await assert.rejects(service.savePeriod({adjustment_direction:'increase',
    ...current,
    name: 'Stale period'
  }, admin, p), e => e.statusCode === 409);
  const next = (await service.bootstrap(admin)).periods.find(x => x.id === p);
  await service.savePeriod(next, admin, p, true);
  assert.equal((await cells(body()))[0].price_source, 'weekday');
  const logs = await service.history({
    accommodationId: accId
  }, admin);
  assert.ok(!logs.some(l => l.action === 'archive_period' && l.accommodation_id === null));
  const allLogs = await service.history({}, admin);
  assert.ok(allLogs.some(l => l.action === 'archive_period'));
});
dbTest('applied periods remain locked after their property configuration is removed',async()=>{
 const p=await period('Locked after application',60,10);
 const current=(await service.bootstrap(admin)).periods.find(x=>x.id===p);
 assert.equal(current.canModify,false);
 assert.ok(current.first_applied_at);
 await assert.rejects(service.savePeriod({adjustment_direction:'increase',...current,name:'Blocked edit'},admin,p),e=>e.statusCode===409);
 await assert.rejects(service.savePeriod(current,admin,p,true),e=>e.statusCode===409);
 await apply(body({action:'period',periodId:p,adjustmentType:'increase_percent',value:10,priority:60,remove:true}),manager);
 const removed=(await service.bootstrap(admin)).periods.find(x=>x.id===p);
 assert.equal(removed.propertyCount,0);
 assert.equal(removed.canModify,false);
 await assert.rejects(service.savePeriod(removed,admin,p,true),e=>e.statusCode===409);
});
dbTest('equal-priority overlapping periods rejected; higher priority wins; override takes precedence', async () => {
  await period('Test period A', 50, 10);
  const p = await service.savePeriod({adjustment_direction:'increase',
    name: 'Test period B',
    start_date: body().start,
    end_date: body().end
  }, admin);
  await assert.rejects(apply(body({
    action: 'period',
    periodId: p.id,
    adjustmentType: 'increase_percent',
    value: 20,
    priority: 50
  })), e => e.statusCode === 409);
  await apply(body({
    action: 'period',
    periodId: p.id,
    adjustmentType: 'increase_percent',
    value: 20,
    priority: 100
  }));
  const c = (await cells(body()))[0];
  assert.equal(c.effective_price, Math.round(c.normal_price * 1.2 * 100) / 100);
  await apply(body());
  assert.equal((await cells(body()))[0].effective_price, 1234567);
  await apply(body({
    action: 'restore'
  }));
  assert.equal((await cells(body()))[0].price_source, 'period');
});
dbTest('future weekly schedule applies from effective date; seven prices required', async () => {
  const b = body({
    action: 'weekday',
    prices: [1010000, 1020000, 1030000, 1040000, 1050000, 1060000, 1070000]
  });
  const prior = await service.offers(db.getDBPool(), [roomId], [service.shift(b.start, -1)]);
  await apply(b);
  const c = (await cells(b))[0],
    day = new Date(b.start).getUTCDay() || 7;
  assert.equal(c.normal_price, b.prices[day - 1]);
  assert.deepEqual(await service.offers(db.getDBPool(), [roomId], [service.shift(b.start, -1)]), prior);
  await assert.rejects(service.change({
    ...b,
    prices: [100]
  }, admin));
});
dbTest('retired sale-control actions are rejected and physical inventory remains booking-derived',async()=>{
 const before=await cells(body());
 for(const action of ['close','open']) await assert.rejects(service.change(body({action}),admin),e=>e.statusCode===400);
 const after=await cells(body());assert.deepEqual(after,before);
 assert.ok(after.every(c=>c.remaining===Math.max(0,c.quantity-c.booked)));
});

dbTest('positive prices allowed; negative adjustment rejected; snapshots unchanged', async () => {
  const snapshots = await new RealRequest(active).query('SELECT * FROM dbo.booking_item_nightly_rates ORDER BY id');
  await apply(body({ value: 1 }), manager);
  await assert.rejects(service.change(body({ value: 0 }), manager));
  await assert.rejects(service.change(body({
    action: 'decrease_percent',
    value: 100
  }), admin));
  await assert.rejects(service.change(body({
    action: 'decrease_amount',
    value: 999999999
  }), admin));
  const after = await new RealRequest(active).query('SELECT * FROM dbo.booking_item_nightly_rates ORDER BY id');
  assert.deepEqual(after.recordset, snapshots.recordset);
});
dbTest('large VND values retain decimal precision', async () => {
  await apply(body({
    value: 2500000000.25
  }));
  assert.equal((await cells(body()))[0].effective_price, 2500000000.25);
});
dbTest('legacy room-type update cannot bypass price permissions or inventory checks', async () => {
  const roomService = require('../services/room_type_service');
  const booking = (await new RealRequest(active).query("SELECT TOP(1) b.id FROM dbo.bookings b JOIN dbo.booking_items bi ON bi.booking_id=b.id WHERE b.status='CONFIRMED' GROUP BY b.id HAVING COUNT(*)>=2 ORDER BY b.id;")).recordset[0];
  assert.ok(booking, 'A confirmed multi-room booking is required');
  await new RealRequest(active).input('bookingId', sql.BigInt, booking.id).input('roomId', sql.Int, roomId).input('accId', sql.Int, accId).input('start', sql.Date, body().start).input('end', sql.Date, body().end).query(`UPDATE dbo.bookings SET accommodation_id=@accId,check_in_date=@start,check_out_date=@end,total_nights=DATEDIFF(day,@start,@end) WHERE id=@bookingId; UPDATE dbo.booking_items SET room_type_id=@roomId WHERE booking_id=@bookingId;`);
  await assert.rejects(roomService.updateRoomType(roomId, {
    quantity: 1
  }, admin), e => e.statusCode === 400);
  await new RealRequest(active).query("UPDATE dbo.role_permissions SET is_granted=0 WHERE role='ACCOMMODATION_MANAGER' AND permission_key='pricing.write'");
  await assert.rejects(roomService.updateRoomType(roomId, {
    basePrice: 1234567
  }, manager), e => e.statusCode === 403);
});
dbTest('HTTP API enforces authentication, manager scope and validation', async () => {
  const express = require('express'),
    app = express(),
    router = require('../routes/admin/pricing_admin_routes');
  app.use(express.json());
  app.use('/anonymous', require('../middlewares/requireAdminLogin'), router);
  app.use('/manager', (req, res, next) => {
    req.currentAdmin = manager;
    next();
  }, router);
  app.use('/admin', (req,res,next)=>{req.currentAdmin=admin;next();},router);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + '/anonymous/bootstrap')).status, 401);
    const created=await fetch(origin+'/admin/periods',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adjustment_direction:'increase',name:'HTTP shared period',start_date:body().start,end_date:body().end})});
    assert.equal(created.status,200);
    const periodId=(await created.json()).data.id;
    const periodPayload=body({action:'period',periodId,adjustmentType:'increase_percent',value:10,priority:80});
    for(const endpoint of ['preview','apply']) {
      const rejected=await fetch(`${origin}/admin/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(periodPayload)});
      assert.equal(rejected.status,endpoint==='preview'?200:409);
    }
    const managerPreview=await fetch(origin+'/manager/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(periodPayload)});
    assert.equal(managerPreview.status,200);
    const previewToken=(await managerPreview.json()).data.previewToken;
    const managerApply=await fetch(origin+'/manager/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...periodPayload,previewToken})});
    assert.equal(managerApply.status,200);
    const scoped = await (await fetch(origin + '/manager/bootstrap')).json();
    assert.equal(scoped.data.accommodations.length, 1);
    assert.equal(scoped.data.accommodations[0].id, accId);
    const denied = await fetch(origin + '/manager/periods', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'forbidden'
      })
    });
    assert.equal(denied.status, 403);
    const invalid = await fetch(origin + '/manager/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...body(),
        roomIds: 'invalid'
      })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
dbTest('customer quote and search use exactly the same daily pricing', async () => {
  const b = body();
  await apply(b);
  const booking = require('../services/booking_web_service');
  const quote = await booking.getBookingPreview({
    accommodationId: accId,
    checkinDate: b.start,
    checkoutDate: b.end,
    rooms: 1
  });
  const room = quote.allRoomTypes.find(r => r.id === roomId);
  assert.equal(room.roomSubtotal, 1234567 * 3);
  const search = require('../services/accommodation_search_service');
  const result = await search.searchAccommodationsByFilters({
    accommodationId: accId,
    checkinDate: b.start,
    checkoutDate: b.end,
    rooms: 1
  });
  assert.equal(result.success, true);
});
test('date validation rejects impossible dates, zero-length and oversized ranges', () => {
  if (!service) service = require('../services/pricing_service');
  assert.throws(() => service.dates('2027-02-30', '2027-03-03'));
  assert.throws(() => service.dates('2027-01-01', '2027-01-01'));
  assert.throws(() => service.dates('2027-01-01', '2030-01-01'));
});
