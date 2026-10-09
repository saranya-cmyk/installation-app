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

// ค่าที่เคยเปิดเผยตรงๆ (Drive folder, อีเมลแอดมิน) ย้ายมาเก็บใน Script Properties แทน
// + กันพัง: ถ้าไม่มีค่า/พิมพ์ผิด ระบบหาเองจากข้อมูลที่จำไว้แล้ว และบันทึกกลับให้อัตโนมัติ
var _props = PropertiesService.getScriptProperties();
function _resolveFolderId() {
  var id = String(_props.getProperty('DRIVE_FOLDER_ID') || '').trim();
  if (id) {
    try { DriveApp.getFolderById(id); return id; } catch (e) { /* ID ผิด → ลองหาเองด้านล่าง */ }
  }
  // โฟลเดอร์หลัก = โฟลเดอร์ที่เก็บชีท _InstallLog / _Jobs ซึ่งระบบจำ ID ไว้แล้ว
  var keys = ['fid__InstallLog', 'fid__Jobs', 'fid__ProblemLog'];
  for (var i = 0; i < keys.length; i++) {
    var fid = _props.getProperty(keys[i]);
    if (!fid) continue;
    try {
      var parents = DriveApp.getFileById(fid).getParents();
      if (parents.hasNext()) {
        var found = parents.next().getId();
        _props.setProperty('DRIVE_FOLDER_ID', found);
        return found;
      }
    } catch (e) {}
  }
  return id || null;
}
// 📧 อีเมลที่รับแจ้งเตือนทุกฉบับ (รูปเข้า / รายงานประจำวัน / ปัญหาหน้างาน) · หลายคนคั่นด้วย ,
//    ถ้าตั้ง ADMIN_EMAIL ใน Script properties ไว้ ระบบจะใช้ค่านั้นก่อน
var DEFAULT_ADMIN_EMAIL = 'saranya@planbmedia.co.th';
function _resolveAdminEmail() {
  var e = String(_props.getProperty('ADMIN_EMAIL') || '').trim();
  if (e) return e;
  if (DEFAULT_ADMIN_EMAIL) return DEFAULT_ADMIN_EMAIL;
  // ตอนช่าง/ลูกค้าเรียกผ่านเว็บ Google มักไม่บอกอีเมลเจ้าของ (ได้ค่าว่าง) → ต้องเก็บไว้ใน Script Properties
  try { e = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || ''; } catch (err) { e = ''; }
  if (!e) e = _driveOwnerEmail_();
  if (e) { try { _props.setProperty('ADMIN_EMAIL', e); } catch (err) {} }   // เจอครั้งเดียว จำไว้ใช้ตลอด
  return e;
}
// ▶ ตั้งอีเมลแอดมิน: ใน Apps Script เลือกฟังก์ชัน setupAdminEmail แล้วกด Run (ครั้งเดียวพอ)
//   ระบบจะจำอีเมลของบัญชีที่กด Run ไว้ส่งแจ้งเตือนทุกฉบับ · อยากใช้อีเมลอื่น ให้แก้ค่า ADMIN_EMAIL ใน Project Settings → Script properties
// สคริปต์บางตัวไม่มีสิทธิ์อ่านอีเมลผู้ใช้ (Session คืนค่าว่าง) → ใช้อีเมลเจ้าของโฟลเดอร์รูป/ไดรฟ์แทน (ใช้สิทธิ์ Drive ที่มีอยู่แล้ว)
function _driveOwnerEmail_() {
  var id = String(_props.getProperty('DRIVE_FOLDER_ID') || '').trim();
  try { if (id) { var o = DriveApp.getFolderById(id).getOwner(); if (o && o.getEmail()) return o.getEmail(); } } catch (err) {}
  try { var r = DriveApp.getRootFolder().getOwner(); if (r && r.getEmail()) return r.getEmail(); } catch (err) {}
  return '';
}
function setupAdminEmail() {
  var e = '';
  try { e = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || ''; } catch (err) {}
  if (!e) e = _driveOwnerEmail_();
  if (!e) throw new Error('หาอีเมลบัญชีนี้ไม่เจอ — ใส่เองที่ Project Settings → Script properties: ADMIN_EMAIL');
  _props.setProperty('ADMIN_EMAIL', e);
  MailApp.sendEmail(e, '[Snap] ทดสอบอีเมลแจ้งเตือน', 'ตั้งค่าเรียบร้อย — ต่อจากนี้ระบบจะส่งอีเมลแจ้งรูปเข้า/งานครบมาที่ ' + e);
  Logger.log('✅ ตั้ง ADMIN_EMAIL = ' + e + ' และส่งอีเมลทดสอบแล้ว');
  return e;
}
var CONFIG = {
  DRIVE_FOLDER_ID: _resolveFolderId(),
  ADMIN_EMAIL:     _resolveAdminEmail(),
  REPAIR_EMAIL:    '', // 🔧 ใส่อีเมลทีมซ่อมตรงนี้ (เว้นว่าง = ส่งหาแอดมินอย่างเดียว, ใส่หลายคนคั่นด้วย ,)
  INSTALLERS_SHEET_ID: '', // 👷 ใส่ ID ชีทรายชื่อช่าง (จาก URL ของชีท) หรือเว้นว่างแล้วตั้งชื่อไฟล์ชีทว่า _Installers ไว้ในโฟลเดอร์แอป
};

var SESSION_TTL_SEC = 3600; // อายุ session upload (1 ชม.)

// ═══════════════════════════ ROUTER ═══════════════════════════

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'login')           return login(body);
    if (body.action === 'authInfo')        return authInfo();
    if (body.action === 'otpSend')         return otpSend(body);
    if (body.action === 'otpVerify')       return otpVerify(body);
    if (body.action === 'pwStatus')        return pwStatus(body);
    if (body.action === 'pwLogin')         return pwLogin(body);
    var tokP = (e.parameter && e.parameter.t) || body.t;
    var who = _authOf(tokP);
    body._role = who.role;   // ไว้ให้ deletePhotos รู้ว่าเป็นแอดมินหรือช่าง (ฝั่งแอปส่งค่านี้มาเองไม่ได้)
    body._who = who.email;   // อีเมลแอดมินที่ล็อกอิน (จากบัตรผ่าน ไม่ใช่จากแอป)
    var gateP = _authGate(body.action, tokP, body);
    if (gateP) return gateP;
    _audit_(body);
    if (body.action === 'uploadBatch')     return uploadBatch(body);
    if (body.action === 'uploadDone')      return uploadDone(body);
    if (body.action === 'saveJob')         return withLock(function(){ return saveJobFn(body.job); });
    if (body.action === 'deleteJob')       return withLock(function(){ return deleteJobFn(body.jobId); });
    if (body.action === 'fixCode')         return withLock(function(){ return fixCode(body); });
    if (body.action === 'exportReport')    return exportReport(body);
    if (body.action === 'createPDF')       return createSalesPDF(body);
    if (body.action === 'deleteCodeFiles') return withLock(function(){ return deleteCodeFiles(body); });
    if (body.action === 'deletePhotos')    return deletePhotosFn(body);
    if (body.action === 'reportProblem')   return reportProblem(body);
    if (body.action === 'reportRepair')    return reportRepair(body);
    if (body.action === 'aiSaveChecks')    return withLock(function(){ return aiSaveChecks(body); });
    if (body.action === 'aiDecision')      return withLock(function(){ return aiDecision(body); });
    if (body.action === 'aiDraft')         return aiDraft(body);
    if (body.action === 'securityInfo')    return securityInfo(body);
    if (body.action === 'securitySet')     return securitySet(body);
    return json({ error: 'unknown action' });
  } catch(err) { return json({ error: err.message }); }
}

function doGet(e) {
  var p = e ? e.parameter : {};
  var gateG = _authGate(p.action, p.t, p);
  if (gateG) return gateG;
  if (p.action === 'getPhotos')      return getPhotos(p);
  if (p.action === 'getPhotoThumbs') return getPhotoThumbs(p);
  if (p.action === 'aiPending')      return aiPending(p);
  if (p.action === 'aiThumbs')       return aiThumbs(p);
  if (p.action === 'getJobs')        return getJobsList(p);
  if (p.action === 'getInstallLog')  return getInstallLog(p);
  if (p.action === 'getProblemLog')  return getProblemLog(p);
  if (p.action === 'getRepairLog')   return getRepairLog(p);
  if (p.action === 'getInstallers')  return getInstallers(p);
  if (p.action === 'approveSend') {
    if (p.go === '1') _auditWrite_('ลิงก์ยืนยันในอีเมล', 'approveSend', 'งาน ' + (p.jobId || '') + ' → ' + (p.to || ''));
    return approveSend(p);
  }
  if (p.action === 'portalLink')     return getPortalLink(p);
  if (p.action === 'portalData')     return getPortalData(p);
  if (p.action === 'mailStatus')     return mailStatus();
  return ContentService.createTextOutput('OK');
}

// ═══════════════════════════ SECURITY (ล็อกอิน) ═══════════════════════════
// ทุกคำขอต้องมี "บัตรผ่าน" (t) — Apps Script ตรวจเองทุกครั้ง ไม่ได้พึ่งแค่หน้าแอป
//   แอดมิน (Snaphub/War Room) = อีเมล + รหัสผ่านส่วนตัว → บัตรผ่านถึงสิ้นวัน (วันรุ่งขึ้นใส่ใหม่)
//                       ตั้งรหัสครั้งแรก / ลืมรหัส = ยืนยันด้วยรหัส 6 หลักทางอีเมลแล้วตั้งใหม่ · เปลี่ยนรหัสได้ในเมนู 🔒
//                       ต้องเป็นอีเมลที่อยู่ในรายชื่อแอดมิน · เจ้าของระบบ (ADMIN_EMAIL) เพิ่ม/ลบรายชื่อได้ในเมนู 🔒
//                       ลบชื่อออก = คนนั้นใช้ไม่ได้ทันที · ทุกคำสั่งสำคัญบันทึกลงชีท _AuditLog ว่าใครทำ
//   ช่าง (Snapsite)    = ไม่ต้องล็อกอิน → ทำได้แค่ส่งรูป/แจ้งปัญหา/ดูงานที่ต้องติด
//                       ลบรูปได้เฉพาะรูปที่เพิ่งส่งไม่เกิน 3 วัน (รูปที่ลบไปอยู่ถังขยะ Drive กู้คืนได้ 30 วัน)
//   จอ War Room / หุ่นยนต์ AI = รหัสจอ (ดูในเมนู 🔒) → ดูอย่างเดียว + บันทึกผล AI
//   ลูกค้า (Portal) และลิงก์ยืนยันในอีเมล ใช้ลิงก์ที่มีรหัสเฉพาะงานอยู่แล้ว ไม่ต้องล็อกอิน
// ขั้นตอนเปิดใช้ (ทำในแอปได้ทั้งหมด): เปิด Snaphub → ใส่อีเมล → เมนู 🔒 เพิ่มรายชื่อแอดมิน/ลิงก์จอ → กด "เปิดใช้งาน"
// ฉุกเฉิน (ใช้งานไม่ได้): รัน disableSecurity() ใน Apps Script
var AUTH_PUBLIC = { '': 1, login: 1, authInfo: 1, otpSend: 1, otpVerify: 1, pwStatus: 1, pwLogin: 1, approveSend: 1, portalData: 1,
  // แอปช่าง (ไม่ต้องล็อกอิน) — ทำได้แค่ส่งรูป/แจ้งปัญหา/ดูงานที่ต้องติด
  uploadBatch: 1, uploadDone: 1, reportProblem: 1, reportRepair: 1, deletePhotos: 1,
  getInstallers: 1, getInstallLog: 1, getPhotos: 1, getJobsField: 1 };
var AUTH_ACL = {           // งานที่จอ War Room / หุ่นยนต์ AI ทำได้ (แอดมินทำได้ทุกอย่าง · ที่ไม่อยู่ในรายการ = แอดมินเท่านั้น)
  getJobs: ['view'], getProblemLog: ['view'], aiPending: ['view'], aiThumbs: ['view'], aiSaveChecks: ['view'], getPhotoThumbs: ['view']
};
var AUTH_DAYS = { admin: 30, view: 365 };
var TECH_DELETE_HOURS = 72;  // ช่างลบรูปได้เฉพาะรูปที่ส่งมาไม่เกินกี่ชั่วโมง (แอดมินลบได้ทุกรูป)
var AUDIT_ACTIONS = { saveJob: 1, deleteJob: 1, fixCode: 1, createPDF: 1, deleteCodeFiles: 1, deletePhotos: 1, aiDecision: 1, exportReport: 1, securitySet: 1 };

