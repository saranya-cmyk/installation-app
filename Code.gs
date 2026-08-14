/**
 * Installation App — Backend (Apps Script)
 * VERSION: v2.0 — Production Hardened
 *
 * การแก้ไขจาก v1:
 *  [P1] รูปไม่หายข้าม batch      — ใช้ session token + cache นับ index ต่อเนื่อง
 *  [P2] Upload-first, delete-later — สร้างรูปใหม่ (ชื่อชั่วคราว) สำเร็จก่อน จึงลบรูปเก่า แล้ว rename
 *  [P3] ไฟล์เสีย 1 รูปไม่ทำให้ batch ล่ม — try/catch ต่อไฟล์ + retry 3 ครั้ง
 *  [P4] LockService              — กันโฟลเดอร์ซ้ำ / แถว log ทับกัน เมื่อใช้งานพร้อมกันหลายคน
 *  [P5] fixCode รองรับโครงสร้างใหม่ — ค้นหา recursive ทุกชั้น + อัปเดต _InstallLog ด้วย
 *  [P6] รูปล่าสุดเท่านั้น          — PDF/Portal ใช้รูปจากวันที่ล่าสุดของแต่ละ Code (ไม่ปนรูปเก่า)
 *  [P7] deleteCodeFiles ลบ log ด้วย — Portal ไม่โชว์ "ติดแล้ว" ค้าง
 *  [P8] Email สรุปครบทุก batch    — สะสมผลทุก batch แล้วส่งฉบับเดียวตอนจบ
 *  [P9] InstallLog แบบ upsert     — ไม่มีแถวซ้ำต่อ jobId+code
 *
 * ⚠️ หลังวางโค้ด: Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
 *    (URL เดิมใช้ได้ ไม่ต้องแก้ฝั่ง HTML)
 */

var CONFIG = {
  DRIVE_FOLDER_ID: '1_RNwEhs93SO-7XfxBCCOIjROCcaQDZ7r',
  ADMIN_EMAIL:     'saranya@planbmedia.co.th',
  REPAIR_EMAIL:    '', // 🔧 ใส่อีเมลทีมซ่อมตรงนี้ (เว้นว่าง = ส่งหาแอดมินอย่างเดียว, ใส่หลายคนคั่นด้วย ,)
  INSTALLERS_SHEET_ID: '', // 👷 ใส่ ID ชีทรายชื่อช่าง (จาก URL ของชีท) หรือเว้นว่างแล้วตั้งชื่อไฟล์ชีทว่า _Installers ไว้ในโฟลเดอร์แอป
};

var SESSION_TTL_SEC = 3600; // อายุ session upload (1 ชม.)

// ═══════════════════════════ ROUTER ═══════════════════════════

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'uploadBatch')     return uploadBatch(body);
    if (body.action === 'saveJob')         return withLock(function(){ return saveJobFn(body.job); });
    if (body.action === 'deleteJob')       return withLock(function(){ return deleteJobFn(body.jobId); });
    if (body.action === 'fixCode')         return withLock(function(){ return fixCode(body); });
    if (body.action === 'exportReport')    return exportReport(body);
    if (body.action === 'createPDF')       return createSalesPDF(body);
    if (body.action === 'deleteCodeFiles') return withLock(function(){ return deleteCodeFiles(body); });
    if (body.action === 'deletePhotos')    return deletePhotosFn(body);
    if (body.action === 'reportProblem')   return reportProblem(body);
    if (body.action === 'reportRepair')    return reportRepair(body);
    return json({ error: 'unknown action' });
  } catch(err) { return json({ error: err.message }); }
}

function doGet(e) {
  var p = e ? e.parameter : {};
  if (p.action === 'getPhotos')      return getPhotos(p);
  if (p.action === 'getJobs')        return getJobsList(p);
  if (p.action === 'getInstallLog')  return getInstallLog(p);
  if (p.action === 'getProblemLog')  return getProblemLog(p);
  if (p.action === 'getRepairLog')   return getRepairLog(p);
  if (p.action === 'getInstallers')  return getInstallers(p);
  if (p.action === 'approveSend')    return approveSend(p);
  if (p.action === 'portalLink')     return getPortalLink(p);
  if (p.action === 'portalData')     return getPortalData(p);
  return ContentService.createTextOutput('OK');
}

// ═══════════════════════════ CORE HELPERS ═══════════════════════════

function json(data){ return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function pad(n){ return String(n).length < 2 ? '0'+n : String(n); }

/** [P4] รัน fn ภายใต้ Script Lock — กัน race condition */
function withLock(fn, waitMs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(waitMs || 30000);
  } catch(e) {
    return json({ success:false, error:'ระบบกำลังประมวลผลงานอื่นอยู่ กรุณาลองใหม่อีกครั้ง' });
  }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch(e) {} }
}

/** [P3] retry สำหรับ Drive API ที่อาจสะดุดชั่วคราว */
function withRetry(fn, tries) {
  tries = tries || 3;
  var lastErr;
  for (var i = 0; i < tries; i++) {
    try { return fn(); }
    catch(e) { lastErr = e; Utilities.sleep(500 * (i + 1)); }
  }
  throw lastErr;
}

/** [SPEED] เปิดชีทระบบด้วย file ID ที่จำไว้ใน ScriptProperties — ข้ามการค้นหา Drive */
function openNamedSS(name, header) {
  var props = PropertiesService.getScriptProperties();
  var pid = props.getProperty('fid_' + name);
  if (pid) {
    try { return SpreadsheetApp.openById(pid); }
    catch(e) { props.deleteProperty('fid_' + name); }
  }
  var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var files = folder.getFilesByName(name);
  if (files.hasNext()) {
    var id = files.next().getId();
    props.setProperty('fid_' + name, id);
    return SpreadsheetApp.openById(id);
  }
  if (!header) return null;
  var nss = SpreadsheetApp.create(name);
  folder.addFile(DriveApp.getFileById(nss.getId()));
  DriveApp.getRootFolder().removeFile(DriveApp.getFileById(nss.getId()));
  nss.getActiveSheet().appendRow(header);
  props.setProperty('fid_' + name, nss.getId());
  return nss;
}

/** [SPEED] cache คำตอบ GET — โหลดซ้ำตอบทันที ไม่เปิดชีทใหม่ */
function respCache(key, ttlSec, builder) {
  var c = CacheService.getScriptCache();
  var hit = c.get(key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var out = builder();
  var s = JSON.stringify(out);
  try { if (s.length < 95000) c.put(key, s, ttlSec); } catch(e) {}
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function bustCache(keys) {
  try { CacheService.getScriptCache().removeAll(keys); } catch(e) {}
}

function mkFolder(parent, name) {
  var ex = parent.getFoldersByName(name);
  return ex.hasNext() ? ex.next() : parent.createFolder(name);
}

/** [P4] สร้าง chain โฟลเดอร์ทั้งเส้นภายใต้ lock เดียว — กันโฟลเดอร์ซ้ำเมื่อยิงพร้อมกัน */
function makeCodeFolderChain(monthStr, mediaName, productName, dateStr, code) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var root   = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    var month  = mkFolder(root, monthStr);
    var media  = mkFolder(month, mediaName);
    var prod   = mkFolder(media, productName);
    var dateF  = mkFolder(prod, dateStr);
    var codeF  = mkFolder(dateF, code);
    return { month: month, product: prod, code: codeF };
  } finally { try { lock.releaseLock(); } catch(e) {} }
}

// ═══════════════════════════ JOBS SHEET ═══════════════════════════

function getJobSheet() {
  var ss = openNamedSS('_Jobs', ['id','name','spots','created','dateStart','dateEnd','active','media','portalKey','salesEmail','approveKey','sentStatus']);
  var sh = ss.getSheetByName('Jobs');
  if (!sh) { sh = ss.getActiveSheet(); try { sh.setName('Jobs'); } catch(e) {} }
  return sh;
}

function getJobsList(p) {
  var view = (p && p.view === 'field') ? 'field' : 'full';
  return respCache('resp_jobs_' + view, 60, function() {
    var out = buildJobsList();
    if (view === 'field' && out.jobs) {
      out.jobs = out.jobs.filter(function(j){ return !j.archived; });
    }
    return out;
  });
}
function buildJobsList() {
  try {
    var sh = getJobSheet();
    var rows = sh.getDataRange().getValues();

    // นับจุดที่ติดแล้ว + วันที่ติดล่าสุด ต่อแต่ละงาน (จาก _InstallLog)
    var doneMap = {}; // jobId -> Set ของ CODE
    var lastInstall = {}; // jobId -> yyyy-mm-dd ล่าสุด
    try {
      var lss = openNamedSS('_InstallLog', null);
      if (lss) {
        var lrows = lss.getActiveSheet().getDataRange().getValues();
        for (var di = 1; di < lrows.length; di++) {
          var jid = lrows[di][0];
          if (!jid) continue;
          if (!doneMap[jid]) doneMap[jid] = {};
          doneMap[jid][String(lrows[di][1]).trim().toUpperCase()] = true;
          var dd = lrows[di][3] ? String(lrows[di][3]).substring(0, 10) : '';
          if (dd && (!lastInstall[jid] || dd > lastInstall[jid])) lastInstall[jid] = dd;
        }
      }
    } catch(e) {}
    var todayD = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
    var grace7 = Utilities.formatDate(new Date(new Date().getTime() - 7*86400000), 'Asia/Bangkok', 'yyyy-MM-dd');
    function dstr(v) {
      if (!v) return '';
      if (v instanceof Date) { try { return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd'); } catch(e) { return ''; } }
      return String(v).substring(0, 10);
    }

    var jobs = [];
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][6]) === 'false') continue;
      try {
        var spots = JSON.parse(rows[i][2]||'[]');
        var jid2 = rows[i][0];
        var doneSet = doneMap[jid2] || {};
        var done = 0;
        for (var si = 0; si < spots.length; si++) {
          if (doneSet[String(spots[si].code).trim().toUpperCase()]) done++;
        }
        var endD = dstr(rows[i][5]);
        var complete = spots.length > 0 && done >= spots.length;
        // จบแล้ว = ครบทุกจุด และ (เลยวันสิ้นสุด หรือ ไม่มีวันสิ้นสุดแต่ติดจุดสุดท้ายมาเกิน 7 วัน)
        var archived = complete && (
          (endD && endD < todayD) ||
          (!endD && lastInstall[jid2] && lastInstall[jid2] < grace7)
        );
        jobs.push({ id:jid2, name:rows[i][1], spots:spots,
          created:rows[i][3], dateStart:rows[i][4]||'', dateEnd:rows[i][5]||'', media:rows[i][7]||'',
          salesEmail:rows[i][9]||'', sentStatus:rows[i][11]||'',
          done:done, total:spots.length, archived:archived });
      } catch(e) {}
    }
    return { jobs: jobs };
  } catch(err) { return { jobs: [], error: err.message }; }
}

