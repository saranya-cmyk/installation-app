# 📘 Runbook — Plan B Installation System

> คู่มือปฏิบัติการสำหรับทีมผู้ดูแลระบบ · เวอร์ชัน 1.0 (ก.ค. 2569)
> **⚠️ มีข้อมูลการเข้าถึงระบบ — จำกัดเฉพาะทีมผู้ดูแล ไม่เผยแพร่สาธารณะ**

---

## 1. ระบบนี้คืออะไร
ระบบจัดการงานติดตั้งป้าย OOH ครบวงจร ต้นทุนโครงสร้าง **0 บาท**

| แอป | ผู้ใช้ | ไฟล์ | หน้าที่ |
|---|---|---|---|
| **Snapsite** | ช่างหน้างาน | `index.html` | ถ่ายรูป · เลือกจุด · ส่ง · แจ้งปัญหา |
| **Snaphub** | แอดมิน | `admin.html` | สร้างงาน · ติดตาม · ส่งมอบลูกค้า |
| **Portal** | ลูกค้า | `portal.html` | ดูสถานะเรียลไทม์ |
| **War Room** | จอสำนักงาน | `warroom.html` | ภาพรวม + แผนที่ |

## 2. สถาปัตยกรรม
```
GitHub Pages (4 แอป) ⇄ Google Apps Script (Code.gs = สมอง) ⇄ Google Drive (รูป)
                                     �︎
                            Google Sheets (6 ชีท)
```
- **หน้าเว็บ:** GitHub Pages, repo `saranya-cmyk/installation-app`
- **Backend:** Apps Script `Code.gs` (GitHub เก็บสำเนา / ตัวจริงรันใน Apps Script)
- **เก็บรูป:** Drive folder `1_RNwEhs93SO-7XfxBCCOIjROCcaQDZ7r`

## 3. ฐานข้อมูล (6 ชีท)
`_Jobs` · `_InstallLog` · `_UploadLog` · `_ProblemLog` · `_RepairLog` · `_Installers`

## 4. 🔑 กฎทอง (อ่านก่อนแตะระบบ)

**กฎ 1 — มี Apps Script 2 โปรเจกต์ อย่าสับสน**
ตัวจริงคือ **"Installation Photos"** (ผูกกับชีท) · "Production Hub" = ห้ามใช้
เปิดตัวจริงเสมอ: **Sheet ระบบ → Extensions → Apps Script**

**กฎ 2 — Deploy = New version เท่านั้น**
`Deploy → Manage deployments → ✏️ → New version → Deploy`
❌ ห้าม "New deployment" (URL เปลี่ยน = ต้องแก้ทุกแอป)

**กฎ 3 — ข้อมูลปัจจุบัน**
- URL: `AKfycbwgA7ohAgzVS4C37dUQh0M3utU5l7Wb17GjURcSCkPXkAW-7XIyhgLbRq_iXl9mVtt0Sg`
- Deployment: Execute as **Me** · Access **Anyone**
- GitHub PAT: หมดอายุ **~9 ส.ค. 2569**

## 5. วิธี Deploy
**หน้าเว็บ:** แก้ไฟล์ใน repo → commit → Pages อัปเดต 1-2 นาที → ผู้ใช้ Ctrl+Shift+R
**Backend:**
1. Sheet → Extensions → Apps Script (กฎ 1)
2. วางโค้ดใหม่ → 💾
3. Deploy → Manage deployments → ✏️ → New version → Deploy (กฎ 2)
4. เด้งขอสิทธิ์ → Allow
5. ทดสอบด้วย health.html

> ⚙️ ถ้าเพิ่ม scope ใหม่: รันฟังก์ชันที่ใช้ API นั้นใน editor ก่อน (อนุมัติสิทธิ์) แล้วค่อย New version

## 6. Health Check
เปิด `health.html` → กดปุ่มเดียว ทดสอบอ่าน+เขียน โชว์ผลดิบ
ใช้: หลัง deploy ทุกครั้ง · เมื่อช่างรายงานส่งไม่ขึ้น

## 7. Backup
- **อัตโนมัติทุกวัน 03:00** (time-trigger) เก็บ 6 ชีท
- ที่เก็บ: `PlanB_App_Backup` ใน My Drive (นอกโฟลเดอร์แอป)
- เก็บ 14 ชุดล่าสุด · ตั้งครั้งแรกด้วย `setupDailyBackup`

## 8. บัญชีและการเข้าถึง
| รายการ | ค่า |
|---|---|
| เจ้าของ | saranya@planbmedia.co.th |
| repo | `github.com/saranya-cmyk/installation-app` (public — ห้าม private) |
| PAT | Contents R/W · หมด ~9 ส.ค. 2569 |
| โฟลเดอร์รูป | `1_RNwEhs93SO-7XfxBCCOIjROCcaQDZ7r` |

## 9. กู้ภัยพิบัติ

**รูปหาย** → Drive → ถังขยะ (กู้ได้ 30 วัน) → Restore

**งานหาย/ลิสต์ว่าง** → เช็ค `_Jobs` (ข้อมูลมักอยู่ครบ ปัญหาคือแอปชี้ URL ผิด) → ตรวจ URL ทุกแอป → ถ้าหายจริงกู้จาก backup

**ส่ง 0 จุด** → health.html เช็คเขียน → ถ้า error สิทธิ์: authTest ใน editor → New version → ถ้า health ผ่านแต่ช่างยังไม่ได้: ล้าง cache เครื่องช่าง + เช็คป้ายเวอร์ชัน

**deployment พัง** → อย่าย้าย URL ก่อนพิสูจน์ (`?action=getJobs` ใน Incognito ต้องเห็นงาน) → สร้างใหม่จากตัวจริง (Me + Anyone) → ทดสอบ health.html ก่อนย้ายแอป

## 10. เช็กก่อนใช้งานใหญ่
- [ ] health.html ผ่านอ่าน+เขียน
- [ ] แอปทุกตัวชี้ URL เดียวกัน
- [ ] backup ล่าสุด < 24 ชม.
- [ ] PAT ยังไม่หมดอายุ
- [ ] ทดสอบส่งรูป + รูปเก่าไม่หาย
- [ ] ลิงก์ลูกค้าเปิดได้ + อัปเดตเอง
