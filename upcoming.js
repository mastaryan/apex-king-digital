// Apex King Digital — Upcoming / To-Do panel backend.
//
// One scheduled action = one row. Nothing client-facing fires without
// Ryan's approval:
//   approve = the row fires ON its scheduled date, as-is (or at once on
//             the next cron run if its date already passed);
//   no approval = never fires;
//   hold = the row stays in "Needs follow-up" until Ryan deals with it;
//   clear = that occurrence never fires, recorded here (not deleted).
// Draft creation at 45 days out + the nudge email to Ryan stay AUTOMATIC
// (no client-facing effect) — the draft is what puts the row in front of
// him. The old 30-day gate auto-send is REMOVED by this design.
//
// Row keys (must match the cron's existing state exactly):
//   reminder:   <siteId>:domainRenewal|hostingRenewal:<days>:<dueDate>
//   gate send:  gate:<siteId>:<year>:send
//   gate draft: gate:<siteId>:<year>:draft  (informational — drafts stay automatic)
//   anchor:     anchor:<siteId>:<kind>:<dueDate>
"use strict";
const fs = require("fs");
const path = require("path");

// ---------- stores (centralized: db/store.js) ----------
// Files are the source of truth during dual-write; the PG mirror updates
// after every file write when USE_POSTGRES=1.
const store = require("./db/store");
const loadSites = store.loadSites;
const saveSites = store.saveSites;
const loadApprovals = store.loadApprovals;
const saveApprovals = store.saveApprovals;
const loadReminderState = store.loadReminderState;
const saveReminderState = store.saveReminderState;
const WINDOW_DAYS = 45;
const REMINDER_WINDOWS = [30, 15, 7, 1];
const RYAN_EMAIL = "info@helixkinglabs.com";

function parseDay(iso) { const d = new Date(iso + "T00:00:00"); return isNaN(d) ? null : d; }
function todayDay() { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }
function isoDay(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}
function kindLabel(kind) { return kind === "domainRenewal" ? "domain" : "hosting"; }

function invoicesForYear(site, year) {
  return (site.invoices || []).filter(r => !r.test && r.renewalDate && r.renewalDate.slice(0, 4) === year && r.status !== "deleted");
}

// Paid renewal (Ryan 2026-10-27): a real (non-test) invoice for this exact
// renewal date shows paid in Stripe. Same rule as the reminders.py
// paid-check. When true, the renewal's remaining panel rows are dropped
// (below) — the gate-send row already flips to "done" on its own and stays.
function isPaidRenewal(site, ds) {
  return (site.invoices || []).some(r => !r.test && r.status === "paid" && r.renewalDate === ds);
}

function reminderStatus(key, approval, entry, daysToRenewal, fireDate, today) {
  if (entry && entry.skipped_paid) return "skipped_paid";
  if (entry && entry.suppressed_by_ryan) return "suppressed";
  if (entry && entry.sent) return "sent";
  if (approval === "cleared") return "cleared";
  if (approval === "held") return "held";
  if (daysToRenewal < 0) return "expired";
  if (approval === "approved") return "approved";
  if (fireDate < today) return "overdue";
  return "scheduled";
}

function gateSendStatus(approval, draftExists, sentExists, daysToRenewal, fireDate, today) {
  if (sentExists) return "done";
  if (approval === "cleared") return "cleared";
  if (approval === "held") return "held";
  if (daysToRenewal < -7) return "expired";
  if (approval === "approved") return "approved";
  if (draftExists) return "draft-ready";
  if (fireDate < today) return "overdue";
  return "scheduled";
}

function gateDraftStatus(invs, daysToRenewal) {
  if (invs.length) return "done";
  if (daysToRenewal < -7) return "expired";
  return "scheduled";
}

function includeRow(row, today) {
  const d = parseDay(row.date);
  if (!d) return false;
  const horizon = addDays(today, WINDOW_DAYS);
  if (d >= today && d <= horizon) return true;
  if (d < today && (row.status === "overdue" || row.status === "held" || row.status === "approved")) return true;
  if (d < today && d >= addDays(today, -7) && ["sent", "skipped_paid", "done", "cleared", "suppressed"].includes(row.status)) return true;
  return false;
}

