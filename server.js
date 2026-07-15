/**
 * Bible Study Rota — Backend Server
 *
 * Express server with:
 *  - SQLite persistence (via better-sqlite3)
 *  - REST API for rota CRUD, member management, assignments, reminders
 *  - Email reminders via Nodemailer + node-cron
 *
 * SETUP:
 *  1. Copy .env.example to .env and fill in your SMTP/API credentials
 *  2. Run: npm install
 *  3. Run: npm start
 *  4. Open http://localhost:3000
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

// ---------------------------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "rota.db");

// Session frequency: "daily" = Mon-Fri every week, or "weekly" on a set day
const SESSION_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri (JS getDay: 0=Sun)
const SESSIONS_TO_GENERATE = parseInt(process.env.SESSIONS_TO_GENERATE, 10) || 20;
const START_DATE_STR = process.env.START_DATE || "2026-07-14"; // ISO date

// ---------------------------------------------------------------------------
// 2. DATABASE SETUP
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // safe concurrent reads
db.pragma("foreign_keys = ON");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL UNIQUE,  -- YYYY-MM-DD
    title       TEXT    DEFAULT 'Bible Study',
    location    TEXT    DEFAULT '',
    notes       TEXT    DEFAULT '',
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL UNIQUE,   -- one assignment per session
    member_id   INTEGER NOT NULL,
    role        TEXT    DEFAULT 'Leader',  -- Leader / Host / Co-Lead
    assigned_by TEXT    DEFAULT '',        -- name/email of who made the assignment
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id)  REFERENCES members(id)  ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL,
    member_id   INTEGER NOT NULL,
    remind_at   TEXT    NOT NULL,  -- ISO 8601 datetime when to fire
    sent        INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id)  REFERENCES members(id)  ON DELETE CASCADE
  );
`);

// ---------------------------------------------------------------------------
// 3. SEED SESSIONS (only if table is empty)
// ---------------------------------------------------------------------------

function seedSessions() {
  const count = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
  if (count > 0) return;

  const insert = db.prepare(
    "INSERT OR IGNORE INTO sessions (date, title) VALUES (?, ?)"
  );

  const start = new Date(START_DATE_STR + "T00:00:00");
  let inserted = 0;
  let d = new Date(start);

  while (inserted < SESSIONS_TO_GENERATE) {
    const day = d.getDay(); // 0-6
    if (SESSION_DAYS.includes(day)) {
      // Use local date parts to avoid UTC timezone shifts
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      insert.run(iso, "Bible Study");
      inserted++;
    }
    d.setDate(d.getDate() + 1);
  }
  console.log(`[seed] Inserted ${inserted} sessions starting ${START_DATE_STR}`);
}

seedSessions();

// ---------------------------------------------------------------------------
// 4. EMAIL TRANSPORT
// ---------------------------------------------------------------------------

// Configure one of: SMTP, SendGrid (via SMTP), Resend, or ethereal for testing
//
// Option A – Generic SMTP (Gmail, Outlook, etc.)
//   Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env
//
// Option B – SendGrid
//   Set SENDGRID_API_KEY in .env; we use their SMTP relay.
//
// Option C – Resend
//   Set RESEND_API_KEY in .env; we use their HTTP API instead of Nodemailer.
//   For Resend we'll use fetch() — handled separately below.
//
// Option D – Ethereal (test/fake SMTP, no real emails)
//   Set USE_ETHEREAL=true in .env

let transporter = null;
let useResend = false;

async function initTransporter() {
  if (process.env.RESEND_API_KEY) {
    useResend = true;
    console.log("[email] Using Resend API for email delivery");
    return;
  }

  if (process.env.USE_ETHEREAL === "true") {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log("[email] Using Ethereal test SMTP — emails will NOT be delivered");
    console.log(`[email] Ethereal account: ${testAccount.user}`);
    return;
  }

  // Default: SMTP
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
  });
  console.log(`[email] SMTP configured: ${process.env.SMTP_HOST || "smtp.gmail.com"}`);
}

/**
 * Send an email (or log it for Ethereal/Resend)
 */