function saveJobFn(job) {
  try {
    var sh = getJobSheet();
    var rows = sh.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === job.id) {
        // อัปเดตเฉพาะ 8 คอลัมน์แรก — ไม่ทับ portalKey/approveKey/sentStatus
        sh.getRange(i+1,1,1,8).setValues([[job.id,job.name,JSON.stringify(job.spots),
          job.created,job.dateStart||'',job.dateEnd||'',true,job.media||'']]);
        if (job.salesEmail !== undefined) sh.getRange(i+1,10).setValue(String(job.salesEmail||'').trim());
        bustCache(['resp_jobs_full', 'resp_jobs_field', 'portal_' + job.id]);
        return json({ success: true });
      }
    }
    sh.appendRow([job.id,job.name,JSON.stringify(job.spots),job.created,
      job.dateStart||'',job.dateEnd||'',true,job.media||'','',String(job.salesEmail||'').trim(),'','']);
    bustCache(['resp_jobs_full', 'resp_jobs_field']);
    return json({ success: true });
  } catch(err) { return json({ success: false, error: err.message }); }
}

function deleteJobFn(jobId) {
  try {
    var sh = getJobSheet();
    var rows = sh.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === jobId) { sh.getRange(i+1,7).setValue(false); break; }
    }
    bustCache(['resp_jobs_full', 'resp_jobs_field', 'portal_' + jobId]);
    return json({ success: true });
  } catch(err) { return json({ success: false, error: err.message }); }
}

// ═══════════════════════════ UPLOAD (หัวใจของระบบ) ═══════════════════════════

function uploadBatch(body) {
  // กันส่งซ้ำ: ถ้าก้อนนี้เคยอัปโหลดสำเร็จไปแล้ว (เน็ตหลุดตอนรอผลลัพธ์ แอปเข้าใจผิดว่าพังแล้วส่งซ้ำ)
  // ให้ส่งผลลัพธ์เดิมกลับไปเลย ไม่อัปโหลดรูปซ้ำเข้า Drive
  var requestId = body.requestId || '';
  var dedupCache = CacheService.getScriptCache();
  if (requestId) {
    var already = dedupCache.get('req_' + requestId);
    if (already) return ContentService.createTextOutput(already).setMimeType(ContentService.MimeType.JSON);
  }
  var installer    = body.installer    || '';
  var jobName      = body.jobName      || '';
  var media        = body.media        || '';
  var spots        = body.spots        || [];
  var files        = body.files        || [];
  var jobId        = body.jobId        || '';
  var batchIndex   = parseInt(body.batchIndex   || 0);
  var totalBatches = parseInt(body.totalBatches || 1);
  var isLastBatch  = (batchIndex + 1) >= totalBatches;

  var cache = CacheService.getScriptCache();

  // [P1] Session token: batch แรกสร้าง token ใหม่ = เริ่ม "รอบส่ง" ใหม่ (replace รูปเก่าได้)
  //      batch ถัดไปใช้ token เดิม = ต่อ index ไม่ลบของ batch ก่อนหน้า
  // session แยกราย "งาน+ช่าง" — หลายคนส่งงานเดียวกันพร้อมกันได้ ไม่รบกวนกัน
  var who = String(installer || '').replace(/\s+/g, '') .substring(0, 40);
  var sessKey = 'sess_' + jobId + '_' + who;
  var sessionToken;
  if (batchIndex === 0) {
    sessionToken = String(new Date().getTime());
    cache.put(sessKey, sessionToken, SESSION_TTL_SEC);
  } else {
    sessionToken = cache.get(sessKey);
    if (!sessionToken) { // cache หมดอายุ/หาย — สร้างใหม่ (จะไม่ลบรูปเดิม แค่ต่อท้าย)
      sessionToken = String(new Date().getTime());
      cache.put(sessKey, sessionToken, SESSION_TTL_SEC);
    }
  }

  // เรียงตามเวลาถ่าย เพื่อรักษาลำดับ ①ป้ายเก่า ②Code ③ป้ายใหม่
  var sorted = files.slice().sort(function(a,b){ return (a.lastModified||0)-(b.lastModified||0); });
  var groups = {};
  sorted.forEach(function(f) {
    var fc = f._forceCode ? String(f._forceCode).trim().toUpperCase() : '__unmatched__';
    if (!groups[fc]) groups[fc] = [];
    groups[fc].push(f);
  });

  var now = new Date();
  var monthStr = Utilities.formatDate(now,'Asia/Bangkok','MM.yyyy');
  var dateStr  = Utilities.formatDate(now,'Asia/Bangkok','yyyy-MM-dd');

  var uploadedCodes = [];
  var failedTotal = 0;
  var unmatched = groups['__unmatched__'] || [];
  var codeKeys = Object.keys(groups).filter(function(k){ return k !== '__unmatched__'; });

  // หา media: body > spot > _Jobs sheet > fallback
  var jobMedia = (media && media.trim()) ? media.trim() : '';
  if (!jobMedia) {
    for (var mi = 0; mi < spots.length; mi++) {
      if (spots[mi].media && spots[mi].media.trim()) { jobMedia = spots[mi].media.trim(); break; }
    }
  }
  if (!jobMedia && jobId) {
    try {
      var jrows = getJobSheet().getDataRange().getValues();
      for (var ji = 1; ji < jrows.length; ji++) {
        if (jrows[ji][0] === jobId && jrows[ji][7]) { jobMedia = String(jrows[ji][7]).trim(); break; }
      }
    } catch(e) {}
  }
  if (!jobMedia) jobMedia = '_ไม่ระบุสื่อ';

  var monthFolderUrl = '';

  for (var ci = 0; ci < codeKeys.length; ci++) {
    var code  = codeKeys[ci];
    var group = groups[code];
    var spot  = null;
    for (var si = 0; si < spots.length; si++) {
      if (String(spots[si].code).trim().toUpperCase() === code) { spot = spots[si]; break; }
    }
    var productName = (spot && spot.product && spot.product.trim()) ? spot.product.trim() : jobName;
    var mediaName   = (spot && spot.media && spot.media.trim()) ? spot.media.trim() : jobMedia;

    var fold;
    try {
      fold = makeCodeFolderChain(monthStr, mediaName, productName, dateStr, code);
    } catch(e) {
      failedTotal += group.length;
      uploadedCodes.push({ code:code, product:productName, address:spot?(spot.address||''):'',
        count:0, failed:group.length, method:'error', error:'สร้างโฟลเดอร์ไม่สำเร็จ: '+e.message,
        folderUrl:'', productFolderUrl:'', date:dateStr });
      continue;
    }
    var codeFolder = fold.code;
    if (!monthFolderUrl) monthFolderUrl = fold.month.getUrl();

    // [P1] เช็คว่า code นี้เคยส่งใน session นี้แล้วหรือยัง
    var seenKey = 'seen_' + jobId + '_' + who + '_' + code;
    var seenRaw = cache.get(seenKey);
    var seen = null;
    try { seen = seenRaw ? JSON.parse(seenRaw) : null; } catch(e) {}
    var isContinuation = seen && seen.t === sessionToken;
    var startIdx = isContinuation ? seen.idx : 1;
    // โหมดที่ช่างเลือกจากหน้าแอป: 'append' = เก็บรูปเก่าไว้ / ไม่ส่งมา = replace (เข้ากันได้กับแอปเวอร์ชันเก่า)
    // ปลอดภัยไว้ก่อน: ลบรูปเก่า "เฉพาะ" เมื่อช่างกดยืนยัน 'ถ่ายใหม่ทั้งหมด' เท่านั้น
    // ถ้าไม่ได้ส่งโหมดมา (แอปเก่า/พลาด/เน็ตแปลก) = ไม่ลบ รูปเก่าอยู่ครบเสมอ
    var modeForCode = (body.modes && body.modes[code]) ? String(body.modes[code]) : 'append';
    var replaceOld = !isContinuation && modeForCode === 'replace';

    // [P2][P3] สร้างรูปใหม่ก่อน (ชื่อชั่วคราวถ้าเป็นโหมด replace) — พลาดรูปไหนข้ามรูปนั้น
    var created = [];      // ไฟล์ที่สร้างสำเร็จ
    var failedInGroup = 0;
    var idx = startIdx;
    for (var fi = 0; fi < group.length; fi++) {
      var f = group[fi];
      try {
        var ext = (String(f.name||'').split('.').pop()||'jpg').toLowerCase();
        if (!/^(jpg|jpeg|png|webp|heic|gif)$/.test(ext)) ext = 'jpg';
        var finalName = code + '_' + pad(idx) + '.' + ext;
        var blobName  = replaceOld ? ('~tmp_' + finalName) : finalName;
        var blob = Utilities.newBlob(Utilities.base64Decode(f.data), f.type||'image/jpeg', blobName);
        var newFile = withRetry(function(){ return codeFolder.createFile(blob); });
        try { withRetry(function(){ return newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }, 2); } catch(e) {}
        created.push({ file:newFile, finalName:finalName });
        idx++;
      } catch(e) {
        failedInGroup++;
        Logger.log('createFile fail ['+code+'] '+(f.name||'')+': '+e.message);
      }
    }

    // [P2] สร้างใหม่ครบแล้ว จึงลบรูปเก่า (เฉพาะโหมด replace และไม่มีไฟล์พลาดเลย)
    if (replaceOld) {
      if (failedInGroup === 0) {
        try {
          var oldFiles = codeFolder.getFiles();
          while (oldFiles.hasNext()) {
            var of = oldFiles.next();
            var on = of.getName();
            if (on.indexOf(code + '_') === 0) of.setTrashed(true); // ไม่โดน ~tmp_
          }
        } catch(e) { Logger.log('trash old ['+code+']: '+e.message); }
      }
      // rename ชื่อชั่วคราว → ชื่อจริง (ถ้ามีไฟล์พลาด รูปเก่าจะยังอยู่ครบ ปลอดภัยกว่า)
      created.forEach(function(c){
        try { withRetry(function(){ return c.file.setName(c.finalName); }, 2); } catch(e) {}
      });
    }

    // [P1] จำ index ล่าสุดไว้ให้ batch ถัดไปนับต่อ
    cache.put(seenKey, JSON.stringify({ t:sessionToken, idx:idx }), SESSION_TTL_SEC);

    failedTotal += failedInGroup;
    var totalCount = idx - 1; // จำนวนรูปสะสมของ code นี้ทั้ง session

    // [SPEED] Photo Index — จำ file ID ของรูป ให้ Portal แสดงได้ทันทีไม่ต้อง scan Drive
    var imgIds = created.map(function(c2){ try { return c2.file.getId(); } catch(e) { return null; } })
                        .filter(function(x){ return x; });

    uploadedCodes.push({ code:code, product:productName,
      address:spot?(spot.address||''):'', count:created.length, total:totalCount,
      failed:failedInGroup, method:'forced', imgIds:imgIds, replaced:replaceOld,
      folderUrl:codeFolder.getUrl(), afterFolderUrl:codeFolder.getUrl(),
      productFolderUrl:fold.product.getUrl(), date:dateStr });
  }

  // รูปที่จับคู่ Code ไม่ได้ → _ตรวจสอบ (พลาดรูปไหนข้าม ไม่ล่มทั้งก้อน)
  if (unmatched.length) {
    try {
      var root2 = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      var mF = withLock2(function(){ return mkFolder(mkFolder(root2, monthStr), '_ตรวจสอบ'); });
      for (var ui = 0; ui < unmatched.length; ui++) {
        try {
          var uf = unmatched[ui];
          withRetry(function(){
            return mF.createFile(Utilities.newBlob(Utilities.base64Decode(uf.data),
              uf.type||'image/jpeg','unmatched_'+dateStr+'_'+(ui+1)+'_'+(uf.name||'photo.jpg')));
          });
        } catch(e) { failedTotal++; }
      }
      if (!monthFolderUrl) monthFolderUrl = mkFolder(root2, monthStr).getUrl();
    } catch(e) { Logger.log('unmatched: '+e.message); }
  }
  if (!monthFolderUrl) {
    try { monthFolderUrl = mkFolder(DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID), monthStr).getUrl(); } catch(e) {}
  }

  // [P9] InstallLog แบบ upsert — ไม่มีแถวซ้ำ
  try { upsertInstallLog(jobId, installer, dateStr, uploadedCodes); }
  catch(e) { Logger.log('InstallLog: '+e.message); }
  bustCache(['resp_ilog', 'portal_' + jobId, 'resp_jobs_full', 'resp_jobs_field']); // ข้อมูลใหม่ → ทุกจอเห็นรอบถัดไป (รวมสถานะจบงาน)

  try { logSheet(installer, jobName, new Date().toISOString(), uploadedCodes, unmatched.length); } catch(e) {}

  // [P8] สะสมผลทุก batch → ส่งอีเมลสรุปครบฉบับเดียวตอน batch สุดท้าย
  try {
    var aggKey = 'agg_' + jobId + '_' + sessionToken;
    var agg = {};
    var aggRaw = cache.get(aggKey);
    if (aggRaw) { try { agg = JSON.parse(aggRaw); } catch(e) { agg = {}; } }
    uploadedCodes.forEach(function(c){
      agg[c.code] = { code:c.code, product:c.product, address:c.address,
        count:(c.total || c.count), failed:c.failed||0, folderUrl:c.folderUrl };
    });
    if (isLastBatch) {
      var allCodes = Object.keys(agg).map(function(k){ return agg[k]; });
      allCodes.sort(function(a,b){ return a.code < b.code ? -1 : 1; });
      try { sendEmail(installer, jobName, allCodes, unmatched.length, monthFolderUrl, jobMedia, failedTotal); }
      catch(e) { Logger.log('Email: '+e.message); }
      cache.remove(aggKey);
    } else {
      cache.put(aggKey, JSON.stringify(agg), SESSION_TTL_SEC);
    }
  } catch(e) { Logger.log('agg: '+e.message); }

  // 🎉 เช็คว่างานครบ 100% หรือยัง — ถ้าครบ ส่งอีเมลให้แอดมินกดยืนยันส่งเซล
  if (isLastBatch && jobId) {
    try { checkJobCompletion(jobId); } catch(e) { Logger.log('completion: '+e.message); }
  }

  var _result = { success:true, codes:uploadedCodes, failed:failedTotal,
    unmatched:unmatched.length, folderUrl:monthFolderUrl };
  if (requestId) {
    try { dedupCache.put('req_' + requestId, JSON.stringify(_result), 600); } catch(e) {} // เก็บ 10 นาที พอคลุมช่วง retry
  }
  return json(_result);
}