function _authOn() { return _props.getProperty('AUTH_ENFORCE') === '1'; }
function _ownerEmail_() { return String(CONFIG.ADMIN_EMAIL || '').split(',')[0].trim().toLowerCase(); }
function _adminList_() {
  var list = []; try { list = JSON.parse(_props.getProperty('ADMIN_LIST') || '[]'); } catch (e) {}
  var own = _ownerEmail_();
  if (own && list.indexOf(own) < 0) list.unshift(own);
  return list;
}
function _isAdminEmail_(em) { em = String(em || '').trim().toLowerCase(); return !!em && _adminList_().indexOf(em) > -1; }
function _ensureKeys_() {
  if (!_props.getProperty('AUTH_SECRET')) _props.setProperty('AUTH_SECRET', _rand_(40));
  if (!_props.getProperty('VIEW_KEY')) _props.setProperty('VIEW_KEY', _rand_(16));
}
function _sign_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, _props.getProperty('AUTH_SECRET') || '')).replace(/=+$/, '');
}
function _b64_(s) { return Utilities.base64EncodeWebSafe(String(s)).replace(/=+$/, ''); }
function _unb64_(s) { try { return Utilities.newBlob(Utilities.base64DecodeWebSafe(s + '===='.slice(s.length % 4 || 4))).getDataAsString(); } catch (e) { return ''; } }
/** เวลาสิ้นวันนี้ (23:59:59 เวลาไทย) — บัตรผ่านแอดมินหมดอายุทุกสิ้นวัน ต้องใส่รหัสผ่านใหม่วันรุ่งขึ้น */
function _endOfDayTH_() {
  var now = Date.now(), th = new Date(now + 7 * 3600000);
  var end = Date.UTC(th.getUTCFullYear(), th.getUTCMonth(), th.getUTCDate(), 23, 59, 59) - 7 * 3600000;
  return end;
}
function _makeToken_(role, email) {
  var exp = role === 'admin' ? _endOfDayTH_() : (Date.now() + AUTH_DAYS[role] * 86400000);
  var body = role + '.' + exp + '.' + _b64_(email || '-');
  return body + '.' + _sign_(body);
}
/** บัตรผ่าน → {role:'admin'|'view'|'', email} · แอดมินที่ถูกลบชื่อออกแล้ว = ใช้ไม่ได้ทันที */
function _authOf(t) {
  var none = { role: '', email: '' };
  t = String(t || '');
  if (!t || !_props.getProperty('AUTH_SECRET')) return none;
  var vk = _props.getProperty('VIEW_KEY');
  if (vk && vk.length >= 12 && t === vk) return { role: 'view', email: '' };   // หุ่นยนต์ AI ใช้รหัสจอตรงๆ (GitHub Secrets)
  var parts = t.split('.');
  if (parts.length !== 4 || !AUTH_DAYS[parts[0]]) return none;
  if (_sign_(parts[0] + '.' + parts[1] + '.' + parts[2]) !== parts[3]) return none;
  if (Number(parts[1]) < Date.now()) return none;
  var em = parts[2] === '-' ? '' : _unb64_(parts[2]);
  if (parts[0] === 'admin' && !_isAdminEmail_(em)) return none;
  return { role: parts[0], email: em };
}
function _roleOf(t) { return _authOf(t).role; }
function _authAllowed(action, role) {
  if (AUTH_PUBLIC[action || '']) return true;
  if (role === 'admin') return true;
  var who = AUTH_ACL[action];
  return !!(who && role && who.indexOf(role) > -1);
}
/** คืน null = ผ่าน · คืนคำตอบ error = ไม่ผ่าน (เฉพาะตอนเปิดใช้ AUTH_ENFORCE แล้ว) */
function _authGate(action, t, p) {
  var role = _roleOf(t);
  // รายการงาน: ถ้าไม่ใช่แอดมิน/จอ → ให้ดูแบบช่างอัตโนมัติ (เฉพาะงานที่ยังไม่จบ ไม่มีอีเมลเซล) แทนการปฏิเสธ
  if (action === 'getJobs' && p && (p.view === 'field' || (role !== 'admin' && role !== 'view' && _authOn()))) { p.view = 'field'; action = 'getJobsField'; }
  // คนที่ไม่ได้ล็อกอิน (แอปช่าง/คนนอกที่รู้ลิงก์ Apps Script) เห็นข้อมูลแคบที่สุด: เฉพาะงานที่ระบุ · ไม่เห็นลิงก์โฟลเดอร์ Drive
  if (p && role !== 'admin' && role !== 'view') {
    if (action === 'getInstallLog' && !p.jobId) return json({ log: [], error: 'กรุณาเข้าสู่ระบบ', auth: true });
    if (action === 'getInstallLog' || action === 'getPhotos') p._field = '1';
  } else if (p) { try { delete p._field; } catch (e) {} }
  if (_authAllowed(action, role)) return null;
  if (!_authOn()) {         // โหมดทดลอง: ยังปล่อยผ่าน แต่จดไว้ว่ายังมีคำขอที่ไม่มีบัตรผ่าน (ดูได้ในเมนู 🔒)
    try { CacheService.getScriptCache().put('auth_last_miss', String(action) + ' @ ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM HH:mm'), 21600); } catch (e) {}
    return null;
  }
  return json({ error: 'กรุณาเข้าสู่ระบบ', auth: true });
}
/** บันทึกว่าใครทำอะไร (ชีท _AuditLog) — พลาดก็ไม่ทำให้งานหลักล้ม */
function _audit_(body) {
  if (!AUDIT_ACTIONS[body.action]) return;
  if (body.action === 'deletePhotos' && body._role !== 'admin') return;   // ช่างลบรูปตัวเอง ไม่ต้องบันทึกที่นี่
  try {
    var d = [];
    if (body.jobId) d.push('งาน ' + body.jobId);
    if (body.job && (body.job.name || body.job.id)) d.push('งาน ' + (body.job.name || body.job.id));
    if (body.code) d.push('Code ' + body.code);
    if (body.codes && body.codes.length) d.push(body.codes.length + ' จุด');
    if (body.fileIds && body.fileIds.length) d.push(body.fileIds.length + ' รูป');
    if (body.geminiKey !== undefined) d.push(body.geminiKey ? 'ตั้งคีย์ Gemini' : 'ลบคีย์ Gemini'); if (body.enforce === true) d.push('เปิดใช้ความปลอดภัย'); if (body.enforce === false) d.push('ปิดการบังคับ');
    if (body.changePass) d.push('เปลี่ยนรหัสผ่าน'); if (body.addAdmin) d.push('เพิ่มแอดมิน ' + body.addAdmin); if (body.removeAdmin) d.push('ลบแอดมิน ' + body.removeAdmin);
    _auditWrite_(body._who || '(ไม่ได้ล็อกอิน)', body.action, d.join(' · '));
  } catch (e) {}
}
function _auditWrite_(who, action, detail) {
  try {
    var ss = openNamedSS('_AuditLog', ['เวลา', 'ใคร', 'ทำอะไร', 'รายละเอียด']);
    if (ss) ss.getActiveSheet().appendRow([Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'), who, action, detail || '']);
  } catch (e) {}
}
function authInfo() {
  return json({ ok: true, enforce: _authOn(), domain: 'planbmedia.co.th' });
}
/** แอดมินใส่อีเมลตัวเอง → ส่งรหัส 6 หลักไปอีเมลนั้น (เฉพาะอีเมลที่อยู่ในรายชื่อแอดมิน) */
function otpSend(body) {
  var em = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ ok: false, error: 'อีเมลไม่ถูกต้อง' });
  if (!_isAdminEmail_(em)) return json({ ok: false, error: 'อีเมลนี้ยังไม่มีสิทธิ์แอดมิน — ขอให้ ' + _ownerEmail_().replace(/^(.{2}).*(@.*)$/, '$1***$2') + ' เพิ่มชื่อในเมนู 🔒' });
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('otp_n_' + em) || 0), g = Number(cache.get('otp_n_all') || 0);
  if (n >= 3 || g >= 30) return json({ ok: false, error: 'ขอรหัสบ่อยเกินไป รอ 15 นาทีแล้วลองใหม่' });
  cache.put('otp_n_' + em, String(n + 1), 900); cache.put('otp_n_all', String(g + 1), 900);
  var code = _rand_(6, '0123456789');
  cache.put('otp_' + em, code, 600); cache.remove('otp_f_' + em);
  MailApp.sendEmail({ to: em, subject: '[Snap] รหัสยืนยันตั้งรหัสผ่าน: ' + code,
    htmlBody: _wrapMail_('<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;padding:20px 24px;text-align:center">' +
      '<p>รหัสยืนยันสำหรับตั้งรหัสผ่าน Snap ของคุณคือ</p>' +
      '<p style="font-size:34px;font-weight:bold;letter-spacing:8px;color:' + PLANB_BLUE + ';margin:10px 0">' + code + '</p>' +
      '<p style="color:#555;font-size:13px">ใส่รหัสนี้แล้วตั้งรหัสผ่านใหม่ — รหัสผ่านเดียวใช้ได้ทั้ง Snaphub และ War Room</p>' +
      '<p style="color:#999;font-size:12px">ใช้ได้ภายใน 10 นาที · ถ้าคุณไม่ได้ขอรหัสนี้ ไม่ต้องทำอะไร</p></div>') });
  return json({ ok: true });
}
/** ยืนยัน OTP + ตั้งรหัสผ่านใหม่ (ครั้งแรก / ลืมรหัส) → เข้าสู่ระบบ */
function otpVerify(body) {
  var em = String(body.email || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var real = cache.get('otp_' + em);
  if (!real || !_isAdminEmail_(em)) return json({ ok: false, error: 'รหัสหมดอายุ — กดขอรหัสใหม่' });
  var f = Number(cache.get('otp_f_' + em) || 0);
  if (String(body.code || '').trim() !== real) {
    if (f + 1 >= 5) cache.remove('otp_' + em); else cache.put('otp_f_' + em, String(f + 1), 600);
    Utilities.sleep(700);
    return json({ ok: false, error: f + 1 >= 5 ? 'ใส่รหัสผิดหลายครั้ง — กดขอรหัสใหม่' : 'รหัสยืนยันไม่ถูกต้อง' });
  }
  var np = String(body.newPass || '');
  if (np.length < 8) return json({ ok: false, error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว' });
  cache.remove('otp_' + em); cache.remove('otp_f_' + em); cache.remove('pw_f_' + em);
  _ensureKeys_();
  _setPass_(em, np);
  _auditWrite_(em, 'setPassword', 'ตั้งรหัสผ่านใหม่ (ยืนยันด้วยรหัสทางอีเมล)');
  return json({ ok: true, role: 'admin', email: em, token: _makeToken_('admin', em) });
}
// ── รหัสผ่านส่วนตัวของแอดมินแต่ละคน: เก็บแบบแฮช + salt (ไม่เก็บรหัสจริง) ──
function _pwKey_(em) { return 'PW_' + String(em).trim().toLowerCase(); }
function _hashPass_(salt, pass) {
  var h = salt + '|' + pass;
  for (var i = 0; i < 300; i++) h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt, Utilities.Charset.UTF_8));
  return h;
}
function _setPass_(em, pass) { var salt = _rand_(16); _props.setProperty(_pwKey_(em), salt + ':' + _hashPass_(salt, pass)); }
function _checkPass_(em, pass) {
  var v = _props.getProperty(_pwKey_(em)); if (!v) return false;
  var k = v.indexOf(':'); return _hashPass_(v.slice(0, k), String(pass)) === v.slice(k + 1);
}
function pwStatus(body) {
  var em = String(body.email || '').trim().toLowerCase();
  if (!_isAdminEmail_(em)) return json({ ok: false, error: 'อีเมลนี้ยังไม่มีสิทธิ์แอดมิน — ขอให้ ' + _ownerEmail_().replace(/^(.{2}).*(@.*)$/, '$1***$2') + ' เพิ่มชื่อในเมนู 🔒' });
  return json({ ok: true, hasPass: !!_props.getProperty(_pwKey_(em)) });
}
function pwLogin(body) {
  var em = String(body.email || '').trim().toLowerCase();
  if (!_isAdminEmail_(em) || !_props.getProperty(_pwKey_(em))) return json({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
  var cache = CacheService.getScriptCache(), fk = 'pw_f_' + em, f = Number(cache.get(fk) || 0);
  if (f >= 5) return json({ ok: false, locked: true, error: 'ใส่รหัสผิดหลายครั้ง ล็อกไว้ 15 นาที — หรือกด "ลืมรหัสผ่าน" เพื่อตั้งใหม่' });
  if (!_checkPass_(em, body.pass)) { cache.put(fk, String(f + 1), 900); Utilities.sleep(700); return json({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }); }
  cache.remove(fk); _ensureKeys_();
  _auditWrite_(em, 'login', 'เข้าสู่ระบบด้วยรหัสผ่าน');
  return json({ ok: true, role: 'admin', email: em, token: _makeToken_('admin', em) });
}
/** จอ War Room: {role:'view', pass: รหัสจอ} → บัตรผ่าน 1 ปี */
function login(body) {
  if (String(body.role || '') !== 'view') return json({ ok: false, error: 'แอดมินเข้าสู่ระบบด้วยอีเมล' });
  var real = _props.getProperty('VIEW_KEY');
  if (!real || !_props.getProperty('AUTH_SECRET')) return json({ ok: false, error: 'แอดมินยังไม่ได้เปิดระบบ — เปิด Snaphub แล้วเข้าเมนู 🔒' });
  var cache = CacheService.getScriptCache(), ck = 'auth_fail_view';
  var fails = Number(cache.get(ck) || 0);
  if (fails >= 8) return json({ ok: false, locked: true, error: 'ใส่รหัสผิดหลายครั้ง ล็อกไว้ 15 นาที' });
  if (String(body.pass || '').trim() !== String(real).trim()) {
    cache.put(ck, String(fails + 1), 900);
    Utilities.sleep(700);
    return json({ ok: false, error: 'รหัสไม่ถูกต้อง' });
  }
  cache.remove(ck);
  return json({ ok: true, role: 'view', token: _makeToken_('view', ''), days: AUTH_DAYS.view });
}
function _rand_(n, chars) {
  chars = chars || 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '', raw = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < n; i++) out += chars.charAt((parseInt(raw.substr((i * 2) % 60, 2), 16) + Math.floor(Math.random() * 256)) % chars.length);
  return out;
}
/** เมนู 🔒 ใน Snaphub (แอดมินเท่านั้น) */
function securityInfo(body) {
  _ensureKeys_();
  var miss = ''; try { miss = CacheService.getScriptCache().get('auth_last_miss') || ''; } catch (e) {}
  var me = (body && body._who) || '';
  return json({ ok: true, enforce: _authOn(), viewKey: _props.getProperty('VIEW_KEY'), lastMiss: miss,
    me: me, owner: _ownerEmail_(), isOwner: !!me && me === _ownerEmail_(), admins: _adminList_(),
    gemini: { hasKey: !!_geminiKey_(), model: _props.getProperty('GEMINI_MODEL') || '' }, myPass: !!(me && _props.getProperty(_pwKey_(me))) });
}
function securitySet(body) {
  var isOwner = !!body._who && body._who === _ownerEmail_();
  if (body.addAdmin || body.removeAdmin) {
    if (!isOwner) return json({ ok: false, error: 'เฉพาะเจ้าของระบบ (' + _ownerEmail_() + ') เพิ่ม/ลบแอดมินได้' });
    var list = []; try { list = JSON.parse(_props.getProperty('ADMIN_LIST') || '[]'); } catch (e) {}
    if (body.addAdmin) {
      var em = String(body.addAdmin).trim().toLowerCase();
      if (!/^[^@\s]+@planbmedia\.co\.th$/.test(em)) return json({ ok: false, error: 'เพิ่มได้เฉพาะอีเมล @planbmedia.co.th' });
      if (list.indexOf(em) < 0) list.push(em);
    }
    if (body.removeAdmin) {
      var rm = String(body.removeAdmin).trim().toLowerCase();
      if (rm === _ownerEmail_()) return json({ ok: false, error: 'ลบเจ้าของระบบไม่ได้' });
      list = list.filter(function (x) { return x !== rm; });
      _props.deleteProperty(_pwKey_(rm));
    }
    _props.setProperty('ADMIN_LIST', JSON.stringify(list));
  }
  if (body.changePass) {
    var cp = body.changePass || {};
    if (!body._who || !_checkPass_(body._who, cp.old)) return json({ ok: false, error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    if (String(cp.neu || '').length < 8) return json({ ok: false, error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัว' });
    _setPass_(body._who, cp.neu);
    var rr2 = JSON.parse(securityInfo(body).getContent()); rr2.passChanged = true; return json(rr2);
  }
  if (body.enforce === true) _props.setProperty('AUTH_ENFORCE', '1');
  if (body.enforce === false) _props.deleteProperty('AUTH_ENFORCE');
  if (body.newViewKey) _props.setProperty('VIEW_KEY', _rand_(16));
  if (body.geminiKey !== undefined) {
    var gk = String(body.geminiKey || '').trim();
    if (gk) _props.setProperty('GEMINI_API_KEY', gk); else _props.deleteProperty('GEMINI_API_KEY');
    _props.deleteProperty('GEMINI_MODEL');
  }
  if (body.geminiTest) {
    var gt = _draftInstallerMessages_({ 'ทดสอบ': [{ code: 'TEST-' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'HHmmss'), reason: 'รูปมืด / อาจไฟป้ายดับ' }] });
    var rr = JSON.parse(securityInfo(body).getContent()); rr.geminiTest = { source: gt.source, model: gt.model || '', text: gt.msgs['ทดสอบ'] || '' };
    return json(rr);
  }
  var tok = '';
  if (body.logoutAll) { _props.setProperty('AUTH_SECRET', _rand_(40)); tok = _makeToken_('admin', body._who); }   // คนที่กดยังอยู่ในระบบต่อ
  var r = JSON.parse(securityInfo(body).getContent());
  if (tok) r.token = tok;
  return json(r);
}
/** ▶ ฉุกเฉิน: ปิดการบังคับชั่วคราว (ระบบกลับมาใช้ได้ทันที) — รันใน Apps Script */
function disableSecurity() { _props.deleteProperty('AUTH_ENFORCE'); Logger.log('🔓 ปิดการบังคับล็อกอินชั่วคราวแล้ว'); }
/** ▶ เปิดบังคับจาก Apps Script (ปกติกดในเมนู 🔒 ได้) */
function enableSecurity() { _ensureKeys_(); _props.setProperty('AUTH_ENFORCE', '1'); Logger.log('🔒 เปิดใช้แล้ว'); }
/** ▶ ดูสถานะ + รายชื่อแอดมิน + รหัสจอ */
function showSecurity() {
  _ensureKeys_();
  Logger.log('สถานะ: ' + (_authOn() ? '🔒 บังคับใช้แล้ว' : '🟡 โหมดทดลอง'));
  Logger.log('แอดมิน: ' + _adminList_().join(', '));
  Logger.log('รหัสจอ War Room / หุ่นยนต์ AI: ' + _props.getProperty('VIEW_KEY'));
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

/** เก็บ/อ่าน cache ขนาดใหญ่ (เกิน 100KB) แบบแบ่งก้อน — งานใหญ่ก็ไม่ต้องคำนวณใหม่ทุกครั้ง */
function putBig_(c, key, str, ttl) {
  try {
    if (str.length < 95000) { c.put(key, str, ttl); return; }
    var n = Math.ceil(str.length / 90000), parts = {};
    for (var i = 0; i < n; i++) parts[key + '__' + i] = str.substr(i * 90000, 90000);
    if (n > 20) return;                               // ใหญ่เกิน — ไม่เก็บ
    c.putAll(parts, ttl);
    c.put(key, '__CHUNKS__' + n, ttl);                // ล้าง key หลัก = ล้างทั้งชุด
  } catch(e) {}
}
function getBig_(c, key) {
  var v = c.get(key);
  if (!v || v.indexOf('__CHUNKS__') !== 0) return v;
  var n = Number(v.substring(10)), keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '__' + i);
  var got = c.getAll(keys), out = '';
  for (i = 0; i < n; i++) { if (got[keys[i]] == null) return null; out += got[keys[i]]; }
  return out;
}

/** [SPEED] cache คำตอบ GET — โหลดซ้ำตอบทันที ไม่เปิดชีทใหม่ */
function respCache(key, ttlSec, builder) {
  var c = CacheService.getScriptCache();
  var hit = getBig_(c, key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var out = builder();
  var s = JSON.stringify(out);
  putBig_(c, key, s, ttlSec);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function bustCache(keys) {
  try { CacheService.getScriptCache().removeAll(keys); } catch(e) {}
}

function mkFolder(parent, name) {
  var ex = parent.getFoldersByName(name);
  return ex.hasNext() ? ex.next() : parent.createFolder(name);
}

/** โฟลเดอร์สินค้าแยกตามงาน — ชื่อสินค้าซ้ำกันคนละงาน (เดือน+สื่อเดียวกัน) จะได้โฟลเดอร์ใหม่ "ชื่อ (2)"
 *  งานล่าสุดเห็นเฉพาะรูปของตัวเอง · ผูกงานด้วยคำอธิบายโฟลเดอร์ snap-job:<jobId> */
var SNAP_JOB_TAG = 'snap-job:';
function _productFolder_(media, productName, jobId) {
  if (!jobId) return mkFolder(media, productName);
  var tag = SNAP_JOB_TAG + jobId, legacy = [], same = 0, it = media.getFolders();
  while (it.hasNext()) {
    var f = it.next(), nm = f.getName();
    if (nm !== productName && nm.indexOf(productName + ' (') !== 0) continue;
    same++;
    var d = ''; try { d = String(f.getDescription() || ''); } catch (e) {}
    if (d === tag) return f;
    if (!d && nm === productName) legacy.push(f);
  }
  // โฟลเดอร์เก่าก่อนมีระบบผูกงาน: ใช้ต่อได้เฉพาะเมื่อไม่มีงานอื่นใช้อยู่
  for (var i = 0; i < legacy.length; i++) {
    if (!_folderUsedByOtherJob_(legacy[i].getId(), jobId)) {
      try { legacy[i].setDescription(tag); } catch (e) {}
      return legacy[i];
    }
  }
  var nf = media.createFolder(same ? productName + ' (' + (same + 1) + ')' : productName);
  try { nf.setDescription(tag); } catch (e) {}
  return nf;
}
function _folderUsedByOtherJob_(folderId, jobId) {
  try {
    var ss = openNamedSS('_InstallLog', null); if (!ss) return false;
    var rows = ss.getActiveSheet().getDataRange().getValues();
    for (var i = 1; i < rows.length; i++)
      if (String(rows[i][6] || '').indexOf(folderId) > -1 && String(rows[i][0]) !== String(jobId)) return true;
    return false;
  } catch (e) { return true; }   // อ่านไม่ได้ → แยกโฟลเดอร์ใหม่ไว้ก่อน ปลอดภัยกว่า
}

/** [P4] สร้าง chain โฟลเดอร์ทั้งเส้นภายใต้ lock เดียว — กันโฟลเดอร์ซ้ำเมื่อยิงพร้อมกัน */
function makeCodeFolderChain(monthStr, mediaName, productName, dateStr, code, jobId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var root   = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    var month  = mkFolder(root, monthStr);
    var media  = mkFolder(month, mediaName);
    var prod   = _productFolder_(media, productName, jobId);
    var dateF  = mkFolder(prod, dateStr);
    var codeF  = mkFolder(dateF, code);
    return { month: month, product: prod, code: codeF };
  } finally { try { lock.releaseLock(); } catch(e) {} }
}

// ═══════════════════════════ JOBS SHEET ═══════════════════════════

// วันที่จากชีทอาจกลายเป็น Date object → แปลงเป็น yyyy-MM-dd เวลาไทยเสมอ (กันวันเลื่อน/ข้อความเพี้ยน)
function ymd_(v) {
  if (!v) return '';
  if (v instanceof Date) { try { return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd'); } catch(e) { return ''; } }
  return String(v).substring(0, 10);
}
function esc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; });
}

function getJobSheet() {
  var ss = openNamedSS('_Jobs', ['id','name','spots','created','dateStart','dateEnd','active','media','portalKey','salesEmail','approveKey','sentStatus','reportedCodes','pendingCodes']);
  var sh = ss.getSheetByName('Jobs');
  if (!sh) { sh = ss.getActiveSheet(); try { sh.setName('Jobs'); } catch(e) {} }
  return sh;
}

function getJobsList(p) {
  var view = (p && p.view === 'field') ? 'field' : 'full';
  return respCache('resp_jobs_' + view, 60, function() {
    var out = buildJobsList();
    if (view === 'field' && out.jobs) {
      out.jobs = out.jobs.filter(function(j){ return !j.archived; }).map(function(j){
        var c = {}; for (var k in j) if (k !== 'salesEmail' && k !== 'sentStatus') c[k] = j[k];   // ช่างไม่ต้องเห็นอีเมลเซล
        return c;
      });
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
          var dd = ymd_(lrows[di][3]);
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
          created:rows[i][3], dateStart:dstr(rows[i][4]), dateEnd:dstr(rows[i][5]), media:rows[i][7]||'',
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
  if (body.sessionToken) {
    // แอปส่ง ID รอบส่งมาเอง — ทุกก้อน (รวมก้อนที่ส่งซ้ำทีหลัง) อยู่รอบเดียวกันเสมอ ไม่ลบรูปของก้อนอื่น
    sessionToken = String(body.sessionToken);
  } else if (batchIndex === 0) {
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
      fold = makeCodeFolderChain(monthStr, mediaName, productName, dateStr, code, jobId);
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
    var batchStart = new Date().getTime();
    var isContinuation = false, startIdx = 1, modeForCode = 'append';
    if (body.modes) for (var mk in body.modes) if (String(mk).trim().toUpperCase() === code) modeForCode = String(body.modes[mk]);
    // จองเลขรูปภายใต้ lock — ก้อนที่ส่งพร้อมกันของ Code เดียวกันจะได้เลขไม่ซ้ำกัน
    var reserve = function() {
      var seen = null;
      try { var seenRaw = cache.get(seenKey); seen = seenRaw ? JSON.parse(seenRaw) : null; } catch(e) {}
      isContinuation = !!(seen && seen.t === sessionToken);
      if (isContinuation) startIdx = seen.idx;
      else if (modeForCode !== 'replace') {
        // เพิ่มรูปรอบใหม่ → ต่อเลขจากรูปที่มีอยู่แล้วในโฟลเดอร์ (กันชื่อไฟล์ซ้ำ CODE_01)
        try {
          var ex = codeFolder.getFiles(), re = new RegExp('^' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d+)', 'i');
          while (ex.hasNext()) { var mm = re.exec(ex.next().getName()); if (mm) startIdx = Math.max(startIdx, Number(mm[1]) + 1); }
        } catch(e) {}
      }
      cache.put(seenKey, JSON.stringify({ t:sessionToken, idx:startIdx + group.length }), SESSION_TTL_SEC);
      return true;
    };
    try { withLock2(reserve); } catch(e) { reserve(); }   // รอ lock ไม่ทัน → จองแบบไม่ล็อก ดีกว่าทั้งก้อนล้มแล้วส่งซ้ำ
    // โหมดที่ช่างเลือกจากหน้าแอป: 'append' = เก็บรูปเก่าไว้ / ไม่ส่งมา = replace (เข้ากันได้กับแอปเวอร์ชันเก่า)
    // ปลอดภัยไว้ก่อน: ลบรูปเก่า "เฉพาะ" เมื่อช่างกดยืนยัน 'ถ่ายใหม่ทั้งหมด' เท่านั้น
    // ถ้าไม่ได้ส่งโหมดมา (แอปเก่า/พลาด/เน็ตแปลก) = ไม่ลบ รูปเก่าอยู่ครบเสมอ
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
            // ลบเฉพาะรูปเก่าที่มีก่อนรอบนี้ — ไม่ลบรูปของก้อนอื่นในรอบเดียวกันที่เพิ่งเข้ามา
            if (on.indexOf(code + '_') === 0 && of.getDateCreated().getTime() < batchStart) of.setTrashed(true);
          }
        } catch(e) { Logger.log('trash old ['+code+']: '+e.message); }
      }
      // rename ชื่อชั่วคราว → ชื่อจริง (ถ้ามีไฟล์พลาด รูปเก่าจะยังอยู่ครบ ปลอดภัยกว่า)
      created.forEach(function(c){
        try { withRetry(function(){ return c.file.setName(c.finalName); }, 2); } catch(e) {}
      });
    }


    failedTotal += failedInGroup;
    var totalCount = created.length; // จำนวนรูปที่เพิ่มในก้อนนี้ (ยอดสะสมคำนวณตอนบันทึก log)

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
  bustCache(['resp_ilog', 'resp_ilog_' + jobId, 'resp_ilogf_' + jobId, 'portal_' + jobId, 'resp_jobs_full', 'resp_jobs_field']); // ข้อมูลใหม่ → ทุกจอเห็นรอบถัดไป (รวมสถานะจบงาน)

  try { logSheet(installer, jobName, new Date().toISOString(), uploadedCodes, unmatched.length); } catch(e) {}

  // [P8] ส่งอีเมลแจ้งแอดมินทันทีที่รูปเข้า — ไม่รอก้อนอื่น (ส่งหลายก้อน = ได้อีเมลตามจำนวนก้อน)
  if (uploadedCodes.length || unmatched.length) {
    var mailCodes = uploadedCodes.map(function(c){ return { code:c.code, product:c.product, address:c.address,
      count:c.count || 0, failed:c.failed || 0, folderUrl:c.folderUrl }; });
    mailCodes.sort(function(a,b){ return a.code < b.code ? -1 : 1; });
    var jobLabel = jobName + (totalBatches > 1 ? ' (ชุดที่ ' + (batchIndex + 1) + '/' + totalBatches + ')' : '');
    try {
      sendEmail(installer, jobLabel, mailCodes, unmatched.length, monthFolderUrl, jobMedia, failedTotal);
      try { _props.deleteProperty('lastMailError'); _props.setProperty('lastMailOk', new Date().toISOString()); } catch(e) {}
    } catch(e) { Logger.log('Email: '+e.message); _noteMailError(e.message); }
  }

  // 🎉 เช็คว่างานครบ 100% หรือยัง — ถ้าครบ ส่งอีเมลให้แอดมินกดยืนยันส่งเซล
  if (isLastBatch && jobId) {
    try { checkJobCompletion(jobId); } catch(e) { Logger.log('completion: '+e.message); }
  }

  // ปลุกหุ่นยนต์ AI ให้ตรวจรูปที่เพิ่งเข้ามาทันที (ไม่ต้องรอรอบ 30 นาที) — พลาดก็ไม่กระทบการอัปโหลด
  if (uploadedCodes.some(function(c){ return (c.count || 0) > 0; })) { try { _kickAiBot_(); } catch(e) {} }

  var _result = { success:true, codes:uploadedCodes, failed:failedTotal,
    unmatched:unmatched.length, folderUrl:monthFolderUrl };
  if (requestId) {
    try { dedupCache.put('req_' + requestId, JSON.stringify(_result), 600); } catch(e) {} // เก็บ 10 นาที พอคลุมช่วง retry
  }
  return json(_result);
}

/** สั่ง GitHub Actions (ai-check) ให้รันทันที — ต้องตั้ง Script Properties: GH_TOKEN (fine-grained, Actions: Read and write)
 *  กันยิงถี่: 1 ครั้ง / 2 นาที (ถ้าบอทกำลังรันอยู่ GitHub จะต่อคิวไว้ 1 รอบ แล้วบอทตรวจวนจนหมดเอง) */
function _aiBotReady_() { return !!String(_props.getProperty('GH_TOKEN') || '').trim(); }
function _kickAiBot_() {
  var token = String(_props.getProperty('GH_TOKEN') || '').trim();
  if (!token) return { ok: false, why: 'notoken' };
  var cache = CacheService.getScriptCache();
  if (cache.get('aibot_kick')) return { ok: true, skipped: true };
  cache.put('aibot_kick', '1', 120);
  var repo = String(_props.getProperty('GH_REPO') || 'saranya-cmyk/installation-app').trim();
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/ai-check.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: String(_props.getProperty('GH_REF') || 'main') }) });
  var code = res.getResponseCode();
  if (code !== 204) {
    try { cache.remove('aibot_kick'); } catch (e) {}
    _auditWrite_('system', 'kickAiBot', 'ปลุกบอท AI ไม่สำเร็จ HTTP ' + code + ' ' + String(res.getContentText() || '').slice(0, 150));
    return { ok: false, why: 'http ' + code };
  }
  return { ok: true };
}
/** รันเองใน Apps Script เพื่อทดสอบ/อนุญาตสิทธิ์: ดูผลใน Logger + แท็บ Actions บน GitHub */
function testKickAiBot() { try { CacheService.getScriptCache().remove('aibot_kick'); } catch (e) {} var r = _kickAiBot_(); Logger.log(JSON.stringify(r)); return r; }

// ── อีเมลส่งรูป ──
function _noteMailError(msg) {
  try { _props.setProperty('lastMailError', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm') + ' — ' + String(msg).slice(0, 300)); } catch(e) {}
}
// แอปรุ่นที่แคชไว้อาจยังเรียกอยู่ — อีเมลส่งไปแล้วตอนรูปเข้า จึงไม่ต้องทำอะไร
function uploadDone(body) { return json({ success:true, mailed:false }); }
// เปิด ?action=mailStatus เพื่อดูว่าอีเมลยังส่งได้ไหม (โควต้าเหลือ / ข้อผิดพลาดล่าสุด)
function mailStatus() {
  var q = -1; try { q = MailApp.getRemainingDailyQuota(); } catch(e) {}
  return json({ adminEmail: CONFIG.ADMIN_EMAIL ? CONFIG.ADMIN_EMAIL.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '(ไม่มี)',
    quotaLeftToday: q, lastMailOk: _props.getProperty('lastMailOk') || '', lastMailError: _props.getProperty('lastMailError') || '',
    security: _authOn() ? 'เปิดใช้แล้ว' : 'ยังไม่เปิด (โหมดทดลอง)' });
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
      var key = String(jobId) + '|' + String(c.code).trim().toUpperCase();
      // ยอดรูปสะสม: ถ่ายใหม่ทั้งหมด = นับใหม่ · เพิ่มรูป = ยอดเดิม + รูปที่เพิ่ม
      var prevCount = index[key] ? (Number(sh.getRange(index[key], 5).getValue()) || 0) : 0;
      var total = c.replaced ? (c.count || 0) : prevCount + (c.count || 0);
      // [SPEED] Photo Index: replace = ทับด้วยชุดใหม่, ต่อ batch = ต่อท้ายของเดิม
      var idsJson = '';
      try {
        var newIds = c.imgIds || [];
        if (index[key] && !c.replaced) {
          var oldIds = [];
          try { oldIds = JSON.parse(sh.getRange(index[key], 8).getValue() || '[]'); } catch(e2) {}
          newIds = oldIds.concat(newIds);
        }
        idsJson = JSON.stringify(newIds.slice(-30));   // เก็บรูปล่าสุด 30 ใบ (เดิมเก็บ 12 ใบแรก รูปใหม่เลยหาย)
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

/** รูปของงาน+จุดนี้ตาม _InstallLog (ใช้จำกัดสิ่งที่แอปช่างเห็น) */
function _jobCodeImgIds_(jobId, code) {
  var ok = {}, ss = openNamedSS('_InstallLog', null); if (!ss) return ok;
  var rows = ss.getActiveSheet().getDataRange().getValues(), cu = String(code).trim().toUpperCase();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(jobId) || String(rows[i][1]).trim().toUpperCase() !== cu) continue;
    try { JSON.parse(rows[i][7] || '[]').forEach(function(id){ ok[String(id)] = 1; }); } catch (e) {}
  }
  return ok;
}
function getPhotos(params) {
  try {
    var code = params.code || '';
    var allow = null;
    if (params._field) {           // ไม่ได้ล็อกอิน → ต้องระบุงาน และเห็นเฉพาะรูปที่ส่งเข้างานนั้น
      if (!params.jobId) return json({ photos: [], error: 'ต้องระบุงาน' });
      allow = _jobCodeImgIds_(String(params.jobId), code);
      if (!Object.keys(allow).length) return json({ photos: [], note: 'ไม่พบรูปของ ' + code });
    }
    var entries = findPhotoEntries(code);
    if (allow) entries = entries.filter(function(en){ return allow[en.file.getId()]; });
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

// ═══════════════ AI ตรวจคุณภาพรูป (รันในเครื่องแอดมิน) ═══════════════
// ส่งรูปย่อแบบ base64 ให้ Snaphub เอาไปวิเคราะห์ด้วย AI ในเบราว์เซอร์แอดมินเอง
// รูปไม่ถูกส่งไปบริการ AI ภายนอกใดๆ · ดึงได้เฉพาะรูปในโฟลเดอร์งานติดตั้ง (ผ่าน findPhotoEntries)
function getPhotoThumbs(params) {
  try {
    var code = String(params.code || '').trim();
    if (!code) return json({ thumbs: [] });
    var entries = findPhotoEntries(code);
    var out = [];
    for (var i = 0; i < entries.length && out.length < 6; i++) {
      var f = entries[i].file;
      var blob = null;
      try { blob = f.getThumbnail(); } catch (e) {}
      if (!blob) continue;
      out.push({
        id: f.getId(), name: f.getName(),
        data: 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes())
      });
    }
    return json({ thumbs: out });
  } catch (err) { return json({ thumbs: [], error: err.message }); }
}

// ═══════════════ บันทึกผล AI ตรวจรูป (_AICheckLog) ═══════════════
// AI (CLIP) รันในเบราว์เซอร์แอดมิน · เซิร์ฟเวอร์ทำหน้าที่แค่ส่งรูปย่อ + บันทึกผล · ไม่มีการเรียก AI ภายนอก
var AI_LOG_HEADER = ['checkedAt','jobId','code','fileId','result','reason','score','decision','decidedAt','ocr'];
var AI_WRONG_SIGN = 'อาจติดผิดป้าย';

// ดัชนีรูปทั้งหมดจาก _InstallLog: fileId → {jobId, code}
function _aiPhotoIndex() {
  var idx = {};
  var ss = openNamedSS('_InstallLog', null);
  if (!ss) return idx;
  var rows = ss.getActiveSheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var ids = [];
    try { ids = JSON.parse(rows[i][7] || '[]'); } catch (e) {}
    for (var k = 0; k < ids.length; k++) {
      if (ids[k]) idx[String(ids[k])] = { jobId: String(rows[i][0]), code: String(rows[i][1]), installer: String(rows[i][2] || '').trim() };
    }
  }
  return idx;
}

function _aiLogSheet() {
  var sh = openNamedSS('_AICheckLog', AI_LOG_HEADER).getActiveSheet();
  if (!sh.getRange(1, 10).getValue()) sh.getRange(1, 10).setValue('ocr');   // ชีทที่สร้างก่อนมี OCR
  return sh;
}

// รายการรูปที่ยังไม่ตรวจ + รูปที่ AI ติดธงแต่แอดมินยังไม่ตัดสิน + สถิติ
function aiPending(p) {
  try {
    var index = _aiPhotoIndex();
    var sheet = _aiLogSheet();
    var rows = sheet.getDataRange().getValues();
    var checked = {}, flags = [], nFlag = 0, nDecided = 0, codeOk = {}, nChecked = 0;
    // สรุปต่องาน ไว้โชว์บนการ์ดงานใน Snaphub: ตรวจแล้วกี่รูป · ติดธงกี่รูป · รอตรวจกี่รูป · ตรวจล่าสุดเมื่อไร
    var byJob = {};
    var bj = function(id) { return byJob[id] || (byJob[id] = { checked: 0, flagged: 0, pending: 0, last: '' }); };
    for (var i = 1; i < rows.length; i++) {
      var fid = String(rows[i][3]);
      checked[fid] = true;
      if (rows[i][4] === 'base') continue;      // รูปเก่าก่อนเริ่มใช้ AI — ไม่ตรวจ ไม่นับ
      nChecked++;
      if (index[fid]) {
        var b = bj(index[fid].jobId), at = rows[i][0];
        at = (at instanceof Date) ? Utilities.formatDate(at, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss') : String(at || '');
        b.checked++;
        if (rows[i][4] === 'flag' && !rows[i][7]) b.flagged++;
        if (at > b.last) b.last = at;
      }
      if (rows[i][9] === 'match') codeOk[rows[i][1] + '|' + rows[i][2]] = true;
      if (rows[i][4] === 'flag') {
        nFlag++;
        if (rows[i][7]) nDecided++;
        else if (index[fid]) flags.push({ jobId: String(rows[i][1]), code: String(rows[i][2]), id: fid,
          installer: index[fid].installer || '', reason: String(rows[i][5]), score: Number(rows[i][6]) || 0, checkedAt: String(rows[i][0]) });
      }
    }
    // รูปใหม่ก่อนเสมอ — รูปที่ช่างเพิ่งส่งไม่ต้องรอคิวรูปเก่าที่ค้างอยู่
    var allIds = Object.keys(index).filter(function(id){ return !checked[id]; });
    // ตรวจเฉพาะรูปที่เข้ามาใหม่: ครั้งแรกที่ใช้โค้ดนี้ รูปเก่าที่ค้างอยู่ทั้งหมดถูกบันทึกเป็น "ก่อนเริ่มใช้ AI" แล้วข้ามไป
    if (allIds.length && !_props.getProperty('AI_BASELINE')) {
      var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
      var base = allIds.map(function(id){ return [stamp, index[id].jobId, index[id].code, id, 'base', 'รูปก่อนเริ่มใช้ AI ตรวจ — ไม่ตรวจย้อนหลัง', 0, '', '', '']; });
      sheet.getRange(sheet.getLastRow() + 1, 1, base.length, AI_LOG_HEADER.length).setValues(base);
      allIds = [];
    }
    try { if (!_props.getProperty('AI_BASELINE')) _props.setProperty('AI_BASELINE', new Date().toISOString()); } catch (e) {}
    allIds.forEach(function(id){ bj(index[id].jobId).pending++; });
    var ids = allIds.slice().reverse().slice(0, 200);
    var pending = ids.map(function(id){ return { jobId: index[id].jobId, code: index[id].code, id: id }; });
    return json({ pending: pending, flags: flags,
      stats: { checked: nChecked, flagged: nFlag, decided: nDecided, codeMatch: Object.keys(codeOk).length, pending: allIds.length }, byJob: byJob });
  } catch (err) { return json({ pending: [], flags: [], error: err.message }); }
}

// ส่งรูปย่อตาม ID — ยอมเฉพาะรูปที่อยู่ในดัชนีงานติดตั้งเท่านั้น (ขอไฟล์อื่นใน Drive ไม่ได้)
function aiThumbs(p) {
  try {
    var full = String(p.full || '') === '1';                 // รูปขนาดจริง (≤1200px) สำหรับอ่าน Code
    var ids = String(p.ids || '').split(',').filter(String).slice(0, full ? 3 : 8);
    var index = _aiPhotoIndex();
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      if (!index[ids[i]]) continue;
      try {
        var file = DriveApp.getFileById(ids[i]);
        var blob = (full && file.getSize() <= 4 * 1024 * 1024) ? file.getBlob() : file.getThumbnail();
        if (!blob) continue;
        out.push({ id: ids[i], data: 'data:' + (blob.getContentType() || 'image/png') + ';base64,' +
          Utilities.base64Encode(blob.getBytes()) });
      } catch (e) {}
    }
    return json({ thumbs: out });
  } catch (err) { return json({ thumbs: [], error: err.message }); }
}

// บันทึกผลตรวจ (ทั้งรูปปกติและรูปติดธง) — ไม่บันทึกซ้ำถ้า fileId เคยตรวจแล้ว
function aiSaveChecks(body) {
  var list = body.rows || [];
  var index = _aiPhotoIndex();
  var sh = _aiLogSheet();
  var data = sh.getDataRange().getValues();
  var seen = {};
  for (var i = 1; i < data.length; i++) seen[String(data[i][3])] = true;
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  var add = [];
  for (var j = 0; j < list.length && j < 50; j++) {
    var r = list[j], fid = String(r.fileId || '');
    if (!index[fid] || seen[fid]) continue;
    seen[fid] = true;
    add.push([now, index[fid].jobId, index[fid].code, fid, (r.result === 'flag' || r.result === 'skip') ? r.result : 'ok',
      String(r.reason || '').slice(0, 80), Math.round((Number(r.score) || 0) * 100) / 100, '', '',
      String(r.ocr || '').slice(0, 40)]);
  }
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, AI_LOG_HEADER.length).setValues(add);
  _aiReconcileWrongSign(sh);
  return json({ success: true, saved: add.length });
}

// รูปมุมกว้างอาจเห็นป้ายข้างๆ → ถ้ารูปอื่นของจุดเดียวกันอ่าน Code ตรงแล้ว ยกเลิกธง "ติดผิดป้าย" ที่ยังไม่มีคนตัดสิน
function _aiReconcileWrongSign(sh) {
  var data = sh.getDataRange().getValues(), ok = {};
  for (var i = 1; i < data.length; i++) if (data[i][9] === 'match') ok[data[i][1] + '|' + data[i][2]] = true;
  for (i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[4] !== 'flag' || r[7] || String(r[9]).indexOf('other:') !== 0 || !ok[r[1] + '|' + r[2]]) continue;
    var rest = String(r[5]).split(' · ').filter(function(s){ return s.indexOf(AI_WRONG_SIGN) !== 0; }).join(' · ');
    sh.getRange(i + 1, 5, 1, 2).setValues([[rest ? 'flag' : 'ok', rest || 'ยกเลิกธงติดผิดป้าย: รูปอื่นของจุดนี้อ่าน Code ตรง']]);
  }
}

// แอดมินตัดสินรูปที่ติดธง: ok = รูปใช้ได้ (AI เตือนผิด) · reshoot = ให้ช่างถ่ายใหม่
function aiDecision(body) {
  var fid = String(body.fileId || ''), d = String(body.decision || '');
  if (d !== 'ok' && d !== 'reshoot') return json({ success: false, error: 'decision ไม่ถูกต้อง' });
  var sh = _aiLogSheet();
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][3]) === fid) {
      sh.getRange(i + 1, 8, 1, 2).setValues([[d, Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss')]]);
      return json({ success: true });
    }
  }
  return json({ success: false, error: 'ไม่พบรูปนี้ในบันทึก' });
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
    var jobId = String(body.jobId || '');
    if (!oldCode || !newCode) return json({ success:false, error:'ข้อมูล Code ไม่ครบ' });
    if (!jobId) return json({ success:false, error:'ไม่ระบุงาน — ไม่แก้เพื่อกันกระทบงานอื่น' });
    if (oldCode === newCode)  return json({ success:true, moved:0, note:'Code เดิมกับใหม่เหมือนกัน' });

    // แก้เฉพาะรูปของ "งานนี้" (ตามดัชนีรูปใน _InstallLog) — ไม่ไล่เปลี่ยนชื่อทั้ง Drive
    // (เดิมเปลี่ยนชื่อรูป/โฟลเดอร์ของ Code นี้ในทุกงานทุกเดือน ทำให้รูปงานเก่าหายจาก Portal)
    var movedFiles = 0, logRows = 0, notIndexed = 0;
    (function() {   // ตัวเรียก (doPost) ถือ lock ให้แล้ว — ไม่ล็อกซ้อน
      var sh = openNamedSS('_InstallLog', ['jobId','code','installer','date','count','folderUrl','productFolderUrl','imgIds']).getActiveSheet();
      var rows = sh.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) !== jobId || String(rows[i][1]).trim().toUpperCase() !== oldCode) continue;
        var ids = [];
        try { ids = JSON.parse(rows[i][7] || '[]'); } catch(e) {}
        ids.forEach(function(fid) {
          try {
            var f = DriveApp.getFileById(fid), fn = f.getName();
            if (fn.toUpperCase().indexOf(oldCode + '_') === 0) { f.setName(newCode + fn.substring(oldCode.length)); movedFiles++; }
          } catch(e) {}
        });
        sh.getRange(i + 1, 2).setValue(newCode);
        if ((Number(rows[i][4]) || 0) > ids.length) notIndexed += (Number(rows[i][4]) || 0) - ids.length;
        logRows++;
      }
    })();

    bustCache(['resp_ilog', 'resp_ilog_' + jobId, 'resp_ilogf_' + jobId, 'portal_' + jobId]);
    if (!logRows) return json({ success:true, moved:0, note:'ไม่พบบันทึกของ ' + oldCode + ' ในงานนี้' });
    return json({ success:true, moved:movedFiles, notIndexed:notIndexed,
      note: notIndexed ? 'มีรูปเก่าอีก ' + notIndexed + ' รูปที่ไม่อยู่ในดัชนี — เปลี่ยนชื่อใน Drive เองถ้าต้องการ' : '' });
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
        var tooOld = body._role !== 'admin' && _authOn() && f.getDateCreated &&
          (Date.now() - f.getDateCreated().getTime()) > TECH_DELETE_HOURS * 3600000;
        if (tooOld) { refused++; return; }   // ช่าง (ไม่ได้ล็อกอิน) ลบรูปเก่าเกิน 3 วันไม่ได้ — ต้องให้แอดมินลบ
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
    bustCache(['resp_ilog', 'resp_ilog_' + jobId, 'resp_ilogf_' + jobId, 'portal_' + jobId, 'resp_jobs_full', 'resp_jobs_field']);
    return json({ success:true, deleted:deleted, refused:refused, remaining:remaining });
  } catch(err) { return json({ success:false, error:err.message }); }
}

