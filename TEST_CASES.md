# Oxide Monitor - End-to-End Test Cases

เอกสารนี้ใช้ตรวจระบบตั้งแต่เริ่มเปิด service จนจบวงจร Order รวมทั้งกรณีผิดพลาดหลัก

## ผลการรันทดสอบล่าสุด

วันที่ 27 ตุลาคม 2026:

- Unit tests: 5/5 ผ่าน
- Automated E2E TC01-TC12: 13 assertions ผ่าน, fail 0
- TC13 Heartbeat timeout: ผ่าน - Order เปลี่ยน `in_progress → delayed`, Bot เปลี่ยนเป็น `offline` และพบ `heartbeat_timeout` event
- TC14 UI stability: ผ่าน - dropdown คง focus ข้าม heartbeat และไม่ถูก redraw
- หลังทดสอบเปิด Simulator กลับและคืน Order ทดสอบเป็น `completed` แล้ว

## เตรียมระบบ

```bash
docker compose up -d --build
docker compose ps
npm install
npm run test:e2e
```

ผลลัพธ์ที่ต้องได้จาก `docker compose ps` คือ `app`, `simulator` และ `postgres` เป็น `healthy`

## Automated test cases

| ID | กรณีทดสอบ | ขั้นตอนหลัก | ผลลัพธ์ที่คาดหวัง |
|---|---|---|---|
| TC01 | Service และ Dashboard | เรียก `/api/health` และ `/` | HTTP 200, `ok=true`, พบหน้า Oxide Bot Monitor |
| TC02 | Dashboard real-time | เชื่อม `/ws` แล้ว toggle system | ได้ event `system.changed` |
| TC03 | Bot heartbeat | เรียก `/api/bots?sync=true` | พบ Bot อย่างน้อย 3 เครื่องและมี heartbeat |
| TC04 | WebSocket command | ส่ง `status` ไป Bot online | Command success และ `transport=websocket` |
| TC05 | Idempotency | สร้าง Order ซ้ำด้วย Idempotency-Key เดิม | ได้ Order ID เดิมและไม่สร้างข้อมูลซ้ำ |
| TC06 | State + Dispatch | `pending_payment → queued → dispatch` | เป็น `in_progress` และมี `assigned_bot_id` |
| TC07 | Complete + Timeline | เปลี่ยนเป็น `completed` แล้วอ่าน Orders | พบ created, dispatched และ transitioned events |
| TC08 | Invalid transition | สั่ง `completed → in_progress` | HTTP 409 `invalid_state_transition` |
| TC09 | Selected deployment | อัปโหลด `.zip` ให้ Bot ที่เลือก | Deployment success และ target ถูกต้อง |
| TC10 | Audit log | อ่าน `/api/audit-logs` | พบ command, dispatch, transition, deployment |
| TC11 | Kill-switch | ปิดระบบแล้วสร้าง Order/เปิด Bot | ทั้งสองคำสั่งถูกปฏิเสธด้วย HTTP 409 |
| TC12 | Restore system | เปิดระบบและ start Bot เดิม | Bot กลับมาทำงานและ command success |

ไฟล์อัตโนมัติ: `e2e/full-flow.test.js`

## TC13 - Heartbeat timeout / Bot crash

กรณีนี้แยกเป็น manual destructive test เพราะต้องหยุด Simulator จริง

1. สร้าง Order และเปลี่ยนเป็น `queued`
2. กด Dispatch ให้ Order เป็น `in_progress`
3. หยุด Simulator:

   ```bash
   docker compose stop simulator
   ```

4. รอมากกว่า `HEARTBEAT_TIMEOUT_SECONDS` ซึ่งค่าเริ่มต้นคือ 20 วินาที
5. เรียก `GET /api/bots` และ `GET /api/orders`

ผลลัพธ์ที่คาดหวัง:

- Bot ที่ขาด heartbeat เปลี่ยนเป็น `offline`
- Order `in_progress` ของ Bot นั้นเปลี่ยนเป็น `delayed`
- Timeline มี event `heartbeat_timeout`

เปิด Simulator กลับ:

```bash
docker compose start simulator
```

## TC14 - UI stability during heartbeat

1. เปิด `http://localhost:3000`
2. เปิด dropdown สถานะ Order ค้างไว้อย่างน้อย 5 วินาที
3. เลือก Bot สำหรับ deployment ด้วย checkbox

ผลลัพธ์ที่คาดหวัง:

- Dropdown ไม่ปิดเองขณะ heartbeat เข้ามา
- Checkbox ที่เลือกไว้ไม่ถูกล้างจาก real-time refresh

## Acceptance criteria

- Automated TC01-TC12 ผ่านทั้งหมด
- TC13 เปลี่ยน Bot เป็น offline และ Order เป็น delayed ได้
- TC14 ไม่มี dropdown หรือ checkbox ถูก reset เอง
- หลังจบ test ระบบถูกเปิดกลับและ Bot เดิมที่ online กลับมาทำงาน