/** lock สั้นๆ แบบคืนค่า (ใช้ภายใน) */
function withLock2(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch(e) {} }
}

/** [P9] อัปเดตแถวเดิมถ้ามี jobId+code อยู่แล้ว ไม่งั้น append — ภายใต้ lock */
function upsertInstallLog(jobId, installer, dateStr, codes) {
  if (!codes.length) return;
  withLock2(function() {
    var logSS = openNamedSS('_InstallLog',
      ['jobId','code','installer','date','count','folderUrl','productFolderUrl','imgIds']);
    var sh = logSS.getActiveSheet();
    var rows = sh.getDataRange().getValues();
    var index = {}; // jobId|CODE -> row number (1-based)
    for (var i = 1; i < rows.length; i++) {
      index[String(rows[i][0]) + '|' + String(rows[i][1]).trim().toUpperCase()] = i + 1;
    }
    codes.forEach(function(c) {
      if (c.method === 'error') return;
      var total = c.total || c.count || 0;
      var key = String(jobId) + '|' + String(c.code).trim().toUpperCase();
      // [SPEED] Photo Index: replace = ทับด้วยชุดใหม่, ต่อ batch = ต่อท้ายของเดิม
      var idsJson = '';
      try {
        var newIds = c.imgIds || [];
        if (index[key] && !c.replaced) {
          var oldIds = [];
          try { oldIds = JSON.parse(sh.getRange(index[key], 8).getValue() || '[]'); } catch(e2) {}
          newIds = oldIds.concat(newIds);
        }
        idsJson = JSON.stringify(newIds.slice(0, 12));
      } catch(e3) { idsJson = ''; }
      if (index[key]) {
        sh.getRange(index[key], 3, 1, 6).setValues([[installer, dateStr, total, c.folderUrl||'', c.productFolderUrl||'', idsJson]]);
      } else {
        sh.appendRow([jobId, c.code, installer, dateStr, total, c.folderUrl||'', c.productFolderUrl||'', idsJson]);
        index[key] = sh.getLastRow();
      }
    });
    return true;
  });
}

// ═══════════════════════════ PHOTO SEARCH (ใช้ร่วมกันทุกฟีเจอร์) ═══════════════════════════

/**
 * ค้นหาไฟล์รูปของ code ทุกชั้นความลึก รองรับทุกโครงสร้าง (เก่า/กลาง/ใหม่)
 * คืนค่า [{ file, date }] โดย date = ชื่อโฟลเดอร์วันที่ (yyyy-MM-dd) ที่ไฟล์อยู่ข้างใน
 */
function findPhotoEntries(codeStr) {
  var entries = [];
  var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var prefix = String(codeStr).trim().toUpperCase() + '_';
  var dateRe = /^\d{4}-\d{2}-\d{2}$/;

  function search(folder, depth, dateCtx) {
    if (depth > 6) return;
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      if (f.getName().toUpperCase().indexOf(prefix) === 0 && f.getMimeType().indexOf('image') > -1) {
        var d = dateCtx;
        if (!d) { try { d = Utilities.formatDate(f.getDateCreated(),'Asia/Bangkok','yyyy-MM-dd'); } catch(e) { d = ''; } }
        entries.push({ file: f, date: d });
      }
    }
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      var name = sub.getName();
      if (name.indexOf('_') === 0 && name !== '_ไม่ระบุสื่อ') continue; // ข้ามโฟลเดอร์ระบบ
      search(sub, depth + 1, dateRe.test(name) ? name : dateCtx);
    }
  }

  var months = root.getFolders();
  while (months.hasNext()) {
    var m = months.next();
    if (/^[0-9]{2}[.][0-9]{4}$/.test(m.getName())) search(m, 0, null);
  }
  return entries;
}

/** [P6] เอาเฉพาะรูปของ "วันที่ล่าสุด" ของ code นั้น เรียงตามชื่อไฟล์ */
function latestPhotoEntries(codeStr) {
  var entries = findPhotoEntries(codeStr);
  if (!entries.length) return [];
  var maxDate = '';
  entries.forEach(function(e){ if (e.date > maxDate) maxDate = e.date; });
  var latest = entries.filter(function(e){ return e.date === maxDate; });
  latest.sort(function(a,b){ return a.file.getName() < b.file.getName() ? -1 : 1; });
  return latest;
}

// เผื่อของเดิมเรียกใช้ — คืน array ของ file objects ทั้งหมด
function findPhotoFiles(codeStr) {
  return findPhotoEntries(codeStr).map(function(e){ return e.file; });
}

function getPhotos(params) {
  try {
    var code = params.code || '';
    var entries = findPhotoEntries(code);
    if (!entries.length) return json({ photos: [], note: 'ไม่พบรูปของ '+code });
    // เรียง: วันที่ใหม่สุดก่อน แล้วตามชื่อไฟล์
    entries.sort(function(a,b){
      if (a.date !== b.date) return a.date > b.date ? -1 : 1;
      return a.file.getName() < b.file.getName() ? -1 : 1;
    });
    var photos = [];
    for (var fi = 0; fi < entries.length; fi++) {
      var f = entries[fi].file;
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
      var id = f.getId();
      photos.push({ id:id, name:f.getName(), phase:'photo', date:entries[fi].date,
        url:'https://drive.google.com/uc?export=view&id='+id,
        thumbnail:'https://drive.google.com/thumbnail?id='+id+'&sz=w400' });
    }
    return json({ photos:photos, total:photos.length });
  } catch(err) { return json({ photos:[], error:err.message }); }
}

// ═══════════════════════════ FIX CODE / DELETE ═══════════════════════════

/**
 * [P5] แก้ Code ผิด → ใหม่ — รองรับโครงสร้างใหม่ (ค้นหา recursive ทุกชั้น)
 * 1) หาโฟลเดอร์ชื่อ oldCode ในทุกเดือน ทุกความลึก
 * 2) rename ไฟล์ข้างใน (prefix เก่า → ใหม่) + rename โฟลเดอร์ (โครงสร้างเดิมอยู่ครบ ไม่ย้ายไฟล์ = ไม่มีความเสี่ยงรูปหาย)
 * 3) อัปเดต _InstallLog ให้ตรงกัน
 */
function fixCode(body) {
  try {
    var oldCode = String(body.oldCode||'').trim().toUpperCase();
    var newCode = String(body.newCode||'').trim().toUpperCase();
    if (!oldCode || !newCode) return json({ success:false, error:'ข้อมูล Code ไม่ครบ' });
    if (oldCode === newCode)  return json({ success:true, moved:0, note:'Code เดิมกับใหม่เหมือนกัน' });

    var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    var movedFiles = 0, renamedFolders = 0;

    // หาโฟลเดอร์ชื่อ oldCode ทุกความลึกในโฟลเดอร์เดือน
    function search(folder, depth) {
      if (depth > 6) return;
      var subs = folder.getFolders();
      while (subs.hasNext()) {
        var sub = subs.next();
        var name = sub.getName();
        if (name.indexOf('_') === 0 && name !== '_ไม่ระบุสื่อ') continue;
        if (name.toUpperCase() === oldCode) {
          // rename ไฟล์ข้างใน
          var fs = sub.getFiles();
          while (fs.hasNext()) {
            var f = fs.next();
            var fn = f.getName();
            if (fn.toUpperCase().indexOf(oldCode + '_') === 0) {
              try { f.setName(newCode + fn.substring(oldCode.length)); movedFiles++; } catch(e) {}
            }
          }
          try { sub.setName(newCode); renamedFolders++; } catch(e) {}
        } else {
          search(sub, depth + 1);
        }
      }
    }
    var months = root.getFolders();
    while (months.hasNext()) {
      var m = months.next();
      if (/^[0-9]{2}[.][0-9]{4}$/.test(m.getName())) search(m, 0);
    }

    // ไฟล์หลุดที่ไม่ได้อยู่ในโฟลเดอร์ชื่อ code (โครงสร้างเก่า) — rename เฉพาะชื่อไฟล์
    try {
      findPhotoEntries(oldCode).forEach(function(e) {
        var fn = e.file.getName();
        if (fn.toUpperCase().indexOf(oldCode + '_') === 0) {
          try { e.file.setName(newCode + fn.substring(oldCode.length)); movedFiles++; } catch(er) {}
        }
      });
    } catch(e) {}

    // อัปเดต _InstallLog: code เก่า → ใหม่ (เฉพาะ jobId เดียวกันถ้ามีส่งมา)
    try {
      var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      var lf = folder.getFilesByName('_InstallLog');
      if (lf.hasNext()) {
        var sh = SpreadsheetApp.open(lf.next()).getActiveSheet();
        var rows = sh.getDataRange().getValues();
        for (var i = 1; i < rows.length; i++) {
          var rowCode = String(rows[i][1]).trim().toUpperCase();
          var jobMatch = !body.jobId || String(rows[i][0]) === String(body.jobId);
          if (rowCode === oldCode && jobMatch) sh.getRange(i+1, 2).setValue(newCode);
        }
      }
    } catch(e) { Logger.log('fixCode log: '+e.message); }

    bustCache(['resp_ilog']);
    if (!movedFiles && !renamedFolders) return json({ success:true, moved:0, note:'ไม่พบรูป/โฟลเดอร์ของ '+oldCode });
    return json({ success:true, moved:movedFiles, folders:renamedFolders });
  } catch(err) { return json({ success:false, error:err.message }); }
}