function deleteCodeFiles(body) {
  try {
    var code = String(body.code||'').trim().toUpperCase();
    var jobId = String(body.jobId || '');
    if (!code) return json({ success:false, error:'ไม่มี Code' });
    if (!jobId) return json({ success:false, error:'ไม่ระบุงาน — ไม่ลบเพื่อกันรูปของงานอื่นหาย' });

    // ลบเฉพาะรูปของงานนี้ (ตามดัชนีรูป) + แถวบันทึกของงานนี้เท่านั้น — ไม่ลบรูป Code เดียวกันของงานอื่น
    var deleted = 0, logDeleted = 0, notIndexed = 0;
    (function() {   // ตัวเรียก (doPost) ถือ lock ให้แล้ว
      var sh = openNamedSS('_InstallLog', ['jobId','code','installer','date','count','folderUrl','productFolderUrl','imgIds']).getActiveSheet();
      var rows = sh.getDataRange().getValues();
      for (var i = rows.length - 1; i >= 1; i--) {
        if (String(rows[i][0]) !== jobId || String(rows[i][1]).trim().toUpperCase() !== code) continue;
        var ids = [];
        try { ids = JSON.parse(rows[i][7] || '[]'); } catch(e) {}
        ids.forEach(function(fid) {
          try { var f = DriveApp.getFileById(fid); if (f.getName().toUpperCase().indexOf(code + '_') === 0) { f.setTrashed(true); deleted++; } } catch(e) {}
        });
        if ((Number(rows[i][4]) || 0) > ids.length) notIndexed += (Number(rows[i][4]) || 0) - ids.length;
        sh.deleteRow(i + 1); logDeleted++;
      }
    })();

    // ล้างเลขรูปที่จำไว้ของ Code นี้ (ทุกช่าง) กันนับต่อจากของที่ลบไปแล้ว
    try {
      var c = CacheService.getScriptCache(), who = String(body.installer || '').replace(/\s+/g, '').substring(0, 40);
      c.remove('seen_' + jobId + '_' + who + '_' + code);
    } catch(e) {}

    bustCache(['resp_ilog', 'resp_ilog_' + jobId, 'resp_ilogf_' + jobId, 'portal_' + jobId, 'resp_jobs_full', 'resp_jobs_field']);
    return json({ success:true, deleted:deleted, logDeleted:logDeleted, notIndexed:notIndexed });
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
      '<p>ช่าง <b>'+esc_(installer)+'</b></p><p>งาน: <b>'+esc_(jobName)+'</b></p>'+
      '<p>สาเหตุ: <b>'+esc_(reason)+'</b></p>'+
      '<p style="color:#888;font-size:12px">'+esc_(timestamp)+'</p></div>';
    // บันทึกลงชีทแล้ว — ส่งอีเมลไม่ได้ก็ไม่ถือว่าพัง (กันแอปช่างส่งซ้ำจนแถวซ้ำ)
    if (CONFIG.ADMIN_EMAIL) { try { MailApp.sendEmail({to:CONFIG.ADMIN_EMAIL,subject:'[ปัญหาหน้างาน] '+jobName+' — '+installer,htmlBody:_wrapMail_(html)}); } catch(e) { Logger.log('problem mail: '+e.message); } }
    bustCache(['resp_plog']);
    return json({ success: true });
  } catch(err) { return json({ success:false, error:err.message }); }
}

