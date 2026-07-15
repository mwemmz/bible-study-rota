/**
 * Bible Study Rota — Frontend Application
 *
 * Vanilla JS SPA that talks to the Express backend API.
 * Handles: rota display, member management, assignments, reminders, session editing.
 */

const API = ""; // same origin

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

let rotaData = [];
let membersData = [];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Format ISO date string to a nice readable form */
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Get weekday name */
function weekday(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "long" });
}

/** Get YYYY-MM-DD for today (local timezone, no UTC shift) */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Convert a Date object to local YYYY-MM-DD */
function toLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Simple fetch wrapper */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** Show a toast message */
function toast(msg, duration = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.add("visible");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove("visible");
    el.classList.add("hidden");
  }, duration);
}

// ---------------------------------------------------------------------------
// TABS
// ---------------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// LOAD DATA
// ---------------------------------------------------------------------------

async function loadRota() {
  try {
    const data = await api("/api/rota");
    rotaData = data.rota;
    membersData = data.members;
    renderRota();
    renderMembers();
    populateMemberSelect();
    requestAnimationFrame(setupScrollReveal);
  } catch (err) {
    toast("Failed to load data: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// RENDER ROTA
// ---------------------------------------------------------------------------

function renderRota() {
  const container = document.getElementById("rota-list");
  const filter = document.getElementById("filter-week").value;
  const today = todayISO();

  let sessions = [...rotaData];

  // Apply filter
  if (filter === "this-week") {
    const d = new Date();
    const dayOfWeek = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    const from = toLocalISO(monday);
    const to = toLocalISO(friday);
    sessions = sessions.filter((s) => s.date >= from && s.date <= to);
  } else if (filter === "next-week") {
    const d = new Date();
    const dayOfWeek = d.getDay();
    const nextMonday = new Date(d);
    nextMonday.setDate(d.getDate() + (8 - dayOfWeek) % 7 || 7);
    const nextFriday = new Date(nextMonday);
    nextFriday.setDate(nextMonday.getDate() + 4);
    const from = toLocalISO(nextMonday);
    const to = toLocalISO(nextFriday);
    sessions = sessions.filter((s) => s.date >= from && s.date <= to);
  } else if (filter === "4-weeks") {
    const from = today;
    const to = new Date();
    to.setDate(to.getDate() + 28);
    const toISO = toLocalISO(to);
    sessions = sessions.filter((s) => s.date >= from && s.date <= toISO);
  }

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No sessions found.</p></div>';
    return;
  }

  let html = "";
  let lastWeek = "";

  for (const s of sessions) {
    // Week separator
    const d = new Date(s.date + "T00:00:00");
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekKey = toLocalISO(weekStart);
    if (weekKey !== lastWeek) {
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      html += `<div class="day-separator">Week of ${fmtDate(toLocalISO(weekStart))}</div>`;
      lastWeek = weekKey;
    }

    const isToday = s.date === today;
    const isPast = s.date < today;
    const cardClass = isToday ? "session-card today" : isPast ? "session-card past" : "session-card";

    html += `<div class="${cardClass}" data-id="${s.id}">`;
    html += `<div class="session-card-inner">`;
    html += `<div class="session-card-header">`;
    html += `<div class="session-date-group"><div class="session-date">${fmtDate(s.date)}</div>`;
    html += `<div class="session-weekday">${weekday(s.date)}</div></div>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="openEditSession(${s.id})">Edit</button>`;
    html += `</div>`;

    // Location / notes
    if (s.location || s.notes) {
      html += `<div class="session-meta">`;
      if (s.location) html += `<span>📍 ${s.location}</span>`;
      if (s.notes) html += `<span>📝 ${s.notes}</span>`;
      html += `</div>`;
    }

    // Assignment
    html += `<div class="assignment-section">`;
    if (s.assignment) {
      const a = s.assignment;
      html += `<div class="assigned">`;
      html += `<span class="assigned-badge"><span class="role-dot"></span>${a.member_name} — ${a.role}${a.recurring ? '<span class="badge-recurring">↻ recurring</span>' : ''}</span>`;
      html += `</div>`;
      // Show reminders
      if (s.reminders && s.reminders.length > 0) {
        for (const r of s.reminders) {
          const fireDate = new Date(r.remind_at);
          const hour = fireDate.getHours();
          const label = hour >= 18 ? "Evening before" : "Morning of";
          const niceTime = fireDate.toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          html += `<div class="reminder-badge">🔔 ${label}: ${niceTime}${r.sent ? " (sent)" : ""}</div>`;
        }
      }
    } else {
      html += `<div class="unassigned">Unassigned</div>`;
    }
    html += `</div>`;

    // Actions
    html += `<div class="session-actions">`;
    if (s.assignment) {
      html += `<button class="btn btn-primary btn-sm" onclick="openAssignModal(${s.id})">Change</button>`;
      html += `<button class="btn btn-danger btn-sm" onclick="removeAssignment(${s.assignment.id})">Remove</button>`;
    } else {
      html += `<button class="btn btn-primary btn-sm" onclick="openAssignModal(${s.id})">Assign</button>`;
    }
    html += `</div>`;

    html += `</div>`; // close session-card-inner
    html += `</div>`; // close session-card
  }

  container.innerHTML = html;
}

document.getElementById("filter-week").addEventListener("change", renderRota);

// ---------------------------------------------------------------------------
// RENDER MEMBERS
// ---------------------------------------------------------------------------

function renderMembers() {
  const container = document.getElementById("members-list");
  if (membersData.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No members yet. Add someone above.</p></div>';
    return;
  }

  container.innerHTML = membersData
    .map(
      (m) => `
    <div class="member-card">
      <div class="member-card-inner">
        <div class="member-info">
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-email">${esc(m.email)}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="removeMember(${m.id})">Remove</button>
      </div>
    </div>
  `
    )
    .join("");
}

function populateMemberSelect() {
  const sel = document.getElementById("assign-member");
  sel.innerHTML = '<option value="">— Choose a member —</option>';
  for (const m of membersData) {
    sel.innerHTML += `<option value="${m.id}">${esc(m.name)} (${esc(m.email)})</option>`;
  }
}

/** Simple HTML escape */
function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// ASSIGN MODAL
// ---------------------------------------------------------------------------

async function openAssignModal(sessionId) {
  const session = rotaData.find((s) => s.id === sessionId);
  if (!session) return;

  // Always refresh members before opening the modal
  try {
    const data = await api("/api/rota");
    membersData = data.members;
    populateMemberSelect();
  } catch (e) {
    // fallback to cached membersData
  }

  document.getElementById("assign-session-id").value = sessionId;
  document.getElementById("modal-date").textContent = fmtDate(session.date) + " — " + weekday(session.date);
  document.getElementById("assign-member").value = session.assignment ? session.assignment.member_id : "";
  document.getElementById("assign-role").value = session.assignment ? session.assignment.role : "Leader";
  document.getElementById("assign-by").value = "";
  document.getElementById("assign-reminder").value = "";
  document.getElementById("assign-recurring").checked = session.assignment && session.assignment.recurring;
  document.getElementById("assign-weekday-label").textContent = weekday(session.date);

  document.getElementById("assign-modal").classList.remove("hidden");
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("assign-modal").classList.add("hidden");
});

document.getElementById("assign-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.add("hidden");
  }
});