const TYPE_RANK = { reminder: 0, "gate-send": 1, "gate-draft": 2, anchor: 3 };

function buildRows(sites, approvals, reminderState, today) {
  today = today || todayDay();
  const rows = [];
  for (const site of sites) {
    for (const kind of ["domainRenewal", "hostingRenewal"]) {
      const ds = site[kind];
      if (!ds) continue;
      const due = parseDay(ds);
      if (!due) continue;
      const daysToRenewal = daysBetween(today, due);
      const year = ds.slice(0, 4);
      const hasEmail = !!(site.clientEmail || "").trim();
      const siteHeld = !!site.invoiceGateHold;
      const invs = invoicesForYear(site, year);
      const draftExists = invs.some(r => r.status === "draft");
      const sentExists = invs.some(r => ["open", "paid", "uncollectible", "void"].includes(r.status));
      const paid = isPaidRenewal(site, ds);

      // Reminder rows — exist regardless of clientEmail (they fall back to Ryan).
      // Paid renewal: no reminder rows — the renewal is done, nothing left to send.
      if (!paid) for (const w of REMINDER_WINDOWS) {
        const fireDate = addDays(due, -w);
        const key = site.id + ":" + kind + ":" + w + ":" + ds;
        const approval = approvals[key] && approvals[key].status;
        const entry = reminderState[key];
        const status = reminderStatus(key, approval, entry, daysToRenewal, fireDate, today);
        const recipient = hasEmail ? site.clientEmail : "Ryan (" + RYAN_EMAIL + ")";
        rows.push({
          key, type: "reminder", date: isoDay(fireDate), siteId: site.id, siteName: site.name,
          kind, renewalDate: ds, days: w, recipient,
          title: "Reminder email — " + site.name + " " + kindLabel(kind) + " renewal in " + w + "d",
          detail: "To " + recipient + " · renewal " + fmtDate(ds) + " (" + daysToRenewal + "d out)",
          status, approval: approval || null, siteHeld,
          overdue: status === "overdue" || (status === "approved" && fireDate < today),
          actionable: ["scheduled", "overdue", "approved", "held"].includes(status),
        });
      }

      // Gate rows — only when the gate can run: clientEmail set, site not held.
      // Paid renewal: the draft row goes too; the send row stays ONLY as its
      // existing "done" state (it already flips to done once paid).
      if (hasEmail && !siteHeld) {
        const draftDate = addDays(due, -45);
        const draftKey = "gate:" + site.id + ":" + year + ":draft";
        if (!paid) rows.push({
          key: draftKey, type: "gate-draft", date: isoDay(draftDate), siteId: site.id, siteName: site.name,
          kind, renewalDate: ds, days: null, recipient: site.clientEmail,
          title: "Draft $100 renewal invoice — " + site.name,
          detail: "Auto-created at 45 days out · review in the site's invoice list",
          status: gateDraftStatus(invs, daysToRenewal), approval: null, siteHeld,
          overdue: false, actionable: false,
        });
        const sendDate = addDays(due, -30);
        const sendKey = "gate:" + site.id + ":" + year + ":send";
        const sendApproval = approvals[sendKey] && approvals[sendKey].status;
        const sendStatus = gateSendStatus(sendApproval, draftExists, sentExists, daysToRenewal, sendDate, today);
        if (!paid || sendStatus === "done") rows.push({
          key: sendKey, type: "gate-send", date: isoDay(sendDate), siteId: site.id, siteName: site.name,
          kind, renewalDate: ds, days: null, recipient: site.clientEmail,
          title: "Send $100 renewal invoice — " + site.name,
          detail: "To " + site.clientEmail + " · due " + fmtDate(ds) + " · $100",
          status: sendStatus, approval: sendApproval || null, siteHeld,
          overdue: sendStatus === "overdue" || (sendStatus === "approved" && sendDate < today),
          actionable: ["scheduled", "overdue", "approved", "held", "draft-ready"].includes(sendStatus),
        });
      }

      // Renewal anchor row. Paid renewal: no anchor — nothing left to track.
      if (!paid) rows.push({
        key: "anchor:" + site.id + ":" + kind + ":" + ds, type: "anchor", date: ds,
        siteId: site.id, siteName: site.name, kind, renewalDate: ds, days: null,
        recipient: "", title: site.name + " " + kindLabel(kind) + " renews",
        detail: "Renewal due " + fmtDate(ds) + (daysToRenewal < 0 ? " (" + Math.abs(daysToRenewal) + "d ago)" : " (" + daysToRenewal + "d out)"),
        status: "anchor", approval: null, siteHeld,
        overdue: daysToRenewal < 0, actionable: false,
      });
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (TYPE_RANK[a.type] - TYPE_RANK[b.type])));
  return rows;
}

