// ทดสอบกฎเทียบ Code ของ AI (ดึงฟังก์ชันจริงจาก admin.html)
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const grab = n => { const i = src.indexOf('function ' + n + '('); let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] == '{') d++; else if (src[k] == '}') { d--; if (!d) return src.slice(i, k + 1); } } };
eval(['aiqCanon', 'aiqLev', 'aiqNear', 'aiqJudge'].map(grab).join('\n'));
const known = ['BKK-1001', 'BKK-1002', 'BKK-1017', 'CNX-0503', 'DP70', 'DP703', '12'];
const cases = [
  ['ตรงเป๊ะ', ['PLAN B  BKK-1001'], 'BKK-1001', 'match'],
  ['O↔0, I↔1', ['BKK-IOO1'], 'BKK-1001', 'match'],
  ['พลาด 1 ตัว', ['BKK-1C01'], 'BKK-1001', 'match'],
  ['Code จุดอื่น', ['BKK-1017'], 'BKK-1001', 'other'],
  ['Code จุดอื่น + พลาด 1 ตัว', ['CNX-O5O3'], 'BKK-1001', 'other'],
  ['อ่านไม่ออก', ['~~ ## ..'], 'BKK-1001', 'none'],
  ['ไม่มี Code', ['SALE 50%'], 'BKK-1001', 'none'],
  ['จุด DP70 แต่ป้ายเขียน DP703 = ติดผิดป้าย', ['DP703'], 'DP70', 'other'],
  ['จุด DP703 ป้าย DP703 = ตรง', ['DP-703'], 'DP703', 'match'],
  ['Code สั้น "12" ไม่นับเลขในข้อความอื่น', ['CALL 0812345'], '12', 'none'],
  ['Code สั้น "12" ตรงทั้งบรรทัด', ['12'], '12', 'match'],
];
let pass = 0;
for (const [name, texts, exp, want] of cases) { const r = aiqJudge(texts, exp, known); const ok = r.ocr === want; if (ok) pass++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' → ' + r.ocr + (r.found ? ' (' + r.found + ')' : '')); }
console.log(`\nผล: ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