document.getElementById("assign-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sessionId = parseInt(document.getElementById("assign-session-id").value, 10);
  const memberId = parseInt(document.getElementById("assign-member").value, 10);
  const role = document.getElementById("assign-role").value;
  const assignedBy = document.getElementById("assign-by").value.trim();
  const reminderOffset = document.getElementById("assign-reminder").value;
  const recurring = document.getElementById("assign-recurring").checked;

  if (!memberId) return toast("Please select a member");

  try {
    // Create or replace assignment
    const result = await api("/api/assignments", {
      method: "POST",
      body: { session_id: sessionId, member_id: memberId, role, assigned_by: assignedBy, recurring },
    });

    // Set reminder if requested
    if (reminderOffset) {
      await api("/api/reminders", {
        method: "POST",
        body: {
          session_id: sessionId,
          member_id: memberId,
          offset_minutes: parseInt(reminderOffset, 10),
        },
      });
    }

    document.getElementById("assign-modal").classList.add("hidden");
    const count = result && result.assigned_count ? result.assigned_count : 1;
    toast(recurring ? `Recurring assignment saved to ${count} sessions!` : "Assignment saved!");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// REMOVE ASSIGNMENT
// ---------------------------------------------------------------------------

async function removeAssignment(assignmentId) {
  if (!confirm("Remove this assignment? Any pending reminders will be cancelled.")) return;
  try {
    await api("/api/assignments/" + assignmentId, { method: "DELETE" });
    toast("Assignment removed");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// ADD MEMBER
// ---------------------------------------------------------------------------

document.getElementById("add-member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("member-name").value.trim();
  const email = document.getElementById("member-email").value.trim();
  if (!name || !email) return;

  try {
    await api("/api/members", { method: "POST", body: { name, email } });
    document.getElementById("member-name").value = "";
    document.getElementById("member-email").value = "";
    toast("Member added!");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// REMOVE MEMBER
// ---------------------------------------------------------------------------

async function removeMember(memberId) {
  if (!confirm("Remove this member? Their assignments will remain but they won't receive future reminders.")) return;
  try {
    await api("/api/members/" + memberId, { method: "DELETE" });
    toast("Member removed");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// ADD SESSION
// ---------------------------------------------------------------------------

document.getElementById("add-session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = document.getElementById("session-date").value;
  const title = document.getElementById("session-title").value.trim();
  const location = document.getElementById("session-location").value.trim();
  const notes = document.getElementById("session-notes").value.trim();

  if (!date) return;

  try {
    await api("/api/sessions", { method: "POST", body: { date, title, location, notes } });
    document.getElementById("session-date").value = "";
    document.getElementById("session-title").value = "Bible Study";
    document.getElementById("session-location").value = "";
    document.getElementById("session-notes").value = "";
    toast("Session added!");
    // Switch to rota tab
    document.querySelector('[data-tab="rota"]').click();
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// EDIT SESSION
// ---------------------------------------------------------------------------

function openEditSession(sessionId) {
  const session = rotaData.find((s) => s.id === sessionId);
  if (!session) return;

  document.getElementById("edit-session-id").value = sessionId;
  document.getElementById("edit-session-date").value = session.date;
  document.getElementById("edit-session-title").value = session.title || "Bible Study";
  document.getElementById("edit-session-location").value = session.location || "";
  document.getElementById("edit-session-notes").value = session.notes || "";

  document.getElementById("edit-session-modal").classList.remove("hidden");
}

document.getElementById("edit-modal-close").addEventListener("click", () => {
  document.getElementById("edit-session-modal").classList.add("hidden");
});

document.getElementById("edit-session-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.add("hidden");
  }
});

document.getElementById("edit-session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("edit-session-id").value;
  const date = document.getElementById("edit-session-date").value;
  const title = document.getElementById("edit-session-title").value.trim();
  const location = document.getElementById("edit-session-location").value.trim();
  const notes = document.getElementById("edit-session-notes").value.trim();

  try {
    await api("/api/sessions/" + id, {
      method: "PUT",
      body: { date, title, location, notes },
    });
    document.getElementById("edit-session-modal").classList.add("hidden");
    toast("Session updated!");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

document.getElementById("delete-session-btn").addEventListener("click", async () => {
  const id = document.getElementById("edit-session-id").value;
  if (!confirm("Delete this session and all its assignments/reminders?")) return;
  try {
    await api("/api/sessions/" + id, { method: "DELETE" });
    document.getElementById("edit-session-modal").classList.add("hidden");
    toast("Session deleted");
    await loadRota();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// SCROLL REVEAL — IntersectionObserver for staggered card entry
// ---------------------------------------------------------------------------

function setupScrollReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
  );

  document.querySelectorAll(".session-card, .member-card, .day-separator").forEach((el) => {
    observer.observe(el);
  });
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

loadRota().then(() => {
  setupScrollReveal();
});
