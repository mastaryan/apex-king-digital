// Apex dashboard — Postgres migration (Phase 1).
// Loads a snapshot (live Render disk files, pulled via GET /api/admin/export
// + the cron's local hidden_files/reminders-sent.json) into the Phase 1
// tables. Repeatable: truncates the 5 Phase 1 tables and reloads, inside
// one transaction.
//
// Usage (local dev DB or any host that can reach the DB):
//   node db/migrate.js --snapshot <snapshot-dir>
// The snapshot dir must contain export.json (the /api/admin/export output)
// and cron-reminders-sent.json (copy of the cron's local state file).
// DATABASE_URL comes from the environment or .secrets.env.
//
// On Render the same migrateSnapshot() runs behind POST /api/admin/migrate
// (TEMPORARY endpoint, removed at cutover) because this box cannot open
// direct DB connections.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { sslFor } = require("./pg");

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// Merge server reminder-state mirror + cron local file.
// Cron wins for sent/to/skipped_paid on conflict; flags are unioned.
// Every conflict is reported.
function mergeReminderState(server, cron) {
  const out = {};
  const conflicts = [];
  const keys = new Set([...Object.keys(server || {}), ...Object.keys(cron || {})]);
  for (const k of keys) {
    const s = (server || {})[k] || {};
    const c = (cron || {})[k] || {};
    const m = {};
    if (c.sent !== undefined || s.sent !== undefined) m.sent = c.sent !== undefined ? c.sent : s.sent;
    if (c.to !== undefined || s.to !== undefined) m.to = c.to !== undefined ? c.to : s.to;
    if (c.skipped_paid !== undefined || s.skipped_paid !== undefined) m.skipped_paid = c.skipped_paid !== undefined ? c.skipped_paid : s.skipped_paid;
    if (c.suppressed_by_ryan || s.suppressed_by_ryan) m.suppressed_by_ryan = true;
    if (c.note !== undefined || s.note !== undefined) m.note = c.note !== undefined ? c.note : s.note;
    if (c.due !== undefined || s.due !== undefined) m.due = c.due !== undefined ? c.due : s.due;
    if (Object.keys(s).length && Object.keys(c).length && JSON.stringify(s) !== JSON.stringify(c)) {
      conflicts.push({ key: k, server: s, cron: c });
    }
    out[k] = m;
  }
  return { merged: out, conflicts };
}