/** [P7] ลบรูปของ code + ลบแถวใน _InstallLog ให้สถานะ Portal ตรงความจริง */
/**
 * ลบรูป "ทีละใบ" ตามรายการ fileIds ที่ช่างเลือก
 * กฎความปลอดภัย:
 *  - ลบเฉพาะไฟล์ที่ชื่อขึ้นต้น CODE_ เท่านั้น (ต่อให้ id ถูกปลอมมา ก็ลบไฟล์อื่นไม่ได้)
 *  - setTrashed = ย้ายลงถังขยะ Drive กู้คืนได้ 30 วัน ไม่ลบถาวร
 *  - อัปเดต _InstallLog: หักจำนวน + เอา id ออกจากดัชนีรูป
 */
function deletePhotosFn(body) {
  try {
    var code   = String(body.code || '').trim().toUpperCase();
    var jobId  = String(body.jobId || '');
    var ids    = (body.fileIds || []).filter(function(x){ return x; });
    if (!code || !ids.length) return json({ success:false, error:'ข้อมูลไม่ครบ' });

    var prefix = code + '_';
    var deleted = 0, refused = 0;
    ids.forEach(function(fid) {
      try {
        var f = DriveApp.getFileById(fid);
        if (String(f.getName()).toUpperCase().indexOf(prefix) === 0) {
          f.setTrashed(true); deleted++;
        } else { refused++; } // ชื่อไม่ใช่ของ code นี้ — ไม่แตะ
      } catch(e) { refused++; }
    });

    // อัปเดต _InstallLog (ถ้ามีแถวของ jobId+code)
    var remaining = null;
    if (jobId && deleted > 0) {
      try {
        withLock2(function() {
          var logSS = openNamedSS('_InstallLog',
            ['jobId','code','installer','date','count','folderUrl','productFolderUrl','imgIds']);
          var sh = logSS.getActiveSheet();
          var rows = sh.getDataRange().getValues();
          for (var i = 1; i < rows.length; i++) {
            if (String(rows[i][0]) === jobId && String(rows[i][1]).trim().toUpperCase() === code) {
              var cnt = Math.max(0, (Number(rows[i][4]) || 0) - deleted);
              sh.getRange(i + 1, 5).setValue(cnt);
              try {
                var oldIds = JSON.parse(rows[i][7] || '[]');
                sh.getRange(i + 1, 8).setValue(JSON.stringify(oldIds.filter(function(x){ return ids.indexOf(x) === -1; })));
              } catch(e2) {}
              remaining = cnt;
              break;
            }
          }
          return true;
        });
      } catch(e) { Logger.log('deletePhotos log: ' + e.message); }
    }
    bustCache(['resp_ilog', 'portal_' + jobId, 'resp_jobs_full', 'resp_jobs_field']);
    return json({ success:true, deleted:deleted, refused:refused, remaining:remaining });
  } catch(err) { return json({ success:false, error:err.message }); }
}

function deleteCodeFiles(body) {
  try {
    var code = String(body.code||'').trim().toUpperCase();
    if (!code) return json({ success:false, error:'ไม่มี Code' });

    var entries = findPhotoEntries(code);
    var parents = {};
    entries.forEach(function(e){
      try { e.file.setTrashed(true); } catch(er) {}
      try {
        var ps = e.file.getParents();
        if (ps.hasNext()) { var p = ps.next(); parents[p.getId()] = p; }
      } catch(er) {}
    });
    // ถ้าโฟลเดอร์ code ว่างแล้ว → trash โฟลเดอร์ด้วย (ไม่ทิ้งโฟลเดอร์เปล่า)
    Object.keys(parents).forEach(function(id){
      var p = parents[id];
      try {
        if (p.getName().toUpperCase() === code && !p.getFiles().hasNext() && !p.getFolders().hasNext()) {
          p.setTrashed(true);
        }
      } catch(er) {}
    });

    // ลบแถวใน _InstallLog (ลบจากล่างขึ้นบน กัน index เลื่อน)
    var logDeleted = 0;
    try {
      var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      var lf = folder.getFilesByName('_InstallLog');
      if (lf.hasNext()) {
        var sh = SpreadsheetApp.open(lf.next()).getActiveSheet();
        var rows = sh.getDataRange().getValues();
        for (var i = rows.length - 1; i >= 1; i--) {
          var jobMatch = !body.jobId || String(rows[i][0]) === String(body.jobId);
          if (String(rows[i][1]).trim().toUpperCase() === code && jobMatch) {
            sh.deleteRow(i + 1); logDeleted++;
          }
        }
      }
    } catch(e) { Logger.log('deleteCode log: '+e.message); }

    // ล้าง cache session ของ code นี้ กันนับ index ต่อจากของที่ลบไปแล้ว
    try { if (body.jobId) CacheService.getScriptCache().remove('seen_' + body.jobId + '_' + code); } catch(e) {}

    bustCache(['resp_ilog']);
    if (body.jobId) bustCache(['portal_' + body.jobId]);
    return json({ success:true, deleted:entries.length, logDeleted:logDeleted });
  } catch(err) { return json({ success:false, error:err.message }); }
}

// ═══════════════════════════ PROBLEM REPORT ═══════════════════════════

function reportProblem(body) {
  try {
    var jobId=body.jobId||'', jobName=body.jobName||'';
    var reason=body.reason||'', installer=body.installer||'';
    var timestamp=body.timestamp||new Date().toISOString();
    try {
      withLock2(function() {
        var folder=DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
        var pFiles=folder.getFilesByName('_ProblemLog');
        var pSS;
        if(pFiles.hasNext()){pSS=SpreadsheetApp.open(pFiles.next());}
        else{
          pSS=SpreadsheetApp.create('_ProblemLog');
          folder.addFile(DriveApp.getFileById(pSS.getId()));
          DriveApp.getRootFolder().removeFile(DriveApp.getFileById(pSS.getId()));
          pSS.getActiveSheet().appendRow(['jobId','jobName','installer','reason','timestamp']);
        }
        pSS.getActiveSheet().appendRow([jobId,jobName,installer,reason,timestamp]);
        return true;
      });
    } catch(e){ Logger.log('ProblemLog: '+e.message); }
    var html='<div style="font-family:Sarabun,sans-serif;padding:20px">'+
      '<h2 style="color:#cc0000">⚠️ รายงานปัญหาหน้างาน</h2>'+
      '<p>ช่าง <b>'+installer+'</b></p><p>งาน: <b>'+jobName+'</b></p>'+
      '<p>สาเหตุ: <b>'+reason+'</b></p>'+
      '<p style="color:#888;font-size:12px">'+timestamp+'</p></div>';
    MailApp.sendEmail({to:CONFIG.ADMIN_EMAIL,subject:'[ปัญหาหน้างาน] '+jobName+' — '+installer,htmlBody:html});
    bustCache(['resp_plog']);
    return json({ success: true });
  } catch(err) { return json({ success:false, error:err.message }); }
}

// ═══════════════════════════ LOGS (อ่าน) ═══════════════════════════

function getInstallLog(params) {
  return respCache('resp_ilog', 45, buildInstallLog);
}
function buildInstallLog() {
  try {
    var ss = openNamedSS('_InstallLog', null);
    if (!ss) return { log: [] };
    var rows = ss.getActiveSheet().getDataRange().getValues();
    var log=[];
    for(var i=1;i<rows.length;i++){
      var wIds = [];
      try { wIds = JSON.parse(rows[i][7] || '[]').slice(0, 2); } catch(e) {}
      log.push({jobId:rows[i][0],code:rows[i][1],installer:rows[i][2],
        date:rows[i][3] ? String(rows[i][3]) : '',count:rows[i][4],folderUrl:rows[i][5],productFolderUrl:rows[i][6],imgs:wIds});
    }
    return { log:log };
  } catch(e){ return { log:[], error:e.message }; }
}

function getProblemLog(params) {
  return respCache('resp_plog', 60, buildProblemLog);
}
function buildProblemLog() {
  try {
    var ss = openNamedSS('_ProblemLog', null);
    if (!ss) return { problems: [] };
    var rows = ss.getActiveSheet().getDataRange().getValues();
    var problems=[];
    for(var i=1;i<rows.length;i++){
      problems.push({jobId:rows[i][0],jobName:rows[i][1],
        installer:rows[i][2],reason:rows[i][3],timestamp:rows[i][4] ? String(rows[i][4]) : ''});
    }
    return { problems:problems };
  } catch(e){ return { problems:[], error:e.message }; }
}

// ═══════════════════════════ REPAIR REPORT (แจ้งซ่อม) ═══════════════════════════

/**
 * ช่างแจ้งซ่อมป้าย: ไฟดับ / ป้ายขาด / โครงสร้างเสียหาย / อุบัติเหตุ ฯลฯ
 * - เก็บรูปหน้างานเข้า Drive: _แจ้งซ่อม/yyyy-MM-dd/CODE
 * - บันทึกลง _RepairLog
 * - ส่งอีเมลด่วนถึงแอดมิน + ทีมซ่อม (ถ้าตั้ง REPAIR_EMAIL ไว้) พร้อมพิกัด GPS กดเปิดแผนที่ได้
 */