// ═══════════════════════════ LOGS (อ่าน) ═══════════════════════════

function getInstallLog(params) {
  var jobId = params && params.jobId ? String(params.jobId) : '';
  // มี jobId = แอปช่างขอแค่งานเดียว (กรองที่เซิร์ฟเวอร์ ลด JSON ที่ส่งกลับ ไม่ต้องรอโหลดทุกงาน)
  // ไม่มี jobId = แอดมิน/War Room ขอภาพรวมทุกงาน (พฤติกรรมเดิมเป๊ะ ไม่กระทบ)
  if (jobId && params._field) {   // แอปช่าง: ตัดลิงก์โฟลเดอร์ Drive ออก (ช่างไม่ได้ใช้)
    return respCache('resp_ilogf_' + jobId, 45, function(){
      var r = buildInstallLog(jobId);
      (r.log || []).forEach(function(e){ delete e.folderUrl; delete e.productFolderUrl; });
      return r;
    });
  }
  if (jobId) {
    return respCache('resp_ilog_' + jobId, 45, function(){ return buildInstallLog(jobId); });
  }
  return respCache('resp_ilog', 45, function(){ return buildInstallLog(null); });
}
function buildInstallLog(filterJobId) {
  try {
    var ss = openNamedSS('_InstallLog', null);
    if (!ss) return { log: [] };
    var rows = ss.getActiveSheet().getDataRange().getValues();
    var log=[];
    for(var i=1;i<rows.length;i++){
      if (filterJobId && String(rows[i][0]) !== filterJobId) continue; // ⭐ กรองตั้งแต่ตรงนี้ ถ้าขอเจาะจงงาน
      var wIds = [];
      try { wIds = JSON.parse(rows[i][7] || '[]').slice(0, 2); } catch(e) {}
      log.push({jobId:rows[i][0],code:rows[i][1],installer:rows[i][2],
        date:ymd_(rows[i][3]),count:rows[i][4],folderUrl:rows[i][5],productFolderUrl:rows[i][6],imgs:wIds});
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
          (folderUrl ? '<a href="'+folderUrl+'" style="background:'+PLANB_BLUE+';color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">📷 ดูรูปหน้างาน ('+photoLinks.length+' รูป)</a>' : '')+
        '</div></div></div>';

    var to = CONFIG.ADMIN_EMAIL;
    if (CONFIG.REPAIR_EMAIL && CONFIG.REPAIR_EMAIL.trim()) to += ',' + CONFIG.REPAIR_EMAIL.trim();
    try {
      MailApp.sendEmail({ to: to,
        subject: '🔧 [แจ้งซ่อมด่วน] ' + code + ' — ' + repairType + (jobName ? ' — ' + jobName : ''),
        htmlBody: _wrapMail_(html) });
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
  // สุ่มจาก UUID (ปลอดภัยกว่า Math.random) · 20 ตัวอักษร เดายากมาก · ลิงก์เดิมที่ส่งไปแล้วยังใช้ได้
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 20);
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
    // ลูกค้าเปิดหน้าค้างไว้หลายคน → ตอบจาก cache ทันทีโดยไม่ต้องเปิดชีทงาน
    var pCache = CacheService.getScriptCache();
    var knownId = pCache.get('pk_' + key);
    if (knownId) {
      var fast = getBig_(pCache, 'portal_' + knownId);
      if (fast) return ContentService.createTextOutput(fast).setMimeType(ContentService.MimeType.JSON);
    }
    var sh = getJobSheet();
    var rows = sh.getDataRange().getValues();
    var job = null;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][8] || '').trim() === key && String(rows[i][6]) !== 'false') {
        job = { id: rows[i][0], name: rows[i][1], spots: JSON.parse(rows[i][2] || '[]'),
          dateStart: ymd_(rows[i][4]), dateEnd: ymd_(rows[i][5]),
          media: rows[i][7] || '' };
        break;
      }
    }
    if (!job) return json({ error: 'invalid key' });
    try { pCache.put('pk_' + key, String(job.id), 600); } catch(e) {}

    // [SPEED] cache ผลลัพธ์ทั้งก้อน 2 นาที (ถูกล้างทันทีเมื่อมีรูปใหม่เข้า)
    var pHit = getBig_(pCache, 'portal_' + job.id);
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
            date: ymd_(lrows[li][3]), count: lrows[li][4] || 0, ids: ids };
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
    putBig_(pCache, 'portal_' + job.id, payload, 120);
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
    var timedOut = [];   // จุดที่ทำไม่ทันเวลา (ต่างจากจุดที่ไม่มีรูป)

    for (var ci = 0; ci < codes.length; ci++) {
      // กันสคริปต์เกินเวลา — หยุดก่อนแล้วแจ้งว่าจุดไหนไม่ทัน
      if (new Date().getTime() - startTime > TIME_LIMIT) {
        for (var rest = ci; rest < codes.length; rest++) { skipped.push(codes[rest].code); timedOut.push(codes[rest].code); }
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
      skipped: skipped.length ? skipped : undefined, timedOut: timedOut.length ? timedOut : undefined });
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
    '<br><br><a href="'+folderUrl+'" style="background:'+PLANB_BLUE+';color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">📁 เปิดโฟลเดอร์</a></p></div>';
  var subjectMedia = mediaLabel ? mediaLabel + ' · ' : '';
  MailApp.sendEmail({to:CONFIG.ADMIN_EMAIL,subject:'[ส่งรูป] '+subjectMedia+jobName+' — '+installer+' — '+codes.length+' จุด',htmlBody:_wrapMail_(html)});
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
  ['_Jobs','_InstallLog','_UploadLog','_ProblemLog','_RepairLog','_Installers','_AICheckLog'].forEach(function(name) {
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
// เรียกทันทีทุกครั้งที่ช่างส่งรูปครบชุด (ไม่รอรอบเวลา) — ถ้ามีจุดใหม่ที่ยังไม่เคยแจ้ง ส่งอีเมลแอดมินทันที
function checkJobCompletion(jobId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var sh = getJobSheet();
    if (!sh.getRange(1, 13).getValue()) sh.getRange(1, 13, 1, 2).setValues([['reportedCodes', 'pendingCodes']]);
    var jr0 = findJobRow(jobId);
    if (!jr0 || String(jr0.values[6]) === 'false') return;
    var spots = JSON.parse(jr0.values[2] || '[]');
    if (!spots.length) return;
    var spotSet = {};
    spots.forEach(function(s){ spotSet[String(s.code).trim().toUpperCase()] = true; });
    var done = Object.keys((_installedByJob()[jobId] || {})).filter(function(c){ return spotSet[c]; });
    var status = String(jr0.values[11] || '').trim();
    var sm = /^sending (\d+)/.exec(status);
    if (sm && Date.now() - Number(sm[1]) < 10 * 60000) return;   // แอดมินกำลังกดส่งเซลอยู่ — รอบหน้าค่อยเช็คจุดใหม่
    var reported = _codesOf(jr0.values[12]), pending = _codesOf(jr0.values[13]);
    if (status.indexOf('sent') === 0 && !String(jr0.values[12] || '').trim()) {
      sh.getRange(jr0.row, 13).setValue(JSON.stringify(done));
      return;
    }
    var known = {};
    reported.concat(pending).forEach(function(c){ known[c] = true; });
    var fresh = done.filter(function(c){ return !known[c]; });
    if (!fresh.length) return;
    var carried = pending.length;
    pending = pending.concat(fresh);
    sh.getRange(jr0.row, 14).setValue(JSON.stringify(pending));
    var jr = { sh: sh, row: jr0.row, values: sh.getRange(jr0.row, 1, 1, 14).getValues()[0] };
    _sendDailyAdminEmail(jr, spots.length, reported.length, pending, carried);
  } finally { lock.releaseLock(); }
}

function _aiJobCounts(jobId, codes) {
  var only = null;
  if (codes && codes.length) { only = {}; codes.forEach(function(c){ only[String(c).trim().toUpperCase()] = true; }); }
  var inScope = function(code) { return !only || only[String(code).trim().toUpperCase()]; };
  var index = _aiPhotoIndex(), total = 0;
  for (var id in index) if (index[id].jobId === String(jobId) && inScope(index[id].code)) total++;
  var rows = _aiLogSheet().getDataRange().getValues();
  var checked = 0, waiting = 0, reshoot = 0;  // reshoot คงไว้เพื่อความเข้ากันได้ (ไม่ใช้แล้ว)
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) !== String(jobId) || !index[String(rows[i][3])] || !inScope(rows[i][2])) continue;
    if (rows[i][4] === 'skip') continue;
    checked++;
    if (rows[i][4] === 'flag') waiting++;   // ธงที่ AI บันทึกไว้ (ใช้แจ้งช่าง ไม่ขวางการส่งเซล)
  }
  var spotsAll = {}, spotsOk = {};
  for (var id2 in index) if (index[id2].jobId === String(jobId) && inScope(index[id2].code)) spotsAll[index[id2].code] = true;
  for (i = 1; i < rows.length; i++)
    if (String(rows[i][1]) === String(jobId) && rows[i][9] === 'match' && inScope(rows[i][2])) spotsOk[String(rows[i][2])] = true;
  return { total: total, checked: checked, waiting: waiting, reshoot: reshoot, unchecked: Math.max(0, total - checked),
           spots: Object.keys(spotsAll).length, codeMatch: Object.keys(spotsOk).length };
}

