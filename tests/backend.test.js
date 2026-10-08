const fs = require('fs');
let src = fs.readFileSync(require('path').join(__dirname,'..','Code.gs'), 'utf-8');
const cacheStore = {};
global.CacheService = { getScriptCache: () => ({ get: k => cacheStore[k]||null, put:(k,v)=>{cacheStore[k]=v;}, remove:k=>{delete cacheStore[k];}, removeAll:ks=>ks.forEach(k=>delete cacheStore[k]), putAll:(o)=>Object.assign(cacheStore,o), getAll:(ks)=>{const o={};ks.forEach(k=>{if(k in cacheStore)o[k]=cacheStore[k];});return o;} }) };
global.ContentService = { createTextOutput: s => ({ _s:s, setMimeType(){return this;}, getContent(){return this._s;} }), MimeType:{JSON:'json'} };
const today = new Date();
const nodeCrypto = require('crypto');
global.Utilities = { formatDate: (d) => d.toISOString().substring(0,10), base64Decode:s=>s, newBlob:()=>({}), sleep:()=>{},
  computeHmacSha256Signature: (v, k) => [...nodeCrypto.createHmac('sha256', k).update(v).digest()],
  base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_'),
  getUuid: () => nodeCrypto.randomUUID() };
global.Logger = { log: ()=>{} };
const propStore = { AI_BASELINE: 'set' };
global.PropertiesService = { getScriptProperties: () => ({ getProperty:k=>propStore[k]||null, setProperty:(k,v)=>{propStore[k]=v;}, deleteProperty:k=>{delete propStore[k];} }) };
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
const bjob = JSON.parse(aiPending({}).getContent()).byJob;
t('การ์ดงาน: สรุป AI ต่องาน (ตรวจ 3 · ติดธง 2 · รอตรวจ 0)', bjob && bjob.J && bjob.J.checked === 3 && bjob.J.flagged === 2 && bjob.J.pending === 0);
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

// ── cache ขนาดใหญ่ (งานหลายร้อยจุด) เก็บแบบแบ่งก้อนได้ และล้างได้ด้วย key เดียว ──
const big = 'x'.repeat(250000);
const cc = CacheService.getScriptCache();
putBig_(cc, 'portal_BIG', big, 120);
t('cache ใหญ่ 250KB เก็บแล้วอ่านกลับได้ครบ', getBig_(cc, 'portal_BIG') === big);
bustCache(['portal_BIG']);
t('ล้าง cache ใหญ่ด้วย key หลักได้', getBig_(cc, 'portal_BIG') === null);

// ── อีเมลสรุปส่งรูป: ก้อนเข้าไม่เรียงลำดับ ต้องได้อีเมล 1 ฉบับที่ครบทุกก้อน ──
const mails = [];
sendEmail = (inst, jn, codes) => mails.push(codes.map(c => c.code + ':' + c.count).join(','));
const mkFolder_ = () => ({ getFiles: () => ({ hasNext: () => false }), createFile: (b) => ({ getId: () => 'id' + Math.random(), setSharing(){}, setName(){} }), getUrl: () => 'u' });
makeCodeFolderChain = () => ({ code: mkFolder_(), month: mkFolder_(), product: mkFolder_() });
upsertInstallLog = () => {}; logSheet = () => {}; checkJobCompletion = () => {};
const up = (b, code, n, tok) => uploadBatch({ jobId: 'M', installer: 'ช่าง', jobName: 'งานM', media: 'Bus', spots: [{code}], batchIndex: b, totalBatches: 3,
  sessionToken: tok, requestId: tok + b, files: Array.from({length:n}, () => ({ _forceCode: code, data: 'x', name: 'a.jpg' })) });
up(2, 'C3', 1, 'T1');
t('รูปเข้าแล้วส่งอีเมลทันที ไม่รอก้อนอื่น', mails.length === 1 && mails[0] === 'C3:1');
up(0, 'C1', 2, 'T1'); up(1, 'C2', 3, 'T1');
t('ทุกก้อนได้อีเมลของตัวเอง ครบทุกจุด ไม่ตกหล่น', mails.length === 3 && mails.join('|') === 'C3:1|C1:2|C2:3');

