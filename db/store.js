// Apex dashboard — centralized store (Phase 1).
// Replaces the three separate loadSites/saveSites copies (server.js,
// invoices.js, upcoming.js) that did whole-file read-modify-write with no
// locking. Files remain the source of truth during dual-write; when
// USE_POSTGRES=1 the PG mirror is updated after every file write. A PG
// failure is logged and swallowed — it must never break a request — and
// drift is caught by GET /api/admin/compare.
//
// File shapes are preserved exactly so API responses do not change.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPool, pgEnabled } = require("./pg");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data", "sites.json");
const SEED_FILE = path.join(__dirname, "..", "data", "sites.json");
const APPROVALS_FILE = path.join(path.dirname(DATA_FILE), "approvals.json");
const REMINDER_STATE_FILE = path.join(path.dirname(DATA_FILE), "reminders-state.json");

// ---------- files (verbatim behavior from the original modules) ----------
function loadSites() {
  if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE) && DATA_FILE !== SEED_FILE) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.copyFileSync(SEED_FILE, DATA_FILE);
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; }
}
function saveSitesFile(sites) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sites, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function loadApprovals() { const a = loadJson(APPROVALS_FILE); return a && typeof a === "object" && !Array.isArray(a) ? a : {}; }
function saveApprovalsFile(a) { saveJson(APPROVALS_FILE, a); }
function loadReminderState() { const s = loadJson(REMINDER_STATE_FILE); return s && typeof s === "object" && !Array.isArray(s) ? s : {}; }
function saveReminderStateFile(s) { saveJson(REMINDER_STATE_FILE, s); }

// ---------- PG mirrors (upsert whole state in one transaction each) ----------
function toDate(v) { return v ? v : null; } // 'YYYY-MM-DD' strings pass through

