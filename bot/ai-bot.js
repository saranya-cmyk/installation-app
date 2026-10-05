// ═══ หุ่นยนต์ตรวจรูป AI — ทำให้ AI ตรวจรูปครบ 100% โดยไม่ต้องมีใครเปิด Snaphub ค้างไว้ ═══
// วิธีทำงาน: เปิด Snaphub (admin.html) ในเบราว์เซอร์แบบไม่มีหน้าจอ → ใช้โค้ด AI ชุดเดียวกับที่แอดมินใช้ (CLIP + Tesseract OCR)
// ตรวจรูปที่ยังไม่เคยตรวจจนหมด แล้วบันทึกผลลงชีท _AICheckLog — AI ตรวจและบันทึกธงเองทั้งหมด ไม่ต้องมีคนตัดสิน — ธงใช้แจ้งช่างทีหลัง
// รันบน GitHub Actions ทุก 30 นาที (.github/workflows/ai-check.yml) · ไม่ใช้บริการ AI ภายนอก · 0 บาท
const { chromium } = require('playwright');

const ADMIN_URL = process.env.ADMIN_URL || 'https://saranya-cmyk.github.io/installation-app/admin.html';
const CACHE_DIR = process.env.CACHE_DIR || '.ai-cache';          // เก็บโมเดล AI ไว้ใช้รอบถัดไป ไม่ต้องโหลดใหม่
const BUDGET_MIN = Number(process.env.BUDGET_MIN || 45);         // รอบนี้ทำงานได้นานสุดกี่นาที (ที่เหลือรอบหน้าตรวจต่อ)
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 50);         // aiRun 1 รอบ = รูปค้างตรวจสูงสุด 200 รูป
const SCRIPT_TARGET = process.env.SCRIPT_TARGET || '';           // ใช้ตอนทดสอบเท่านั้น (ชี้ไป Apps Script จำลอง)

const t0 = Date.now();
const LINES = [];
const log = (...a) => { const t = new Date().toISOString().slice(11, 19) + ' ' + a.join(' '); LINES.push(t); console.log(t); };
// เวลาพัง: เขียนสาเหตุลงหน้าสรุปของรอบนั้น (คนที่ไม่ได้ล็อกอิน GitHub ก็เปิดดูได้) แล้วจบด้วยสถานะสีแดง
function fail(reason) {
  console.log('::error title=AI bot::' + String(reason).replace(/\r?\n/g, ' ').slice(0, 500));
  if (process.env.GITHUB_STEP_SUMMARY) {
    require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### ❌ หุ่นยนต์ตรวจรูปไม่สำเร็จ\n\n**สาเหตุ:** ' + String(reason).slice(0, 500) + '\n\n```\n' + LINES.slice(-60).join('\n') + '\n```\n');
  }
  process.exit(1);
}
const left = () => BUDGET_MIN * 60000 - (Date.now() - t0);

