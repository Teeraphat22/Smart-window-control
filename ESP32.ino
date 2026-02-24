#include <WiFi.h>
#include <WiFiManager.h>
#include <ArduinoWebsockets.h>
#include <DHT.h>
#include <ESP32Servo.h>

using namespace websockets;

#define DHTPIN 4
#define DHTTYPE DHT22
#define LDR_PIN 34
#define SERVO_PIN 18
#define BUZZER 19
#define LED_WIFI 2
#define LED_STATUS 23
#define RESET_BUTTON 0  // ปุ่ม BOOT ของ ESP32 (GPIO0)

WiFiManager wm;             // 🔥 ต้องเป็น global
bool apModeActive = false;  // 🔥 ต้องประกาศตรงนี้
unsigned long buttonPressStart = 0;
bool buttonHolding = false;

// ===== WebSocket Server =====
const char* ws_host = "172.24.184.185";  // 🔥 เปลี่ยนเป็น IP ของคอมพิวเตอร์ที่รันเซิร์ฟเวอร์
const int ws_port = 8080;// 🔥 เปลี่ยนเป็นพอร์ตที่เซิร์ฟเวอร์ใช้

WebsocketsClient wsClient;

DHT dht(DHTPIN, DHTTYPE);
Servo myServo;

// ===== System State =====
enum Mode { AUTO,
            MANUAL };
Mode controlMode = AUTO;

float temperature;
int lightValue;
bool windowOpen = false;
int servoStop = 90;

/* ================= Servo ================= */

void beep() {
  tone(BUZZER, 1000);
  delay(200);
  noTone(BUZZER);
}

void openWindow() {
  myServo.write(110);
  delay(250);
  myServo.write(servoStop);
  beep();
  digitalWrite(LED_STATUS, HIGH);
  windowOpen = true;
}

void closeWindow() {
  myServo.write(70);
  delay(250);
  myServo.write(servoStop);
  beep();
  digitalWrite(LED_STATUS, LOW);
  windowOpen = false;
}

void onMessageCallback(WebsocketsMessage message) {

  String cmd = message.data();
  cmd.trim();  // 🔥 กัน \r \n space

  Serial.println("CMD: [" + cmd + "]");

  // 🔒 รับเฉพาะคำสั่งจริงเท่านั้น
  if (cmd == "AUTO" || cmd == "OPEN" || cmd == "CLOSE") {

    if (cmd == "AUTO") {
      controlMode = AUTO;
      Serial.println("Mode -> AUTO");
    }

    else if (cmd == "OPEN") {
      controlMode = MANUAL;
      Serial.println("Mode -> MANUAL (OPEN)");

      if (!windowOpen) {
        openWindow();
      }
    }

    else if (cmd == "CLOSE") {
      controlMode = MANUAL;
      Serial.println("Mode -> MANUAL (CLOSE)");

      if (windowOpen) {
        closeWindow();
      }
    }
  }

  else {
    // 🚫 ถ้าไม่ใช่คำสั่ง คำอื่น ignore
    Serial.println("Ignored message");
  }
}

/* ================= Connect WS ================= */

void connectWebSocket() {

  if (WiFi.status() != WL_CONNECTED) return;

  if (wsClient.available()) return;

  String url = "ws://" + String(ws_host) + ":" + String(ws_port);

  Serial.println("Connecting to WebSocket...");

  if (wsClient.connect(url)) {
    Serial.println("WebSocket Connected");
    wsClient.send("ROLE:ESP32");
  } else {
    Serial.println("WebSocket Failed");
  }
}

/* ================= Setup ================= */

void setup() {

  Serial.begin(115200);
  pinMode(RESET_BUTTON, INPUT_PULLUP);
  pinMode(LED_WIFI, OUTPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(LED_STATUS, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  myServo.setPeriodHertz(50);
  myServo.attach(SERVO_PIN, 500, 2400);
  myServo.write(servoStop);

  dht.begin();

  // ไม่ใช้ autoConnect แล้ว
  WiFi.mode(WIFI_STA);
  WiFi.begin();

  unsigned long startAttemptTime = millis();

  // รอเชื่อม WiFi สูงสุด 10 วิ
  while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 10000) {
    delay(100);
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Starting Config Portal (non-blocking)");
    wm.setConfigPortalBlocking(false);
    wm.startConfigPortal("SmartWindow-Setup");
    apModeActive = true;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi Connected");
  } else {
    Serial.println("No WiFi. Running in OFFLINE mode.");
  }

  wsClient.onMessage(onMessageCallback);

  if (WiFi.status() == WL_CONNECTED) {
    connectWebSocket();
  }
}
void checkWiFiReset() {

  if (digitalRead(RESET_BUTTON) == LOW) {  // กดปุ่ม (BOOT จะเป็น LOW เมื่อกด)

    if (!buttonHolding) {
      buttonHolding = true;
      buttonPressStart = millis();
    }

    if (millis() - buttonPressStart > 3000 && !apModeActive) {

      Serial.println("Resetting WiFi settings...");

      wm.resetSettings();
      wm.setConfigPortalBlocking(false);
      wm.startConfigPortal("SmartWindow-Setup");
      apModeActive = true;

      buttonHolding = false;
    }
  }
}

void checkWiFiConnection() {

  if (WiFi.status() != WL_CONNECTED) {

    digitalWrite(LED_WIFI, LOW);

    static unsigned long lastReconnect = 0;

    if (millis() - lastReconnect > 5000) {  // ลอง reconnect ทุก 5 วิ
      Serial.println("WiFi reconnecting...");
      WiFi.reconnect();
      lastReconnect = millis();
    }

  } else {
    digitalWrite(LED_WIFI, HIGH);
  }
}

/* ================= Loop ================= */

void loop() {
  if (apModeActive && WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi configured. Closing AP.");
    wm.stopConfigPortal();
    apModeActive = false;
  }

  if (apModeActive) {
    wm.process();
  }

  checkWiFiReset();
  checkWiFiConnection();

  // ===== NETWORK =====
  if (WiFi.status() == WL_CONNECTED) {

    wsClient.poll();

    if (!wsClient.available()) {
      connectWebSocket();
    }
  }

  // ===== SENSOR READ =====
  temperature = dht.readTemperature();
  lightValue = analogRead(LDR_PIN);

  if (isnan(temperature)) return;

  // ===== AUTO MODE (ต้องทำงานแม้ไม่มี WiFi) =====
  if (controlMode == AUTO) {

    if (lightValue > 1000) {

      if (windowOpen) closeWindow();

    } else {

      if (temperature >= 25 && !windowOpen)
        openWindow();

      if (temperature < 25 && windowOpen)
        closeWindow();
    }
  }

  // ===== Buzzer =====
  if (temperature >= 35) {
    digitalWrite(BUZZER, HIGH);
  } else {
    digitalWrite(BUZZER, LOW);
  }

  static unsigned long lastSend = 0;

  if (millis() - lastSend > 2000) {

    lastSend = millis();

    // ===== SEND DATA (เฉพาะตอน WS ต่ออยู่) =====
    if (wsClient.available()) {

      String payload = "{";
      payload += "\"temperature\":" + String(temperature) + ",";
      payload += "\"light\":" + String(lightValue) + ",";
      payload += "\"window\":\"" + String(windowOpen ? "OPEN" : "CLOSE") + "\",";
      payload += "\"mode\":\"" + String(controlMode == AUTO ? "AUTO" : "MANUAL") + "\"";
      payload += "}";

      wsClient.send(payload);
      Serial.println(payload);
    }
  }
}