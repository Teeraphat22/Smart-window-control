# Smart Window Control System — คู่มือการรันแบบ Local (ภาษาไทย)

เอกสารนี้อธิบายการรันแอปแบบไม่ใช้ Docker (รันด้วย `node server.js`), การสร้างฐานข้อมูล PostgreSQL ผ่าน `psql` (SQL Shell), การเชื่อมต่อ Firebase Realtime Database เพื่อเก็บค่า `light`, `temperature`, `window` และวิธีสร้าง Firebase Admin SDK (Service Account) รวมถึงตัวอย่างการใช้งาน WebSocket

สรุปขั้นตอนหลัก
- ติดตั้ง dependencies (`npm install`)
- สร้าง PostgreSQL role & database แล้วรัน `init.sql`
- สร้าง Firebase Project + Realtime Database
- สร้างและดาวน์โหลด Service Account (Admin SDK) เก็บเป็น `serviceAccountKey.json`
- ตั้งค่า environment variables แล้วรัน `node server.js`

ข้อกำหนดเบื้องต้น
- Node.js 18+ ติดตั้งบนเครื่อง
- PostgreSQL (psql/SQL Shell) ติดตั้งบนเครื่องหรือเข้าถึงได้
- บัญชี Firebase (Google) เพื่อสร้าง Project และดาวน์โหลด Service Account

การติดตั้ง dependencies

```powershell
cd C:\Users\UsER\smart-window-server
npm install
```

สร้างฐานข้อมูล PostgreSQL (psql)

1) เปิด `psql` (SQL Shell) หรือ PowerShell แล้วเรียกใช้งาน `psql` ถ้าเป็น Windows และติดตั้ง PostgreSQL 18 คุณอาจรัน:

```powershell
# ตัวอย่างถ้าใช้ psql ที่ติดตั้งบน Windows
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres
```

2) (ถ้าต้องการ) สร้าง role และ database (ตัวอย่างตั้งรหัสผ่านเป็น `admin123`):

```sql
-- รันใน psql (login ด้วย postgres หรือ superuser)
CREATE ROLE admin WITH LOGIN PASSWORD 'admin123';
ALTER ROLE admin WITH SUPERUSER; -- (ตัวเลือก) ถ้าต้องการสิทธิ์มากขึ้น
CREATE DATABASE smart_window_db OWNER admin;
```

3) ใช้ `init.sql` เพื่อสร้างตาราง (ไฟล์ `init.sql` อยู่ในโฟลเดอร์โปรเจค):

```powershell
# ตัวอย่างเรียกใช้จาก PowerShell บน Windows
$env:PGPASSWORD='admin123'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -U admin -d smart_window_db -f init.sql
```

(ถ้า `psql` อยู่ใน PATH ให้ใช้ `psql -h localhost -U admin -d smart_window_db -f init.sql`)

ตรวจสอบตาราง `users`:

```sql
-- ใน psql
\c smart_window_db admin
SELECT count(*) FROM users;
```

การสร้าง Firebase Realtime Database

1) เข้าไปที่ https://console.firebase.google.com และสร้าง Project ใหม่ (หรือเลือก Project ที่มีอยู่)
2) ในเมนูด้านซ้าย เลือก "Realtime Database" → "Create database"
3) เลือกตำแหน่ง (location) และเริ่มในโหมด `locked` (แนะนำสำหรับ production) หรือ `test` ชั่วคราว
4) เมื่อสร้างแล้ว จะได้ URL ของ Realtime DB เช่น `https://<PROJECT_ID>.firebaseio.com` (หรือ `https://<PROJECT_ID>.<region>.firebasedatabase.app` ขึ้นกับ region)

โครงสร้างตัวอย่างใน Realtime DB (แนะนำ)

- `/sensors/{deviceId}/latest` — เก็บค่าปัจจุบัน { temperature, light, window, timestamp }
- `/sensors/{deviceId}/history` — เก็บรายการย้อนหลัง (push entries)

ตัวอย่างโครงสร้าง JSON:

```json
{
  "sensors": {
    "esp32-1": {
      "latest": {
        "temperature": 24.5,
        "light": 430,
        "window": "OPEN",
        "timestamp": 1670000000000
      },
      "history": {
        "-Nabc123": { "temperature": 24.5, "light": 430, "window": "OPEN", "timestamp": 1670000000000 }
      }
    }
  }
}
```

สร้าง Firebase Admin SDK (Service Account JSON)

1) ใน Firebase Console ไปที่ Project settings (ไอคอนฟันเฟือง) → เลือกแท็บ "Service accounts"
2) กดปุ่ม "Generate new private key" (หรือ "Generate private key")
3) ดาวน์โหลดไฟล์ JSON ที่ได้ แล้ววางไว้ในโฟลเดอร์โปรเจคของคุณ (เช่น `serviceAccountKey.json`) อย่า commit ไฟล์นี้ขึ้น repo
4) เซิร์ฟเวอร์ Node.js จะใช้ไฟล์นี้เพื่อ initial Firebase Admin SDK

ตัวอย่างการตั้งค่าใน `server.js` (ถ้าโค้ดยังไม่ได้ทำ):

```js
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // เช่น https://<PROJECT_ID>.firebaseio.com
});

const db = admin.database();
```