async function sendEmail(to, subject, htmlBody) {
  if (!to) return;

  // Resend path
  if (useResend) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "rota@yourdomain.com",
          to: [to],
          subject,
          html: htmlBody,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) console.error("[email] Resend error:", data);
      else console.log(`[email] Sent via Resend to ${to} — id: ${data.id}`);
    } catch (err) {
      console.error("[email] Resend request failed:", err.message);
    }
    return;
  }

  // Nodemailer path (SMTP / Ethereal)
  if (!transporter) {
    console.warn("[email] No transporter configured — skipping email to", to);
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Bible Study Rota" <${process.env.SMTP_USER || "rota@localhost"}>`,
      to,
      subject,
      html: htmlBody,
    });
    console.log(`[email] Sent to ${to} — messageId: ${info.messageId}`);
    // If Ethereal, log the preview URL
    if (process.env.USE_ETHEREAL === "true") {
      console.log(`[email] Preview: ${nodemailer.getTestMessageUrl(info)}`);
    }
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// 5. CRON — CHECK & SEND REMINDERS
// ---------------------------------------------------------------------------

function buildReminderEmail(member, session, role) {
  const dateObj = new Date(session.date + "T00:00:00");
  const niceDate = dateObj.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#4a6741;">Bible Study Reminder</h2>
      <p>Hi <strong>${member.name}</strong>,</p>
      <p>This is a friendly reminder that you are assigned as <strong>${role}</strong> for the upcoming Bible study session:</p>
      <div style="background:#f4f8f2;border-left:4px solid #4a6741;padding:16px;margin:16px 0;border-radius:4px;">
        <p style="margin:0;"><strong>Date:</strong> ${niceDate}</p>
        ${session.location ? `<p style="margin:4px 0 0;"><strong>Location:</strong> ${session.location}</p>` : ""}
        ${session.notes ? `<p style="margin:4px 0 0;"><strong>Notes:</strong> ${session.notes}</p>` : ""}
      </div>
      <p>Thank you for serving! 🙏</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;" />
      <p style="font-size:12px;color:#999;">Bible Study Rota — automated reminder</p>
    </div>
  `;
}

/**
 * Cron job: runs every minute, checks for reminders that should fire now.
 * Also cleans up reminders whose sessions no longer have an assignment.
 */
function startReminderCron() {
  // Every minute
  cron.schedule("* * * * *", async () => {
    const now = new Date().toISOString();

    // 1. Cancel orphaned reminders (assignment removed)
    const orphaned = db
      .prepare(
        `SELECT r.id FROM reminders r
         LEFT JOIN assignments a ON a.session_id = r.session_id
         WHERE a.id IS NULL AND r.sent = 0`
      )
      .all();

    if (orphaned.length > 0) {
      const del = db.prepare("DELETE FROM reminders WHERE id = ?");
      const delMany = db.transaction((rows) => {
        for (const row of rows) del.run(row.id);
      });
      delMany(orphaned);
      console.log(`[cron] Cancelled ${orphaned.length} orphaned reminders`);
    }

    // 2. Fire due reminders
    const due = db
      .prepare(
        `SELECT r.id, r.session_id, r.member_id,
                s.date, s.title, s.location, s.notes,
                m.name, m.email, a.role
         FROM reminders r
         JOIN sessions s   ON s.id = r.session_id
         JOIN members  m   ON m.id = r.member_id
         JOIN assignments a ON a.session_id = r.session_id AND a.member_id = r.member_id
         WHERE r.sent = 0 AND r.remind_at <= ?`
      )
      .all(now);

    for (const row of due) {
      const html = buildReminderEmail(
        { name: row.name },
        { date: row.date, location: row.location, notes: row.notes },
        row.role
      );
      await sendEmail(
        row.email,
        `Reminder: You're leading Bible Study on ${row.date}`,
        html
      );
      db.prepare("UPDATE reminders SET sent = 1 WHERE id = ?").run(row.id);
    }

    if (due.length > 0) {
      console.log(`[cron] Sent ${due.length} reminder(s)`);
    }
  });

  console.log("[cron] Reminder checker scheduled (every minute)");
}

// ---------------------------------------------------------------------------
// 6. EXPRESS APP & API ROUTES
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from public directory
const publicDir = path.join(__dirname, "public");
console.log(`[static] __dirname: ${__dirname}`);
console.log(`[static] publicDir: ${publicDir}`);

const fs = require("fs");
try {
  const files = fs.readdirSync(publicDir);
  console.log(`[static] Files in public/: ${files.join(", ")}`);
} catch (e) {
  console.error(`[static] ERROR reading public dir: ${e.message}`);
}