async function migrateSnapshot(pool, snap) {
  const report = {
    customers: 0, sites: 0, invoices: 0, approvals: 0, approvalsDropped: [],
    reminderKeys: 0, reminderConflicts: [], attachmentsStored: 0,
    attachmentsMissing: [], customersDeduped: 0,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE invoices, reminder_state, approvals, sites, customers CASCADE");

    // Attachment bytes, keyed by file name.
    const attByFile = new Map();
    for (const a of (snap.attachments || [])) {
      const buf = Buffer.from(a.dataBase64, "base64");
      const hash = sha256(buf);
      if (a.sha256 && a.sha256 !== hash) {
        throw new Error("attachment checksum mismatch: " + a.file);
      }
      attByFile.set(a.file, { bytes: buf, sha256: hash });
    }

    // 1. Customers — one per site, deduped by email (case-insensitive).
    const siteToCustomer = {};
    const byEmail = new Map();
    for (const s of snap.sites) {
      const email = (s.clientEmail || "").trim();
      let cid;
      if (email) {
        const key = email.toLowerCase();
        if (byEmail.has(key)) {
          cid = byEmail.get(key);
          report.customersDeduped++;
        } else {
          const r = await client.query(
            "INSERT INTO customers (display_name, contact_name, email) VALUES ($1,$2,$3) RETURNING id",
            [s.name, s.contactName || null, email]);
          cid = r.rows[0].id;
          byEmail.set(key, cid);
          report.customers++;
        }
      } else {
        const r = await client.query(
          "INSERT INTO customers (display_name, contact_name, email) VALUES ($1,$2,$3) RETURNING id",
          [s.name, s.contactName || null, null]);
        cid = r.rows[0].id;
        report.customers++;
      }
      siteToCustomer[s.id] = cid;
    }

    // 2. Sites (ids verbatim) + 3. Invoices (flattened).
    for (const s of snap.sites) {
      await client.query(
        `INSERT INTO sites (id, customer_id, name, url, render_service_id,
           domain_renewal, hosting_renewal, client_email, contact_name, notes,
           invoice_gate_hold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, siteToCustomer[s.id], s.name, s.url, s.render_service_id || s.renderServiceId || null,
         s.domainRenewal || null, s.hostingRenewal || null,
         s.clientEmail || "", s.contactName || "", s.notes || "",
         !!s.invoiceGateHold]);
      report.sites++;
      for (const r of (s.invoices || [])) {
        let attBytes = null;
        let attName = r.attachmentName || null;
        if (r.attachmentFile) {
          const base = path.basename(r.attachmentFile);
          const hit = attByFile.get(base);
          if (hit) {
            attBytes = hit.bytes;
            report.attachmentsStored++;
          } else {
            report.attachmentsMissing.push({ invoice: r.id, file: base });
          }
        }
        await client.query(
          `INSERT INTO invoices (id, site_id, number, status, amount_cents, currency,
             is_test, is_auto, renewal_date, due_date, recipient, hosted_url, pdf_url,
             attachment_name, attachment, created_at, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [r.id, s.id, r.number || null, r.status,
           r.amount != null ? r.amount : 10000, r.currency || "usd",
           !!r.test, !!r.auto, r.renewalDate || null, r.dueDate || null,
           r.recipient || null, r.hostedUrl || null, r.pdfUrl || null,
           attName, attBytes,
           r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
           r.sentAt ? new Date(r.sentAt).toISOString() : null]);
        report.invoices++;
      }
    }

    // 4. Approvals — keys verbatim; drop keys whose site no longer exists.
    const siteIds = new Set(snap.sites.map(s => s.id));
    for (const [key, v] of Object.entries(snap.approvals || {})) {
      let siteId;
      if (key.startsWith("gate:")) siteId = key.split(":")[1];
      else siteId = key.split(":")[0];
      if (!siteIds.has(siteId)) {
        report.approvalsDropped.push(key);
        continue;
      }
      const kind = key.startsWith("gate:") ? "gate-send" : "reminder";
      await client.query(
        "INSERT INTO approvals (key, site_id, kind, status, updated_at) VALUES ($1,$2,$3,$4,$5)",
        [key, siteId, kind, v.status, v.updatedAt ? new Date(v.updatedAt).toISOString() : new Date().toISOString()]);
      report.approvals++;
    }

    // 5. Reminder state — merge server mirror + cron local file.
    const { merged, conflicts } = mergeReminderState(snap.reminderState, snap.cronReminderState);
    report.reminderConflicts = conflicts;
    for (const [key, v] of Object.entries(merged)) {
      const parts = key.split(":");
      const siteId = parts[0];
      const kind = parts[1] || null;
      const windowDays = parts[2] ? parseInt(parts[2], 10) : null;
      const dueDate = parts[3] || null;
      const decisionDate = v.sent || (typeof v.skipped_paid === "string" ? v.skipped_paid : null);
      await client.query(
        `INSERT INTO reminder_state (key, site_id, kind, window_days, due_date,
           sent_at, sent_to, skipped_paid, suppressed_by_ryan, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [key, siteIds.has(siteId) ? siteId : null, kind,
         Number.isFinite(windowDays) ? windowDays : null, dueDate,
         decisionDate || null, v.to || null,
         !!v.skipped_paid, !!v.suppressed_by_ryan, v.note || null]);
      report.reminderKeys++;
    }

    await client.query("COMMIT");
    return report;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- CLI ----------
async function main() {
  const args = process.argv.slice(2);
  const snapIdx = args.indexOf("--snapshot");
  if (snapIdx === -1) {
    console.error("usage: node db/migrate.js --snapshot <dir> [--remote <dashboard-url>]");
    process.exit(2);
  }
  const dir = args[snapIdx + 1];
  const exp = JSON.parse(fs.readFileSync(path.join(dir, "export.json"), "utf8"));
  let cronState = {};
  try { cronState = JSON.parse(fs.readFileSync(path.join(dir, "cron-reminders-sent.json"), "utf8")); } catch { /* optional */ }
  const snapshot = {
    sites: exp.sites, approvals: exp.approvals, reminderState: exp.reminderState,
    attachments: exp.attachments, cronReminderState: cronState,
  };

  // --remote: POST the snapshot to the dashboard's TEMPORARY
  // /api/admin/migrate endpoint (runs on Render, where the DB is
  // reachable). Used because this box cannot open direct DB connections.
  const remoteIdx = args.indexOf("--remote");
  if (remoteIdx !== -1) {
    const base = args[remoteIdx + 1].replace(/\/$/, "");
    let token = process.env.DASHBOARD_TOKEN || "";
    if (!token) {
      for (const line of fs.readFileSync(path.join(__dirname, "..", ".secrets.env"), "utf8").split("\n")) {
        if (line.startsWith("API_TOKEN=")) token = line.slice("API_TOKEN=".length);
      }
    }
    if (!token) { console.error("API_TOKEN not set"); process.exit(2); }
    const res = await fetch(base + "/api/admin/migrate", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const body = await res.text();
    console.log("HTTP", res.status);
    console.log(body.slice(0, 4000));
    if (!res.ok) process.exit(1);
    return;
  }

  let url = process.env.DATABASE_URL || "";
  if (!url) {
    try {
      for (const line of fs.readFileSync(path.join(__dirname, "..", ".secrets.env"), "utf8").split("\n")) {
        if (line.startsWith("DATABASE_URL=")) url = line.slice("DATABASE_URL=".length);
      }
    } catch { /* no local secrets file */ }
  }
  if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }
  const pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 2 });
  try {
    const report = await migrateSnapshot(pool, snapshot);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(e => { console.error("MIGRATION FAILED:", e.message); process.exit(1); });
}

module.exports = { migrateSnapshot, mergeReminderState };