(async () => {
  const ctx = await chromium.launchPersistentContext(CACHE_DIR, {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,   // ปกติไม่ต้องตั้ง (ใช้ Chromium ของ Playwright)
    viewport: { width: 1280, height: 900 },            // ขนาดคอมพิวเตอร์ → Snaphub เปิดโหมดตรวจอัตโนมัติ
    serviceWorkers: 'block',                           // กัน service worker ส่งคำขอเลี่ยงตัวกลางด้านล่าง
  });
  // เบราว์เซอร์บนเครื่อง GitHub เรียก Apps Script ตรงๆ ไม่ผ่าน (Failed to fetch)
  // → ให้หุ่นยนต์เป็นคนเรียก Apps Script แทนเบราว์เซอร์ แล้วส่งคำตอบกลับเข้าหน้า Snaphub (ข้อมูลเหมือนเดิมทุกอย่าง)
  await ctx.route(/^https:\/\/script\.google\.com\/macros\/s\//, async route => {
    const req = route.request();
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    const url = SCRIPT_TARGET ? req.url().replace('https://script.google.com', SCRIPT_TARGET) : req.url();
    const isPost = req.method() === 'POST';
    try {
      const res = await fetch(url, {
        method: isPost ? 'POST' : 'GET', redirect: 'follow',
        body: isPost ? (req.postData() || '') : undefined,
        headers: isPost ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
      });
      const body = await res.text();
      if (!res.ok || !/^\s*[\[{]/.test(body)) {
        log('⚠️ Apps Script ตอบผิดปกติ:', res.status, (res.url || '').slice(0, 90), '|', body.slice(0, 200).replace(/\s+/g, ' '));
      }
      await route.fulfill({ status: res.status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }, body });
    } catch (e) {
      log('⚠️ เรียก Apps Script ไม่ได้:', e.message, e.cause ? '(' + (e.cause.code || e.cause.message) + ')' : '');
      await route.abort().catch(() => {});
    }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', e => log('⚠️ page error:', e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));   // กันหน้าต่าง alert ค้าง
  // ส่งข้อความเตือน/ผิดพลาดจากหน้าเว็บออกมาใน log ของ GitHub — ไว้ดูสาเหตุเวลาขึ้นสีแดง
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log('🌐', m.type() + ':', m.text().slice(0, 400)); });
  page.on('requestfailed', r => log('⚠️ โหลดไม่สำเร็จ:', r.url().slice(0, 150), '→', (r.failure() || {}).errorText));

  log('เปิด Snaphub:', ADMIN_URL);
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => typeof aiRun === 'function' && typeof _aiqState !== 'undefined', null, { timeout: 120000 });

  // ยอดตั้งต้นก่อนเริ่มตรวจ (ไว้คำนวณว่ารอบนี้ตรวจไปกี่รูป)
  const snap = () => page.evaluate(async () => {
    try { await aiqFetchState(); } catch (e) {}
    const st = _aiqState.stats || {};
    return { stats: st, pending: st.pending != null ? st.pending : (_aiqState.pending || []).length, flags: (_aiqState.flags || []).length };
  });
  const before = await snap().catch(() => ({ stats: {} }));
  log(`เริ่ม: ตรวจแล้ว ${before.stats.checked || 0} รูป · รอตรวจ ${before.pending || 0}${before.pending >= 200 ? '+' : ''} รูป`);
  // รายงานความคืบหน้าทุก 2 นาที (เห็นใน log ว่ายังทำงานอยู่)
  const tick = setInterval(() => {
    page.evaluate(() => { const c = document.getElementById('aiqChip'); return c ? c.textContent : ''; })
      .then(t => t && log('…', t)).catch(() => {});
  }, 120000);

  let last = null, timedOut = false;
  let stuck = 0, LAST_CHECKED = before.stats.checked;
  for (let round = 1; round <= MAX_ROUNDS && left() > 60000; round++) {
    let timer;
    const r = await Promise.race([
      page.evaluate(async () => {
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        while (_aiqBusy) await sleep(1000);            // Snaphub อาจเริ่มตรวจเองไปแล้ว รอให้จบก่อน
        window._aiqLastErr = '';
        await aiRun();
        while (_aiqBusy) await sleep(1000);
        const chip = document.getElementById('aiqChip');
        const st = _aiqState.stats || {};
        return {
          stats: st, pending: st.pending != null ? st.pending : (_aiqState.pending || []).length,
          flags: (_aiqState.flags || []).length, chip: chip ? chip.textContent : '', err: window._aiqLastErr || '',
        };
      }),
      new Promise(res => { timer = setTimeout(() => res({ timeout: true }), Math.max(left(), 1000)); }),
    ]);
    clearTimeout(timer);                                 // ไม่ให้ตัวจับเวลาค้าง → งานหมดแล้วจบรอบได้ทันที
    if (r.timeout) { timedOut = true; log('⏱ ครบเวลารอบนี้ — รูปที่เหลือจะตรวจต่อรอบหน้า (ผลที่ตรวจแล้วบันทึกไว้หมดแล้ว)'); break; }
    last = r;
    log(`รอบ ${round}: ตรวจแล้วรวม ${r.stats.checked || 0} รูป · รอตรวจ ${r.pending} รูป · ติดธง (บันทึกไว้แจ้งช่าง) ${r.flags} รูป`);
    if (r.err || /ใช้งาน AI ไม่ได้/.test(r.chip)) { clearInterval(tick); log('❌', r.err || r.chip); await ctx.close().catch(() => {}); fail(r.err || r.chip); }
    if (!r.pending) break;
    // รอบนี้ตรวจไม่เพิ่มเลยทั้งที่ยังมีรูปค้าง → หยุดเสียเวลา แล้วแจ้งเป็นสีแดง
    if (r.stats.checked === LAST_CHECKED) stuck++; else stuck = 0;
    LAST_CHECKED = r.stats.checked;
    if (stuck >= 2) { clearInterval(tick); await ctx.close().catch(() => {}); fail('AI ตรวจไม่คืบหน้า 2 รอบติดกัน ทั้งที่ยังค้างตรวจ ' + r.pending + ' รูป'); }
  }
  clearInterval(tick);
  if (timedOut || !last) {
    last = await Promise.race([snap(), new Promise(res => setTimeout(() => res(null), 90000))]).catch(() => null) || last;
  }

  if (last) {
    const n = (last.stats.checked || 0) - (before.stats.checked || 0);
    const more = last.pending ? `${last.pending}${last.pending >= 200 ? '+' : ''}` : '0';
    log(`✅ เสร็จ: รอบนี้ AI ตรวจรูปใหม่ ${n} รูป · ค้างตรวจ ${more} รูป · ติดธงบันทึกไว้แจ้งช่าง ${last.flags} รูป`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### 🤖 AI ตรวจรูปอัตโนมัติ\n\n| ตรวจรูปใหม่รอบนี้ | ตรวจแล้วทั้งหมด | ค้างตรวจ (ตรวจต่อรอบหน้า) | ติดธง (บันทึกไว้แจ้งช่าง) |\n|---|---|---|---|\n` +
        `| ${n} | ${last.stats.checked || 0} | ${more} | ${last.flags} |\n\n` +
        '```\n' + LINES.slice(-25).join('\n') + '\n```\n');
    }
  }
  await ctx.close();
  process.exit(0);
})().catch(e => { log('❌ หุ่นยนต์ตรวจรูปล้มเหลว:', e && e.stack || e); fail(e && e.message || e); });