ถ้าคุณไม่ต้องการวางไฟล์ JSON ในโปรเจค ให้ตั้งตัวแปรสภาพแวดล้อม `GOOGLE_APPLICATION_CREDENTIALS` เป็นพาธของไฟล์ JSON แทน:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS='C:\path\to\serviceAccountKey.json'
```

การตั้งค่าตัวแปรแวดล้อมสำหรับรัน `server.js`

ตัวอย่าง (PowerShell):

```powershell
$env:DB_HOST='localhost'
$env:DB_PORT='PORTDB'
$env:DB_NAME='DB_NAME'
$env:DB_USER='admin'
$env:DB_PASSWORD='admin123'
$env:JWT_SECRET='replace_this_with_a_real_secret'
$env:FIREBASE_DB_URL='https://<PROJECT_ID>.firebaseio.com'
$env:GOOGLE_APPLICATION_CREDENTIALS='C:\Users\UsER\<NameProject>\serviceAccountKey.json'

# ติดตั้ง dependencies แล้วรันเซิร์ฟเวอร์
npm install
node server.js
```

หมายเหตุ: ถ้า `server.js` อ่านค่า `PORT` จาก env ให้ตั้ง `PORT` ให้ตรงกับค่าที่ต้องการ (default โปรเจคนี้มักใช้ 8081 หรือ 8080)

WebSocket — รูปแบบการสื่อสารและตัวอย่าง

เซิร์ฟเวอร์ของโปรเจครองรับการเชื่อมต่อแบบ WebSocket ระหว่าง ESP32 และ Browser (dashboard) โดยมี flow พื้นฐานดังนี้:

1. เมื่อต่อ WebSocket สำเร็จ ให้ client ส่งข้อความระบุ role เป็น `ROLE:ESP32` หรือ `ROLE:BROWSER` เพื่อให้เซิร์ฟเวอร์รู้ชนิดของ client
2. หากเป็น Browser ให้ส่ง `USER:<userId>` เพื่อเชื่อม session ของผู้ใช้กับการเชื่อมต่อ WebSocket
3. ESP32 ส่ง JSON payload ที่มี `temperature`, `light`, `window` (หรือชื่อฟิลด์ตามที่โปรเจคคาดหวัง)
4. Browser ส่งคำสั่งเป็นข้อความเช่น `OPEN`, `CLOSE`, `AUTO` → เซิร์ฟเวอร์จะส่งต่อไปยัง ESP32 ที่ถูกจับคู่

ตัวอย่าง WebSocket client (เบราว์เซอร์) สำหรับทดสอบ:

```html
<script>
const ws = new WebSocket('ws://localhost:8081');
ws.addEventListener('open', () => {
  console.log('WS open');
  ws.send('ROLE:BROWSER');
  // ถ้ารู้ user id
  ws.send('USER:1');
});

ws.addEventListener('message', (ev) => {
  console.log('WS message', ev.data);
});

// ส่งคำสั่งปิด/เปิด
function sendCommand(cmd) {
  ws.send(cmd); // e.g. 'OPEN' or 'CLOSE'
}
</script>
```

ตัวอย่าง JSON ที่ ESP32 ควรส่ง (ผ่าน WebSocket):

```json
{"temperature":24.5,"light":430,"window":"OPEN","timestamp":1670000000000}
```

การเก็บค่าที่ได้รับไปยัง Firebase Realtime DB (ตัวอย่างใน Node)

```js
// สมมติว่า `db` มาจาก admin.database();
function saveSensorReading(deviceId, payload) {
  const latestRef = db.ref(`sensors/${deviceId}/latest`);
  const historyRef = db.ref(`sensors/${deviceId}/history`).push();

  latestRef.set(payload);
  historyRef.set(payload);
}
```

ตัวอย่างเมื่อตรวจพบข้อความจาก ESP32 ใน `server.js`:

```js
// เมื่อได้รับ JSON จาก ws (ESP32)
const payload = JSON.parse(message);
saveSensorReading('esp32-1', payload);
```

ข้อควรระวัง
- อย่าเก็บ `serviceAccountKey.json` ในระบบควบคุมเวอร์ชัน (เช่น Git) — เพิ่มไฟล์นี้ใน `.gitignore`
- ตั้งค่ากฎ Realtime Database ให้ปลอดภัยก่อนเปิด production (อย่าใช้ `test` mode เป็นเวลานาน)
- เปลี่ยน `JWT_SECRET` เป็นค่าสุ่มและปลอดภัยก่อนใช้งานจริง

ทดสอบการเชื่อมต่อ (checklist)
- เปิด `psql` และยืนยันว่า `users` มีอยู่
- ตั้ง `FIREBASE_DB_URL` และดาวน์โหลด `serviceAccountKey.json`
- รัน `node server.js` และตรวจดู logs — ควรเห็นข้อความว่าเชื่อมต่อ DB และ Firebase สำเร็จ
- เปิดเบราว์เซอร์ที่ `http://localhost:8081` (หรือพอร์ตที่เซิร์ฟเวอร์ฟัง)
- ทดสอบ WebSocket ด้วยตัวอย่างสคริปต์ด้านบน

---

