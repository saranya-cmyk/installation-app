const fs = require('fs');
let src = fs.readFileSync(require('path').join(__dirname,'..','Code.gs'), 'utf-8');
const cacheStore = {};
global.CacheService = { getScriptCache: () => ({ get: k => cacheStore[k]||null, put:(k,v)=>{cacheStore[k]=v;}, remove:k=>{delete cacheStore[k];}, removeAll:ks=>ks.forEach(k=>delete cacheStore[k]), putAll:(o)=>Object.assign(cacheStore,o), getAll:(ks)=>{const o={};ks.forEach(k=>{if(k in cacheStore)o[k]=cacheStore[k];});return o;} }) };
global.ContentService = { createTextOutput: s => ({ _s:s, setMimeType(){return this;}, getContent(){return this._s;} }), MimeType:{JSON:'json'} };
const today = new Date();
const nodeCrypto = require('crypto');
global.Utilities = { formatDate: (d) => d.toISOString().substring(0,10), base64Decode:s=>s, newBlob:(b)=>({ getDataAsString: () => Buffer.from(b||[]).toString('utf8') }),
  base64DecodeWebSafe: (s) => [...Buffer.from(s, 'base64url')], sleep:()=>{},
  computeHmacSha256Signature: (v, k) => [...nodeCrypto.createHmac('sha256', k).update(v).digest()],
  base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_'),
  getUuid: () => nodeCrypto.randomUUID(),
  DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, base64Encode: (b) => Buffer.from(b).toString('base64'),
  computeDigest: (a, v) => [...nodeCrypto.createHash(a).update(v).digest()] };
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
let shareMode = [], viewers = [];
DriveApp.Access = { ANYONE_WITH_LINK: 1, PRIVATE: 0 }; DriveApp.Permission = { VIEW: 1, NONE: 0 };
DriveApp.getFolderById = (id) => ({ getName: () => 'สินค้า Cookies', setSharing: (a) => { shareMode.push(a); }, addViewer: (e) => viewers.push(e) });
approveSend({ jobId: 'S1', k: 'KEY', go: '1', to: 'sale1@planbmedia.co.th', cc: 'Boss@planbmedia.co.th' });
const lastMail = sent[sent.length - 1].htmlBody;
t('อีเมลถึงเซลมีลิงก์โฟลเดอร์รูปใน Drive', lastMail.indexOf('folders/PROD123') > -1);
t('เปิดลิงก์โฟลเดอร์ให้เซลส่งต่อลูกค้าได้', shareMode.join() === '1');
// ชื่อสินค้าซ้ำกันคนละงาน → งานล่าสุดได้โฟลเดอร์ของตัวเอง
{
  const mkF = (name, desc, id) => ({ name, desc, id, getName(){ return this.name; }, getId(){ return this.id; },
    getDescription(){ return this.desc; }, setDescription(d){ this.desc = d; } });
  const kids = [];
  const media = { getFolders: () => { let i = 0; return { hasNext: () => i < kids.length, next: () => kids[i++] }; },
    createFolder: (n) => { const f = mkF(n, '', 'NEW' + kids.length); kids.push(f); return f; } };
  const keepOpen = openNamedSS;
  openNamedSS = (n) => n === '_InstallLog' ? { getActiveSheet: () => ({ getDataRange: () => ({ getValues: () => [[], ['OLD', 'X', '', '', 0, '', 'https://drive.google.com/drive/folders/LEG1', '[]']] }) }) } : null;
  kids.push(mkF('Cookies', '', 'LEG1'));
  const fA = _productFolder_(media, 'Cookies', 'JOB-NEW');
  t('ชื่อสินค้าซ้ำกับงานเก่า → สร้างโฟลเดอร์ใหม่ "Cookies (2)" ไม่ปนกัน', fA.getName() === 'Cookies (2)' && fA.getDescription() === 'snap-job:JOB-NEW');
  t('งานเดิมอัปโหลดรอบต่อไป → ใช้โฟลเดอร์เดิมของตัวเอง', _productFolder_(media, 'Cookies', 'JOB-NEW') === fA && kids.length === 2);
  t('โฟลเดอร์เก่าที่เป็นของงานนั้นเอง → ใช้ต่อได้', _productFolder_(media, 'Cookies', 'OLD').getId() === 'LEG1');
  openNamedSS = keepOpen;
}
t('Code แต่ละจุดอยู่คนละช่อง ไม่ติดกัน', /A1<\/div><\/td><td/.test(lastMail));