function reportRepair(body) {
  try {
    var code       = String(body.code||'').trim().toUpperCase() || 'ไม่ระบุจุด';
    var jobId      = body.jobId      || '';
    var jobName    = body.jobName    || '';
    var media      = body.media      || '';
    var repairType = body.repairType || 'อื่นๆ';
    var detail     = body.detail     || '';
    var installer  = body.installer  || '';
    var lat        = body.lat        || '';
    var lng        = body.lng        || '';
    var photos     = body.photos     || [];
    var timestamp  = body.timestamp  || new Date().toISOString();

    var now = new Date();
    var dateStr = Utilities.formatDate(now,'Asia/Bangkok','yyyy-MM-dd');
    var timeStr = Utilities.formatDate(now,'Asia/Bangkok','dd/MM/yyyy HH:mm');

    // อัปโหลดรูปหน้างาน (พลาดรูปไหนข้าม ไม่ล่มทั้งรายการ)
    var folderUrl = '';
    var photoLinks = [];
    if (photos.length) {
      try {
        var repairFolder = withLock2(function() {
          var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
          return mkFolder(mkFolder(mkFolder(root, '_แจ้งซ่อม'), dateStr), code);
        });
        folderUrl = repairFolder.getUrl();
        for (var i = 0; i < Math.min(photos.length, 6); i++) {
          try {
            var p = photos[i];
            var ext = (String(p.name||'').split('.').pop()||'jpg').toLowerCase();
            if (!/^(jpg|jpeg|png|webp|gif)$/.test(ext)) ext = 'jpg';
            var f = withRetry(function() {
              return repairFolder.createFile(Utilities.newBlob(
                Utilities.base64Decode(p.data), p.type||'image/jpeg',
                'REPAIR_' + code + '_' + pad(i+1) + '.' + ext));
            });
            try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
            photoLinks.push('https://drive.google.com/file/d/' + f.getId() + '/view');
          } catch(e) { Logger.log('repair photo: '+e.message); }
        }
      } catch(e) { Logger.log('repair folder: '+e.message); }
    }

    // บันทึกลง _RepairLog
    try {
      withLock2(function() {
        var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
        var rf = folder.getFilesByName('_RepairLog');
        var ss;
        if (rf.hasNext()) { ss = SpreadsheetApp.open(rf.next()); }
        else {
          ss = SpreadsheetApp.create('_RepairLog');
          folder.addFile(DriveApp.getFileById(ss.getId()));
          DriveApp.getRootFolder().removeFile(DriveApp.getFileById(ss.getId()));
          ss.getActiveSheet().appendRow(['timestamp','code','jobId','jobName','media','repairType','detail','installer','lat','lng','photos','folderUrl','status']);
        }
        ss.getActiveSheet().appendRow([timestamp, code, jobId, jobName, media, repairType, detail,
          installer, lat, lng, photoLinks.length, folderUrl, 'แจ้งใหม่']);
        return true;
      });
    } catch(e) { Logger.log('RepairLog: '+e.message); }

    // อีเมลด่วน
    var mapLink = (lat && lng) ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';
    var html = '<div style="font-family:Sarabun,Arial,sans-serif;max-width:640px;padding:24px">'+
      '<div style="background:#c62828;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">'+
        '<h2 style="margin:0;font-size:20px">🔧 แจ้งซ่อมด่วน — ' + repairType + '</h2></div>'+
      '<div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 10px 10px;padding:18px">'+
        '<table style="width:100%;font-size:14px;border-collapse:collapse">'+
          '<tr><td style="padding:6px 0;color:#888;width:110px">จุด (Code)</td><td style="font-family:monospace;font-weight:bold;font-size:16px">' + code + '</td></tr>'+
          (jobName ? '<tr><td style="padding:6px 0;color:#888">งาน</td><td>' + jobName + '</td></tr>' : '')+
          (media ? '<tr><td style="padding:6px 0;color:#888">สื่อ</td><td>' + media + '</td></tr>' : '')+
          '<tr><td style="padding:6px 0;color:#888">อาการ</td><td style="font-weight:bold;color:#c62828">' + repairType + '</td></tr>'+
          (detail ? '<tr><td style="padding:6px 0;color:#888">รายละเอียด</td><td>' + detail + '</td></tr>' : '')+
          '<tr><td style="padding:6px 0;color:#888">ผู้แจ้ง</td><td>' + installer + '</td></tr>'+
          '<tr><td style="padding:6px 0;color:#888">เวลา</td><td>' + timeStr + '</td></tr>'+
        '</table>'+
        '<div style="margin-top:16px">'+
          (mapLink ? '<a href="'+mapLink+'" style="background:#1665c1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px">📍 เปิดแผนที่จุดเกิดเหตุ</a>' : '')+
          (folderUrl ? '<a href="'+folderUrl+'" style="background:#c8f542;color:#000;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">📷 ดูรูปหน้างาน ('+photoLinks.length+' รูป)</a>' : '')+
        '</div></div></div>';

    var to = CONFIG.ADMIN_EMAIL;
    if (CONFIG.REPAIR_EMAIL && CONFIG.REPAIR_EMAIL.trim()) to += ',' + CONFIG.REPAIR_EMAIL.trim();
    try {
      MailApp.sendEmail({ to: to,
        subject: '🔧 [แจ้งซ่อมด่วน] ' + code + ' — ' + repairType + (jobName ? ' — ' + jobName : ''),
        htmlBody: html });
    } catch(e) { Logger.log('repair mail: '+e.message); }

    bustCache(['resp_rlog']);
    return json({ success:true, photos:photoLinks.length, folderUrl:folderUrl });
  } catch(err) { return json({ success:false, error:err.message }); }
}

function getInstallers(params) {
  return respCache('resp_installers', 300, function() {
    try {
      var ss = null;
      if (CONFIG.INSTALLERS_SHEET_ID && CONFIG.INSTALLERS_SHEET_ID.trim()) {
        try { ss = SpreadsheetApp.openById(CONFIG.INSTALLERS_SHEET_ID.trim()); } catch(e) {}
      }
      if (!ss) ss = openNamedSS('_Installers', null);
      if (!ss) return { installers: [] };
      var rows = ss.getActiveSheet().getDataRange().getValues();
      var names = [];
      for (var i = 0; i < rows.length; i++) {
        var v = String(rows[i][0] || '').trim();
        if (!v) continue;
        // ข้ามหัวตาราง เช่น "ชื่อ", "ชื่อช่าง", "name", "รายชื่อ"
        if (i === 0 && /^(ชื่อ|รายชื่อ|name|ช่าง)/i.test(v)) continue;
        if (names.indexOf(v) === -1) names.push(v);
      }
      return { installers: names };
    } catch(e) { return { installers: [], error: e.message }; }
  });
}

function getRepairLog(params) {
  return respCache('resp_rlog', 60, buildRepairLog);
}
function buildRepairLog() {
  try {
    var ss = openNamedSS('_RepairLog', null);
    if (!ss) return { repairs: [] };
    var rows = ss.getActiveSheet().getDataRange().getValues();
    var repairs = [];
    for (var i = 1; i < rows.length; i++) {
      repairs.push({ timestamp: rows[i][0] ? String(rows[i][0]) : '', code: rows[i][1],
        jobId: rows[i][2], jobName: rows[i][3], media: rows[i][4],
        repairType: rows[i][5], detail: rows[i][6], installer: rows[i][7],
        lat: rows[i][8], lng: rows[i][9], photos: rows[i][10],
        folderUrl: rows[i][11], status: rows[i][12] || '' });
    }
    return { repairs: repairs };
  } catch(e) { return { repairs: [], error: e.message }; }
}

// ═══════════════════════════ CUSTOMER PORTAL ═══════════════════════════

function genPortalKey() {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  var key = '';
  for (var i = 0; i < 10; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
  return key;
}

function getPortalLink(p) {
  try {
    // [P4] lock กันสองคนขอ key พร้อมกันแล้วได้ key คนละอันทับกัน
    return withLock2(function() {
      var sh = getJobSheet();
      var rows = sh.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        if (rows[i][0] === p.jobId) {
          var key = rows[i][8] ? String(rows[i][8]).trim() : '';
          if (!key) {
            key = genPortalKey();
            sh.getRange(i + 1, 9).setValue(key);
          }
          return json({ key: key });
        }
      }
      return json({ error: 'job not found' });
    });
  } catch (err) { return json({ error: err.message }); }
}

function getPortalData(p) {
  try {
    var key = (p.key || '').trim();
    if (!key) return json({ error: 'no key' });
    var sh = getJobSheet();
    var rows = sh.getDataRange().getValues();
    var job = null;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][8] || '').trim() === key && String(rows[i][6]) !== 'false') {
        job = { id: rows[i][0], name: rows[i][1], spots: JSON.parse(rows[i][2] || '[]'),
          dateStart: rows[i][4] ? String(rows[i][4]) : '', dateEnd: rows[i][5] ? String(rows[i][5]) : '',
          media: rows[i][7] || '' };
        break;
      }
    }
    if (!job) return json({ error: 'invalid key' });

    // [SPEED] cache ผลลัพธ์ทั้งก้อน 2 นาที (ถูกล้างทันทีเมื่อมีรูปใหม่เข้า)
    var pCache = CacheService.getScriptCache();
    var pHit = pCache.get('portal_' + job.id);
    if (pHit) return ContentService.createTextOutput(pHit).setMimeType(ContentService.MimeType.JSON);

    // สถานะติดตั้งจาก _InstallLog (+ Photo Index)
    var done = {};
    var logSS = openNamedSS('_InstallLog', null);
    if (logSS) {
      var lrows = logSS.getActiveSheet().getDataRange().getValues();
      for (var li = 1; li < lrows.length; li++) {
        if (lrows[li][0] === job.id) {
          var ids = [];
          try { ids = JSON.parse(lrows[li][7] || '[]'); } catch(e) {}
          done[String(lrows[li][1]).trim().toUpperCase()] = {
            date: lrows[li][3] ? String(lrows[li][3]) : '', count: lrows[li][4] || 0, ids: ids };
        }
      }
    }

    var spots = job.spots.map(function(s) {
      var d = done[String(s.code).trim().toUpperCase()];
      var imgs = [];
      if (d && d.ids && d.ids.length) {
        // [SPEED] มี Photo Index → ลิงก์รูปได้ทันที (รูปตั้งสิทธิ์แชร์ตั้งแต่ตอนอัปโหลดแล้ว)
        imgs = d.ids.slice(0, 6).map(function(fid) {
          return { t: 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w400',
                   u: 'https://drive.google.com/file/d/' + fid + '/view' };
        });
      }
      return { code: s.code, address: s.address || '', product: s.product || '', media: s.media || '',
        lat: s.lat || null, lng: s.lng || null,
        done: !!d, date: d ? d.date : '', photos: d ? (d.count || 0) : 0,
        imgs: imgs, _hasIdx: !!(d && d.ids && d.ids.length) };
    });
    var doneCount = spots.filter(function(s){ return s.done; }).length;

    // scan โฟลเดอร์รอบเดียว เก็บรูปของทุกจุดที่ติดแล้ว
    // [P6] เก็บพร้อมวันที่ แล้วคัดเฉพาะ "วันที่ล่าสุด" ต่อจุด — ไม่ปนรูปติดตั้งรอบเก่า
    try {
      var codeMap = {}; // UPPER code -> spot (เฉพาะจุดเก่าที่ไม่มี Photo Index)
      spots.forEach(function(s){ if (s.done && !s._hasIdx) codeMap[String(s.code).trim().toUpperCase()] = s; });
      var needWalk = Object.keys(codeMap).length > 0;
      var collected = {}; // UPPER code -> [{date, name, t, u}]
      var dateRe = /^\d{4}-\d{2}-\d{2}$/;
      var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);

      function walk(fo, depth, dateCtx) {
        if (depth > 6) return;
        var fs = fo.getFiles();
        while (fs.hasNext()) {
          var f = fs.next();
          var nm = f.getName().toUpperCase();
          var us = nm.lastIndexOf('_');
          if (us <= 0) continue;
          var codePart = nm.substring(0, us);
          if (!codeMap[codePart]) continue;
          if (f.getMimeType().indexOf('image') === -1) continue;
          try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
          var fid = f.getId();
          if (!collected[codePart]) collected[codePart] = [];
          collected[codePart].push({ date: dateCtx || '', name: nm,
            t: 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w400',
            u: 'https://drive.google.com/file/d/' + fid + '/view' });
        }
        var subs = fo.getFolders();
        while (subs.hasNext()) {
          var sub = subs.next();
          var sn = sub.getName();
          if (sn.indexOf('_') === 0 && sn !== '_ไม่ระบุสื่อ') continue;
          walk(sub, depth + 1, dateRe.test(sn) ? sn : dateCtx);
        }
      }
      if (needWalk) {
        var months = root.getFolders();
        while (months.hasNext()) {
          var mo = months.next();
          if (/^[0-9]{2}[.][0-9]{4}$/.test(mo.getName())) walk(mo, 0, null);
        }
      }

      // คัดวันที่ล่าสุดต่อจุด + เรียงชื่อไฟล์ + จำกัด 6 รูป
      Object.keys(collected).forEach(function(codeU){
        var arr = collected[codeU];
        var maxDate = '';
        arr.forEach(function(x){ if (x.date > maxDate) maxDate = x.date; });
        var latest = arr.filter(function(x){ return x.date === maxDate; });
        latest.sort(function(a,b){ return a.name < b.name ? -1 : 1; });
        codeMap[codeU].imgs = latest.slice(0, 6).map(function(x){ return { t:x.t, u:x.u }; });
      });
    } catch(e) {}

    spots.forEach(function(s){ delete s._hasIdx; });
    var payload = JSON.stringify({ name: job.name, media: job.media, dateStart: job.dateStart, dateEnd: job.dateEnd,
      total: spots.length, done: doneCount, spots: spots });
    try { if (payload.length < 95000) pCache.put('portal_' + job.id, payload, 120); } catch(e) {}
    return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
  } catch (err) { return json({ error: err.message }); }
}