// ── ตรวจเฉพาะรูปใหม่: ครั้งแรก รูปเก่าที่ค้างถูกบันทึกเป็น base แล้วไม่ตรวจย้อนหลัง ──
delete propStore.AI_BASELINE;
const bLog = [['jobId','code','i','d','c','f','p','imgIds'], ['B','B1','ก', yest, 2, '', '', JSON.stringify(['old1','old2'])]];
const bAI = [['checkedAt','jobId','code','fileId','result','reason','score','decision','decidedAt','ocr'], ['t','B','B1','x0','ok','','0','','','']];
const bSheet = { getDataRange: () => ({ getValues: () => bAI }), getLastRow: () => bAI.length,
  getRange: (r, c, n) => ({ getValue: () => 'ocr', setValue(){}, setValues: (v) => { v.forEach(x => bAI.push(x)); } }) };
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => bLog }) }) } : { getActiveSheet: () => bSheet };
const b1 = JSON.parse(aiPending({}).getContent());
t('ครั้งแรก: รูปเก่าที่ค้างไม่ถูกส่งไปตรวจ (pending 0) และไม่นับเป็น "ตรวจแล้ว"', b1.pending.length === 0 && b1.stats.pending === 0 && b1.stats.checked === 1 && bAI.filter(r => r[4] === 'base').length === 2);
bLog[1][7] = JSON.stringify(['old1','old2','new9']);
const b2 = JSON.parse(aiPending({}).getContent());
t('รูปที่เข้ามาหลังจากนั้น AI ตรวจตามปกติ', b2.pending.length === 1 && b2.pending[0].id === 'new9');

// ── ส่งเซล: หน้าใส่อีเมลเซล + CC ก่อนส่ง ──
global.HtmlService = { createHtmlOutput: h => ({ h, setTitle(){ return this; }, addMetaTag(){ return this; } }) };
const sent = [], writes = {};
global.MailApp = { sendEmail: o => sent.push(o) };
const jrow = ['S1','งานส่ง', JSON.stringify([{code:'A1'},{code:'A2'}]), '', '2026-10-01', '2026-10-09', true, 'Bus', 'pk1', 'old@planbmedia.co.th', 'KEY', 'pending', '[]', JSON.stringify(['A1']), ''];
const jsh = { getRange: (r, c, nr, nc) => ({ getValue: () => (c === 12 ? jrow[11] : jrow[c-1]), setValue: v => { if (r === 1) return; writes[c] = v; if (c === 12) jrow[11] = v; },
  getValues: () => [jrow], setValues(){} }) };
findJobRow = () => ({ sh: jsh, row: 2, values: jrow });
createSalesPDF = () => ({ getContent: () => JSON.stringify({ success: true, pdfUrl: 'pdf', photoCount: 3, timedOut: [] }) });
openNamedSS = () => null;
const f1 = approveSend({ jobId: 'S1', k: 'KEY' });
t('กดจากอีเมล → ได้หน้าใส่อีเมลก่อน ยังไม่ส่ง (เติมอีเมลเซลเดิมไว้ให้)', sent.length === 0 && f1.h.indexOf('name="to"') > -1 && f1.h.indexOf('old@planbmedia.co.th') > -1 && f1.h.indexOf('name="cc"') > -1);
const f2 = approveSend({ jobId: 'S1', k: 'KEY', go: '1', to: 'ผิดๆ', cc: '' });
t('อีเมลผิดรูปแบบ → กลับหน้าเดิมพร้อมแจ้ง ไม่ส่ง', sent.length === 0 && f2.h.indexOf('อีเมลไม่ถูกต้อง') > -1);
approveSend({ jobId: 'S1', k: 'KEY', go: '1', to: 'sale1@planbmedia.co.th, sale2@planbmedia.co.th', cc: 'boss@planbmedia.co.th' });
t('ส่งถึงเซลที่ใส่ + CC ที่ใส่ และจำไว้ใช้รอบหน้า', sent.length === 1 && sent[0].to === 'sale1@planbmedia.co.th,sale2@planbmedia.co.th' && sent[0].cc === 'boss@planbmedia.co.th'
  && writes[10] === 'sale1@planbmedia.co.th,sale2@planbmedia.co.th' && writes[15] === 'boss@planbmedia.co.th');