// ── ความปลอดภัย: แอดมินล็อกอินด้วยอีเมลตัวเอง + รหัส 6 หลักทางอีเมล · Apps Script ตรวจบัตรผ่านเองทุกคำขอ ──
for (const k of ['AUTH_SECRET','AUTH_ENFORCE','VIEW_KEY','ADMIN_LIST']) delete propStore[k];
CONFIG.ADMIN_EMAIL = 'saranya@planbmedia.co.th';
const audit = [];
openNamedSS = (name) => name === '_AuditLog' ? { getActiveSheet: () => ({ appendRow: r => audit.push(r) }) } : null;
const deny = (a, tk, p) => { const g = _authGate(a, tk, p || {}); return !!(g && JSON.parse(g.getContent()).auth); };
const otpLogin = (em) => {
  const r = JSON.parse(otpSend({ email: em }).getContent());
  if (!r.ok) return r;
  const m = sent[sent.length - 1]; const code = (m.subject.match(/(\d{6})$/) || [])[1];
  return Object.assign({ code, mailTo: m.to }, JSON.parse(otpVerify({ email: em, code, newPass: 'Passw0rd!' + em.length }).getContent()));
};
const notListed = JSON.parse(otpSend({ email: 'stranger@planbmedia.co.th' }).getContent());
t('อีเมลที่ไม่อยู่ในรายชื่อแอดมิน → ขอรหัสไม่ได้ (ไม่ส่งอีเมล)', notListed.ok === false && /ยังไม่มีสิทธิ์/.test(notListed.error));
const own = otpLogin('Saranya@PlanBmedia.co.th');
t('เจ้าของระบบใส่อีเมล → รหัส 6 หลักส่งเข้าอีเมลตัวเอง → เข้าระบบได้', own.ok && own.mailTo === 'saranya@planbmedia.co.th' && _authOf(own.token).email === 'saranya@planbmedia.co.th');
t('รหัสจากอีเมลไม่ถูกส่งกลับมาที่แอป', JSON.stringify(JSON.parse(otpSend({ email: 'saranya@planbmedia.co.th' }).getContent())).indexOf('code') === -1);
t('รหัสผิด → เข้าไม่ได้', JSON.parse(otpVerify({ email: 'saranya@planbmedia.co.th', code: 'xxxxxx', newPass: 'abcdefgh' }).getContent()).ok === false);
t('รหัสใช้ซ้ำไม่ได้', JSON.parse(otpVerify({ email: 'saranya@planbmedia.co.th', code: own.code, newPass: 'abcdefgh' }).getContent()).ok === false);
// ── รหัสผ่านส่วนตัว ──
const OWNPW = 'Passw0rd!' + 'saranya@planbmedia.co.th'.length;
t('ยืนยัน OTP แล้วตั้งรหัสผ่านได้ · เก็บแบบแฮช ไม่เก็บรหัสจริง', !!propStore['PW_saranya@planbmedia.co.th'] && propStore['PW_saranya@planbmedia.co.th'].indexOf(OWNPW) === -1);
t('อีเมลที่ตั้งรหัสแล้ว → แอปถามรหัสผ่าน (ไม่ต้องขอ OTP)', JSON.parse(pwStatus({ email: 'saranya@planbmedia.co.th' }).getContent()).hasPass === true);
const pl = JSON.parse(pwLogin({ email: 'Saranya@planbmedia.co.th', pass: OWNPW }).getContent());
t('เข้าด้วยอีเมล + รหัสผ่านได้', pl.ok && _authOf(pl.token).email === 'saranya@planbmedia.co.th');
t('รหัสผ่านผิด → เข้าไม่ได้', JSON.parse(pwLogin({ email: 'saranya@planbmedia.co.th', pass: 'wrongpass' }).getContent()).ok === false);
const expT = Number(pl.token.split('.')[1]);
t('บัตรผ่านหมดอายุสิ้นวันนี้ (เวลาไทย) — พรุ่งนี้ต้องใส่รหัสใหม่', expT > Date.now() && expT - Date.now() <= 24 * 3600000 && new Date(expT + 7 * 3600000).getUTCHours() === 23);
t('ตั้งรหัสสั้นกว่า 8 ตัวไม่ได้', JSON.parse((() => { otpSend({ email: 'saranya@planbmedia.co.th' }); const c = sent[sent.length - 1].subject.match(/(\d{6})$/)[1]; return otpVerify({ email: 'saranya@planbmedia.co.th', code: c, newPass: 'short' }); })().getContent()).ok === false);
const cpBad = JSON.parse(securitySet({ _who: 'saranya@planbmedia.co.th', changePass: { old: 'ผิด', neu: 'NewPass123' } }).getContent());
const cpOk = JSON.parse(securitySet({ _who: 'saranya@planbmedia.co.th', changePass: { old: OWNPW, neu: 'NewPass123' } }).getContent());
t('เปลี่ยนรหัสในเมนู 🔒: ต้องใส่รหัสเดิมถูก · รหัสเก่าใช้ไม่ได้ รหัสใหม่ใช้ได้', cpBad.ok === false && cpOk.passChanged === true
  && JSON.parse(pwLogin({ email: 'saranya@planbmedia.co.th', pass: OWNPW }).getContent()).ok === false
  && JSON.parse(pwLogin({ email: 'saranya@planbmedia.co.th', pass: 'NewPass123' }).getContent()).ok === true);