// ═══════════════════════════ REPORTS ═══════════════════════════

function exportReport(body) {
  try {
    var jobName=body.jobName||'Report', codes=body.codes||[];
    var ss=SpreadsheetApp.create('รายงาน_'+jobName+'_'+Utilities.formatDate(new Date(),'Asia/Bangkok','yyyyMMdd'));
    var sh=ss.getActiveSheet();
    sh.setName('สรุปงาน');
    sh.appendRow(['Code','สินค้า','ที่อยู่','จำนวนรูป','สถานะ','Drive']);
    codes.forEach(function(c){sh.appendRow([c.code,c.product,c.address,c.count,c.method||'pending',c.folderUrl||'']);});
    sh.getRange(1,1,1,6).setBackground('#c8f542').setFontWeight('bold');
    var folder=DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    folder.addFile(DriveApp.getFileById(ss.getId()));
    DriveApp.getRootFolder().removeFile(DriveApp.getFileById(ss.getId()));
    return json({success:true,reportUrl:ss.getUrl(),title:ss.getName()});
  } catch(e){return json({success:false,error:e.message});}
}

function createSalesPDF(body) {
  try {
    var startTime  = new Date().getTime();
    var TIME_LIMIT = 4 * 60 * 1000; // กันชน 6 นาที — เหลือเวลาบันทึก+return ก่อนโดน kill

    var jobName   = body.jobName   || 'Report';
    var codes     = body.codes     || [];
    var media     = body.media     || '';
    var dateStart = body.dateStart || '';
    var dateEnd   = body.dateEnd   || '';

    function fmtDate(d) {
      if (!d) return '';
      var dt = new Date(d);
      return isNaN(dt.getTime()) ? d : Utilities.formatDate(dt,'Asia/Bangkok','dd/MM/yyyy');
    }

    var doc = DocumentApp.create('รูปติดตั้ง_'+jobName+'_'+Utilities.formatDate(new Date(),'Asia/Bangkok','yyyyMMdd'));
    var b = doc.getBody();

    // A4 landscape
    b.setPageWidth(841.89);
    b.setPageHeight(595.28);
    b.setMarginTop(40);
    b.setMarginBottom(40);
    b.setMarginLeft(40);
    b.setMarginRight(40);

    // Cover page
    var p1 = b.appendParagraph('รูปติดตั้ง');
    p1.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    p1.setSpacingBefore(100);
    p1.editAsText().setFontSize(16).setForegroundColor('#888888');

    if (media) {
      var p2 = b.appendParagraph('สื่อ : ' + media);
      p2.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      p2.editAsText().setFontSize(24).setForegroundColor('#185FA5');
    }

    var p3 = b.appendParagraph(jobName);
    p3.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    p3.editAsText().setFontSize(42).setBold(true).setForegroundColor('#0D0D2A');

    var dateInfo = dateStart
      ? 'วันที่ : '+fmtDate(dateStart)+(dateEnd?' – '+fmtDate(dateEnd):'')
      : 'วันที่ : '+Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy');
    var p4 = b.appendParagraph(dateInfo);
    p4.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    p4.editAsText().setFontSize(20).setForegroundColor('#185FA5');

    var photoCount = 0;
    var skipped = [];

    for (var ci = 0; ci < codes.length; ci++) {
      // กันสคริปต์เกินเวลา — หยุดก่อนแล้วแจ้งว่าจุดไหนไม่ทัน
      if (new Date().getTime() - startTime > TIME_LIMIT) {
        for (var rest = ci; rest < codes.length; rest++) skipped.push(codes[rest].code);
        break;
      }
      var codeInfo = codes[ci];
      // เร็ว: ลองดึงรูปจาก imgIds ใน _InstallLog ก่อน (ตรงจุด) → ถ้าไม่มีค่อยไล่หาใน Drive
      var files = [];
      try {
        if (codeInfo.imgIds && codeInfo.imgIds.length) {
          for (var ii = 0; ii < Math.min(codeInfo.imgIds.length, 2); ii++) {
            try { files.push(DriveApp.getFileById(codeInfo.imgIds[ii])); } catch(e) {}
          }
        }
        if (!files.length) {
          var latest = latestPhotoEntries(codeInfo.code);
          files = latest.slice(0, 2).map(function(e){ return e.file; });
        }
      } catch(e) { skipped.push(codeInfo.code); continue; }
      if (!files.length) { skipped.push(codeInfo.code); continue; }

      for (var pi = 0; pi < files.length; pi++) {
        try {
          b.appendPageBreak();

          var hdr = b.appendParagraph(codeInfo.code + (codeInfo.address ? '   |   ' + codeInfo.address : ''));
          hdr.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
          hdr.editAsText().setFontSize(12).setForegroundColor('#444466');

          var imgPara = b.appendParagraph('');
          imgPara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
          var imgInline = imgPara.appendInlineImage(files[pi].getBlob());
          var iw = imgInline.getWidth();
          var ih = imgInline.getHeight();
          var scale = Math.min(700/iw, 400/ih);
          var fw = Math.round(iw*scale);
          var fh = Math.round(ih*scale);
          imgInline.setWidth(fw);
          imgInline.setHeight(fh);
          var remaining = 455 - fh;
          var spacingBefore = Math.max(0, Math.min(Math.round(remaining / 2) + 40, 210));
          imgPara.setSpacingBefore(spacingBefore);
          imgPara.setSpacingAfter(0);
          photoCount++;
        } catch(e){ Logger.log('img ['+codeInfo.code+']: '+e.message); }
      }
    }

    doc.saveAndClose();
    var df = DriveApp.getFileById(doc.getId());
    DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).addFile(df);
    DriveApp.getRootFolder().removeFile(df);
    try{ df.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}

    return json({ success:true, docUrl:doc.getUrl(),
      pdfUrl:'https://docs.google.com/document/d/'+doc.getId()+'/export?format=pdf',
      photoCount:photoCount,
      skipped: skipped.length ? skipped : undefined });
  } catch(err) {
    Logger.log('PDF Error: '+err.message);
    return json({ success:false, error:err.message });
  }
}

// ═══════════════════════════ EMAIL / UPLOAD LOG ═══════════════════════════

function sendEmail(installer, jobName, codes, unmatched, folderUrl, mediaName, failedTotal) {
  var total = codes.reduce(function(s,c){return s+(c.count||0);},0);
  var mediaLabel = (mediaName && mediaName !== '_ไม่ระบุสื่อ') ? mediaName : '';

  var thStyle = 'padding:10px 12px;font-size:13px;border-bottom:2px solid #ccc;background:#f0f0f0;font-weight:bold;';
  var tdStyle = 'padding:10px 12px;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;';

  var rows = codes.map(function(c, i){
    var bg = i % 2 === 0 ? '#fafafa' : '#ffffff';
    var addr = c.address || '';
    if (addr.length > 60) addr = addr.substring(0, 60) + '...';
    var warn = (c.failed && c.failed > 0) ? ' <span style="color:#cc0000">⚠️'+c.failed+'</span>' : '';
    return '<tr style="background:'+bg+'">'+
      '<td style="'+tdStyle+'text-align:left;font-family:monospace;font-weight:bold;white-space:nowrap">'+c.code+'</td>'+
      '<td style="'+tdStyle+'text-align:left">'+(c.product||'')+'</td>'+
      '<td style="'+tdStyle+'text-align:left;color:#666;font-size:12px">'+addr+'</td>'+
      '<td style="'+tdStyle+'text-align:center;white-space:nowrap">'+c.count+' รูป'+warn+'</td>'+
      '<td style="'+tdStyle+'text-align:center;white-space:nowrap"><a href="'+c.folderUrl+'" style="color:#1665c1;text-decoration:none">📁 ดูรูป</a></td></tr>';
  }).join('');

  var failWarn = (failedTotal && failedTotal > 0)
    ? '<p style="color:#cc0000;font-weight:bold">⚠️ มีรูปอัปโหลดไม่สำเร็จ '+failedTotal+' รูป — แจ้งช่างส่งซ้ำเฉพาะจุดนั้น</p>' : '';

  var html='<div style="font-family:Sarabun,Arial,sans-serif;max-width:720px;padding:24px">'+
    '<h2 style="margin:0 0 4px 0">📸 ส่งรูปติดตั้ง</h2>'+
    (mediaLabel ? '<div style="font-size:16px;color:#1665c1;font-weight:bold;margin-bottom:2px">📺 '+mediaLabel+'</div>' : '')+
    '<div style="font-size:18px;font-weight:bold;margin-bottom:8px;color:#111">'+jobName+'</div>'+
    '<p style="margin:0 0 14px 0;color:#555">ช่าง <b>'+installer+'</b></p>'+
    failWarn+
    '<table style="width:100%;border-collapse:collapse;border:1px solid #e5e5e5">'+
      '<tr>'+
        '<th style="'+thStyle+'text-align:left">Code</th>'+
        '<th style="'+thStyle+'text-align:left">สินค้า</th>'+
        '<th style="'+thStyle+'text-align:left">ที่อยู่</th>'+
        '<th style="'+thStyle+'text-align:center">รูป</th>'+
        '<th style="'+thStyle+'text-align:center">Drive</th></tr>'+
      rows+'</table>'+
    '<p style="margin-top:14px">✅ <b>'+codes.length+' จุด</b> · 📸 <b>'+total+' รูป</b>'+
      (unmatched?' · ⚠️ ตรวจสอบ <b>'+unmatched+' รูป</b>':'')+
    '<br><br><a href="'+folderUrl+'" style="background:#c8f542;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">📁 เปิดโฟลเดอร์</a></p></div>';
  var subjectMedia = mediaLabel ? mediaLabel + ' · ' : '';
  MailApp.sendEmail({to:CONFIG.ADMIN_EMAIL,subject:'[ส่งรูป] '+subjectMedia+jobName+' — '+installer+' — '+codes.length+' จุด',htmlBody:html});
}