app.use(express.static(publicDir));

// Fallback: serve index.html for root
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- Sessions ---

// GET all sessions (optionally filter by month/year)
app.get("/api/sessions", (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    rows = db
      .prepare("SELECT * FROM sessions WHERE date BETWEEN ? AND ? ORDER BY date")
      .all(from, to);
  } else {
    rows = db.prepare("SELECT * FROM sessions ORDER BY date").all();
  }
  res.json(rows);
});

// POST create a session
app.post("/api/sessions", (req, res) => {
  const { date, title, location, notes } = req.body;
  if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
  try {
    const info = db
      .prepare("INSERT INTO sessions (date, title, location, notes) VALUES (?, ?, ?, ?)")
      .run(date, title || "Bible Study", location || "", notes || "");
    res.json({ id: info.lastInsertRowid, date, title: title || "Bible Study" });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A session already exists on that date" });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT update a session
app.put("/api/sessions/:id", (req, res) => {
  const { title, location, notes, date } = req.body;
  const stmt = db.prepare(
    "UPDATE sessions SET title = COALESCE(?, title), location = COALESCE(?, location), notes = COALESCE(?, notes), date = COALESCE(?, date) WHERE id = ?"
  );
  stmt.run(title || null, location || null, notes || null, date || null, req.params.id);
  res.json({ ok: true });
});

// DELETE a session
app.delete("/api/sessions/:id", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Members ---

// GET all members
app.get("/api/members", (_req, res) => {
  res.json(db.prepare("SELECT * FROM members ORDER BY name").all());
});

// POST create a member
app.post("/api/members", (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const info = db
      .prepare("INSERT INTO members (name, email) VALUES (?, ?)")
      .run(name.trim(), email.trim().toLowerCase());
    console.log(`[members] Created: id=${info.lastInsertRowid} name=${name} email=${email}`);
    const all = db.prepare("SELECT * FROM members").all();
    console.log(`[members] Total members in DB: ${all.length}`);
    res.json({ id: info.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase() });
  } catch (e) {
    console.error(`[members] Error creating member:`, e.message);
    if (e.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A member with that email already exists" });
    }
    res.status(500).json({ error: e.message });
  }
});

// DELETE a member
app.delete("/api/members/:id", (req, res) => {
  db.prepare("DELETE FROM members WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Assignments ---

// GET all assignments (joined with session + member info)
app.get("/api/assignments", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.session_id, a.member_id, a.role, a.assigned_by, a.created_at,
              s.date, s.title, s.location,
              m.name AS member_name, m.email AS member_email
       FROM assignments a
       JOIN sessions s ON s.id = a.session_id
       JOIN members  m ON m.id = a.member_id
       ORDER BY s.date`
    )
    .all();
  res.json(rows);
});

// POST create or replace an assignment for a session
app.post("/api/assignments", (req, res) => {
  const { session_id, member_id, role, assigned_by } = req.body;
  if (!session_id || !member_id) {
    return res.status(400).json({ error: "session_id and member_id required" });
  }

  const assign = db.transaction(() => {
    // Remove existing assignment for this session (replace)
    db.prepare("DELETE FROM assignments WHERE session_id = ?").run(session_id);
    // Also remove any pending reminders for this session
    db.prepare("DELETE FROM reminders WHERE session_id = ? AND sent = 0").run(session_id);

    const info = db
      .prepare(
        "INSERT INTO assignments (session_id, member_id, role, assigned_by) VALUES (?, ?, ?, ?)"
      )
      .run(session_id, member_id, role || "Leader", assigned_by || "");

    // Auto-create a 1-day-before reminder
    const session = db.prepare("SELECT date FROM sessions WHERE id = ?").get(session_id);
    if (session) {
      // Session date at 09:00 local, minus 1 day = reminder time
      const sessionDateTime = new Date(session.date + "T09:00:00");
      const remindAt = new Date(sessionDateTime.getTime() - 1440 * 60000); // 1440 min = 1 day
      db.prepare(
        "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)"
      ).run(session_id, member_id, remindAt.toISOString());
    }

    return info.lastInsertRowid;
  });

  const id = assign();
  res.json({ id, session_id, member_id, reminder: "1 day before" });
});

// DELETE an assignment
app.delete("/api/assignments/:id", (req, res) => {
  // Also cancel pending reminders for this session
  const assignment = db.prepare("SELECT session_id FROM assignments WHERE id = ?").get(req.params.id);
  if (assignment) {
    db.prepare("DELETE FROM reminders WHERE session_id = ? AND sent = 0").run(assignment.session_id);
  }
  db.prepare("DELETE FROM assignments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Reminders ---

// GET all reminders (with joined info)
app.get("/api/reminders", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, s.date, m.name AS member_name, m.email AS member_email, a.role
       FROM reminders r
       JOIN sessions s ON s.id = r.session_id
       JOIN members  m ON m.id = r.member_id
       JOIN assignments a ON a.session_id = r.session_id AND a.member_id = r.member_id
       ORDER BY r.remind_at`
    )
    .all();
  res.json(rows);
});

// POST create a reminder for an assignment
// Body: { session_id, member_id, offset_minutes } — how many minutes before session date to remind
// Or: { session_id, member_id, remind_at } — exact ISO datetime
app.post("/api/reminders", (req, res) => {
  const { session_id, member_id, offset_minutes, remind_at } = req.body;
  if (!session_id || !member_id) {
    return res.status(400).json({ error: "session_id and member_id required" });
  }

  let fireAt;
  if (remind_at) {
    fireAt = remind_at;
  } else if (offset_minutes != null) {
    // Calculate from session date (at 09:00 as default session start)
    const session = db.prepare("SELECT date FROM sessions WHERE id = ?").get(session_id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const sessionDateTime = new Date(session.date + "T09:00:00");
    fireAt = new Date(sessionDateTime.getTime() - offset_minutes * 60000).toISOString();
  } else {
    return res.status(400).json({ error: "Provide offset_minutes or remind_at" });
  }

  // Don't create reminders in the past
  if (new Date(fireAt) < new Date()) {
    return res.status(400).json({ error: "Reminder time is in the past" });
  }

  // Check assignment exists
  const assignment = db
    .prepare("SELECT id FROM assignments WHERE session_id = ? AND member_id = ?")
    .get(session_id, member_id);
  if (!assignment) {
    return res.status(404).json({ error: "No assignment found for this session/member" });
  }

  const info = db
    .prepare("INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)")
    .run(session_id, member_id, fireAt);

  res.json({ id: info.lastInsertRowid, remind_at: fireAt });
});

// DELETE a reminder
app.delete("/api/reminders/:id", (req, res) => {
  db.prepare("DELETE FROM reminders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Dashboard data (single endpoint for the frontend) ---
app.get("/api/rota", (_req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY date").all();
  const assignments = db
    .prepare(
      `SELECT a.*, m.name AS member_name, m.email AS member_email
       FROM assignments a
       JOIN members m ON m.id = a.member_id`
    )
    .all();
  const reminders = db
    .prepare(
      `SELECT r.*, m.name AS member_name
       FROM reminders r
       JOIN members m ON m.id = r.member_id`
    )
    .all();
  const members = db.prepare("SELECT * FROM members ORDER BY name").all();
  console.log(`[rota] sessions=${sessions.length} members=${members.length} assignments=${assignments.length}`);

  // Merge assignments into sessions
  const assignmentMap = {};
  assignments.forEach((a) => {
    assignmentMap[a.session_id] = a;
  });
  const reminderMap = {};
  reminders.forEach((r) => {
    if (!reminderMap[r.session_id]) reminderMap[r.session_id] = [];
    reminderMap[r.session_id].push(r);
  });

  const rota = sessions.map((s) => ({
    ...s,
    assignment: assignmentMap[s.id] || null,
    reminders: reminderMap[s.id] || [],
  }));

  res.json({ rota, members });
});

// --- Debug endpoint ---
app.get("/api/debug", (_req, res) => {
  const sessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
  const members = db.prepare("SELECT * FROM members").all();
  const assignments = db.prepare("SELECT * FROM assignments").all();
  const reminders = db.prepare("SELECT * FROM reminders").all();
  res.json({
    dbPath: DB_PATH,
    sessions,
    members,
    assignments,
    reminders,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// ---------------------------------------------------------------------------
// 7. START SERVER
// ---------------------------------------------------------------------------

async function start() {
  await initTransporter();
  startReminderCron();

  app.listen(PORT, () => {
    console.log(`\n🟢 Bible Study Rota running at http://localhost:${PORT}\n`);
  });
}

start();