t('อีเมลถึงเซลไม่มีลิงก์เรียลไทม์', sent[0].htmlBody.indexOf('portal.html') === -1 && sent[0].htmlBody.indexOf('เรียลไทม์') === -1);
// ลิงก์โฟลเดอร์รูปใน Drive + Code เว้นระยะเป็นช่อง
jrow[11] = 'pending'; jrow[12] = '[]'; jrow[13] = JSON.stringify(['A1']);
openNamedSS = (name) => name === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => [
  ['jobId','code','i','d','c','f','p','imgIds'], ['S1','A1','ก','2026-10-07',2,'u','https://drive.google.com/drive/folders/PROD123','["x1"]'] ] }) }) } : null;
let shared = 0;
DriveApp.Access = { ANYONE_WITH_LINK: 1 }; DriveApp.Permission = { VIEW: 1 };
DriveApp.getFolderById = (id) => ({ getName: () => 'สินค้า Cookies', setSharing: () => { shared++; } });
approveSend({ jobId: 'S1', k: 'KEY', go: '1', to: 'sale1@planbmedia.co.th', cc: '' });
const lastMail = sent[sent.length - 1].htmlBody;
t('อีเมลถึงเซลมีลิงก์โฟลเดอร์รูปใน Drive และเปิดสิทธิ์ให้ดูได้', lastMail.indexOf('folders/PROD123') > -1 && shared === 1);
t('Code แต่ละจุดอยู่คนละช่อง ไม่ติดกัน', /A1<\/div><\/td><td/.test(lastMail));