for (let i = 0; i < 6; i++) pwLogin({ email: 'saranya@planbmedia.co.th', pass: 'เดา' + i });
t('เดารหัสผ่านผิด 5 ครั้ง → ล็อก 15 นาที', JSON.parse(pwLogin({ email: 'saranya@planbmedia.co.th', pass: 'NewPass123' }).getContent()).locked === true);
delete cacheStore['pw_f_saranya@planbmedia.co.th'];
const tkO = own.token;
const ownerBody = { _who: 'saranya@planbmedia.co.th' };
t('เพิ่มได้เฉพาะอีเมล @planbmedia.co.th', JSON.parse(securitySet(Object.assign({ addAdmin: 'x@gmail.com' }, ownerBody)).getContent()).ok === false);
securitySet(Object.assign({ addAdmin: 'Nok@planbmedia.co.th' }, ownerBody));
const nok = otpLogin('nok@planbmedia.co.th');
t('เจ้าของเพิ่มแอดมินใหม่ → คนนั้นใส่อีเมลตัวเองแล้วเข้าระบบได้', nok.ok && _authOf(nok.token).role === 'admin' && _authOf(nok.token).email === 'nok@planbmedia.co.th');
t('แอดมินที่ไม่ใช่เจ้าของ เพิ่ม/ลบแอดมินไม่ได้', JSON.parse(securitySet({ _who: 'nok@planbmedia.co.th', addAdmin: 'b@planbmedia.co.th' }).getContent()).ok === false);
t('ลบเจ้าของระบบไม่ได้', JSON.parse(securitySet(Object.assign({ removeAdmin: 'saranya@planbmedia.co.th' }, ownerBody)).getContent()).ok === false);
t('โหมดทดลอง (ยังไม่เปิด) → คำขอที่ไม่มีบัตรผ่านยังใช้ได้ ระบบไม่สะดุด', _authGate('deleteJob', '', {}) === null);
securitySet(Object.assign({ enforce: true }, ownerBody));
t('เปิดใช้จากเมนู 🔒 ได้', _authOn());
t('เปิดใช้แล้ว → ไม่มีบัตรผ่าน ลบงาน/สร้างงาน/ลิงก์ลูกค้า/เมนู 🔒 ไม่ได้', deny('deleteJob', '') && deny('saveJob', '') && deny('portalLink', '') && deny('securityInfo', '') && deny('securitySet', ''));
t('แอปช่างไม่ต้องล็อกอิน: ส่งรูป แจ้งปัญหา ดูงานแบบช่าง ได้ปกติ', !deny('uploadBatch', '') && !deny('reportProblem', '') && !deny('getJobs', '', { view: 'field' }) && !deny('getInstallLog', ''));
const pj = {}; _authGate('getJobs', '', pj);
t('ไม่มีบัตรผ่านขอรายการงาน → ได้แบบช่างอัตโนมัติ (แอปช่างรุ่นเก่ายังใช้ได้)', pj.view === 'field');
const fieldJobs = JSON.parse(getJobsList({ view: 'field' }).getContent()).jobs;
t('รายการงานแบบช่างไม่มีอีเมลเซล', fieldJobs.length > 0 && fieldJobs.every(j => !('salesEmail' in j)));
t('ลูกค้า Portal และลิงก์ยืนยันในอีเมล ยังเปิดได้โดยไม่ต้องล็อกอิน', !deny('portalData', '') && !deny('approveSend', '') && !deny('otpSend', ''));
t('แอดมินทำได้ทุกอย่าง', !deny('deleteJob', nok.token) && !deny('saveJob', tkO) && !deny('portalLink', tkO));
const tkV = JSON.parse(login({ role: 'view', pass: propStore.VIEW_KEY }).getContent()).token;
t('จอ War Room ดู + บันทึกผล AI ได้ แต่ลบ/สร้างงานไม่ได้', !deny('aiPending', tkV) && !deny('aiSaveChecks', tkV) && !deny('getJobs', tkV) && deny('deleteJob', tkV) && deny('saveJob', tkV));
t('ร่างข้อความแจ้งช่าง (Gemini) ใน Snaphub → แอดมินเท่านั้น จอ War Room/ไม่ล็อกอิน ใช้ไม่ได้', !deny('aiDraft', tkO) && deny('aiDraft', tkV) && deny('aiDraft', ''));
{
  const keepR = _aiFlagReport, keepD = _draftInstallerMessages_;
  let askedJob = null;
  _aiFlagReport = (j) => { askedJob = j; return { 'สมชาย': [{ code: 'BKK-1', reason: 'รูปมืด' }, { code: 'BKK-2', reason: 'รูปเบลอ' }] }; };
  _draftInstallerMessages_ = (by) => ({ source: 'gemini', model: 'gemini-x', msgs: { 'สมชาย': 'ช่างสมชาย BKK-1 BKK-2 ถ่ายใหม่' } });
  const r = JSON.parse(aiDraft({ jobId: 'J9' }).getContent());
  t('กดร่างข้อความ → ใช้ธงล่าสุดของงานนั้น ได้ข้อความแยกตามช่าง', askedJob === 'J9' && r.success && r.drafts.length === 1 && r.drafts[0].count === 2 && /BKK-2/.test(r.drafts[0].text));
  _aiFlagReport = () => ({});
  t('ไม่มีธง → ไม่เรียก Gemini', JSON.parse(aiDraft({}).getContent()).drafts.length === 0);
  _aiFlagReport = keepR; _draftInstallerMessages_ = keepD;
}
t('หุ่นยนต์ใช้รหัสจอตรงๆ ได้ (สิทธิ์ดูอย่างเดียว)', !deny('aiPending', propStore.VIEW_KEY) && deny('deleteJob', propStore.VIEW_KEY));
const pv = tkV.split('.');
const forgedRole = ['admin', pv[1], pv[2], pv[3]].join('.');
const forgedWho = [ 'admin', nok.token.split('.')[1], Buffer.from('saranya@planbmedia.co.th').toString('base64url'), nok.token.split('.')[3] ].join('.');
t('ปลอมบัตรจอเป็นแอดมิน หรือแก้อีเมลในบัตรเป็นคนอื่น ไม่ได้', deny('deleteJob', forgedRole) && deny('deleteJob', forgedWho));
const expBody = 'admin.' + (Date.now() - 1000) + '.' + Buffer.from('nok@planbmedia.co.th').toString('base64url');
t('บัตรผ่านหมดอายุ → ต้องล็อกอินใหม่', deny('deleteJob', expBody + '.' + _sign_(expBody)));
// บันทึกว่าใครทำอะไร
audit.length = 0;
const fakeReq = (action, tok, extra) => { const b = Object.assign({ action }, extra); const w = _authOf(tok); b._role = w.role; b._who = w.email; _audit_(b); };
fakeReq('deleteJob', nok.token, { jobId: 'J9' });
t('ลบงาน → บันทึกชื่อคนลบลงชีท _AuditLog', audit.length === 1 && audit[0][1] === 'nok@planbmedia.co.th' && audit[0][2] === 'deleteJob' && /J9/.test(audit[0][3]));
fakeReq('uploadBatch', '', {});
t('งานของช่าง (ส่งรูป) ไม่ต้องบันทึกซ้ำใน _AuditLog', audit.length === 1);
securitySet(Object.assign({ removeAdmin: 'nok@planbmedia.co.th' }, ownerBody));
t('เจ้าของลบชื่อออก → คนนั้นใช้ไม่ได้ทันที (แม้บัตรยังไม่หมดอายุ) คนอื่นไม่สะดุด + ลบรหัสผ่านทิ้ง', deny('deleteJob', nok.token) && !deny('deleteJob', tkO) && !propStore['PW_nok@planbmedia.co.th']);
const la = JSON.parse(securitySet(Object.assign({ logoutAll: true }, ownerBody)).getContent());
t('ให้ทุกเครื่องออกจากระบบ → บัตรเก่าใช้ไม่ได้ · คนกดได้บัตรใหม่ใช้ต่อ', deny('deleteJob', tkO) && deny('aiPending', tkV) && !deny('deleteJob', la.token));
for (let i = 0; i < 8; i++) login({ role: 'view', pass: 'เดา' });
t('เดารหัสจอผิดเกิน 8 ครั้ง → ล็อกชั่วคราว', JSON.parse(login({ role: 'view', pass: propStore.VIEW_KEY }).getContent()).locked === true);
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
t('disableSecurity → ใช้งานได้ทันที (ฉุกเฉิน)', _authGate('deleteJob', '', {}) === null);

