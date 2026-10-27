# Oxide Monitor

โปรเจกต์ขนาดเล็กสำหรับ Centralized Bot Monitoring, Bot Control และ Order Tracking ตามโจทย์ Back End Developer โดยทำงานบน local เท่านั้นและเชื่อมกับ Bot Simulator ใน candidate pack นี้

## สิ่งที่ทำแล้ว

- Dashboard แบบ responsive พร้อมข้อมูล real-time ผ่าน WebSocket
- สรุป Online, Active (เปิดรับงาน), Standby (online แต่พักรับงาน) และ In Progress แยกกัน
- แสดงสถานะ, heartbeat, CPU, memory, Bot state และประวัติคำสั่ง Done/Failed ของ Bot อย่างน้อย 3 เครื่อง
- คำสั่งรายเครื่อง `start`, `stop`, `restart`, `status` พร้อมบันทึกผลและ audit log
- Global kill-switch: ปิดระบบแล้วหยุด Bot ที่ online และปฏิเสธการเริ่มงานใหม่
- รับไฟล์ update `.zip` ขนาดไม่เกิน 25 MB สำหรับทุกเครื่องหรือเครื่องที่เลือก พร้อม deployment record
- Order state machine: `pending_payment -> queued -> in_progress -> completed`
- Dispatch endpoint เลือก Bot ที่ online, เปิดรับงาน และมีงาน `in_progress` น้อยที่สุดโดยอัตโนมัติ
- เมื่อเลือกสถานะ `in_progress` จาก Dashboard ระบบจะเรียก Auto Dispatch โดยไม่ต้องกรอก Bot ID เอง
- Recovery state: `delayed`, `failed`, `cancelled`
- ตรวจ heartbeat timeout และเปลี่ยน order ที่ทำงานบน Bot ที่หลุดเป็น `delayed`
- Timeline ของ Order และ Audit log
- Idempotency, transaction/row lock, retry แบบ exponential backoff
- ไฟล์ `api.http` และ unit tests

> การ deploy package ในโปรเจกต์ทดสอบนี้จำลองขั้นตอนรับและกระจายไฟล์เท่านั้น เพราะ simulator ไม่มี update endpoint และโจทย์ห้ามใช้ source code ของ Bot จริง

## Architecture

```text
Browser Dashboard
  | REST + WebSocket
  v
Express API ---- PostgreSQL
  ^
  | WebSocket heartbeat + command
  | REST fallback + retry
Bot Simulator (local only)
```

Bot Simulator ส่ง heartbeat และรับคำสั่งควบคุมผ่าน WebSocket `/agent-ws` ส่วน Backend ใช้ REST polling ทุก 5 วินาทีเป็น fallback/reconciliation จากนั้น broadcast event ผ่าน WebSocket `/ws` ให้ Dashboard โหลดข้อมูลล่าสุด การแก้ข้อมูลสำคัญใช้ PostgreSQL transaction เป็นขอบเขตความถูกต้อง

## ติดตั้งและรัน

วิธีที่ง่ายที่สุดต้องมีเพียง Docker Desktop จากนั้นรัน:

```bash
docker compose up --build
```

Docker จะเปิด PostgreSQL, Bot Simulator และ Dashboard/API ให้ครบ พร้อมสร้าง schema และ seed ให้อัตโนมัติสำหรับ database volume ใหม่ จากนั้นเปิด `http://localhost:3000`

ตรวจว่าขึ้นครบ 3 services และเป็น `healthy`:

```bash
docker compose ps
```

หากตัวใดไม่ขึ้น ให้ดูสาเหตุด้วย:

```bash
docker compose logs --tail=100 app simulator postgres
```

หยุดระบบด้วย:

```bash
docker compose down
```

### รันแบบแยก service สำหรับพัฒนา

ต้องมี Node.js 20+ และ Docker Desktop

```bash
cp .env.example .env
npm install
docker compose up -d postgres
docker compose exec -T postgres psql -U oxide -d oxide_monitor < db/schema.sql
docker compose exec -T postgres psql -U oxide -d oxide_monitor < db/seed.sql
```

เปิด terminal 2 หน้าต่าง:

```bash
npm run simulator
```

```bash
npm run dev
```

เปิด `http://localhost:3000` สำหรับ Dashboard

บน PowerShell ซึ่งไม่รองรับ `<` แบบ shell สามารถใช้คำสั่งนี้แทน:

```powershell
Get-Content -Raw db/schema.sql | docker compose exec -T postgres psql -U oxide -d oxide_monitor
Get-Content -Raw db/seed.sql | docker compose exec -T postgres psql -U oxide -d oxide_monitor
```