async function mirrorSites(sites) {
  // Guard: an empty sites array is never legitimate (9 live sites). If
  // the file read failed, mirroring would wipe PG — refuse instead.
  if (!sites.length) {
    console.error("pg mirrorSites skipped: empty sites array (file read failure?)");
    return;
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seenSiteIds = new Set();
    for (const s of sites) {
      seenSiteIds.add(s.id);
      await client.query(
        `INSERT INTO sites (id, customer_id, name, url, render_service_id,
           domain_renewal, hosting_renewal, client_email, contact_name, notes,
           invoice_gate_hold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           -- customer_id is NOT in the file record: preserve the value
           -- set by the migration (COALESCE keeps the existing row value
           -- when the incoming value is NULL).
           customer_id = COALESCE(EXCLUDED.customer_id, sites.customer_id),
           name = EXCLUDED.name,
           url = EXCLUDED.url, render_service_id = EXCLUDED.render_service_id,
           domain_renewal = EXCLUDED.domain_renewal,
           hosting_renewal = EXCLUDED.hosting_renewal,
           client_email = EXCLUDED.client_email,
           contact_name = EXCLUDED.contact_name, notes = EXCLUDED.notes,
           invoice_gate_hold = EXCLUDED.invoice_gate_hold,
           updated_at = now()`,
        [s.id, s.customer_id || null, s.name, s.url, s.renderServiceId || null,
         toDate(s.domainRenewal), toDate(s.hostingRenewal),
         s.clientEmail || "", s.contactName || "", s.notes || "",
         !!s.invoiceGateHold]);
      // Invoices for this site: upsert each, then drop rows no longer present.
      const seenInvIds = new Set();
      for (const r of (s.invoices || [])) {
        seenInvIds.add(r.id);
        // Attachment bytes come from the Render disk file. If the file is
        // unreadable but the record still names an attachment, PRESERVE
        // the bytes already in PG (attMissing) instead of wiping them —
        // a missing disk file must not destroy the stored copy.
        let attBytes = null, attMissing = false;
        if (r.attachmentFile) {
          try { attBytes = fs.readFileSync(r.attachmentFile); }
          catch { attBytes = null; attMissing = !!r.attachmentName; }
        }
        await client.query(
          `INSERT INTO invoices (id, site_id, number, status, amount_cents, currency,
             is_test, is_auto, renewal_date, due_date, recipient, hosted_url, pdf_url,
             attachment_name, attachment, created_at, sent_at, last_refreshed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
           ON CONFLICT (id) DO UPDATE SET
             site_id = EXCLUDED.site_id, number = EXCLUDED.number,
             status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents,
             currency = EXCLUDED.currency, is_test = EXCLUDED.is_test,
             is_auto = EXCLUDED.is_auto, renewal_date = EXCLUDED.renewal_date,
             due_date = EXCLUDED.due_date, recipient = EXCLUDED.recipient,
             hosted_url = EXCLUDED.hosted_url, pdf_url = EXCLUDED.pdf_url,
             attachment_name = EXCLUDED.attachment_name,
             attachment = CASE WHEN $18 THEN invoices.attachment ELSE EXCLUDED.attachment END,
             sent_at = EXCLUDED.sent_at,
             last_refreshed_at = now()`,
          [r.id, s.id, r.number || null, r.status,
           r.amount != null ? r.amount : 10000, r.currency || "usd",
           !!r.test, !!r.auto, toDate(r.renewalDate), toDate(r.dueDate),
           r.recipient || null, r.hostedUrl || null, r.pdfUrl || null,
           r.attachmentName || null, attBytes,
           r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
           r.sentAt ? new Date(r.sentAt).toISOString() : null, attMissing]);
      }
      await client.query(
        "DELETE FROM invoices WHERE site_id = $1 AND NOT (id = ANY($2))",
        [s.id, [...seenInvIds]]);
    }
    // Sites deleted from the file go away in PG too (with their invoices).
    await client.query(
      "DELETE FROM sites WHERE NOT (id = ANY($1))",
      [[...seenSiteIds]]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function mirrorApprovals(approvals) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM approvals");
    // Approvals for sites that no longer exist (stale ZZ test keys) would
    // violate the site FK and roll back the whole mirror — skip them so
    // one stale key can't poison legitimate approvals.
    const { rows: siteRows } = await client.query("SELECT id FROM sites");
    const siteIds = new Set(siteRows.map(r => r.id));
    for (const [key, v] of Object.entries(approvals)) {
      const siteId = key.split(":")[0].startsWith("gate:") ? key.split(":")[1] : key.split(":")[0];
      if (!siteIds.has(siteId)) { console.error("pg mirrorApprovals skipping stale key (site gone):", key); continue; }
      const kind = key.startsWith("gate:") ? "gate-send" : "reminder";
      await client.query(
        `INSERT INTO approvals (key, site_id, kind, status, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
        [key, siteId || null, kind, v.status, v.updatedAt ? new Date(v.updatedAt).toISOString() : new Date().toISOString()]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function mirrorReminderState(state) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM reminder_state");
    // Same stale-site skip as mirrorApprovals (FK on site_id).
    const { rows: siteRows } = await client.query("SELECT id FROM sites");
    const siteIds = new Set(siteRows.map(r => r.id));
    for (const [key, v] of Object.entries(state)) {
      const parts = key.split(":");
      const siteId = parts[0];
      if (!siteIds.has(siteId)) { console.error("pg mirrorReminderState skipping stale key (site gone):", key); continue; }
      const kind = parts[1] || null;
      const windowDays = parts[2] ? parseInt(parts[2], 10) : null;
      const dueDate = parts[3] || null;
      // File format: sent entries carry {sent: 'YYYY-MM-DD', to};
      // skipped-paid entries carry {skipped_paid: 'YYYY-MM-DD', due} with
      // NO sent field. sent_at records whichever decision date exists.
      const decisionDate = v.sent || (typeof v.skipped_paid === "string" ? v.skipped_paid : null);
      await client.query(
        `INSERT INTO reminder_state (key, site_id, kind, window_days, due_date,
           sent_at, sent_to, skipped_paid, suppressed_by_ryan, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (key) DO UPDATE SET
           sent_at = EXCLUDED.sent_at, sent_to = EXCLUDED.sent_to,
           skipped_paid = EXCLUDED.skipped_paid,
           suppressed_by_ryan = EXCLUDED.suppressed_by_ryan,
           note = EXCLUDED.note, updated_at = now()`,
        [key, siteId, kind, Number.isFinite(windowDays) ? windowDays : null,
         dueDate, decisionDate || null,
         v.to || null, !!v.skipped_paid, !!v.suppressed_by_ryan, v.note || null]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- public API: file-first, PG mirror when enabled ----------
// PG failures are logged and swallowed: files are the source of truth
// during dual-write. Callers await these so mirrors complete before any
// subsequent compare; a slow PG adds one round-trip, never an error.
async function saveSites(sites) {
  saveSitesFile(sites);
  if (pgEnabled()) {
    try { await mirrorSites(sites); }
    catch (e) { console.error("pg mirrorSites failed (file write kept):", e.message); }
  }
}
async function saveApprovals(a) {
  saveApprovalsFile(a);
  if (pgEnabled()) {
    try { await mirrorApprovals(a); }
    catch (e) { console.error("pg mirrorApprovals failed (file write kept):", e.message); }
  }
}
async function saveReminderState(s) {
  saveReminderStateFile(s);
  if (pgEnabled()) {
    try { await mirrorReminderState(s); }
    catch (e) { console.error("pg mirrorReminderState failed (file write kept):", e.message); }
  }
}

// ---------- PG readers (for /api/admin/compare + migration checks) ----------
// Return file-shaped data so the compare can diff field-for-field.
// Invoice records carry attachmentBytes (Buffer|null) instead of
// attachmentFile (disk path); the compare hashes bytes on both sides.
async function loadSitesPg() {
  const pool = getPool();
  const { rows: siteRows } = await pool.query("SELECT * FROM sites ORDER BY id");
  const { rows: invRows } = await pool.query("SELECT * FROM invoices ORDER BY site_id, created_at DESC NULLS LAST, id");
  const bySite = {};
  for (const r of invRows) {
    (bySite[r.site_id] = bySite[r.site_id] || []).push({
      id: r.id, number: r.number, status: r.status,
      amount: r.amount_cents, currency: r.currency,
      test: r.is_test, auto: r.is_auto,
      renewalDate: r.renewal_date ? r.renewal_date.toISOString().slice(0, 10) : null,
      dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
      createdAt: r.created_at ? r.created_at.toISOString() : null,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      hostedUrl: r.hosted_url, pdfUrl: r.pdf_url,
      recipient: r.recipient, attachmentName: r.attachment_name,
      attachmentBytes: r.attachment || null,
    });
  }
  return siteRows.map(s => ({
    id: s.id, name: s.name, url: s.url, renderServiceId: s.render_service_id,
    domainRenewal: s.domain_renewal ? s.domain_renewal.toISOString().slice(0, 10) : null,
    hostingRenewal: s.hosting_renewal ? s.hosting_renewal.toISOString().slice(0, 10) : null,
    clientEmail: s.client_email,
    // File records omit contactName entirely when unset (the field was
    // added after the seed); PG stores "". Omit the key to keep the API
    // response shape identical to the file-backed one.
    contactName: s.contact_name || undefined,
    notes: s.notes,
    invoiceGateHold: s.invoice_gate_hold,
    invoices: bySite[s.id] || [],
  }));
}
async function loadApprovalsPg() {
  const pool = getPool();
  const { rows } = await pool.query("SELECT key, status, updated_at FROM approvals");
  const out = {};
  for (const r of rows) out[r.key] = { status: r.status, updatedAt: r.updated_at ? r.updated_at.toISOString() : null };
  return out;
}
async function loadReminderStatePg() {
  const pool = getPool();
  const { rows } = await pool.query("SELECT * FROM reminder_state");
  const out = {};
  for (const r of rows) {
    const e = {};
    // File format: sent entries carry {sent, to}; skipped-paid entries
    // carry {skipped_paid: date} with NO sent field. Reconstruct exactly.
    if (r.skipped_paid) {
      e.skipped_paid = r.sent_at ? r.sent_at.toISOString().slice(0, 10) : true;
    } else if (r.sent_at) {
      e.sent = r.sent_at.toISOString().slice(0, 10);
    }
    if (r.sent_to) e.to = r.sent_to;
    if (r.suppressed_by_ryan) e.suppressed_by_ryan = true;
    if (r.note) e.note = r.note;
    // "due" is NOT reconstructed: it is redundant with the key (which
    // carries the due date) and file entries only sometimes include it.
    // The compare normalizes it away on both sides.
    out[r.key] = e;
  }
  return out;
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

module.exports = {
  DATA_FILE, APPROVALS_FILE, REMINDER_STATE_FILE,
  loadSites, saveSites, loadApprovals, saveApprovals,
  loadReminderState, saveReminderState,
  loadSitesPg, loadApprovalsPg, loadReminderStatePg,
  mirrorSites, mirrorApprovals, mirrorReminderState, sha256,
};