// ── Gemini API: ร่างข้อความแจ้งช่าง (ส่งเฉพาะ Code + เหตุผล · ตรวจผลก่อนใช้ · พังได้ไม่กระทบงาน) ──
for (const k of Object.keys(cacheStore)) delete cacheStore[k];
const apiLog = [], fetched = [];
openNamedSS = (name) => name === '_AIApiLog' ? { getActiveSheet: () => ({ appendRow: r => apiLog.push(r) }) } : null;
let gemReply = null;
global.UrlFetchApp = { fetch: (url, opt) => {
  fetched.push({ url, body: opt && opt.payload ? String(opt.payload) : '', key: opt && opt.headers ? opt.headers['x-goog-api-key'] : '' });
  if (/\/models\?/.test(url)) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ models: [] }) };
  const m = url.match(/models\/([^:]+):generateContent/)[1];
  return gemReply(m);
} };
delete propStore.GEMINI_API_KEY; delete propStore.GEMINI_MODEL;
const byF = { 'สมชาย': [{ code: 'DP713', reason: 'รูปเบลอมาก' }], 'วิชัย': [{ code: 'DP959', reason: 'อาจติดผิดป้าย — อ่านได้ DP958' }, { code: 'DP1090', reason: 'รูปมืด / อาจไฟป้ายดับ' }] };
const d0 = _draftInstallerMessages_(byF);
t('ไม่มีคีย์ Gemini → ใช้ข้อความแม่แบบ ไม่เรียก API งานไม่สะดุด · บอกสาเหตุ', d0.source === 'template' && d0.why === 'nokey' && fetched.length === 0 && /DP713/.test(d0.msgs['สมชาย']));
t('ไม่มีคีย์ → ไม่จำผลแม่แบบไว้ (ใส่คีย์แล้วใช้ Gemini ได้ทันที)', Object.keys(cacheStore).filter(k => /^gem5_/.test(k)).length === 0);
for (const k of Object.keys(cacheStore)) delete cacheStore[k];
propStore.GEMINI_API_KEY = 'KEY123';
const okText = { messages: [ { id: 'ช่าง 1', items: [{ code: 'DP713', fix: 'ถือมือถือให้นิ่ง แตะโฟกัสก่อนถ่าย' }] },
                             { id: 'ช่าง 2', items: [{ code: 'DP959', fix: 'ถ่ายป้าย Code ให้ชัด เช็คว่าติดถูกจุด' }, { code: 'DP1090', fix: 'ถ่ายตอนไฟป้ายติด' }] } ] };
