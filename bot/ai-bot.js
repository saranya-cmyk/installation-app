// ═══ หุ่นยนต์ตรวจรูป AI — ทำให้ AI ตรวจรูปครบ 100% โดยไม่ต้องมีใครเปิด Snaphub ค้างไว้ ═══
// วิธีทำงาน: เปิด Snaphub (admin.html) ในเบราว์เซอร์แบบไม่มีหน้าจอ → ใช้โค้ด AI ชุดเดียวกับที่แอดมินใช้ (CLIP + Tesseract OCR)
// ตรวจรูปที่ยังไม่เคยตรวจจนหมด แล้วบันทึกผลลงชีท _AICheckLog — AI แค่ติดธงเตือน คนยังเป็นผู้ตัดสินใน Snaphub เหมือนเดิม
// รันบน GitHub Actions ทุก 30 นาที (.github/workflows/ai-check.yml) · ไม่ใช้บริการ AI ภายนอก · 0 บาท
const { chromium } = require('playwright');

const ADMIN_URL = process.env.ADMIN_URL || 'https://saranya-cmyk.github.io/installation-app/admin.html';
const CACHE_DIR = process.env.CACHE_DIR || '.ai-cache';          // เก็บโมเดล AI ไว้ใช้รอบถัดไป ไม่ต้องโหลดใหม่
const BUDGET_MIN = Number(process.env.BUDGET_MIN || 45);         // รอบนี้ทำงานได้นานสุดกี่นาที (ที่เหลือรอบหน้าตรวจต่อ)
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 50);         // aiRun 1 รอบ = รูปค้างตรวจสูงสุด 200 รูป

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

  let before = null, last = null;
  for (let round = 1; round <= MAX_ROUNDS && left() > 60000; round++) {
    const r = await Promise.race([
      page.evaluate(async () => {
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        while (_aiqBusy) await sleep(1000);            // Snaphub อาจเริ่มตรวจเองไปแล้ว รอให้จบก่อน
        const start = JSON.parse(JSON.stringify(_aiqState.stats || {}));
        await aiRun();
        while (_aiqBusy) await sleep(1000);
        const chip = document.getElementById('aiqChip');
        return {
          start, stats: _aiqState.stats || {}, pending: (_aiqState.pending || []).length,
          flags: (_aiqState.flags || []).length, chip: chip ? chip.textContent : '',
        };
      }),
      new Promise(res => setTimeout(() => res({ timeout: true }), Math.max(left(), 1000))),
    ]);
    if (r.timeout) { log('⏱ หมดเวลารอบนี้ — รูปที่เหลือจะตรวจต่อรอบหน้า'); break; }
    if (!before) before = r.start;
    last = r;
    log(`รอบ ${round}: ตรวจแล้วรวม ${r.stats.checked || 0} รูป · รอตรวจ ${r.pending} รูป · ติดธงรอคนตัดสิน ${r.flags} รูป`);
    if (/ใช้งาน AI ไม่ได้/.test(r.chip)) { log('❌', r.chip); await ctx.close().catch(() => {}); fail(r.chip); }
    if (!r.pending) break;
  }

  if (last) {
    const n = (last.stats.checked || 0) - ((before && before.checked) || 0);
    log(`✅ เสร็จ: รอบนี้ AI ตรวจรูปใหม่ ${n} รูป · ค้างตรวจ ${last.pending} รูป · รอแอดมินตัดสิน ${last.flags} รูป`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### 🤖 AI ตรวจรูปอัตโนมัติ\n\n| ตรวจรูปใหม่รอบนี้ | ตรวจแล้วทั้งหมด | ค้างตรวจ | รอแอดมินตัดสิน |\n|---|---|---|---|\n` +
        `| ${n} | ${last.stats.checked || 0} | ${last.pending} | ${last.flags} |\n`);
    }
  }
  await ctx.close();
})().catch(e => { log('❌ หุ่นยนต์ตรวจรูปล้มเหลว:', e && e.stack || e); fail(e && e.message || e); });
