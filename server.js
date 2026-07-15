/**
 * Bible Study Rota — Backend Server
 *
 * Express server with:
 *  - Turso (libsql) cloud database for persistent shared storage
 *  - REST API for rota CRUD, member management, assignments, reminders
 *  - Email reminders via Nodemailer + node-cron
 *
 * SETUP:
 *  1. Create a free Turso database at https://turso.tech
 *  2. Copy .env.example to .env and fill in Turso + SMTP credentials
 *  3. Run: npm install
 *  4. Run: npm start
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@libsql/client");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

// ---------------------------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = [1, 2, 3, 4, 5]; // Mon-Fri
const SESSIONS_TO_GENERATE = parseInt(process.env.SESSIONS_TO_GENERATE, 10) || 20;
const START_DATE_STR = process.env.START_DATE || "2026-07-14";

// ---------------------------------------------------------------------------
// 2. DATABASE SETUP (Turso / libsql)
// ---------------------------------------------------------------------------

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

console.log(`[db] Connected to: ${process.env.TURSO_DATABASE_URL ? "Turso cloud" : "local file"}`);

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL UNIQUE,
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
      session_id  INTEGER NOT NULL UNIQUE,
      member_id   INTEGER NOT NULL,
      role        TEXT    DEFAULT 'Leader',
      assigned_by TEXT    DEFAULT '',
      recurring   INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id)  REFERENCES members(id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      member_id   INTEGER NOT NULL,
      remind_at   TEXT    NOT NULL,
      sent        INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id)  REFERENCES members(id)  ON DELETE CASCADE
    );
  `);
  // Migration: add recurring column to existing databases
  try {
    await db.execute("ALTER TABLE assignments ADD COLUMN recurring INTEGER DEFAULT 0");
  } catch (e) { /* column already exists */ }
  console.log("[db] Tables created/verified");
}

// ---------------------------------------------------------------------------
// 3. SEED SESSIONS (only if table is empty)
// ---------------------------------------------------------------------------

async function seedSessions() {
  const result = await db.execute("SELECT COUNT(*) as c FROM sessions");
  if (result.rows[0].c > 0) return;

  const start = new Date(START_DATE_STR + "T00:00:00");
  let inserted = 0;
  let d = new Date(start);

  const stmts = [];
  while (inserted < SESSIONS_TO_GENERATE) {
    const day = d.getDay();
    if (SESSION_DAYS.includes(day)) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      stmts.push({
        sql: "INSERT OR IGNORE INTO sessions (date, title) VALUES (?, ?)",
        args: [iso, "Bible Study"],
      });
      inserted++;
    }
    d.setDate(d.getDate() + 1);
  }

  // Execute all inserts in a batch
  await db.batch(stmts);
  console.log(`[seed] Inserted ${inserted} sessions starting ${START_DATE_STR}`);
}

// ---------------------------------------------------------------------------
// 4. EMAIL TRANSPORT
// ---------------------------------------------------------------------------

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
    console.log("[email] Using Ethereal test SMTP");
    return;
  }

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