// รายการรูปที่ AI ติดธง จัดกลุ่มตามช่าง — ใช้แจ้งช่างทีหลัง (ไม่ขวางการส่งเซล ไม่ต้องมีคนตัดสิน)
function _aiFlagReport(jobId, codes) {
  var only = null;
  if (codes && codes.length) { only = {}; codes.forEach(function(c){ only[String(c).trim().toUpperCase()] = true; }); }
  var index = _aiPhotoIndex(), rows = _aiLogSheet().getDataRange().getValues(), seen = {}, by = {};
  for (var i = 1; i < rows.length; i++) {
    if ((jobId && String(rows[i][1]) !== String(jobId)) || rows[i][4] !== 'flag' || !index[String(rows[i][3])]) continue;
    var code = String(rows[i][2]).trim().toUpperCase();
    if (only && !only[code]) continue;
    var who = index[String(rows[i][3])].installer || 'ไม่ระบุช่าง';
    var key = who + '|' + code + '|' + rows[i][5];
    if (seen[key]) continue; seen[key] = true;
    (by[who] = by[who] || []).push({ code: code, reason: String(rows[i][5]) });
  }
  return by;
}

function _aiJobSummaryHtml(jobId, codes) {
  var c = _aiJobCounts(jobId, codes);
  var total = c.total, checked = c.checked, waiting = c.waiting, unchecked = c.unchecked;
  var lines = [], color = PLANB_BLUE, bg = '#eaf2fd';
  if (!total) lines.push('🤖 ยังไม่มีข้อมูลรูปสำหรับ AI ตรวจ');
  else lines.push('🤖 AI ตรวจรูปแล้ว <b>' + checked + '/' + total + '</b> รูป');
  if (total) lines.push('🔎 อ่าน Code บนป้ายยืนยันตรง <b>' + c.codeMatch + '/' + c.spots + '</b> จุด' + (c.codeMatch < c.spots ? ' (จุดที่เหลือไม่มีรูปป้าย Code ที่อ่านได้)' : ''));
  if (waiting) {
    lines.push('📝 AI บันทึกรูปที่ควรแจ้งช่าง <b>' + waiting + '</b> รูป (บันทึกในชีท _AICheckLog — ไม่ขวางการส่งเซล)');
    var by = _aiFlagReport(jobId, codes), who;
    for (who in by) {
      var items = by[who].slice(0, 12).map(function(x){ return x.code + ' (' + x.reason + ')'; }).join(', ');
      lines.push('&nbsp;&nbsp;👷 <b>' + who + '</b>: ' + items + (by[who].length > 12 ? ' และอีก ' + (by[who].length - 12) + ' จุด' : ''));
    }
    color = '#b25e00'; bg = '#fff4e5';
    var draftBy = by;
  }
  if (unchecked) { lines.push('⏳ AI ยังไม่ได้ตรวจ ' + unchecked + ' รูป (' + (_aiBotReady_() ? 'บอทเริ่มตรวจแล้ว — ผลขึ้นใน Snaphub ภายในไม่กี่นาที' : 'บอทจะตรวจให้ในรอบถัดไป') + ')'); if (color === PLANB_BLUE) { color = '#555'; bg = '#f3f3f3'; } }
  if (total && !waiting && !unchecked) lines.push('✓ ไม่พบรูปที่ต้องแจ้งช่าง');
  return '<div style="background:' + bg + ';color:' + color + ';border-radius:10px;padding:12px;font-size:13px;line-height:1.7;margin-bottom:18px;text-align:left">' + lines.join('<br>') + '</div>' +
    (draftBy ? _draftHtml_(draftBy) : '');
}