function computeRows(sites, approvals, reminderState, today) {
  today = today || todayDay();
  const all = buildRows(sites, approvals, reminderState, today);
  // Keep: in-window rows, overdue/held/approved rows (until resolved),
  // recently-done rows (last 7 days), and anchors for any kept renewal.
  const kept = all.filter(r => r.type === "anchor" ? false : includeRow(r, today));
  const keptRenewals = new Set(kept.map(r => r.siteId + "|" + r.kind + "|" + r.renewalDate));
  const horizon = addDays(today, WINDOW_DAYS);
  for (const r of all) {
    if (r.type !== "anchor") continue;
    const d = parseDay(r.date);
    if ((d >= addDays(today, -7) && d <= horizon) || keptRenewals.has(r.siteId + "|" + r.kind + "|" + r.renewalDate)) kept.push(r);
  }
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (TYPE_RANK[a.type] - TYPE_RANK[b.type])));
  return kept;
}

function mountUpcoming(app, authRequired) {
  // Refresh stored invoice statuses from Stripe before computing rows, so a
  // payment shows up the moment Ryan opens the panel instead of waiting for
  // the next cron refresh. Lazy require: invoices.js requires this module at
  // top level, so a top-level require here would be a cycle.
  async function refreshAllInvoices(sites) {
    const { refreshSiteInvoices } = require("./invoices");
    let changed = false;
    for (const site of sites) {
      if (await refreshSiteInvoices(site)) changed = true;
    }
    if (changed) await saveSites(sites);
    return sites;
  }

  app.get("/api/upcoming", authRequired, async (req, res) => {
    const sites = await refreshAllInvoices(loadSites());
    res.json({
      today: isoDay(todayDay()),
      windowDays: WINDOW_DAYS,
      rows: computeRows(sites, loadApprovals(), loadReminderState()),
    });
  });

  app.get("/api/approvals", authRequired, (req, res) => {
    res.json(loadApprovals());
  });

  app.post("/api/reminders-state", authRequired, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "state object required" });
    }
    if (JSON.stringify(body).length > 1000000) {
      return res.status(400).json({ error: "state too large" });
    }
    await saveReminderState(body);
    res.json({ ok: true, keys: Object.keys(body).length });
  });

  app.post("/api/upcoming/action", authRequired, async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || "");
    const action = String(b.action || "");
    if (!["approve", "hold", "clear"].includes(action)) {
      return res.status(400).json({ error: "action must be approve, hold, or clear" });
    }
    const sites = loadSites();
    await refreshAllInvoices(sites);
    const approvals = loadApprovals();
    const reminderState = loadReminderState();
    const rows = computeRows(sites, approvals, reminderState);
    const row = rows.find(r => r.key === key);
    if (!row) return res.status(404).json({ error: "row not found (it may be outside the 45-day window or already resolved)" });
    if (!row.actionable) return res.status(400).json({ error: "this row cannot be " + action + "d (status: " + row.status + ")" });
    const site = sites.find(s => s.id === row.siteId);
    if (row.type === "gate-send" && site && site.invoiceGateHold) {
      return res.status(400).json({ error: "invoice automation is held for this site — lift the hold first" });
    }
    const status = action === "approve" ? "approved" : action === "hold" ? "held" : "cleared";
    approvals[key] = { status, updatedAt: new Date().toISOString() };
    await saveApprovals(approvals);
    const updated = buildRows(sites, approvals, reminderState).find(r => r.key === key);
    res.json({ ok: true, row: updated || row });
  });
}

module.exports = {
  mountUpcoming, computeRows, buildRows, loadApprovals, saveApprovals,
  loadReminderState, saveReminderState, loadSites, WINDOW_DAYS, REMINDER_WINDOWS,
};
