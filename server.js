// ===============================
// Smart Window Control System
// WebSocket + PostgreSQL + Firebase + Auth
// ===============================

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
const crypto = require("crypto");

// ===============================
// Database Setup
// ===============================

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || "smart_window_db",
  user: process.env.DB_USER || "admin",
  password: process.env.DB_PASSWORD || "admin123",
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

// Test database connection
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ Database connected successfully");
  }
});

// ===============================
// Firebase Setup
// ===============================

// Prefer passing the service account JSON via environment variable
// (FIREBASE_SERVICE_ACCOUNT) to avoid committing credentials into Git.
let db = null;
let firebaseInitialized = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL || "",
    });
    firebaseInitialized = true;
    console.log("✅ Firebase initialized from FIREBASE_SERVICE_ACCOUNT");
  } catch (error) {
    console.error("❌ Firebase initialization error (env):", error.message);
  }
} else {
  const serviceAccountPath = "./serviceAccountKey.json";
  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL || "",
      });
      firebaseInitialized = true;
      console.log("✅ Firebase initialized from serviceAccountKey.json");
    } catch (error) {
      console.error("❌ Firebase initialization error:", error.message);
    }
  } else {
    console.warn("⚠️  serviceAccountKey.json not found and FIREBASE_SERVICE_ACCOUNT not set, Firebase disabled");
  }
}

if (firebaseInitialized && admin.database) {
  db = admin.database();
} else {
  db = null;
}
// ===============================
// Telegram Setup
// ===============================

// Load Telegram configuration from environment variables to avoid committing tokens.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram disabled (missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID)");
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }
    );
    console.log("Telegram Alert Sent");
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

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// ===============================
// Middleware
// ===============================

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid token" });
    }
    // Verify token is recorded and not revoked
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const result = await pool.query(
        'SELECT id, revoked, expires_at FROM user_tokens WHERE token_hash = $1 LIMIT 1',
        [tokenHash]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Token not recognized' });
      }

      const row = result.rows[0];
      if (row.revoked) {
        return res.status(401).json({ error: 'Token revoked' });
      }

      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.status(401).json({ error: 'Token expired' });
      }

      // update last used
      try {
        await pool.query('UPDATE user_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
      } catch (e) {
        console.warn('Failed to update token last_used_at', e && e.message ? e.message : e);
      }

      req.user = user;
      next();
    } catch (dbErr) {
      console.error('Token lookup error:', dbErr && dbErr.message ? dbErr.message : dbErr);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}

// ===============================
// Auth Routes
// ===============================

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", database: "connected", timestamp: result.rows[0] });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(503).json({ status: "error", database: "disconnected", error: error.message });
  }
});

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    console.log("📝 Register attempt:", { username, email });

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password required" });
    }

    // Check if user exists
    const userExists = await pool.query(
      "SELECT * FROM users WHERE username = $1 OR email = $2",
      [username, email]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: "Username or email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email",
      [username, email, hashedPassword]
    );

    const user = result.rows[0];
    console.log("✅ User created:", user);

    // Create user settings
    await pool.query(
      "INSERT INTO window_settings (user_id) VALUES ($1)",
      [user.id]
    );

    // Generate token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: "24h",
    });

    // Store token hash in DB for revocation/checks
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
      await pool.query(
        'INSERT INTO user_tokens (user_id, jti, token_hash, type, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [user.id, null, tokenHash, 'access', expiresAt]
      );
    } catch (e) {
      console.warn('Failed to persist token after register:', e && e.message ? e.message : e);
    }

    res.status(201).json({ user, token });
  } catch (error) {
    console.error("❌ Register error:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    // Find user
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];

    // Compare passwords
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Generate token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: "24h",
    });

    // Store token hash for revocation/checks
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
      await pool.query(
        'INSERT INTO user_tokens (user_id, jti, token_hash, type, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [user.id, null, tokenHash, 'access', expiresAt]
      );
    } catch (e) {
      console.warn('Failed to persist token after login:', e && e.message ? e.message : e);
    }

    res.json({
      user: { id: user.id, username: user.username, email: user.email },
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user settings
app.get("/api/settings", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM window_settings WHERE user_id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Settings not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Settings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update user settings
app.put("/api/settings", authenticateToken, async (req, res) => {
  try {
    const { auto_open_temp, auto_close_temp, auto_mode } = req.body;

    const result = await pool.query(
      "UPDATE window_settings SET auto_open_temp = $1, auto_close_temp = $2, auto_mode = $3, updated_at = CURRENT_TIMESTAMP WHERE user_id = $4 RETURNING *",
      [auto_open_temp, auto_close_temp, auto_mode, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Settings update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===============================
// Admin Routes
// ===============================

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin";

// Admin login
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: "admin", username }, JWT_SECRET, {
      expiresIn: "8h",
    });
    // persist admin token
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8h
      await pool.query(
        'INSERT INTO user_tokens (user_id, jti, token_hash, type, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [null, null, tokenHash, 'admin', expiresAt]
      );
    } catch (e) {
      console.warn('Failed to persist admin token:', e && e.message ? e.message : e);
    }
    return res.json({ token });
  }

  res.status(401).json({ error: "Invalid admin credentials" });
});

// Admin middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Admin token required" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== "admin") {
      return res.status(403).json({ error: "Admin access denied" });
    }
    req.admin = decoded;
    next();
  });
}