// ═══════════════ Gemini API — ร่างข้อความแจ้งช่างจากธงที่ AI ตรวจรูปเจอ ═══════════════
// ส่งไป Gemini เฉพาะข้อความ: Code จุด + เหตุผลที่ติดธง (ไม่มีรูป · ไม่มีชื่อลูกค้า/ชื่องาน · ชื่อช่างแทนด้วย "ช่าง 1, 2, ...")
// Gemini ตอบเป็น JSON → ระบบตรวจว่าครบทุก Code ก่อนใช้ ถ้าไม่ผ่าน/ไม่มีคีย์/โควต้าหมด → ใช้ข้อความแม่แบบแทน (งานไม่สะดุด)
// ทุกครั้งที่เรียกบันทึกลงชีท _AIApiLog (เวลา · โมเดล · ผล · เวลาที่ใช้) — ใส่คีย์ได้ในเมนู 🔒 ของ Snaphub
var GEMINI_PREF = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.0-flash'];
function _geminiKey_() { return String(_props.getProperty('GEMINI_API_KEY') || '').trim(); }
function _geminiModelList_(key) {
  var saved = _props.getProperty('GEMINI_MODEL'), list = saved ? [saved] : [];
  GEMINI_PREF.forEach(function (m) { if (list.indexOf(m) < 0) list.push(m); });
  try {   // เผื่อชื่อรุ่นเปลี่ยน: ถามรายชื่อรุ่นที่ใช้ได้จริงจาก API แล้วต่อท้าย
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) (JSON.parse(r.getContentText()).models || []).forEach(function (m) {
      var n = String(m.name || '').replace('models/', '');
      if (/flash/.test(n) && !/image|tts|audio|live|embedding|thinking|exp/.test(n) && (m.supportedGenerationMethods || []).indexOf('generateContent') > -1 && list.indexOf(n) < 0) list.push(n);
    });
  } catch (e) {}
  return list;
}
function _geminiJson_(prompt, purpose) {
  var key = _geminiKey_(), t0 = Date.now();
  if (!key) return { ok: false, why: 'nokey' };
  var body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 2048 } });
  var models = _geminiModelList_(key), lastErr = '';
  for (var i = 0; i < models.length && i < 6; i++) {
    try {
      // ส่งคีย์ทาง header (รองรับคีย์แบบเก่า AIza... และแบบใหม่ AQ....) — ไม่ติดไปกับ URL/log
      var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent',
        { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: body, muteHttpExceptions: true });
      var code = res.getResponseCode();
      if (code === 404 || code === 400) { lastErr = models[i] + ' ' + code; continue; }   // รุ่นนี้ใช้ไม่ได้ → ลองรุ่นถัดไป
      if (code !== 200) { lastErr = models[i] + ' ' + code; break; }                      // โควต้าหมด/ระบบล่ม → ใช้แม่แบบแทน
      var j = JSON.parse(res.getContentText());
      var txt = (((j.candidates || [])[0] || {}).content || {}).parts;
      txt = (txt || []).map(function (x) { return x.text || ''; }).join('');
      var data = JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim());
      _props.setProperty('GEMINI_MODEL', models[i]);
      _aiApiLog_(purpose, models[i], 'ok', Date.now() - t0, '');
      return { ok: true, data: data, model: models[i] };
    } catch (e) { lastErr = models[i] + ' ' + e.message; }
  }
  _aiApiLog_(purpose, models[Math.min(i, models.length - 1)] || '-', 'error', Date.now() - t0, String(lastErr).slice(0, 200));
  return { ok: false, why: lastErr };
}
function _aiApiLog_(purpose, model, status, ms, note) {
  try {
    var ss = openNamedSS('_AIApiLog', ['เวลา', 'งานที่ให้ AI ทำ', 'โมเดล', 'ผล', 'ใช้เวลา (ms)', 'หมายเหตุ']);
    if (ss) ss.getActiveSheet().appendRow([Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'), purpose, model, status, ms, note || '']);
  } catch (e) {}
}
/** by = {ชื่อช่าง: [{code, reason}]} → {ชื่อช่าง: ข้อความพร้อมส่ง LINE} · source = 'gemini' | 'template' */
// คำแนะนำสำรองตามปัญหา (ใช้เมื่อ Gemini ไม่ตอบ/ตอบไม่ครบ)
function _fixTip_(reason) {
  var r = String(reason || '');
  if (/ผิดป้าย/.test(r)) return 'ถ่ายป้าย Code ให้เห็นชัด และเช็คว่าติดตรงจุดนี้จริง';
  if (/มืด|ไฟ/.test(r)) return 'ถ่ายตอนไฟป้ายติด หรือเปิดแฟลชช่วย';
  if (/เบลอ/.test(r)) return 'ถือมือถือให้นิ่ง แตะโฟกัสที่ป้ายก่อนกดถ่าย';
  if (/เอียง/.test(r)) return 'ยืนตรงหน้าป้าย ถือมือถือให้ตรง';
  if (/Code|โค้ด/i.test(r)) return 'ถ่ายป้าย Code ให้เห็นชัดอีก 1 รูป';
  return 'ถ่ายใหม่ให้เห็นป้ายชัดทั้งป้าย';
}
// จัดข้อความเป็นบรรทัด อ่านง่ายบน LINE: ทักทาย → จุดละ 2 บรรทัด (Code+ปัญหา / วิธีถ่าย) → ขอบคุณ
function _fmtDraft_(name, items, fixes) {
  var lines = ['สวัสดีค่ะ ช่าง' + (name === 'ไม่ระบุช่าง' ? '' : name) + ' 🙏', 'รบกวนถ่ายรูปใหม่ ' + items.length + ' จุดนะคะ', ''];
  items.forEach(function (x, k) {
    lines.push('📍 ' + x.code);
    lines.push('⚠️ ' + x.reason);
    lines.push('👉 ' + (fixes[k] || _fixTip_(x.reason)));
    lines.push('');
  });
  lines.push('ถ้าผ่านไปแถวนั้นรบกวนถ่ายแล้วส่งในแอปได้เลยค่ะ ขอบคุณค่ะ 🙏');
  return lines.join('\n');
}
function _draftInstallerMessages_(by) {
  var names = Object.keys(by || {});
  if (!names.length) return { source: 'none', msgs: {} };
  var tpl = {}, tplItems = {};
  var itemsOf = function (n, fixes) { return by[n].map(function (x, k) { return { code: x.code, reason: x.reason, fix: fixes[k] || _fixTip_(x.reason) }; }); };
  names.forEach(function (n) { tpl[n] = _fmtDraft_(n, by[n], []); tplItems[n] = itemsOf(n, []); });
  // ผูกผลที่จำไว้กับคีย์ปัจจุบัน — เปลี่ยน/ใส่คีย์ใหม่ = ไม่ใช้ผลเก่า (กันค้างข้อความแม่แบบจากตอนยังไม่มีคีย์)
  var cacheKey = 'gem5_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(by) + '|' + _geminiKey_().slice(-8))).slice(0, 22);
  var cache = CacheService.getScriptCache(), hit = cache.get(cacheKey);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  // ส่งแบบไม่ระบุตัวตน: ช่าง 1, ช่าง 2 ... (ไม่ส่งชื่อจริง ชื่อลูกค้า หรือรูป)
  var anon = names.map(function (n, k) { return { id: 'ช่าง ' + (k + 1), items: by[n].slice(0, 20) }; });
  var prompt = 'คุณคือผู้ช่วยแอดมินทีมติดตั้งป้ายโฆษณา AI ตรวจรูปติดตั้งแล้วพบรูปที่ควรให้ช่างถ่ายใหม่ ' +
    'สำหรับแต่ละจุด เขียนคำแนะนำวิธีถ่ายใหม่ที่ตรงกับปัญหาของจุดนั้น 1 ประโยคสั้นๆ (ไม่เกิน 60 ตัวอักษร) ภาษาง่าย สุภาพแบบที่ทำงาน ' +
    'ไม่ใส่คำลงท้าย (ครับ/ค่ะ/นะจ๊ะ/จ้า) และไม่ใส่อีโมจิ ' +
    '(เช่น รูปมืด → ถ่ายตอนไฟป้ายติดหรือเปิดแฟลช, รูปเบลอ → ถือนิ่ง/แตะโฟกัส, อาจติดผิดป้าย → ถ่ายป้าย Code ให้ชัดและเช็คจุดติด) ' +
    'ใช้ code ตามข้อมูลเท่านั้น ห้ามแต่ง code ใหม่ ห้ามใส่คำทักทาย\n' +
    'ตอบเป็น JSON เท่านั้น รูปแบบ {"messages":[{"id":"ช่าง 1","items":[{"code":"...","fix":"..."}]}]}\nข้อมูล: ' + JSON.stringify(anon);
  var r = _geminiJson_(prompt, 'ร่างข้อความแจ้งช่าง (' + names.length + ' คน)');
  var why = r.ok ? 'badjson' : (r.why === 'nokey' ? 'nokey' : (/ 429/.test(r.why || '') ? 'quota' : 'error'));
  var out = { source: 'template', msgs: tpl, items: tplItems, model: '', why: why };
  if (r.ok && r.data && r.data.messages) {
    var got = {}, good = true, msgs = {}, its = {};
    r.data.messages.forEach(function (m) {
      var fx = {}; (m.items || []).forEach(function (it) { fx[String(it.code || '').trim().toUpperCase()] = String(it.fix || '').trim(); });
      got[String(m.id || '').trim()] = fx;
    });
    anon.forEach(function (a, k) {
      var fx = got[a.id] || {};
      // ตรวจผลก่อนใช้: ทุกจุดต้องมีคำแนะนำ สั้น ไม่ขึ้นบรรทัดใหม่ — จุดไหนไม่ผ่าน ใช้คำแนะนำสำรองของจุดนั้น
      var fixes = by[names[k]].map(function (x, i) {
        if (i >= a.items.length) return '';
        var f = fx[String(x.code).toUpperCase()] || '';
        if (!f || f.length > 90 || /[\r\n]/.test(f)) { good = false; return ''; }
        return f;
      });
      msgs[names[k]] = _fmtDraft_(names[k], by[names[k]], fixes);
      its[names[k]] = itemsOf(names[k], fixes);
    });
    out = { source: good ? 'gemini' : 'gemini+template', msgs: msgs, items: its, model: r.model };
    if (!good) _aiApiLog_('ตรวจผล Gemini', r.model, 'บางจุดไม่มีคำแนะนำ → ใช้คำแนะนำสำรองเฉพาะจุดนั้น', 0, '');
  }
  // ไม่มีคีย์ → ไม่จำผล (ใส่คีย์แล้วใช้ได้ทันที) · เรียกพลาด → จำแค่ 10 นาที กันยิง API ซ้ำ · สำเร็จ → จำ 6 ชม.
  if (out.why !== 'nokey' || out.source !== 'template') {
    try { cache.put(cacheKey, JSON.stringify(out), out.source === 'template' ? 600 : 21600); } catch (e) {}
  }
  return out;
}
/** Snaphub ปุ่ม "💬 ร่างข้อความแจ้งช่าง" — ใช้ธงล่าสุด ณ ตอนกด (ไม่ต้องรออีเมลรายวัน) · แอดมินเท่านั้น */
function aiDraft(body) {
  try {
    var by = _aiFlagReport(String(body.jobId || ''), null), names = Object.keys(by);
    if (!names.length) return json({ success: true, source: 'none', drafts: [] });
    var d = _draftInstallerMessages_(by);
    return json({ success: true, source: d.source, model: d.model || '', why: d.why || '',
      drafts: names.map(function (n) { return { installer: n, count: by[n].length, text: d.msgs[n] || '', items: (d.items || {})[n] || [] }; }) });
  } catch (e) { return json({ success: false, error: String(e && e.message || e) }); }
}
function _draftHtml_(by) {
  var d = _draftInstallerMessages_(by), names = Object.keys(d.msgs || {});
  if (!names.length) return '';
  var head = d.source === 'template' ? '💬 ข้อความแจ้งช่าง (แม่แบบ) — คัดลอกส่ง LINE ได้เลย'
    : '💬 ข้อความแจ้งช่าง — ร่างโดย Gemini API' + (d.model ? ' (' + d.model + ')' : '') + ' · คัดลอกส่ง LINE ได้เลย';
  return '<div style="text-align:left;margin:-8px 0 18px 0;padding:12px;border:1px dashed #d9b98a;border-radius:10px;background:#fffdf8;font-size:13px;color:#333">' +
    '<div style="font-weight:bold;color:#b25e00;margin-bottom:6px">' + head + '</div>' +
    names.map(function (n) { return '<div style="margin:6px 0;padding:10px 12px;background:#fff;border-radius:8px;border:1px solid #eee;white-space:pre-line;line-height:1.7">' + esc_(d.msgs[n]) +
      '<div style="white-space:normal;margin-top:8px"><a href="https://line.me/R/share?text=' + encodeURIComponent(d.msgs[n]) + '" style="display:inline-block;background:#06C755;color:#fff;text-decoration:none;font-weight:bold;font-size:12px;padding:6px 12px;border-radius:6px">💬 ส่ง LINE</a></div></div>'; }).join('') +
    '<div style="color:#999;font-size:11px">ส่งให้ AI เฉพาะ Code + เหตุผล (ไม่มีรูป · ไม่มีชื่อลูกค้า · ไม่มีชื่อช่าง)</div></div>';
}
/** เมนู 🔒: ใส่/ลบคีย์ Gemini (คีย์ไม่ถูกส่งกลับไปที่แอป) + ทดสอบ */
function geminiTest() {   // ▶ รันใน Apps Script เพื่อลองเรียก Gemini (ดูผลใน Execution log และชีท _AIApiLog)
  var r = _draftInstallerMessages_({ 'ทดสอบ': [{ code: 'TEST-' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'HHmmss'), reason: 'รูปมืด / อาจไฟป้ายดับ' }] });
  Logger.log(JSON.stringify(r));
  return r;
}

function _webAppUrl() {
  var base = ''; try { base = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (!/\/exec$/.test(base)) base = 'https://script.google.com/macros/s/AKfycbwgA7ohAgzVS4C37dUQh0M3utU5l7Wb17GjURcSCkPXkAW-7XIyhgLbRq_iXl9mVtt0Sg/exec'; // กันลิงก์ผิดบางสภาพแวดล้อม
  return base;
}

// ═══════════════ รายงานรายวัน (แทนการรอครบ 100%) ═══════════════
// _Jobs คอลัมน์ 13 = reportedCodes (จุดที่ส่งเซลแล้ว) · 14 = pendingCodes (จุดรอบนี้ที่รอแอดมินยืนยัน)
function mailCcOf_(ccEmail, noSales) {
  return ccEmail ? ccEmail : (!noSales && CONFIG.ADMIN_EMAIL ? CONFIG.ADMIN_EMAIL : '');
}
function _codesOf(v) {
  try { var a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(function(c){ return String(c).trim().toUpperCase(); }) : []; }
  catch (e) { return []; }
}
function _installedByJob() {
  var out = {}, ss = openNamedSS('_InstallLog', null);
  if (!ss) return out;
  var rows = ss.getActiveSheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var j = String(rows[i][0]);
    (out[j] = out[j] || {})[String(rows[i][1]).trim().toUpperCase()] = true;
  }
  return out;
}


/** ห่ออีเมลให้เป็นการ์ดกว้างคงที่ 600px อยู่กลางจอ (Outlook/Gmail ไม่ยืดเต็มจอ) */
function _wrapMail_(inner) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f4f7" style="background:#f2f4f7"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3e6ea;border-radius:14px"><tr><td style="padding:4px">' +
    inner + '</td></tr></table></td></tr></table>';
}