function logSheet(installer,jobName,timestamp,codes,unmatched) {
  try {
    withLock2(function() {
      var folder=DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      var files=folder.getFilesByName('_UploadLog');
      var ss;
      if(files.hasNext()){ss=SpreadsheetApp.open(files.next());}
      else{
        ss=SpreadsheetApp.create('_UploadLog');
        folder.addFile(DriveApp.getFileById(ss.getId()));
        DriveApp.getRootFolder().removeFile(DriveApp.getFileById(ss.getId()));
        ss.getActiveSheet().appendRow(['วันที่','ช่าง','งาน','Code','สินค้า','ที่อยู่','รูป','วิธี','Drive']);
      }
      var sh=ss.getActiveSheet();
      codes.forEach(function(c){sh.appendRow([timestamp,installer,jobName,c.code,c.product||'',c.address||'',c.count,c.method,c.folderUrl||'']);});
      if(unmatched>0) sh.appendRow([timestamp,installer,jobName,'_ตรวจสอบ','','',unmatched,'unmatched','']);
      return true;
    });
  } catch(e){Logger.log('Log: '+e.message);}
}

// ═══════════════════════════ UTIL / TEST ═══════════════════════════

function authorizeAll() {
  DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getName();
  MailApp.getRemainingDailyQuota();
  var testDoc = DocumentApp.create('_test_auth');
  DriveApp.getFileById(testDoc.getId()).setTrashed(true);
  var testSlide = SlidesApp.create('_test_slides_auth');
  DriveApp.getFileById(testSlide.getId()).setTrashed(true);
  CacheService.getScriptCache().put('_auth_test','ok',60);
  PropertiesService.getScriptProperties().setProperty('_auth_test','ok');
  LockService.getScriptLock().tryLock(100) && LockService.getScriptLock().releaseLock();
  Logger.log('Authorized OK');
}

/**
 * ═══ รันครั้งเดียว: เติม Photo Index ย้อนหลังให้งานเก่า ═══
 * วิธีรัน: เปิด Apps Script → เลือกฟังก์ชัน backfillPhotoIndex → กด Run → ดูผลใน Execution log
 * ถ้า log บอก "ยังไม่เสร็จ" (ข้อมูลเยอะเกิน 4.5 นาที) ให้กด Run ซ้ำจนขึ้น "เสร็จสมบูรณ์"
 */
function backfillPhotoIndex() {
  var t0 = new Date().getTime();
  var TIME_LIMIT = 4.5 * 60 * 1000;
  var timedOut = false;

  var ss = openNamedSS('_InstallLog', null);
  if (!ss) { Logger.log('ไม่พบ _InstallLog'); return; }
  var sh = ss.getActiveSheet();
  var rows = sh.getDataRange().getValues();

  // 1) หาแถวที่ยังไม่มี index
  var need = {}; // CODE(upper) -> [เลขแถว]
  var needCount = 0;
  for (var i = 1; i < rows.length; i++) {
    var cur = rows[i][7];
    var empty = !cur || String(cur).trim() === '' || String(cur).trim() === '[]';
    if (empty && rows[i][1]) {
      var c = String(rows[i][1]).trim().toUpperCase();
      if (!need[c]) need[c] = [];
      need[c].push(i + 1);
      needCount++;
    }
  }
  if (!needCount) { Logger.log('✅ เสร็จสมบูรณ์ — ทุกแถวมี Photo Index แล้ว'); return; }
  Logger.log('ต้องเติม ' + needCount + ' แถว (' + Object.keys(need).length + ' code)');

  // 2) scan Drive รอบเดียว เก็บรูปของทุก code ที่ต้องการ
  var collected = {}; // CODE -> [{id, date, name}]
  var dateRe = /^\d{4}-\d{2}-\d{2}$/;
  var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);

  function walk(folder, depth, dateCtx) {
    if (timedOut || depth > 6) return;
    if (new Date().getTime() - t0 > TIME_LIMIT) { timedOut = true; return; }
    var fs = folder.getFiles();
    while (fs.hasNext()) {
      var f = fs.next();
      var nm = f.getName().toUpperCase();
      var us = nm.lastIndexOf('_');
      if (us <= 0) continue;
      var codePart = nm.substring(0, us);
      if (!need[codePart]) continue;
      if (f.getMimeType().indexOf('image') === -1) continue;
      if (!collected[codePart]) collected[codePart] = [];
      var d = dateCtx;
      if (!d) { try { d = Utilities.formatDate(f.getDateCreated(),'Asia/Bangkok','yyyy-MM-dd'); } catch(e) { d = ''; } }
      // แชร์ลิงก์ไว้เลย ให้ thumbnail เปิดได้แน่นอน
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
      collected[codePart].push({ id: f.getId(), date: d, name: nm });
    }
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      if (timedOut) return;
      var sub = subs.next();
      var sn = sub.getName();
      if (sn.indexOf('_') === 0 && sn !== '_ไม่ระบุสื่อ') continue;
      walk(sub, depth + 1, dateRe.test(sn) ? sn : dateCtx);
    }
  }
  var months = root.getFolders();
  while (months.hasNext() && !timedOut) {
    var mo = months.next();
    if (/^[0-9]{2}[.][0-9]{4}$/.test(mo.getName())) walk(mo, 0, null);
  }

  // 3) เขียนกลับ: ใช้เฉพาะรูปของวันที่ล่าสุดต่อ code เรียงตามชื่อไฟล์
  var written = 0;
  Object.keys(collected).forEach(function(code) {
    var arr = collected[code];
    var maxDate = '';
    arr.forEach(function(x){ if (x.date > maxDate) maxDate = x.date; });
    var latest = arr.filter(function(x){ return x.date === maxDate; });
    latest.sort(function(a,b){ return a.name < b.name ? -1 : 1; });
    var idsJson = JSON.stringify(latest.slice(0, 12).map(function(x){ return x.id; }));
    need[code].forEach(function(rowNum) {
      try { sh.getRange(rowNum, 8).setValue(idsJson); written++; } catch(e) {}
    });
  });

  bustCache(['resp_ilog']);
  if (timedOut) {
    Logger.log('⏳ ยังไม่เสร็จ (หมดเวลา) — เติมไปแล้ว ' + written + ' แถว กด Run ซ้ำอีกครั้งเพื่อทำต่อ');
  } else {
    var missing = needCount - written;
    Logger.log('✅ เสร็จสมบูรณ์ — เติม ' + written + ' แถว' +
      (missing > 0 ? ' / อีก ' + missing + ' แถวไม่พบรูปใน Drive (อาจถูกลบไปแล้ว)' : ''));
  }
}

/**
 * ═══ ตัววินิจฉัย Auto-archive: รันแล้วดู Execution log ═══
 * บอกทุกงานว่าทำไมจบ/ไม่จบ พร้อมรายชื่อจุดที่ขาด log
 */
function diagnoseArchive() {
  var out = buildJobsList();
  var jobs = out.jobs || [];
  if (!jobs.length) { Logger.log('ไม่มีงาน'); return; }

  // ดึงชุด code ที่มี log ต่อ job มาโชว์จุดที่ขาด
  var doneMap = {};
  try {
    var lss = openNamedSS('_InstallLog', null);
    if (lss) {
      var lrows = lss.getActiveSheet().getDataRange().getValues();
      for (var i = 1; i < lrows.length; i++) {
        if (!lrows[i][0]) continue;
        if (!doneMap[lrows[i][0]]) doneMap[lrows[i][0]] = {};
        doneMap[lrows[i][0]][String(lrows[i][1]).trim().toUpperCase()] = true;
      }
    }
  } catch(e) {}

  var todayD = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  jobs.forEach(function(j) {
    var missing = [];
    (j.spots||[]).forEach(function(s) {
      var c = String(s.code).trim().toUpperCase();
      if (!(doneMap[j.id] && doneMap[j.id][c])) missing.push(s.code);
    });
    var endRaw = j.dateEnd ? String(j.dateEnd) : '(ไม่มี)';
    var complete = j.done >= j.total && j.total > 0;
    var reason;
    if (j.archived) reason = '✅ จบแล้ว (เข้าหมวด archive)';
    else if (!complete) reason = '⛔ ยังไม่ครบ — ขาด log ' + missing.length + ' จุด: ' + missing.slice(0,8).join(', ') + (missing.length>8?' ...':'');
    else if (!j.dateEnd) reason = '⏳ ครบแล้ว แต่ไม่มีวันสิ้นสุด — รอครบ 7 วันหลังติดจุดสุดท้าย';
    else reason = '⏳ ครบแล้ว แต่ยังไม่เลยวันสิ้นสุด (สิ้นสุด: ' + endRaw + ' / วันนี้: ' + todayD + ')';
    Logger.log('[' + j.name + '] ' + j.done + '/' + j.total + ' | สิ้นสุด: ' + endRaw + ' → ' + reason);
  });
  Logger.log('— จบรายงาน —');
}

/**
 * ═══ Backup อัตโนมัติ ═══
 * รัน setupDailyBackup ครั้งเดียว → ระบบสำรองชีททุกวัน 03:00 เก็บ 14 ชุดล่าสุด
 * ที่เก็บ: โฟลเดอร์ "PlanB_App_Backup" ใน My Drive (นอกโฟลเดอร์แอป — แอปโดนลบ backup ยังอยู่)
 */
var BACKUP_KEEP = 14;

function backupSystemSheets() {
  var bf = mkFolder(DriveApp.getRootFolder(), 'PlanB_App_Backup');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd_HHmm');
  var dayFolder = bf.createFolder(stamp);
  var copied = 0;
  ['_Jobs','_InstallLog','_UploadLog','_ProblemLog','_RepairLog','_Installers'].forEach(function(name) {
    try {
      var ss = openNamedSS(name, null);
      if (ss) { DriveApp.getFileById(ss.getId()).makeCopy(name + '_' + stamp, dayFolder); copied++; }
    } catch(e) { Logger.log('backup ' + name + ': ' + e.message); }
  });
  // ลบชุดเก่าเกิน BACKUP_KEEP
  var subs = bf.getFolders(), list = [];
  while (subs.hasNext()) list.push(subs.next());
  list.sort(function(a,b){ return a.getName() < b.getName() ? -1 : 1; });
  while (list.length > BACKUP_KEEP) { try { list.shift().setTrashed(true); } catch(e) {} }
  Logger.log('✅ Backup เสร็จ: ' + stamp + ' (' + copied + ' ชีท) — เก็บย้อนหลัง ' + Math.min(list.length, BACKUP_KEEP) + ' ชุด');
}

function setupDailyBackup() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'backupSystemSheets') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSystemSheets').timeBased().everyDays(1).atHour(3).create();
  backupSystemSheets(); // สำรองทันที 1 รอบให้เห็นผลเลย
  Logger.log('✅ ตั้งสำรองอัตโนมัติทุกวัน 03:00 น. เรียบร้อย');
}

function testPDF() {
  try {
    Logger.log('Starting testPDF...');
    var result = createSalesPDF({
      jobName: 'Test Job',
      media: 'Cookies',
      dateStart: '2026-06-01',
      dateEnd: '2026-06-03',
      codes: [{ code: 'DP703', address: 'ที่อยู่ทดสอบ', product: 'Test', folderUrl: '' }]
    });
    var parsed = JSON.parse(result.getContent());
    Logger.log('photoCount: ' + parsed.photoCount);
    Logger.log('docUrl: ' + parsed.docUrl);
  } catch(e) {
    Logger.log('ERROR: ' + e.message);
    Logger.log(e.stack);
  }
}