gemReply = (m) => m === 'gemini-2.5-flash-lite' ? { getResponseCode: () => 404, getContentText: () => '{}' }
  : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(okText) }] } }] }) };
const d1 = _draftInstallerMessages_(byF);
const sentBody = fetched.filter(f => /generateContent/.test(f.url)).map(f => f.body).join(' ');
t('มีคีย์ → เรียก Gemini API จริง (รุ่นแรกใช้ไม่ได้ → ลองรุ่นถัดไปเอง)', d1.source === 'gemini' && d1.model === 'gemini-2.5-flash' && fetched.some(f => /gemini-2.5-flash-lite:generateContent/.test(f.url)));
t('ข้อความที่ได้ใส่ชื่อช่างกลับให้ และมีครบทุก Code', /^สวัสดีค่ะ ช่างสมชาย/.test(d1.msgs['สมชาย']) && /DP959/.test(d1.msgs['วิชัย']) && /DP1090/.test(d1.msgs['วิชัย']));
t('อีเมลมีปุ่มส่ง LINE พร้อมข้อความแจ้งช่าง', (() => { const h = _draftHtml_(byF); return /line\.me\/R\/share\?text=/.test(h) && h.indexOf(encodeURIComponent('DP1090')) > -1; })());
t('ร่างข้อความส่งข้อมูลการ์ดด้วย: ทุกจุดมี Code + ปัญหา + วิธีถ่าย', d1.items['วิชัย'].length === 2 && d1.items['วิชัย'][1].code === 'DP1090' && d1.items['วิชัย'][1].fix === 'ถ่ายตอนไฟป้ายติด' && d0.items['สมชาย'][0].fix.length > 0);
t('ข้อความแจ้งช่างแบ่งบรรทัดอ่านง่าย: จุดละบรรทัด + วิธีถ่ายใต้แต่ละจุด', d1.msgs['วิชัย'].split('\n').filter(l => /^📍/.test(l)).length === 2 && /📍 DP1090\n⚠️ รูปมืด[^\n]*\n👉 ถ่ายตอนไฟป้ายติด/.test(d1.msgs['วิชัย']));
t('ส่งให้ Gemini เฉพาะ Code + เหตุผล — ไม่มีชื่อช่างจริง ไม่มีรูป', sentBody.indexOf('สมชาย') === -1 && sentBody.indexOf('วิชัย') === -1 && !/base64|inlineData|image/.test(sentBody) && /DP713/.test(sentBody));
t('ทุกครั้งที่เรียก บันทึกลงชีท _AIApiLog (โมเดล · ผล · เวลา)', apiLog.length === 1 && apiLog[0][2] === 'gemini-2.5-flash' && apiLog[0][3] === 'ok');
t('ส่งคีย์ทาง header ไม่ใส่ใน URL (ใช้ได้ทั้งคีย์ AIza… และ AQ.…)', fetched.every(f => f.url.indexOf('KEY123') === -1 && f.key === 'KEY123'));
t('จำรุ่นที่ใช้ได้ไว้ รอบหน้าไม่ต้องลองใหม่', propStore.GEMINI_MODEL === 'gemini-2.5-flash');
for (const k of Object.keys(cacheStore)) delete cacheStore[k];
const badText = { messages: [ { id: 'ช่าง 1', items: [{ code: 'DP713', fix: 'ถือให้นิ่งแล้วถ่าย DP713 ใหม่' }] }, { id: 'ช่าง 2', items: [{ code: 'DP959', fix: 'ถ่ายป้าย Code ให้ชัด' }] } ] };
gemReply = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(badText) }] } }] }) });
const d2 = _draftInstallerMessages_(byF);
t('ตรวจผลก่อนใช้: Gemini ลืมจุด DP1090 → จุดนั้นใช้คำแนะนำสำรอง จุดอื่นใช้ของ Gemini', d2.source === 'gemini+template' && /DP1090\n⚠️ รูปมืด[^\n]*\n👉 ถ่ายตอนไฟป้ายติด หรือเปิดแฟลช/.test(d2.msgs['วิชัย']) && /ถ่าย DP713 ใหม่/.test(d2.msgs['สมชาย']));
for (const k of Object.keys(cacheStore)) delete cacheStore[k];
apiLog.length = 0;
gemReply = () => ({ getResponseCode: () => 429, getContentText: () => '{}' });
const d3 = _draftInstallerMessages_(byF);
t('โควต้าหมด/ระบบล่ม → ใช้แม่แบบ งานไม่สะดุด + บันทึก error + บอกว่าโควต้าเต็ม', d3.source === 'template' && d3.why === 'quota' && apiLog.length === 1 && apiLog[0][3] === 'error');
propStore.GEMINI_API_KEY = 'OTHERKEY9';
const dNew = _draftInstallerMessages_(byF);
t('เปลี่ยนคีย์ใหม่ → ไม่ใช้ผลเก่าที่จำไว้ เรียก Gemini ใหม่', apiLog.length === 2);
propStore.GEMINI_API_KEY = 'KEY123';
gemReply = () => { throw new Error('ไม่ควรเรียกซ้ำ'); };
t('ข้อมูลเดิมไม่เรียก API ซ้ำ (ใช้ผลที่จำไว้)', _draftInstallerMessages_(byF).source === 'template');
const si = JSON.parse(securityInfo({ _who: 'saranya@planbmedia.co.th' }).getContent());
t('เมนู 🔒 บอกว่ามีคีย์ แต่ไม่ส่งคีย์กลับไปที่แอป', si.gemini.hasKey === true && JSON.stringify(si).indexOf('KEY123') === -1);