function _sendDailyAdminEmail(jr, total, reportedCount, pending, carried) {
  var jobId = jr.values[0], jobName = jr.values[1] || '', media = jr.values[7] || '';
  var salesEmail = String(jr.values[9] || '').trim();
  var approveKey = genPortalKey() + genPortalKey();
  jr.sh.getRange(jr.row, 11).setValue(approveKey);
  jr.sh.getRange(jr.row, 12).setValue('pending');
  var cum = reportedCount + pending.length, isDone = cum >= total;
  var confirmUrl = _webAppUrl() + '?action=approveSend&jobId=' + encodeURIComponent(jobId) + '&k=' + approveKey;
  var codeList = pending.slice(0, 40).join(', ') + (pending.length > 40 ? ' และอีก ' + (pending.length - 40) + ' จุด' : '');
  var F = "font-family:'Sarabun','Leelawadee UI','Segoe UI',Tahoma,Arial,sans-serif;", ac = PLANB_BLUE;
  var pct = total ? Math.min(100, Math.round(cum / total * 100)) : 0;
  var stat = function (n, label, color, last) {
    return '<td align="center" width="33%" style="padding:16px 4px;' + (last ? '' : 'border-right:1px solid #262626;') + F + '">' +
      '<div style="font-size:26px;font-weight:bold;color:' + color + ';line-height:1.15">' + n + '</div>' +
      '<div style="font-size:12px;color:#8a8a8a;margin-top:4px">' + label + '</div></td>';
  };
  var cs = pending.slice(0, 60), rows = '';
  for (var ri = 0; ri < cs.length; ri += 4) {
    rows += '<tr>';
    for (var ci = 0; ci < 4; ci++) {
      var cc = cs[ri + ci];
      rows += '<td width="25%" style="padding:3px">' + (cc ? '<div style="background:#1d1d1d;border:1px solid #2e2e2e;border-radius:6px;padding:6px 4px;text-align:center;font-size:13px;color:#e0e0e0;font-family:Consolas,Menlo,monospace">' + esc_(cc) + '</div>' : '&nbsp;') + '</td>';
    }
    rows += '</tr>';
  }
  var logo = null; try { logo = _planbLogoBlob_(); } catch (e) {}
  var brand = logo ? '<img src="cid:planblogo" alt="Plan B" height="30" style="height:30px;display:block;border:0">'
    : '<span style="font-size:17px;font-weight:bold;color:#ffffff">Plan <span style="color:' + PLANB_BLUE + '">B</span></span>';
  var html = '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0b0b" style="background:#0b0b0b"><tr><td align="center" style="padding:30px 12px">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#151515" style="max-width:600px;width:100%;background:#151515;border:1px solid #262626;border-radius:16px">' +
    '<tr><td style="padding:26px 28px 0;' + F + '">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">' + brand + '</td>' +
        (media ? '<td align="right" valign="middle" style="' + F + 'font-size:12px;color:#8a8a8a">' + esc_(media) + '</td>' : '') + '</tr></table>' +
      '<div style="margin-top:20px;font-size:13px;color:' + ac + ';font-weight:bold">● ' + (isDone ? '🎉 งานติดตั้งครบ 100%' : 'รายงานติดตั้งประจำวัน') + ' · รอแอดมินยืนยันส่งเซล</div>' +
      '<div style="font-size:26px;font-weight:bold;color:#ffffff;margin-top:6px;line-height:1.3">' + esc_(jobName) + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 28px 0">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#1d1d1d" style="background:#1d1d1d;border-radius:12px"><tr>' +
        stat(pending.length, 'จุดรอบนี้', '#ffffff') +
        stat(cum + '<span style="font-size:15px;color:#777">/' + total + '</span>', 'สะสมทั้งงาน', ac) +
        stat(pct + '%', 'ความคืบหน้า', '#ffffff', true) +
      '</tr></table>' +
      (carried ? '<div style="' + F + 'color:#ffc46b;font-size:12px;margin-top:8px">รวม ' + carried + ' จุดจากรอบก่อนที่ยังไม่ได้กดยืนยัน</div>' : '') +
    '</td></tr>' +
    (rows ? '<tr><td style="padding:20px 28px 0;' + F + '"><div style="font-size:13px;font-weight:bold;color:#e6e6e6;margin-bottom:8px">จุดที่ติดตั้งรอบนี้</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>' +
      (pending.length > 60 ? '<div style="font-size:12px;color:#8a8a8a;margin-top:6px">และอีก ' + (pending.length - 60) + ' จุด</div>' : '') + '</td></tr>' : '') +
    '<tr><td style="padding:20px 28px 0;' + F + '">' + _aiJobSummaryHtml(jobId, pending) + '</td></tr>' +
    '<tr><td style="padding:0 28px;' + F + '"><div style="font-size:13px;color:#9a9a9a;line-height:1.6">กดปุ่มด้านล่าง → <b style="color:#ffffff">ใส่/แก้อีเมลเซลและ CC</b> → กดยืนยัน ระบบจะส่ง PDF รูปของจุดรอบนี้ให้ทันที' +
      (salesEmail ? '<br>อีเมลเซลที่ใช้ครั้งก่อน: <b style="color:#ffffff">' + esc_(salesEmail) + '</b>' : '') + '</div></td></tr>' +
    '<tr><td style="padding:18px 28px 10px">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="' + ac + '" style="background:' + ac + ';border-radius:10px">' +
        '<a href="' + confirmUrl + '" style="display:block;padding:15px;' + F + 'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">ใส่อีเมลเซล แล้วส่งรูปรอบนี้</a>' +
      '</td></tr></table></td></tr>' +
    '<tr><td align="center" style="padding:8px 28px 24px;' + F + 'font-size:11px;color:#6b6b6b">การสร้าง PDF ใช้เวลา 1-3 นาที · ใช้ปุ่มจากอีเมลฉบับล่าสุดเท่านั้น<br>ระบบจัดการภาพติดตั้ง Snap · Plan B Media</td></tr>' +
  '</table></td></tr></table>';
  var mail = { to: CONFIG.ADMIN_EMAIL,
    subject: (isDone ? '🎉 [งานครบ 100%] ' : '📋 [รายงานประจำวัน] ') + jobName + ' — +' + pending.length + ' จุด (' + cum + '/' + total + ') กดยืนยันเพื่อส่งเซล',
    htmlBody: html };
  if (logo) mail.inlineImages = { planblogo: logo };
  MailApp.sendEmail(mail);
}

// กด Run ฟังก์ชันนี้ครั้งเดียวใน Apps Script Editor เพื่อตั้งเวลาส่งรายงานทุกวันราว 10:00 น.


/** แอดมินกดปุ่มยืนยันจากอีเมล → สร้าง PDF → ส่งเซล + ลิงก์ Portal → ปิดจ็อบ */
// โลโก้ Plan B สำหรับอีเมล: วางไฟล์ชื่อ planb-logo.png (หรือ .jpg) ไว้ในโฟลเดอร์หลักของแอปใน Drive
// ระบบแนบเป็นรูปในตัวอีเมล (ไม่ต้องกดโหลดรูป) · ไม่มีไฟล์ = ใช้ตัวอักษร "Plan B" แทน
function _planbLogoBlob_() {
  try {
    var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    var names = ['planb-logo.png', 'planb-logo.jpg', 'planb-logo.jpeg'];
    for (var i = 0; i < names.length; i++) {
      var it = folder.getFilesByName(names[i]);
      if (it.hasNext()) return it.next().getBlob().setName('planb-logo');
    }
  } catch (e) {}
  return null;
}

// 🎨 สีน้ำเงิน CI ของ Plan B ที่ใช้ในอีเมลถึงเซล — แก้รหัสสีตรงนี้ให้ตรงคู่มือ CI ได้เลย
var PLANB_BLUE = '#1f6fd6';

// การ์ดอีเมลถึงเซล (ธีมดำแบบแอป Snaphub) — ใช้ตาราง + สไตล์ในบรรทัด ให้แสดงได้ทั้ง Outlook / Gmail / มือถือ
function _salesCardHtml_(d) {
  var F = "font-family:'Sarabun','Leelawadee UI','Segoe UI',Tahoma,Arial,sans-serif;";
  var ac = PLANB_BLUE;  // สีน้ำเงินตาม CI Plan B ทั้งงานครบและอัปเดตรายวัน
  var fmt = function(v) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); return m ? (Number(m[3]) + '/' + Number(m[2]) + '/' + (Number(m[1]) + 543)) : ''; };
  var period = (d.dateStart || d.dateEnd) ? (fmt(d.dateStart) + (d.dateEnd ? ' – ' + fmt(d.dateEnd) : '')) : '';
  var pct = d.total ? Math.min(100, Math.round(d.cum / d.total * 100)) : 0;
  var stat = function(n, label, color, last) {
    return '<td align="center" width="33%" style="padding:16px 4px;' + (last ? '' : 'border-right:1px solid #262626;') + F + '">' +
      '<div style="font-size:26px;font-weight:bold;color:' + color + ';line-height:1.15">' + n + '</div>' +
      '<div style="font-size:12px;color:#8a8a8a;margin-top:4px">' + label + '</div></td>';
  };
  // Code แต่ละจุดเป็นช่องในตาราง 4 คอลัมน์ — ทุกโปรแกรมอีเมล (รวม Outlook) เว้นระยะชัดเจน ไม่ติดกัน
  var cs = (d.codes || []).slice(0, 60), rows = '';
  for (var ri = 0; ri < cs.length; ri += 4) {
    rows += '<tr>';
    for (var ci = 0; ci < 4; ci++) {
      var cc = cs[ri + ci];
      rows += '<td width="25%" style="padding:3px">' + (cc ? '<div style="background:#1d1d1d;border:1px solid #2e2e2e;border-radius:6px;padding:6px 4px;text-align:center;font-size:13px;color:#e0e0e0;font-family:Consolas,Menlo,monospace">' + esc_(cc) + '</div>' : '&nbsp;') + '</td>';
    }
    rows += '</tr>';
  }
  var list = rows ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>' +
    ((d.codes || []).length > 60 ? '<div style="font-size:12px;color:#8a8a8a;margin-top:6px">และอีก ' + (d.codes.length - 60) + ' จุด</div>' : '') : '';
  var fl = (d.folders || []).map(function(f, i) {
    var label = (d.folders.length > 1 && f.name) ? 'รูปติดตั้งใน Drive · ' + esc_(f.name) : 'เปิดโฟลเดอร์รูปติดตั้งใน Drive';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr>' +
      '<td align="center" style="border:1px solid ' + ac + ';border-radius:10px">' +
      '<a href="' + esc_(f.url) + '" style="display:block;padding:13px;' + F + 'font-size:14px;font-weight:bold;color:' + ac + ';text-decoration:none">' + label + '</a></td></tr></table>';
  }).join('');
  var brand = d.logo
    ? '<img src="cid:planblogo" alt="Plan B" height="30" style="height:30px;display:block;border:0">'
    : '<span style="font-size:17px;font-weight:bold;color:#ffffff">Plan <span style="color:' + PLANB_BLUE + '">B</span></span>';
  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0b0b" style="background:#0b0b0b"><tr><td align="center" style="padding:30px 12px">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#151515" style="max-width:600px;width:100%;background:#151515;border:1px solid #262626;border-radius:16px">' +
    '<tr><td style="padding:26px 28px 0;' + F + '">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td valign="middle">' + brand + '</td>' +
        (d.media ? '<td align="right" valign="middle" style="' + F + 'font-size:12px;color:#8a8a8a">' + esc_(d.media) + '</td>' : '') +
      '</tr></table>' +
      '<div style="margin-top:20px;font-size:13px;color:' + ac + ';font-weight:bold">● ' + (d.isDone ? 'งานติดตั้งเสร็จสมบูรณ์' : 'อัปเดตงานติดตั้ง') + '</div>' +
      '<div style="font-size:26px;font-weight:bold;color:#ffffff;margin-top:6px;line-height:1.3">' + esc_(d.jobName) + '</div>' +
      (period ? '<div style="font-size:13px;color:#8a8a8a;margin-top:4px">ระยะเวลาติดตั้ง ' + period + '</div>' : '') +
    '</td></tr>' +
    '<tr><td style="padding:20px 28px 0">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#1d1d1d" style="background:#1d1d1d;border-radius:12px"><tr>' +
        stat(d.nNow, 'จุดที่ส่งรอบนี้', '#ffffff') +
        stat(d.cum + '<span style="font-size:15px;color:#777">/' + d.total + '</span>', 'สะสมทั้งงาน (' + pct + '%)', ac) +
        stat(d.photos, 'รูปใน PDF', '#ffffff', true) +
      '</tr></table></td></tr>' +
    (list ? '<tr><td style="padding:20px 28px 0;' + F + '"><div style="font-size:13px;font-weight:bold;color:#e6e6e6;margin-bottom:8px">จุดที่ติดตั้งรอบนี้</div>' + list + '</td></tr>' : '') +
    (d.noSales ? '<tr><td style="padding:14px 28px 0;' + F + '"><div style="background:#3a1414;color:#ff8a80;font-size:13px;padding:10px 12px;border-radius:8px">⚠️ ไม่ได้ระบุอีเมลเซล — กรุณาส่งต่อให้เซลผู้ดูแลเองค่ะ</div></td></tr>' : '') +
    '<tr><td style="padding:22px 28px 10px">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="' + ac + '" style="background:' + ac + ';border-radius:10px">' +
        '<a href="' + esc_(d.pdfUrl || '') + '" style="display:block;padding:15px;' + F + 'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">ดาวน์โหลด PDF รูปติดตั้ง</a>' +
      '</td></tr></table>' + fl + '</td></tr>' +
    '<tr><td align="center" style="padding:8px 28px 24px;' + F + 'font-size:11px;color:#6b6b6b">ส่งจากระบบจัดการภาพติดตั้ง Snap · Plan B Media</td></tr>' +
  '</table></td></tr></table>';
}