// ═══════════════════════════ AUTO-CLOSE JOB (งานครบ → ยืนยัน → ส่งเซล) ═══════════════════════════

var PORTAL_BASE_URL = 'https://saranya-cmyk.github.io/installation-app/portal.html?key=';

function findJobRow(jobId) {
  var sh = getJobSheet();
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === jobId) return { sh: sh, row: i + 1, values: rows[i] };
  }
  return null;
}

/** เช็คว่าทุกจุดของงานติดตั้งครบหรือยัง — ถ้าครบและยังไม่เคยแจ้ง ส่งอีเมลให้แอดมินกดยืนยัน */
function checkJobCompletion(jobId) {
  var jr = findJobRow(jobId);
  if (!jr) return;
  if (String(jr.values[6]) === 'false') return;          // งานถูกลบแล้ว
  var sentStatus = String(jr.values[11] || '').trim();
  if (sentStatus) return;                                 // แจ้งไปแล้ว (pending/sent) ไม่แจ้งซ้ำ

  var spots;
  try { spots = JSON.parse(jr.values[2] || '[]'); } catch(e) { return; }
  if (!spots.length) return;

  // นับจุดที่ติดแล้วจาก _InstallLog
  var doneCodes = {};
  var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var files = folder.getFilesByName('_InstallLog');
  if (!files.hasNext()) return;
  var lrows = SpreadsheetApp.open(files.next()).getActiveSheet().getDataRange().getValues();
  for (var i = 1; i < lrows.length; i++) {
    if (lrows[i][0] === jobId) doneCodes[String(lrows[i][1]).trim().toUpperCase()] = true;
  }
  var doneCount = 0;
  spots.forEach(function(s){ if (doneCodes[String(s.code).trim().toUpperCase()]) doneCount++; });
  if (doneCount < spots.length) return; // ยังไม่ครบ

  // ครบ 100% — สร้าง approveKey + ตั้งสถานะ pending + ส่งอีเมลยืนยันถึงแอดมิน
  var approveKey = genPortalKey() + genPortalKey(); // 20 ตัวอักษร
  jr.sh.getRange(jr.row, 11).setValue(approveKey);
  jr.sh.getRange(jr.row, 12).setValue('pending');

  var jobName = jr.values[1] || '';
  var media = jr.values[7] || '';
  var salesEmail = String(jr.values[9] || '').trim();
  var confirmUrl = ScriptApp.getService().getUrl() + '?action=approveSend&jobId=' + encodeURIComponent(jobId) + '&k=' + approveKey;

  var html = '<div style="font-family:Sarabun,Arial,sans-serif;max-width:600px;padding:24px">'+
    '<div style="background:linear-gradient(135deg,#2e7d32,#66bb6a);color:#fff;padding:22px;border-radius:12px 12px 0 0;text-align:center">'+
      '<div style="font-size:34px">🎉</div>'+
      '<h2 style="margin:6px 0 0 0">งานติดตั้งครบ 100%</h2></div>'+
    '<div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:22px;text-align:center">'+
      (media ? '<div style="color:#1665c1;font-weight:bold;margin-bottom:4px">📺 '+media+'</div>' : '')+
      '<div style="font-size:20px;font-weight:bold;margin-bottom:6px">'+jobName+'</div>'+
      '<div style="color:#555;margin-bottom:18px">ติดตั้งครบทั้ง <b>'+spots.length+' จุด</b> เรียบร้อยแล้ว</div>'+
      '<div style="background:#f7f7f7;border-radius:10px;padding:12px;font-size:13px;color:#666;margin-bottom:18px">'+
        (salesEmail ? 'เมื่อกดยืนยัน ระบบจะสร้าง PDF รูปติดตั้ง แล้วส่งให้เซล<br><b style="color:#111">'+salesEmail+'</b><br>พร้อมลิงก์ให้ลูกค้าดูสถานะเรียลไทม์ (CC ถึงคุณด้วย)'
                    : '⚠️ งานนี้<b>ไม่ได้ระบุอีเมลเซล</b> — เมื่อกดยืนยัน ระบบจะสร้าง PDF และส่งทุกอย่างมาที่อีเมลคุณ เพื่อส่งต่อเอง')+
      '</div>'+
      '<a href="'+confirmUrl+'" style="background:#2e7d32;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">✅ ยืนยัน — สร้าง PDF และส่งเซล</a>'+
      '<div style="color:#999;font-size:11px;margin-top:14px">การสร้าง PDF ใช้เวลา 1-3 นาที กดแล้วรอหน้ายืนยันขึ้นก่อนปิดนะคะ</div>'+
    '</div></div>';

  MailApp.sendEmail({ to: CONFIG.ADMIN_EMAIL,
    subject: '🎉 [งานครบ 100%] ' + jobName + ' — กดยืนยันเพื่อส่งเซล',
    htmlBody: html });
}

/** แอดมินกดปุ่มยืนยันจากอีเมล → สร้าง PDF → ส่งเซล + ลิงก์ Portal → ปิดจ็อบ */
function approveSend(p) {
  function page(title, msg, ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Sarabun,Arial,sans-serif;max-width:460px;margin:60px auto;text-align:center;padding:20px">'+
      '<div style="font-size:56px">'+(ok?'✅':'⚠️')+'</div>'+
      '<h2 style="color:'+(ok?'#2e7d32':'#c62828')+'">'+title+'</h2>'+
      '<p style="color:#555;line-height:1.7">'+msg+'</p>'+
      '<p style="color:#aaa;font-size:12px;margin-top:30px">ปิดหน้านี้ได้เลยค่ะ — Plan B Installation App</p></div>')
      .setTitle('Plan B — ' + title);
  }
  try {
    var jr = findJobRow(p.jobId || '');
    if (!jr) return page('ไม่พบงาน', 'ลิงก์อาจไม่ถูกต้อง หรืองานถูกลบไปแล้ว', false);
    if (String(jr.values[10] || '').trim() !== String(p.k || '').trim() || !p.k)
      return page('ลิงก์ไม่ถูกต้อง', 'กรุณาใช้ปุ่มจากอีเมลฉบับล่าสุดค่ะ', false);

    var sentStatus = String(jr.values[11] || '').trim();
    if (sentStatus.indexOf('sent') === 0)
      return page('ส่งไปแล้วค่ะ', 'งานนี้ถูกยืนยันและส่งให้เซลไปแล้วเมื่อ ' + sentStatus.replace('sent ','') + '<br>ไม่ต้องส่งซ้ำค่ะ', true);

    var jobId = jr.values[0], jobName = jr.values[1] || '', media = jr.values[7] || '';
    var dateStart = jr.values[4] ? String(jr.values[4]) : '';
    var dateEnd = jr.values[5] ? String(jr.values[5]) : '';
    var salesEmail = String(jr.values[9] || '').trim();
    var spots = JSON.parse(jr.values[2] || '[]');

    // 1) สร้าง PDF รูปติดตั้ง
    var codes = spots.map(function(s){ return { code: s.code, address: s.address || '', product: s.product || '' }; });
    var pdfRes = JSON.parse(createSalesPDF({ jobName: jobName, media: media,
      dateStart: dateStart, dateEnd: dateEnd, codes: codes }).getContent());
    if (!pdfRes.success) return page('สร้าง PDF ไม่สำเร็จ', (pdfRes.error||'') + '<br>ลองกดปุ่มในอีเมลอีกครั้งค่ะ', false);

    // 2) ลิงก์ Portal เรียลไทม์ (สร้าง key ถ้ายังไม่มี)
    var portalKey = String(jr.values[8] || '').trim();
    if (!portalKey) { portalKey = genPortalKey(); jr.sh.getRange(jr.row, 9).setValue(portalKey); }
    var portalUrl = PORTAL_BASE_URL + portalKey;

    // 3) ส่งอีเมลถึงเซล (หรือแอดมินถ้าไม่มีเซล)
    var noSales = !salesEmail;
    var to = noSales ? CONFIG.ADMIN_EMAIL : salesEmail;
    var mailHtml = '<div style="font-family:Sarabun,Arial,sans-serif;max-width:620px;padding:24px">'+
      '<h2 style="margin:0 0 4px 0">📦 งานติดตั้งเสร็จสมบูรณ์ พร้อมส่งมอบ</h2>'+
      (media ? '<div style="color:#1665c1;font-weight:bold">📺 '+media+'</div>' : '')+
      '<div style="font-size:19px;font-weight:bold;margin:4px 0 14px 0">'+jobName+'</div>'+
      (noSales ? '<p style="color:#c62828;font-weight:bold">⚠️ งานนี้ไม่ได้ระบุอีเมลเซล — กรุณาส่งต่อให้เซลผู้ดูแลเองค่ะ</p>' : '')+
      '<p style="color:#555">ติดตั้งครบทั้ง <b>'+spots.length+' จุด</b> เรียบร้อยแล้ว เอกสารส่งมอบตามนี้ค่ะ</p>'+
      '<div style="margin:18px 0">'+
        '<a href="'+(pdfRes.pdfUrl||pdfRes.docUrl)+'" style="background:#c62828;color:#fff;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:bold;display:inline-block;margin:0 8px 8px 0">📄 ดาวน์โหลด PDF รูปติดตั้ง</a>'+
        '<a href="'+portalUrl+'" style="background:#2e7d32;color:#fff;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:bold;display:inline-block;margin-bottom:8px">🔗 ลิงก์สถานะเรียลไทม์ (ส่งให้ลูกค้าได้เลย)</a>'+
      '</div>'+
      '<div style="background:#f7f7f7;border-radius:10px;padding:14px;font-size:13px;color:#555">'+
        '💡 ลิงก์เรียลไทม์เปิดได้ทุกอุปกรณ์ ไม่ต้อง login — ลูกค้าเห็นชื่อสื่อ สินค้า แผนที่ และรูปติดตั้งของทุกจุด อัปเดตอัตโนมัติ<br>'+
        '<span style="color:#888;word-break:break-all">'+portalUrl+'</span>'+
      '</div></div>';
    var mailOpts = { to: to,
      subject: '📦 [ส่งมอบงาน] ' + (media ? media + ' · ' : '') + jobName + ' — ครบ ' + spots.length + ' จุด',
      htmlBody: mailHtml };
    if (!noSales) mailOpts.cc = CONFIG.ADMIN_EMAIL;
    MailApp.sendEmail(mailOpts);

    // 4) ปิดสถานะ
    var doneStamp = 'sent ' + Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
    jr.sh.getRange(jr.row, 12).setValue(doneStamp);

    return page('ส่งเรียบร้อยแล้ว 🎉',
      'งาน <b>'+jobName+'</b><br>PDF รูปติดตั้ง ('+(pdfRes.photoCount||0)+' รูป) + ลิงก์เรียลไทม์<br>ส่งถึง <b>'+to+'</b> แล้ว'+
      (noSales ? '<br><span style="color:#c62828">(งานนี้ไม่มีอีเมลเซล จึงส่งเข้าอีเมลแอดมิน)</span>' : ' (CC ถึงแอดมิน)'), true);
  } catch(err) {
    return page('เกิดข้อผิดพลาด', err.message + '<br>ลองกดปุ่มในอีเมลอีกครั้ง หรือติดต่อผู้ดูแลระบบค่ะ', false);
  }
}
