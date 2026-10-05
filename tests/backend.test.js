const fs = require('fs');
let src = fs.readFileSync(require('path').join(__dirname,'..','Code.gs'), 'utf-8');
const cacheStore = {};
global.CacheService = { getScriptCache: () => ({ get: k => cacheStore[k]||null, put:(k,v)=>{cacheStore[k]=v;}, remove:k=>{delete cacheStore[k];}, removeAll:ks=>ks.forEach(k=>delete cacheStore[k]) }) };
global.ContentService = { createTextOutput: s => ({ _s:s, setMimeType(){return this;}, getContent(){return this._s;} }), MimeType:{JSON:'json'} };
const today = new Date();
global.Utilities = { formatDate: (d) => d.toISOString().substring(0,10), base64Decode:s=>s, newBlob:()=>({}), sleep:()=>{} };
global.Logger = { log: ()=>{} };
global.PropertiesService = { getScriptProperties: () => ({ getProperty:()=>null, setProperty:()=>{}, deleteProperty:()=>{} }) };
global.LockService = { getScriptLock: () => ({ waitLock:()=>{}, releaseLock:()=>{}, tryLock:()=>true }) };
// mock ชีท: งาน A ครบ+เลยกำหนด(archive), งาน B ครบแต่ยังไม่หมดเขต, งาน C ไม่ครบ+เลยกำหนด
const yest = new Date(Date.now()-2*86400000).toISOString().substring(0,10);
const tomo = new Date(Date.now()+2*86400000).toISOString().substring(0,10);
const jobRows = [
  ['id','name','spots','created','ds','de','active','media','pk','se','ak','ss'],
  ['A','งานA', JSON.stringify([{code:'X1'}]), '', '', yest, true, 'Bus','','','',''],
  ['B','งานB', JSON.stringify([{code:'Y1'}]), '', '', tomo, true, 'Bus','','','',''],
  ['C','งานC', JSON.stringify([{code:'Z1'},{code:'Z2'}]), '', '', yest, true, 'Bus','','','',''],
];
const logRows = [
  ['jobId','code','inst','date','count','f','p','img'],
  ['A','X1','ช่าง', yest, 3, '', '', ''],
  ['B','Y1','ช่าง', yest, 3, '', '', ''],
  ['C','Z1','ช่าง', yest, 3, '', '', ''],
];
global.SpreadsheetApp = {};
global.DriveApp = {};
eval(src.replace(/^var CONFIG[\s\S]*?};/, 'var CONFIG={DRIVE_FOLDER_ID:"x",ADMIN_EMAIL:"a",REPAIR_EMAIL:"",INSTALLERS_SHEET_ID:""};'));
// override เฉพาะที่ต้องใช้
getJobSheet = () => ({ getDataRange: () => ({ getValues: () => jobRows }) });
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => logRows }) }) } : null;

const full = buildJobsList();
let pass=0, fail=0;
function t(n,c){ c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n)); }
const A = full.jobs.find(j=>j.id==='A'), B = full.jobs.find(j=>j.id==='B'), C = full.jobs.find(j=>j.id==='C');
t('งาน A ครบ+เลยกำหนด → archived', A.archived === true && A.done === 1);
t('งาน B ครบแต่ยังไม่หมดเขต → ยัง active', B.archived === false);
t('งาน C เลยกำหนดแต่ไม่ครบ → ยัง active (1/2)', C.archived === false && C.done === 1 && C.total === 2);
const field = JSON.parse(getJobsList({view:'field'}).getContent());
t('ช่าง (view=field) เห็น 2 งาน ไม่เห็นงาน A', field.jobs.length === 2 && !field.jobs.find(j=>j.id==='A'));
const admin = JSON.parse(getJobsList({}).getContent());
t('แอดมิน (full) เห็นครบ 3 งาน พร้อมธง archived', admin.jobs.length === 3 && admin.jobs.find(j=>j.id==='A').archived);

// ── AI ธง → รายการแจ้งช่าง (ไม่มีด่านล็อก) ──
const logRows2 = [
  ['jobId','code','installer','date','count','f','p','imgIds'],
  ['J','A1','สมชาย', yest, 2, '', '', JSON.stringify(['f1','f2'])],
  ['J','A2','สมหญิง', yest, 1, '', '', JSON.stringify(['f3'])],
];
const aiRows = [
  ['checkedAt','jobId','code','fileId','result','reason','score','decision','decidedAt','ocr'],
  ['t','J','A1','f1','flag','รูปมืด','0.9','','',''],
  ['t','J','A1','f2','ok','','0.1','','',''],
  ['t','J','A2','f3','flag','รูปเบลอ','0.9','','',''],
];
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => logRows2 }) }) }
  : { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => aiRows }), getRange: () => ({ getValue: () => 'x', setValue(){} }) }) };