// แยกรายการอีเมลจากช่องกรอก (คั่นด้วย , ; เว้นวรรค หรือขึ้นบรรทัดใหม่)
function _emailList_(v) {
  var ok = [], bad = [];
  String(v || '').split(/[\s,;]+/).forEach(function(e) {
    e = e.trim(); if (!e) return;
    if (/^[^@\s<>"']+@[^@\s<>"']+\.[^@\s<>"']+$/.test(e)) { if (ok.indexOf(e.toLowerCase()) < 0) ok.push(e.toLowerCase()); }
    else bad.push(e);
  });
  return { ok: ok.slice(0, 20), bad: bad };
}
// หน้าใส่อีเมลเซล + CC ก่อนกดส่งจริง
function _approveFormPage(jobId, k, jobName, media, nNew, nReported, nTotal, err, toVal, ccVal) {
  var url = _webAppUrl();
  var inp = 'width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:15px;font-family:inherit';
  var html = '<div style="font-family:Sarabun,Arial,sans-serif;max-width:480px;margin:40px auto;padding:20px">' +
    '<div style="text-align:center;font-size:44px">📨</div>' +
    '<h2 style="text-align:center;margin:6px 0 2px">ส่งรูปติดตั้งให้เซล</h2>' +
    (media ? '<div style="text-align:center;color:#1665c1;font-weight:bold">📺 ' + esc_(media) + '</div>' : '') +
    '<div style="text-align:center;font-size:18px;font-weight:bold;margin:4px 0">' + esc_(jobName) + '</div>' +
    '<div style="text-align:center;color:#666;margin-bottom:18px">รอบนี้ <b>' + nNew + ' จุด</b>' + (nReported ? ' · ส่งไปแล้วก่อนหน้า ' + nReported + ' จุด' : '') + '</div>' +
    (err ? '<div style="background:#fdecea;color:#c62828;padding:10px 12px;border-radius:8px;margin-bottom:14px;font-size:14px">⚠️ ' + esc_(err) + '</div>' : '') +
    '<form method="get" action="' + url + '" target="_top" onsubmit="var b=document.getElementById(\'sb\');b.disabled=true;b.textContent=\'⏳ กำลังสร้าง PDF และส่ง (1-3 นาที) อย่าปิดหน้านี้...\'">' +
      '<input type="hidden" name="action" value="approveSend">' +
      '<input type="hidden" name="jobId" value="' + esc_(jobId) + '">' +
      '<input type="hidden" name="k" value="' + esc_(k) + '">' +
      '<input type="hidden" name="go" value="1">' +
      '<label style="font-weight:bold;font-size:14px">ถึง (อีเมลเซล)</label>' +
      '<input name="to" type="text" value="' + esc_(toVal) + '" placeholder="sales@planbmedia.co.th" style="' + inp + ';margin:6px 0 14px">' +
      '<label style="font-weight:bold;font-size:14px">CC</label>' +
      '<input name="cc" type="text" value="' + esc_(ccVal) + '" placeholder="ไม่ใส่ก็ได้" style="' + inp + ';margin:6px 0 6px">' +
      '<div style="color:#888;font-size:12px;margin-bottom:18px">หลายคนคั่นด้วย , · ถ้าไม่ใส่อีเมลเซล ระบบจะส่งเข้าอีเมลแอดมินเพื่อส่งต่อเอง · ระบบจำอีเมลไว้ใช้รอบหน้า</div>' +
      '<button id="sb" type="submit" style="width:100%;background:' + PLANB_BLUE + ';color:#fff;border:none;padding:16px;border-radius:10px;font-size:16px;font-weight:bold;font-family:inherit;cursor:pointer">✅ ยืนยัน — ส่ง PDF รูปติดตั้ง</button>' +
    '</form>' +
    '<p style="color:#aaa;font-size:12px;text-align:center;margin-top:24px">Plan B Installation App</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('Plan B — ส่งรูปให้เซล')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function approveSend(p) {
  function page(title, msg, ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Sarabun,Arial,sans-serif;max-width:460px;margin:60px auto;text-align:center;padding:20px">'+
      '<div style="font-size:56px">'+(ok?'✅':'⚠️')+'</div>'+
      '<h2 style="color:'+(ok?PLANB_BLUE:'#c62828')+'">'+title+'</h2>'+
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
    var pending = _codesOf(jr.values[13]), reported = _codesOf(jr.values[12]);
    if (!pending.length) return page('ไม่มีจุดใหม่รอส่ง', 'รอบนี้ไม่มีจุดติดตั้งใหม่ที่รอส่งเซลค่ะ', true);

    // ขั้นที่ 1: หน้าใส่อีเมลเซล + CC ก่อนส่ง (กดจากอีเมลแล้วยังไม่ส่งทันที — กันตัวสแกนลิงก์ในอีเมลกดแทนด้วย)
    var savedTo = String(jr.values[9] || '').trim(), savedCc = String(jr.values[14] || '').trim();
    if (String(p.go || '') !== '1') {
      return _approveFormPage(p.jobId, p.k, jobName, media, pending.length, reported.length,
        0,
        p.err ? String(p.err) : '', p.to != null ? String(p.to) : savedTo, p.cc != null ? String(p.cc) : (savedCc || CONFIG.ADMIN_EMAIL || ''));
    }
    var toList = _emailList_(p.to), ccList = _emailList_(p.cc);
    if (toList.bad.length || ccList.bad.length) {
      return _approveFormPage(p.jobId, p.k, jobName, media, pending.length, reported.length, 0,
        'อีเมลไม่ถูกต้อง: ' + toList.bad.concat(ccList.bad).join(', '), String(p.to || ''), String(p.cc || ''));
    }
    // กันกดซ้ำ/ตัวสแกนลิงก์ในอีเมลเปิดซ้อน → เซลได้อีเมล 2 ฉบับ: จองสถานะ "กำลังส่ง" ภายใต้ lock
    var busy = withLock2(function() {
      var cur = String(jr.sh.getRange(jr.row, 12).getValue() || '');
      var m = /^sending (\d+)/.exec(cur);
      if (cur.indexOf('sent') === 0 || (m && Date.now() - Number(m[1]) < 10 * 60000)) return cur;
      jr.sh.getRange(jr.row, 12).setValue('sending ' + Date.now());
      return '';
    });
    if (busy) return page(busy.indexOf('sent') === 0 ? 'ส่งไปแล้วค่ะ' : 'กำลังส่งอยู่ค่ะ', 'ระบบกำลังสร้าง PDF / ส่งให้เซลจากการกดครั้งก่อน ไม่ต้องกดซ้ำค่ะ', true);
    var releaseClaim = function(){ try { jr.sh.getRange(jr.row, 12).setValue('pending'); } catch(e) {} };
    var dateStart = ymd_(jr.values[4]);
    var dateEnd = ymd_(jr.values[5]);
    var salesEmail = toList.ok.join(',');
    var ccEmail = ccList.ok.filter(function(e){ return toList.ok.indexOf(e) < 0; }).join(',');
    // จำอีเมลที่ใส่ไว้ใช้รอบหน้า (คอลัมน์ 10 = เซล, 15 = CC)
    try {
      jr.sh.getRange(jr.row, 10).setValue(salesEmail); jr.sh.getRange(jr.row, 15).setValue(ccEmail);
      if (!jr.sh.getRange(1, 15).getValue()) jr.sh.getRange(1, 15).setValue('ccEmail');
    } catch(e) {}
    var spots = JSON.parse(jr.values[2] || '[]');

    // 1) สร้าง PDF รูปติดตั้ง
    var pendSet = {}; pending.forEach(function(c){ pendSet[c] = true; });
    var codes = spots.filter(function(s){ return pendSet[String(s.code).trim().toUpperCase()]; })
      .map(function(s){ return { code: s.code, address: s.address || '', product: s.product || '' }; });
    var prodUrlOf = {};   // Code → ลิงก์โฟลเดอร์รูป (โฟลเดอร์สินค้า: มีแต่รูปติดตั้ง ไม่มี PDF/เอกสาร)
    // ใช้ดัชนีรูปของงานนี้ (_InstallLog) — เร็ว และไม่ดึงรูปของงานอื่นที่ Code ซ้ำกันมาปน
    try {
      var ilog = openNamedSS('_InstallLog', null);
      if (ilog) {
        var irows = ilog.getActiveSheet().getDataRange().getValues(), idMap = {};
        for (var ir = 1; ir < irows.length; ir++) {
          if (String(irows[ir][0]) !== String(jobId)) continue;
          try { idMap[String(irows[ir][1]).trim().toUpperCase()] = JSON.parse(irows[ir][7] || '[]'); } catch(e) {}
          if (irows[ir][6]) prodUrlOf[String(irows[ir][1]).trim().toUpperCase()] = String(irows[ir][6]);
        }
        codes.forEach(function(c){ c.imgIds = idMap[String(c.code).trim().toUpperCase()] || []; });
      }
    } catch(e) {}
    var pdfRes = JSON.parse(createSalesPDF({ jobName: jobName, media: media,
      dateStart: dateStart, dateEnd: dateEnd, codes: codes }).getContent());
    if (!pdfRes.success) { releaseClaim(); return page('สร้าง PDF ไม่สำเร็จ', (pdfRes.error||'') + '<br>ลองกดปุ่มในอีเมลอีกครั้งค่ะ', false); }
    // จุดที่สร้าง PDF ไม่ทัน → ยังค้างไว้ส่งรอบหน้า ไม่นับว่าส่งแล้ว
    var skippedSet = {}; (pdfRes.timedOut || []).forEach(function(c){ skippedSet[String(c).trim().toUpperCase()] = true; });
    var sentNow = pending.filter(function(c){ return !skippedSet[c]; });
    var leftOver = pending.filter(function(c){ return skippedSet[c]; });
    var cum = reported.length + sentNow.length, isDone = cum >= spots.length;
    if (!sentNow.length) { releaseClaim(); return page('สร้าง PDF ไม่ทันเวลา', 'ระบบยังทำ PDF ไม่ทันในรอบนี้ — กดปุ่มในอีเมลอีกครั้งค่ะ', false); }

    // 2) ลิงก์ Portal เรียลไทม์ (สร้าง key ถ้ายังไม่มี)
    var portalKey = String(jr.values[8] || '').trim();
    if (!portalKey) { portalKey = genPortalKey(); jr.sh.getRange(jr.row, 9).setValue(portalKey); }

    // 3) ส่งอีเมลถึงเซล (หรือแอดมินถ้าไม่มีเซล)
    var noSales = !salesEmail;
    var to = noSales ? CONFIG.ADMIN_EMAIL : salesEmail;
    // ลิงก์โฟลเดอร์รูปใน Drive ของงานนี้ — เปิด "ทุกคนที่มีลิงก์ดูได้" ให้เซลส่งต่อลูกค้าได้
    var folders = [], seenF = {};
    sentNow.forEach(function(c) {
      var u = prodUrlOf[c]; if (!u || seenF[u]) return; seenF[u] = true;
      var m = /folders\/([A-Za-z0-9_-]+)/.exec(u), name = '';
      try { if (m) { var fo = DriveApp.getFolderById(m[1]); name = fo.getName();
        try { fo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {} } } catch(e) {}
      folders.push({ url: u, name: name });
    });
    var logoBlob = _planbLogoBlob_();
    var mailHtml = _salesCardHtml_({ logo: !!logoBlob, isDone: isDone, media: media, jobName: jobName, noSales: noSales,
      dateStart: dateStart, dateEnd: dateEnd, nNow: sentNow.length, cum: cum, total: spots.length,
      photos: pdfRes.photoCount || 0, pdfUrl: pdfRes.pdfUrl || pdfRes.docUrl, codes: sentNow, folders: folders.slice(0, 6) });
    var mailOpts = { to: to,
      subject: (isDone ? '📦 [ส่งมอบงาน] ' : '📋 [อัปเดตรายวัน] ') + (media ? media + ' · ' : '') + jobName +
        (isDone ? ' — ครบ ' + spots.length + ' จุด' : ' — +' + sentNow.length + ' จุด (' + cum + '/' + spots.length + ')'),
      htmlBody: mailHtml };
    if (logoBlob) mailOpts.inlineImages = { planblogo: logoBlob };
    var ccOut = mailCcOf_(ccEmail, noSales); if (ccOut) mailOpts.cc = ccOut;
    MailApp.sendEmail(mailOpts);

    // 4) ปิดสถานะ
    var doneStamp = 'sent ' + Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm');
    withLock2(function() {
      // อ่านใหม่ — ระหว่างทำ PDF อาจมีจุดใหม่เข้ามาเพิ่มในคิว ไม่ให้หาย
      var v = jr.sh.getRange(jr.row, 1, 1, 14).getValues()[0];
      var sentSet = {}; sentNow.forEach(function(c){ sentSet[c] = true; });
      var stillPending = _codesOf(v[13]).filter(function(c){ return !sentSet[c]; });
      var curStatus = String(v[11] || '');
      var newStatus = stillPending.length ? 'pending' : doneStamp;   // ยังมีจุดค้าง → กดลิงก์เดิมส่งต่อได้
      if (/^sending/.test(curStatus) || curStatus === 'pending' || !curStatus) jr.sh.getRange(jr.row, 12).setValue(newStatus);
      jr.sh.getRange(jr.row, 13, 1, 2).setValues([[JSON.stringify(_codesOf(v[12]).concat(sentNow)), JSON.stringify(stillPending)]]); // ย้ายจุดที่ส่งจริง → ส่งแล้ว
      return true;
    });

    return page('ส่งเรียบร้อยแล้ว 🎉',
      'งาน <b>'+jobName+'</b> · รอบนี้ '+sentNow.length+' จุด (สะสม '+cum+'/'+spots.length+')<br>PDF รูปติดตั้ง ('+(pdfRes.photoCount||0)+' รูป)<br>ส่งถึง <b>'+esc_(to)+'</b> แล้ว'+
      (mailOpts.cc ? '<br>CC: <b>' + esc_(mailOpts.cc) + '</b>' : '') +
      (noSales ? '<br><span style="color:#c62828">(ไม่ได้ใส่อีเมลเซล จึงส่งเข้าอีเมลแอดมิน)</span>' : '') +
      (leftOver.length ? '<br><span style="color:#b25e00">⏳ อีก ' + leftOver.length + ' จุดสร้าง PDF ไม่ทันรอบนี้ — กดปุ่มเดิมในอีเมลอีกครั้งเพื่อส่งต่อ</span>' : ''), true);
  } catch(err) {
    try { var jr2 = findJobRow(p.jobId || ''); if (jr2 && /^sending/.test(String(jr2.values[11]))) jr2.sh.getRange(jr2.row, 12).setValue('pending'); } catch(e) {}
    return page('เกิดข้อผิดพลาด', err.message + '<br>ลองกดปุ่มในอีเมลอีกครั้ง หรือติดต่อผู้ดูแลระบบค่ะ', false);
  }
}
