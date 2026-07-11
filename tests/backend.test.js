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
console.log(`\nผล: ${pass}/${pass+fail}`);
process.exit(fail?1:0);