// Get all users
app.get("/api/admin/users", authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, created_at, updated_at FROM users ORDER BY id"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Admin get users error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update user
app.put("/api/admin/users/:id", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, password } = req.body;

    // Check if user exists
    const userExists = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check for duplicate username/email (excluding current user)
    const duplicate = await pool.query(
      "SELECT * FROM users WHERE (username = $1 OR email = $2) AND id != $3",
      [username, email, id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: "Username or email already exists" });
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        "UPDATE users SET username = $1, email = $2, password_hash = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4",
        [username, email, hashedPassword, id]
      );
    } else {
      await pool.query(
        "UPDATE users SET username = $1, email = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
        [username, email, id]
      );
    }

    res.json({ message: "User updated successfully" });
  } catch (error) {
    console.error("Admin update user error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete user
app.delete("/api/admin/users/:id", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id, username", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "User deleted", user: result.rows[0] });
  } catch (error) {
    console.error("Admin delete user error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get sensor data from Firebase or system state
app.get("/api/sensor-data", async (req, res) => {
  try {
    if (db) {
      const data = await Promise.race([
        db.ref("current_state").once("value"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 2000)
        ),
      ]).then(snapshot => snapshot.val());
      return res.json(data || systemState);
    }
    res.json(systemState);
  } catch (error) {
    console.warn("⚠️  Firebase unavailable, returning system state");
    res.json(systemState);
  }
});

// Get sensor logs from Firebase
app.get("/api/sensor-logs", async (req, res) => {
  try {
    if (db) {
      const data = await Promise.race([
        db.ref("logs/sensor_data").once("value"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 3000)
        ),
      ]).then(snapshot => snapshot.val());
      const logs = data ? Object.entries(data).map(([timestamp, value]) => ({ 
        timestamp: timestamp.replace(/_/g, "."),
        ...value 
      })) : [];
      return res.json(logs);
    }
    res.json([]);
  } catch (error) {
    console.warn("⚠️  Firebase unavailable, returning empty logs");
    res.json([]);
  }
});

// Get command logs from Firebase
app.get("/api/command-logs", async (req, res) => {
  try {
    if (db) {
      const data = await Promise.race([
        db.ref("logs/commands").once("value"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 3000)
        ),
      ]).then(snapshot => snapshot.val());
      const logs = data ? Object.entries(data).reverse().slice(0, 20).map(([timestamp, value]) => ({ 
        timestamp: timestamp.replace(/_/g, "."),
        ...value 
      })) : [];
      return res.json(logs);
    }
    res.json([]);
  } catch (error) {
    console.warn("⚠️  Firebase unavailable");
    res.json([]);
  }
});

app.get("/api/last-command", async (req, res) => {
  try {
    if (db) {
      const data = await Promise.race([
        db.ref("logs/commands").orderByChild("$key").limitToLast(1).once("value"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 2000)
        ),
      ]).then(snapshot => snapshot.val());
      const lastCmd = data ? Object.values(data)[0] : null;
      return res.json(lastCmd || { command: null, timestamp: null });
    }
    res.json({ command: null, timestamp: null });
  } catch (error) {
    console.warn("⚠️  Firebase unavailable");
    res.json({ command: null, timestamp: null });
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

let lastTempAlert = 0;
let lastLightAlert = 0;
let lastWindowAlert = 0;

const ALERT_INTERVAL = 60000; // 1 minute

// ===============================
// Firebase Helper Functions
// ===============================

async function logToFirebase(logType, data) {
  if (!db) {
    console.warn("⚠️  Firebase not available, skipping log");
    return;
  }
  try {
    // Use timestamp without dots (Firebase doesn't allow dots in keys)
    const timestamp = new Date().toISOString().replace(/\./g, "_");
    const logPath = `logs/${logType}/${timestamp}`;
    await db.ref(logPath).set(data);
    console.log("📝 Firebase log saved:", logPath);
  } catch (error) {
    console.warn("⚠️  Firebase log error:", error.message);
  }
}

async function saveToFirebase(path, data) {
  if (!db) {
    console.warn("⚠️  Firebase not available, skipping write to", path);
    return;
  }
  try {
    await db.ref(path).set(data);
    console.log("📝 Firebase write successful:", path);
  } catch (error) {
    console.error("❌ Firebase write error:", error.message);
  }
}

async function loadFromFirebase(path) {
  if (!db) {
    console.warn("⚠️  Firebase not available, skipping read from", path);
    return null;
  }
  try {
    const snapshot = await Promise.race([
      db.ref(path).once("value"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Firebase read timeout")), 5000)
      ),
    ]);
    console.log("📖 Firebase read successful:", path);
    return snapshot.val();
  } catch (error) {
    console.warn("⚠️  Firebase read error:", error.message);
    return null;
  }
}



// ===============================
// WebSocket Logic
// ===============================

wss.on("connection", (ws) => {
  console.log("Client Connected");
  ws.role = "UNKNOWN";
  ws.userId = null;

  ws.on("message", async (message) => {
    const msg = message.toString();

    // ===============================
    // ROLE REGISTER
    // ===============================
    if (msg.startsWith("ROLE:")) {
      ws.role = msg.split(":")[1];
      console.log("Role:", ws.role);
      return;
    }

    // ===============================
    // USER ID (for browser clients with token)
    // ===============================
    if (msg.startsWith("USER:")) {
      ws.userId = msg.split(":")[1];
      console.log("User ID:", ws.userId);
      return;
    }

    // ===============================
    // ESP32 DATA
    // ===============================
    if (ws.role === "ESP32") {
      try {
        const data = JSON.parse(msg);

        systemState.temperature = data.temperature;
        systemState.light = data.light;
        systemState.window = data.window;
        systemState.mode = data.mode || "AUTO";
        systemState.timestamp = new Date().toISOString();

        // Save to Firebase Realtime Database (logs)
        await logToFirebase("sensor_data", {
          temperature: systemState.temperature,
          light: systemState.light,
          window: systemState.window,
          mode: systemState.mode,
        });

        // Also update current state
        await saveToFirebase("current_state", {
          temperature: systemState.temperature,
          light: systemState.light,
          window: systemState.window,
          mode: systemState.mode,
          timestamp: systemState.timestamp,
        });

        // Broadcast to browsers
        broadcastToBrowser(systemState);

        console.log("Data received:", systemState);

        // ===============================
        // Telegram Alert Logic
        // ===============================

        if (systemState.window !== previousWindowState) {
          const alertMessage =
            `🚨 Smart Window Alert 🚨\n` +
            `🪟 Window: ${systemState.window}\n` +
            `🌡 Temperature: ${systemState.temperature}°C\n` +
            `💡 Light: ${systemState.light} lux`;

          sendTelegram(alertMessage);
          previousWindowState = systemState.window;
        }
      } catch (err) {
        console.error("ESP32 handler error:", err && err.message ? err.message : err);
      }
    }

    // ===============================
    // Command from Browser
    // ===============================
    if (ws.role === "BROWSER") {
      if (msg === "OPEN" || msg === "CLOSE" || msg === "AUTO") {
        systemState.window = msg;

        // Send to ESP32
        sendToESP32(msg);


        // Log command to Firebase (best-effort)
        try {
          await logToFirebase("commands", {
            command: msg,
            window: systemState.window,
          });
        } catch (fbErr) {
          console.warn("Firebase log failed:", fbErr && fbErr.message ? fbErr.message : fbErr);
        }

        console.log("Command sent to ESP32:", msg);
      }
    }
  });

  ws.on("close", () => {
    console.log("Client Disconnected:", ws.role);
  });
});

// ===============================
// Broadcast to Browser
// ===============================

function broadcastToBrowser(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.role === "BROWSER") {
      client.send(JSON.stringify(data));
    }
  });
}

// ===============================
// Send Command to ESP32
// ===============================

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
  console.log("Dashboard: http://localhost:" + PORT);
  console.log("pgAdmin: http://localhost:5050");
  console.log("=================================");
});