หากเคยสร้าง database จาก schema รุ่นเดิม ให้ลบ volume สำหรับข้อมูลทดสอบแล้วสร้างใหม่:

```bash
docker compose down -v
docker compose up --build
```

## ทดสอบ

```bash
npm test
npm run test:e2e
```

- `npm test` ทดสอบ unit test โดยไม่ต้องเปิด service
- `npm run test:e2e` ทดสอบ flow จริง TC01-TC12 โดยต้องเปิด Docker ก่อน
- รายละเอียดทุกกรณีและ Heartbeat Timeout อยู่ใน `TEST_CASES.md`

ทดสอบ API เพิ่มเติมด้วย `api.http` ใน VS Code REST Client/JetBrains หรือใช้ curl ตัวอย่าง:

```bash
curl http://localhost:3000/api/bots?sync=true
curl -X POST http://localhost:3000/api/orders \
  -H "content-type: application/json" \
  -H "Idempotency-Key: order-1001" \
  -d '{"externalOrderId":"ORDER-1001","amount":499,"currency":"THB"}'
```

## API หลัก

| Method | Path | ใช้งาน |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/summary` | ตัวเลขภาพรวมและสถานะ kill-switch |
| GET | `/api/bots?sync=true` | Sync และอ่านสถานะ Bot |
| POST | `/api/bots/:id/commands` | ส่งคำสั่งให้ Bot |
| POST | `/api/system/enabled` | เปิด/ปิดระบบ |
| GET / POST | `/api/orders` | อ่าน/สร้าง Order |
| POST | `/api/orders/:id/transition` | เปลี่ยน state ของ Order |
| POST | `/api/orders/:id/dispatch` | กระจาย queued Order ไปยัง active Bot อัตโนมัติ |
| POST | `/api/deployments` | อัปโหลด package แบบ multipart |
| GET | `/api/audit-logs` | อ่าน audit log |
| WS | `/ws` | Event แจ้งข้อมูลเปลี่ยน |

## การแก้เคสปัญหา 5 ข้อ

1. **Concurrent state transition** - ล็อก Order ด้วย `SELECT ... FOR UPDATE` ภายใน transaction ทำให้สอง request เปลี่ยน state เดียวกันพร้อมกันไม่ได้
2. **Duplicate request / idempotency** - `POST /api/orders` บังคับ `Idempotency-Key`, มี unique constraint และ advisory transaction lock; ส่ง key เดิมจะได้ Order เดิมโดยไม่สร้างซ้ำ
3. **Transient simulator failure** - คำสั่ง Bot retry สูงสุด 3 ครั้งด้วย exponential backoff และบันทึก command เป็น `failed` เมื่อยังไม่สำเร็จ
4. **Bot crash / heartbeat timeout** - งาน background ตรวจ heartbeat; Bot ที่ stale ถูก mark offline และ Order `in_progress` ของ Bot นั้นเปลี่ยนเป็น `delayed` พร้อม timeline event
5. **Partial fleet update / traceability** - แยก `deployments` และ `deployment_targets` เพื่อเก็บผลรายเครื่อง พร้อม audit log ทำให้ระบุและ retry เฉพาะเครื่องที่ล้มเหลวได้เมื่อเชื่อมกับ Agent จริง

## เหตุผลในการออกแบบ

- ใช้ REST สำหรับ query/command ที่ต้องการผลลัพธ์ชัดเจน และ WebSocket สำหรับแจ้ง UI ว่าข้อมูลเปลี่ยน
- ใช้ PostgreSQL เป็น source of truth สำหรับ Order, command, deployment และ audit
- State machine อยู่ใน code และ database มี CHECK constraint เป็นด่านป้องกันอีกชั้น
- Simulator เป็นเพียง adapter ภายนอก จึงเปลี่ยนเป็น gRPC/MQTT Agent จริงภายหลังได้โดยไม่เปลี่ยน API ฝั่ง Dashboard
- ไม่มี password/token จริงใน source; ทุกค่าที่เปลี่ยนตาม environment อยู่ใน `.env`

## ข้อจำกัดของ demo

- ยังไม่มี authentication/authorization; production ควรใช้ SSO/JWT และ RBAC สำหรับ kill-switch/deployment
- ไฟล์ package ถูกเก็บใน `uploads/` บนเครื่อง local; production ควรใช้ object storage, checksum และ signature verification
- simulator ไม่มี API สำหรับ deploy code จึงจำลองเฉพาะ deployment; heartbeat และคำสั่งควบคุมใช้ WebSocket จริง โดยมี REST polling เป็น fallback