// ── ความปลอดภัย: Apps Script ตรวจบัตรผ่านเองทุกคำขอ ──
delete propStore.AUTH_SECRET; delete propStore.AUTH_ENFORCE;
t('ยังไม่ตั้งรหัส → ล็อกอินไม่ได้ บอกให้รัน setupSecurity', JSON.parse(login({ role:'admin', pass:'x' }).getContent()).error.indexOf('setupSecurity') > -1);
setupSecurity();
t('setupSecurity สร้างรหัสแอดมิน 10 ตัว · รหัสจอ 16 ตัว (ช่างไม่ต้องมีรหัส)', propStore.ADMIN_PASS.length === 10 && propStore.VIEW_KEY.length === 16 && !propStore.TEAM_PIN);
t('โหมดทดลอง (ยังไม่ enable) → คำขอที่ไม่มีบัตรผ่านยังใช้ได้ ระบบไม่สะดุด', _authGate('deleteJob', '') === null);
enableSecurity();
const deny = (a, tk, p) => { const g = _authGate(a, tk, p); return !!(g && JSON.parse(g.getContent()).auth); };
t('เปิดใช้แล้ว → ไม่มีบัตรผ่าน ลบงาน/สร้างงาน/ลิงก์ลูกค้าไม่ได้', deny('deleteJob', '') && deny('saveJob', '') && deny('portalLink', '') && deny('createPDF', ''));
const pj = {}; _authGate('getJobs', '', pj);
t('ไม่มีบัตรผ่านขอรายการงาน → ได้แบบช่างอัตโนมัติ (แอปช่างรุ่นเก่ายังใช้ได้)', pj.view === 'field');
t('แอปช่างไม่ต้องล็อกอิน: ส่งรูป แจ้งปัญหา ดูงานแบบช่าง ได้ปกติ', !deny('uploadBatch', '') && !deny('reportProblem', '') && !deny('getJobs', '', { view: 'field' }) && !deny('getInstallLog', ''));
const fieldJobs = JSON.parse(getJobsList({ view: 'field' }).getContent()).jobs;
t('รายการงานแบบช่างไม่มีอีเมลเซล', fieldJobs.length > 0 && fieldJobs.every(j => !('salesEmail' in j)));
t('ลูกค้า Portal และลิงก์ยืนยันในอีเมล ยังเปิดได้โดยไม่ต้องล็อกอิน', !deny('portalData', '') && !deny('approveSend', ''));
const bad = JSON.parse(login({ role:'admin', pass:'ผิด' }).getContent());
t('รหัสผิด → ไม่ได้บัตรผ่าน', bad.ok === false && !bad.token);
const tkA = JSON.parse(login({ role:'admin', pass: propStore.ADMIN_PASS }).getContent()).token;
const tkV = JSON.parse(login({ role:'view', pass: propStore.VIEW_KEY }).getContent()).token;
t('แอดมินทำได้ทุกอย่าง', !deny('deleteJob', tkA) && !deny('saveJob', tkA) && !deny('portalLink', tkA));
t('จอ War Room ดู + บันทึกผล AI ได้ แต่ลบ/สร้างงานไม่ได้', !deny('aiPending', tkV) && !deny('aiSaveChecks', tkV) && !deny('getJobs', tkV) && deny('deleteJob', tkV) && deny('saveJob', tkV));
t('หุ่นยนต์ใช้รหัสจอตรงๆ ได้ (สิทธิ์ดูอย่างเดียว)', !deny('aiPending', propStore.VIEW_KEY) && deny('deleteJob', propStore.VIEW_KEY));
const forged = tkV.replace(/^view/, 'admin');
t('ปลอมบัตรจอเป็นแอดมินไม่ได้', deny('deleteJob', forged));
const parts = tkA.split('.'); const expired = 'admin.' + (Date.now() - 1000) + '.' + _sign_('admin.' + (Date.now() - 1000));
t('บัตรผ่านหมดอายุ → ต้องล็อกอินใหม่', deny('deleteJob', expired) && parts.length === 3);
logoutEveryone();
t('logoutEveryone → บัตรเก่าใช้ไม่ได้ทันที', deny('deleteJob', tkA) && deny('aiPending', tkV));
for (let i = 0; i < 8; i++) login({ role:'admin', pass:'เดา' });
t('เดารหัสแอดมินผิดเกิน 8 ครั้ง → ล็อกชั่วคราว แม้ใส่ถูก', JSON.parse(login({ role:'admin', pass: propStore.ADMIN_PASS }).getContent()).locked === true);
// ช่างลบรูปได้เฉพาะรูปที่เพิ่งส่ง · แอดมินลบได้ทุกรูป
const trashed = [];
const mkFile = (id, hoursAgo) => ({ getName: () => 'P1_' + id + '.jpg', getDateCreated: () => new Date(Date.now() - hoursAgo * 3600000), setTrashed: () => trashed.push(id) });
const files = { new1: mkFile('new1', 2), old1: mkFile('old1', 24 * 10) };
DriveApp.getFileById = id => files[id];
deletePhotosFn({ code: 'P1', fileIds: ['new1', 'old1'], _role: '' });
t('ช่าง (ไม่ล็อกอิน) ลบได้แค่รูปที่ส่งไม่เกิน 3 วัน รูปเก่ากว่านั้นลบไม่ได้', trashed.join() === 'new1');
deletePhotosFn({ code: 'P1', fileIds: ['old1'], _role: 'admin' });
t('แอดมินลบรูปเก่าได้', trashed.join() === 'new1,old1');
disableSecurity();
t('disableSecurity → ใช้งานได้ทันที (ฉุกเฉิน)', _authGate('deleteJob', '') === null);

console.log(`\nผล: ${pass}/${pass+fail}`);
process.exit(fail?1:0);
