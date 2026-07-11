# Plan B Installation App — คู่มือผู้ดูแลระบบ

ระบบจัดการงานติดตั้งสื่อโฆษณา: ช่างส่งรูปหน้างาน → แอดมินติดตามเรียลไทม์ → ลูกค้าดูสถานะผ่านลิงก์ → จอ War Room สำหรับทีม

## สถาปัตยกรรม (1 นาทีเข้าใจ)

```
GitHub Pages (หน้าเว็บทั้งหมด)          Google (หลังบ้านทั้งหมด)
├─ index.html    แอปช่างติดตั้ง   ──►  Apps Script Web App (Code.gs)
├─ admin.html    แอปแอดมิน        ──►    ├─ Google Drive = เก็บรูป + ชีทระบบ
├─ portal.html   ลิงก์ลูกค้า       ──►    ├─ _Jobs         งานทั้งหมด
├─ warroom.html  จอทีวีแผนก       ──►    ├─ _InstallLog   ประวัติติดตั้ง (+Photo Index)
└─ Code.gs       สำเนา backup           ├─ _UploadLog / _ProblemLog / _RepairLog
                                        └─ MailApp = อีเมลแจ้งเตือน
```

- **ไม่มีเซิร์ฟเวอร์ ไม่มีค่าใช้จ่าย** — GitHub Pages + Apps Script ฟรีทั้งคู่
- ตัวจริงของ Code.gs รันอยู่ใน Apps Script — ไฟล์ในนี้เป็นสำเนา backup

## การ Deploy

| แก้ไฟล์ | วิธี deploy |
|---|---|
| *.html | commit เข้า repo นี้ → GitHub Pages อัปเดตเองใน 1-2 นาที |
| Code.gs | วางทับใน Apps Script editor → 💾 → Deploy → Manage deployments → ✏️ → **New version** ← ห้ามลืมขั้นนี้ |

⚠️ ห้ามกด "New deployment" (URL จะเปลี่ยน หน้าเว็บทุกหน้าพังทันที) — ใช้ Edit + New version เท่านั้น

## ค่า CONFIG ใน Code.gs (บรรทัดบนสุด)

- `DRIVE_FOLDER_ID` — โฟลเดอร์ Drive หลักของแอป
- `ADMIN_EMAIL` — อีเมลรับแจ้งเตือนทุกอย่าง
- `INSTALLERS_SHEET_ID` — ชีทรายชื่อช่าง (คอลัมน์ A)
- `REPAIR_EMAIL` — อีเมลทีมซ่อม (ฟีเจอร์พักการใช้งาน ปุ่มถูกถอดจากหน้าช่าง)

## ฟังก์ชันดูแลระบบ (รันจาก Apps Script editor)

| ฟังก์ชัน | ใช้เมื่อ |
|---|---|
| `authorizeAll` | รันครั้งแรก / หลังเพิ่ม scope ใหม่ |
| `diagnoseArchive` | งานไม่ยอมจบ/จบผิด — บอกเหตุผลรายงาน |
| `backfillPhotoIndex` | รูปเก่าไม่โชว์ใน portal/warroom |
| `backupSystemSheets` | สำรองชีททันที (ปกติรันเองทุกวัน 03:00) |
| `setupDailyBackup` | ติดตั้งตัวจับเวลา backup ทุกวัน 03:00 (รันครั้งเดียว สำรองทันที 1 รอบ) |

## กู้คืนเมื่อเกิดเหตุ (Recovery Playbook)

1. **ลบรูป/โฟลเดอร์ผิด** → Drive > ถังขยะ กู้ได้ภายใน 30 วัน
2. **ชีทระบบพัง/หาย** → เปิด My Drive > `PlanB_App_Backup/<วันที่_เวลา>` copy ชีทกลับเข้าโฟลเดอร์แอป ตั้งชื่อเดิม (ขึ้นต้น _) แล้วรัน `authorizeAll`
3. **หน้าเว็บพัง หลัง commit** → GitHub > repo > History ของไฟล์ > เปิดเวอร์ชันก่อนหน้า > copy กลับ
4. **Apps Script พัง** → วาง Code.gs จาก repo นี้ (สำเนาล่าสุดเสมอ) + ใส่ค่า CONFIG + New version
5. **URL Apps Script เปลี่ยนโดยไม่ตั้งใจ** → แก้ค่า SCRIPT_URL ในไฟล์ html ทั้ง 4 ให้ตรง URL ใหม่

## การทดสอบ

โฟลเดอร์ `tests/` มีเทสอัตโนมัติ รันในเครื่อง: `cd tests && npm install && npm test`
ทุก commit จะรันเทสเองผ่าน GitHub Actions (ดูผลที่แท็บ Actions)