async function sendEmail(to, subject, htmlBody) {
  if (!to) return;

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

function buildReminderEmail(member, session, role, remindAt) {
  const dateObj = new Date(session.date + "T00:00:00");
  const niceDate = dateObj.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const sessionDate = new Date(session.date + "T08:00:00");
  const isEvening = new Date(remindAt).getHours() >= 18;
  const greeting = isEvening
    ? "Tomorrow is your Bible study session!"
    : "Good morning! Today is your Bible study session.";

  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#4a6741;">Bible Study Reminder</h2>
      <p>Hi <strong>${member.name}</strong>,</p>
      <p>${greeting}</p>
      <p>You are assigned as <strong>${role}</strong> for the upcoming session:</p>
      <div style="background:#f4f8f2;border-left:4px solid #4a6741;padding:16px;margin:16px 0;border-radius:4px;">
        <p style="margin:0;"><strong>Date:</strong> ${niceDate}</p>
        ${session.location ? `<p style="margin:4px 0 0;"><strong>Location:</strong> ${session.location}</p>` : ""}
        ${session.notes ? `<p style="margin:4px 0 0;"><strong>Notes:</strong> ${session.notes}</p>` : ""}
      </div>
      <p>Thank you for serving!</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;" />
      <p style="font-size:12px;color:#999;">Bible Study Rota — automated reminder</p>
    </div>
  `;
}

async function startReminderCron() {
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date().toISOString();

      // Cancel orphaned reminders (assignment removed)
      const orphaned = await db.execute(
        `SELECT r.id FROM reminders r
         LEFT JOIN assignments a ON a.session_id = r.session_id
         WHERE a.id IS NULL AND r.sent = 0`
      );
      if (orphaned.rows.length > 0) {
        const stmts = orphaned.rows.map((r) => ({
          sql: "DELETE FROM reminders WHERE id = ?",
          args: [r.id],
        }));
        await db.batch(stmts);
        console.log(`[cron] Cancelled ${orphaned.rows.length} orphaned reminders`);
      }

      // Fire due reminders
      const due = await db.execute({
        sql: `SELECT r.id, r.session_id, r.member_id, r.remind_at,
                s.date, s.title, s.location, s.notes,
                m.name, m.email, a.role
         FROM reminders r
         JOIN sessions s   ON s.id = r.session_id
         JOIN members  m   ON m.id = r.member_id
         JOIN assignments a ON a.session_id = r.session_id AND a.member_id = r.member_id
         WHERE r.sent = 0 AND r.remind_at <= ?`,
        args: [now],
      });

      for (const row of due.rows) {
        const html = buildReminderEmail(
          { name: row.name },
          { date: row.date, location: row.location, notes: row.notes },
          row.role,
          row.remind_at
        );
        await sendEmail(row.email, `Reminder: You're leading Bible Study on ${row.date}`, html);
        await db.execute({ sql: "UPDATE reminders SET sent = 1 WHERE id = ?", args: [row.id] });
      }

      if (due.rows.length > 0) {
        console.log(`[cron] Sent ${due.rows.length} reminder(s)`);
      }
    } catch (err) {
      console.error("[cron] Error:", err.message);
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

// Serve static files
const publicDir = path.join(__dirname, "public");
const fs = require("fs");
try {
  const files = fs.readdirSync(publicDir);
  console.log(`[static] Files in public/: ${files.join(", ")}`);
} catch (e) {
  console.error(`[static] ERROR: ${e.message}`);
}
app.use(express.static(publicDir));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- Sessions ---

app.get("/api/sessions", async (req, res) => {
  const { from, to } = req.query;
  let result;
  if (from && to) {
    result = await db.execute({
      sql: "SELECT * FROM sessions WHERE date BETWEEN ? AND ? ORDER BY date",
      args: [from, to],
    });
  } else {
    result = await db.execute("SELECT * FROM sessions ORDER BY date");
  }
  res.json(result.rows);
});

app.post("/api/sessions", async (req, res) => {
  const { date, title, location, notes } = req.body;
  if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
  try {
    const result = await db.execute({
      sql: "INSERT INTO sessions (date, title, location, notes) VALUES (?, ?, ?, ?)",
      args: [date, title || "Bible Study", location || "", notes || ""],
    });

    const newSessionId = Number(result.lastInsertRowid);
    const newDate = new Date(date + "T00:00:00");
    const weekday = newDate.getDay();

    // Auto-assign any recurring pattern for this weekday
    const recurringAssignments = (await db.execute({
      sql: `SELECT DISTINCT a.member_id, a.role, a.assigned_by
       FROM assignments a
       JOIN sessions s ON s.id = a.session_id
       WHERE a.recurring = 1 AND a.session_id != ?
         AND strftime('%w', s.date) = ?
         AND s.date < ?`,
      args: [newSessionId, String(weekday), date],
    })).rows;

    if (recurringAssignments.length > 0) {
      const ra = recurringAssignments[0]; // Take the most recent recurring pattern
      await db.execute({
        sql: "INSERT INTO assignments (session_id, member_id, role, assigned_by, recurring) VALUES (?, ?, ?, ?, 1)",
        args: [newSessionId, ra.member_id, ra.role, ra.assigned_by || ""],
      });
      // Auto-create two reminders: evening before (20:00) and morning of (08:00)
      const sessionDateTime = new Date(date + "T08:00:00");
      const eveningBefore = new Date(sessionDateTime.getTime() - 12 * 3600000);
      await db.execute({
        sql: "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)",
        args: [newSessionId, ra.member_id, eveningBefore.toISOString()],
      });
      await db.execute({
        sql: "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)",
        args: [newSessionId, ra.member_id, sessionDateTime.toISOString()],
      });
      console.log(`[sessions] Auto-assigned recurring member ${ra.member_id} to new session ${newSessionId}`);
    }

    res.json({ id: newSessionId, date, title: title || "Bible Study" });
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A session already exists on that date" });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/sessions/:id", async (req, res) => {
  const { title, location, notes, date } = req.body;
  await db.execute({
    sql: `UPDATE sessions SET
      title = COALESCE(?, title),
      location = COALESCE(?, location),
      notes = COALESCE(?, notes),
      date = COALESCE(?, date)
      WHERE id = ?`,
    args: [title || null, location || null, notes || null, date || null, req.params.id],
  });
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", async (req, res) => {
  await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// --- Members ---

app.get("/api/members", async (_req, res) => {
  const result = await db.execute("SELECT * FROM members ORDER BY name");
  res.json(result.rows);
});

app.post("/api/members", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email required" });
  try {
    const result = await db.execute({
      sql: "INSERT INTO members (name, email) VALUES (?, ?)",
      args: [name.trim(), email.trim().toLowerCase()],
    });
    console.log(`[members] Created: id=${result.lastInsertRowid} name=${name} email=${email}`);
    res.json({ id: Number(result.lastInsertRowid), name: name.trim(), email: email.trim().toLowerCase() });
  } catch (e) {
    console.error(`[members] Error:`, e.message);
    if (e.message && e.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A member with that email already exists" });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/members/:id", async (req, res) => {
  await db.execute({ sql: "DELETE FROM members WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// --- Assignments ---

app.get("/api/assignments", async (_req, res) => {
  const result = await db.execute(
    `SELECT a.id, a.session_id, a.member_id, a.role, a.assigned_by, a.recurring, a.created_at,
            s.date, s.title, s.location,
            m.name AS member_name, m.email AS member_email
     FROM assignments a
     JOIN sessions s ON s.id = a.session_id
     JOIN members  m ON m.id = a.member_id
     ORDER BY s.date`
  );
  res.json(result.rows);
});

app.post("/api/assignments", async (req, res) => {
  const { session_id, member_id, role, assigned_by, recurring } = req.body;
  if (!session_id || !member_id) {
    return res.status(400).json({ error: "session_id and member_id required" });
  }

  try {
    // Get the selected session's date
    const sessionResult = await db.execute({ sql: "SELECT date FROM sessions WHERE id = ?", args: [session_id] });
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }
    const sessionDate = new Date(sessionResult.rows[0].date + "T00:00:00");
    const weekday = sessionDate.getDay(); // 0=Sun, 1=Mon, ...

    // Find all future sessions on the same day of the week
    const allSessions = (await db.execute("SELECT id, date FROM sessions ORDER BY date")).rows;
    const targetSessions = allSessions.filter((s) => {
      const d = new Date(s.date + "T00:00:00");
      return d.getDay() === weekday && d >= sessionDate;
    });

    // If not recurring, only assign to the selected session
    const sessionsToAssign = recurring ? targetSessions : [allSessions.find((s) => s.id === session_id)].filter(Boolean);

    const stmts = [];
    let assignedCount = 0;

    for (const s of sessionsToAssign) {
      // Remove existing assignment for this session
      stmts.push({ sql: "DELETE FROM assignments WHERE session_id = ?", args: [s.id] });
      stmts.push({ sql: "DELETE FROM reminders WHERE session_id = ? AND sent = 0", args: [s.id] });
    }

    await db.batch(stmts);

    const assignStmts = [];
    const reminderStmts = [];

    for (const s of sessionsToAssign) {
      assignStmts.push({
        sql: "INSERT INTO assignments (session_id, member_id, role, assigned_by, recurring) VALUES (?, ?, ?, ?, ?)",
        args: [s.id, member_id, role || "Leader", assigned_by || "", recurring ? 1 : 0],
      });

      // Auto-create two reminders: evening before (20:00) and morning of (08:00)
      const sDate = new Date(s.date + "T08:00:00");
      const eveningBefore = new Date(sDate.getTime() - 12 * 3600000); // 20:00 day before
      reminderStmts.push({
        sql: "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)",
        args: [s.id, member_id, eveningBefore.toISOString()],
      });
      reminderStmts.push({
        sql: "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)",
        args: [s.id, member_id, sDate.toISOString()],
      });

      assignedCount++;
    }

    await db.batch(assignStmts);
    await db.batch(reminderStmts);

    console.log(`[assignments] Assigned member ${member_id} to ${assignedCount} session(s) (recurring: ${!!recurring})`);

    res.json({
      session_id,
      member_id,
      recurring: !!recurring,
      assigned_count: assignedCount,
      reminder: "Evening before (20:00) + Morning of (08:00)",
    });
  } catch (err) {
    console.error("[assignments] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/assignments/:id", async (req, res) => {
  const assignment = await db.execute({ sql: "SELECT session_id FROM assignments WHERE id = ?", args: [req.params.id] });
  if (assignment.rows.length > 0) {
    await db.execute({ sql: "DELETE FROM reminders WHERE session_id = ? AND sent = 0", args: [assignment.rows[0].session_id] });
  }
  await db.execute({ sql: "DELETE FROM assignments WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// --- Reminders ---

app.get("/api/reminders", async (_req, res) => {
  const result = await db.execute(
    `SELECT r.*, s.date, m.name AS member_name, m.email AS member_email, a.role
     FROM reminders r
     JOIN sessions s ON s.id = r.session_id
     JOIN members  m ON m.id = r.member_id
     JOIN assignments a ON a.session_id = r.session_id AND a.member_id = r.member_id
     ORDER BY r.remind_at`
  );
  res.json(result.rows);
});

app.post("/api/reminders", async (req, res) => {
  const { session_id, member_id, offset_minutes, remind_at } = req.body;
  if (!session_id || !member_id) {
    return res.status(400).json({ error: "session_id and member_id required" });
  }

  let fireAt;
  if (remind_at) {
    fireAt = remind_at;
  } else if (offset_minutes != null) {
    const session = await db.execute({ sql: "SELECT date FROM sessions WHERE id = ?", args: [session_id] });
    if (session.rows.length === 0) return res.status(404).json({ error: "Session not found" });
    const sessionDateTime = new Date(session.rows[0].date + "T09:00:00");
    fireAt = new Date(sessionDateTime.getTime() - offset_minutes * 60000).toISOString();
  } else {
    return res.status(400).json({ error: "Provide offset_minutes or remind_at" });
  }

  if (new Date(fireAt) < new Date()) {
    return res.status(400).json({ error: "Reminder time is in the past" });
  }

  const assignment = await db.execute({
    sql: "SELECT id FROM assignments WHERE session_id = ? AND member_id = ?",
    args: [session_id, member_id],
  });
  if (assignment.rows.length === 0) {
    return res.status(404).json({ error: "No assignment found for this session/member" });
  }

  const result = await db.execute({
    sql: "INSERT INTO reminders (session_id, member_id, remind_at) VALUES (?, ?, ?)",
    args: [session_id, member_id, fireAt],
  });

  res.json({ id: Number(result.lastInsertRowid), remind_at: fireAt });
});

app.delete("/api/reminders/:id", async (req, res) => {
  await db.execute({ sql: "DELETE FROM reminders WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// --- Dashboard data ---

app.get("/api/rota", async (_req, res) => {
  const sessions = (await db.execute("SELECT * FROM sessions ORDER BY date")).rows;
  const assignments = (await db.execute(
    `SELECT a.*, m.name AS member_name, m.email AS member_email
     FROM assignments a
     JOIN members m ON m.id = a.member_id`
  )).rows;
  const reminders = (await db.execute(
    `SELECT r.*, m.name AS member_name
     FROM reminders r
     JOIN members m ON m.id = r.member_id`
  )).rows;
  const members = (await db.execute("SELECT * FROM members ORDER BY name")).rows;

  const assignmentMap = {};
  assignments.forEach((a) => { assignmentMap[a.session_id] = a; });
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

// --- Debug ---

app.get("/api/debug", async (_req, res) => {
  const sessions = (await db.execute("SELECT COUNT(*) as c FROM sessions")).rows[0].c;
  const members = (await db.execute("SELECT * FROM members")).rows;
  const assignments = (await db.execute("SELECT * FROM assignments")).rows;
  res.json({ sessions, members, assignments, dbUrl: process.env.TURSO_DATABASE_URL ? "turso" : "local" });
});

// ---------------------------------------------------------------------------
// 7. START SERVER
// ---------------------------------------------------------------------------

async function start() {
  await initDB();
  await seedSessions();
  await initTransporter();
  startReminderCron();

  app.listen(PORT, () => {
    console.log(`\n🟢 Bible Study Rota running at http://localhost:${PORT}\n`);
  });
}

start();
