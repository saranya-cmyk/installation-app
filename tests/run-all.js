// รันเทสทั้งหมด: syntax ทุกไฟล์ + unit test backend + smoke test ทุกหน้า
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failed = 0;
function step(name, fn) {
  try { fn(); console.log('✅ ' + name); }
  catch(e) { failed++; console.log('❌ ' + name + ' — ' + (e.message||e).toString().split('\n')[0]); }
}

// 1) syntax JS ในทุกไฟล์ html + Code.gs
['index.html','admin.html','portal.html','warroom.html'].forEach(f => {
  step('syntax ' + f, () => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.length > 50);
    const tmp = path.join(__dirname, '.tmp-' + f + '.js');
    fs.writeFileSync(tmp, scripts.join('\n;\n'));
    execSync('node --check ' + JSON.stringify(tmp));
    fs.unlinkSync(tmp);
  });
});
step('syntax Code.gs', () => {
  const tmp = path.join(__dirname, '.tmp-code.js');
  fs.copyFileSync(path.join(ROOT, 'Code.gs'), tmp);
  execSync('node --check ' + JSON.stringify(tmp));
  fs.unlinkSync(tmp);
});

// 2) ฟังก์ชันประกาศซ้ำ
step('ไม่มีฟังก์ชันซ้ำ', () => {
  for (const f of ['index.html','admin.html','portal.html','warroom.html','Code.gs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const names = [...src.matchAll(/(?:^|\n)(?:async )?function ([a-zA-Z0-9_]+)\s*\(/g)].map(m => m[1]);
    const dup = names.filter((n,i) => names.indexOf(n) !== i);
    if (dup.length) throw new Error(f + ': ' + [...new Set(dup)].join(','));
  }
});

// 3) ทุก action ฝั่งหน้าเว็บมี route ฝั่ง backend
step('route ครบทุก action', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf-8');
  const routes = new Set([...backend.matchAll(/action === '([a-zA-Z]+)'/g)].map(m => m[1]));
  const used = new Set();
  for (const f of ['index.html','admin.html','portal.html','warroom.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    [...src.matchAll(/action[=:]\s*'([a-zA-Z]+)'/g), ...src.matchAll(/\?action=([a-zA-Z]+)/g)].forEach(m => used.add(m[1]));
  }
  const missing = [...used].filter(a => !routes.has(a));
  if (missing.length) throw new Error('ขาด route: ' + missing.join(','));
});

// 4) unit test backend (archive logic + cache)
step('backend unit tests', () => { execSync('node ' + JSON.stringify(path.join(__dirname, 'backend.test.js')), { stdio: 'pipe' }); });

// 5) smoke ทุกหน้า (jsdom)
step('smoke ทุกหน้า', () => { execSync('node ' + JSON.stringify(path.join(__dirname, 'smoke.test.js')), { stdio: 'pipe' }); });

console.log(failed ? `\n❌ พัง ${failed} รายการ` : '\n🎉 ผ่านทั้งหมด');
process.exit(failed ? 1 : 0);
