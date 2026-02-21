// ===============================
// Smart Window Control System
// WebSocket + PostgreSQL + Firebase + Auth
// ===============================

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const { Pool } = require("pg");
const admin = require("firebase-admin");
const fs = require("fs");

// ===============================
// Environment Validation
// ===============================

const {
  PORT = 8080,
  DB_HOST = "localhost",
  DB_PORT = 5432,
  DB_NAME = "smart_window_db",
  DB_USER = "admin",
  DB_PASSWORD,
  JWT_SECRET,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  FIREBASE_DB_URL
} = process.env;

if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET is required in .env");
  process.exit(1);
}

// ===============================
// Database Setup
// ===============================

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
});

pool.query("SELECT NOW()")
  .then(() => console.log("✅ Database connected successfully"))
  .catch(err => console.error("❌ Database connection failed:", err.message));

// ===============================
// Firebase Setup
// ===============================

let db = null;
const serviceAccountPath = "./serviceAccountKey.json";

if (fs.existsSync(serviceAccountPath) && FIREBASE_DB_URL) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DB_URL,
    });
    db = admin.database();
    console.log("✅ Firebase initialized successfully");
  } catch (error) {
    console.error("❌ Firebase initialization error:", error.message);
  }
} else {
  console.warn("⚠️ Firebase disabled (missing key or DB URL)");
}

// ===============================
// Telegram Setup
// ===============================

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram disabled (missing env vars)");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      }
    );
    console.log("📩 Telegram alert sent");
  } catch (error) {
    console.log("Telegram Error:", error.message);
  }
}

// ===============================
// Express Setup
// ===============================

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===============================
// Auth Middleware
// ===============================

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Access token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// ===============================
// Routes
// ===============================

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", timestamp: result.rows[0] });
  } catch (error) {
    res.status(503).json({ status: "error", error: error.message });
  }
});

// ===============================
// System State
// ===============================

let systemState = {
  temperature: 0,
  light: 0,
  window: "CLOSE",
  mode: "AUTO",
  timestamp: null,
};

let previousWindowState = "CLOSE";

// ===============================
// WebSocket Logic
// ===============================

wss.on("connection", (ws) => {
  ws.role = "UNKNOWN";

  ws.on("message", async (message) => {
    const msg = message.toString();

    if (msg.startsWith("ROLE:")) {
      ws.role = msg.split(":")[1];
      return;
    }

    if (ws.role === "ESP32") {
      try {
        const data = JSON.parse(msg);

        systemState = {
          temperature: data.temperature,
          light: data.light,
          window: data.window,
          mode: data.mode || "AUTO",
          timestamp: new Date().toISOString(),
        };

        if (db) {
          const timestamp = new Date().toISOString().replace(/\./g, "_");
          await db.ref(`logs/sensor_data/${timestamp}`).set(systemState);
          await db.ref("current_state").set(systemState);
        }

        broadcastToBrowser(systemState);

        if (systemState.window !== previousWindowState) {
          await sendTelegram(
            `🚨 Smart Window Alert 🚨
Window: ${systemState.window}
Temp: ${systemState.temperature}°C
Light: ${systemState.light} lux`
          );
          previousWindowState = systemState.window;
        }

      } catch (err) {
        console.error("ESP32 error:", err.message);
      }
    }

    if (ws.role === "BROWSER") {
      if (["OPEN", "CLOSE", "AUTO"].includes(msg)) {
        sendToESP32(msg);
      }
    }
  });
});

// ===============================
// Helpers
// ===============================

function broadcastToBrowser(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.role === "BROWSER") {
      client.send(JSON.stringify(data));
    }
  });
}

function sendToESP32(command) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.role === "ESP32") {
      client.send(command);
    }
  });
}

// ===============================
// Start Server
// ===============================

server.listen(PORT, () => {
  console.log("=================================");
  console.log("Smart Window Control System");
  console.log("Server running on port:", PORT);
  console.log("=================================");
});