// ── อีเมลรายงานประจำวัน: การ์ดกว้างคงที่ 600px อยู่กลาง (ไม่ยืดเต็มจอใน Outlook) ──
const _aiSum = _aiJobSummaryHtml; _aiJobSummaryHtml = () => '<div>AI</div>';
_planbLogoBlob_ = () => null;
const before2 = sent.length;
_sendDailyAdminEmail({ values: ['J1', 'Happy Noz', '', '', '', '', true, 'Cookies', '', 'sale@planbmedia.co.th'], sh: { getRange: () => ({ setValue() {} }) }, row: 2 }, 2, 0, ['DP703', 'DDP023'], 1);
const dm = sent[sent.length - 1];
t('รายงานประจำวันเป็นการ์ดกว้าง 600px อยู่กลางจอ แบบเดียวกับอีเมลส่งเซล', sent.length === before2 + 1 && /width="600"/.test(dm.htmlBody) && /align="center"/.test(dm.htmlBody) && !/max-width:600px;padding:24px/.test(dm.htmlBody));
t('Code แต่ละจุดอยู่คนละช่อง + ปุ่มยืนยันส่งเซลครบ', /DP703<\/div><\/td><td/.test(dm.htmlBody) && /approveSend/.test(dm.htmlBody) && /งานติดตั้งครบ 100%/.test(dm.htmlBody));
_aiJobSummaryHtml = _aiSum;
t('อีเมลอื่นห่อเป็นการ์ดกว้างคงที่ด้วย', /width="600"/.test(_wrapMail_('<p>x</p>')));

console.log(`\nผล: ${pass}/${pass+fail}`);
process.exit(fail?1:0);