const rep = _aiFlagReport('J', ['A1','A2']);
t('รายงานธงจัดกลุ่มตามช่าง (สมชาย: A1 รูปมืด, สมหญิง: A2 รูปเบลอ)',
  rep['สมชาย'] && rep['สมชาย'].length === 1 && rep['สมชาย'][0].code === 'A1' && rep['สมหญิง'][0].reason === 'รูปเบลอ');
t('สรุป AI ในอีเมลแอดมินระบุชื่อช่างและไม่ขวางการส่ง', _aiJobSummaryHtml('J', ['A1','A2']).indexOf('สมชาย') > -1 && _aiJobSummaryHtml('J', ['A1','A2']).indexOf('ไม่ขวาง') > -1);
t('approveSend ไม่มีด่านล็อกจาก AI แล้ว', String(approveSend).indexOf('_aiGatePage') === -1 && typeof _aiGatePage === 'undefined');

// ── รูปใหม่ต้องได้ตรวจก่อนรูปเก่า ──
const logRows3 = [
  ['jobId','code','installer','date','count','f','p','imgIds'],
  ['OLD','O1','ก', yest, 1, '', '', JSON.stringify(['old1'])],
  ['NEW','N1','ข', yest, 1, '', '', JSON.stringify(['new1'])],
];
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => logRows3 }) }) }
  : { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => [aiRows[0]] }), getRange: () => ({ getValue: () => 'x', setValue(){} }) }) };
const pend = JSON.parse(aiPending({}).getContent()).pending;
t('AI ตรวจรูปที่เพิ่งส่งก่อนรูปเก่าที่ค้าง', pend.length === 2 && pend[0].id === 'new1');

// ── วันที่จากชีทเป็น Date object ต้องออกมาเป็น yyyy-MM-dd (เดิมกลายเป็น "Mon Oct 05..." / วันเลื่อน) ──
const dObj = new Date(Date.UTC(2026, 9, 5, 5, 0, 0));
const jobRowsD = [jobRows[0], ['D','งานD', JSON.stringify([{code:'Q1'}]), '', dObj, dObj, true, 'Bus','','','','']];
getJobSheet = () => ({ getDataRange: () => ({ getValues: () => jobRowsD }) });
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => [logRows[0], ['D','Q1','ช่าง', dObj, 2, '', '', '']] }) }) } : null;
const jd = buildJobsList().jobs.find(j => j.id === 'D');
t('วันที่เริ่ม/สิ้นสุดของงานเป็น yyyy-MM-dd', jd && jd.dateStart === '2026-10-05' && jd.dateEnd === '2026-10-05');
const ild = buildInstallLog('D').log[0];
t('วันที่ติดตั้งใน log เป็น yyyy-MM-dd', ild && ild.date === '2026-10-05');

// ── บันทึก log: เพิ่มรูป = ยอดสะสม, ถ่ายใหม่ = นับใหม่, ดัชนีรูปเก็บรูปล่าสุด ──
const ilRows = [['jobId','code','installer','date','count','folderUrl','productFolderUrl','imgIds'],
  ['J','A1','ก','2026-10-01', 5, '', '', JSON.stringify(Array.from({length:30},(_,i)=>'o'+i))]];
const ilSheet = { getDataRange: () => ({ getValues: () => ilRows }),
  getRange: (r, c, nr, nc) => ({ getValue: () => ilRows[r-1][c-1],
    setValues: (v) => { v[0].forEach((x, k) => { ilRows[r-1][c-1+k] = x; }); }, setValue: (x) => { ilRows[r-1][c-1] = x; } }),
  appendRow: (row) => ilRows.push(row), getLastRow: () => ilRows.length };
openNamedSS = () => ({ getActiveSheet: () => ilSheet });
upsertInstallLog('J', 'ก', '2026-10-05', [{ code:'A1', count:3, imgIds:['n1','n2','n3'], replaced:false }]);
const ids1 = JSON.parse(ilRows[1][7]);
t('เพิ่มรูป: ยอดสะสม 5+3 = 8', ilRows[1][4] === 8);
t('ดัชนีรูปเก็บรูปใหม่ล่าสุดไว้ (ไม่ตัดรูปใหม่ทิ้ง)', ids1.length === 30 && ids1[29] === 'n3');
upsertInstallLog('J', 'ก', '2026-10-05', [{ code:'A1', count:4, imgIds:['r1','r2','r3','r4'], replaced:true }]);
t('ถ่ายใหม่ทั้งหมด: นับใหม่ = 4', ilRows[1][4] === 4 && JSON.parse(ilRows[1][7]).length === 4);

// ── แก้/ลบ Code ต้องระบุงาน (กันกระทบรูปของงานอื่น) ──
t('แก้ Code โดยไม่ระบุงาน = ปฏิเสธ', JSON.parse(fixCode({ oldCode:'A1', newCode:'A2' }).getContent()).success === false);
t('ลบรูปทั้ง Code โดยไม่ระบุงาน = ปฏิเสธ', JSON.parse(deleteCodeFiles({ code:'A1' }).getContent()).success === false);
console.log(`\nผล: ${pass}/${pass+fail}`);
process.exit(fail?1:0);
