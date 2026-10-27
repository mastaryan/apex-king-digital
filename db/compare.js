// Apex dashboard — file vs Postgres comparison (Phase 1, TEMPORARY).
// Powers GET /api/admin/compare during dual-write verification. Compares
// the file state (source of truth) against the PG mirror field-for-field
// and reports every divergence. Removed at cutover along with the other
// /api/admin/* endpoints.
"use strict";
const fs = require("fs");
const store = require("./store");

function normSite(s) {
  return {
    id: s.id, name: s.name, url: s.url,
    renderServiceId: s.renderServiceId || null,
    domainRenewal: s.domainRenewal || null,
    hostingRenewal: s.hostingRenewal || null,
    clientEmail: s.clientEmail || "", contactName: s.contactName || "",
    notes: s.notes || "", invoiceGateHold: !!s.invoiceGateHold,
  };
}
function attShaFile(rec, snapshotShas) {
  if (!rec.attachmentFile) return null;
  try { return store.sha256(fs.readFileSync(rec.attachmentFile)); }
  catch {
    // Local verification: the attachment bytes live on the Render disk,
    // not here. The snapshot's export carries the authoritative sha256
    // for each attachment file — use it as the file-side truth.
    const base = rec.attachmentFile.split("/").pop();
    if (snapshotShas && snapshotShas[base]) return snapshotShas[base];
    return "MISSING-FILE:" + rec.attachmentFile;
  }
}
function attShaPg(rec) {
  if (!rec.attachmentBytes) return null;
  return store.sha256(rec.attachmentBytes);
}
function normInvoice(r, attSha) {
  return {
    id: r.id, number: r.number || null, status: r.status,
    amount: r.amount != null ? r.amount : 10000, currency: r.currency || "usd",
    test: !!r.test, auto: !!r.auto,
    renewalDate: r.renewalDate || null, dueDate: r.dueDate || null,
    recipient: r.recipient || null, hostedUrl: r.hostedUrl || null,
    pdfUrl: r.pdfUrl || null, attachmentName: r.attachmentName || null,
    attachmentSha256: attSha,
  };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// opts: { snapshotShas?: {filename: sha256}, expectedDrops?: Set<string> }
// snapshotShas: attachment sha256s from the migration snapshot export
// (used when the disk file is not on this box). expectedDrops: approval
// keys intentionally dropped by the migration (stale ZZ test keys) —
// reported as expected, not as divergences.
async function compareState(opts = {}) {
  const snapshotShas = opts.snapshotShas || null;
  const expectedDrops = opts.expectedDrops || new Set();
  const diffs = [];
  // --- sites + invoices ---
  const fileSites = store.loadSites();
  let pgSites;
  try {
    pgSites = await store.loadSitesPg();
  } catch (e) {
    return { match: false, diffs: [{ where: "pg", error: "could not read PG state: " + e.message }] };
  }
  const pgById = new Map(pgSites.map(s => [s.id, s]));
  const fileIds = new Set();
  for (const s of fileSites) {
    fileIds.add(s.id);
    const p = pgById.get(s.id);
    if (!p) { diffs.push({ where: "sites." + s.id, file: "present", pg: "missing" }); continue; }
    if (!same(normSite(s), normSite(p))) {
      diffs.push({ where: "sites." + s.id, file: normSite(s), pg: normSite(p) });
    }
    const fileInvs = new Map((s.invoices || []).map(r => [r.id, r]));
    const pgInvs = new Map((p.invoices || []).map(r => [r.id, r]));
    for (const [id, r] of fileInvs) {
      const pr = pgInvs.get(id);
      if (!pr) { diffs.push({ where: "invoices." + id, file: "present", pg: "missing" }); continue; }
      const f = normInvoice(r, attShaFile(r, snapshotShas));
      const g = normInvoice(pr, attShaPg(pr));
      // createdAt/sentAt are not compared: PG stores them as timestamptz
      // and the mirror may normalize formatting; status/amount/dates are
      // the fields that matter. (sentAt is compared as a date below.)
      if (!same(f, g)) diffs.push({ where: "invoices." + id, file: f, pg: g });
      const fSent = r.sentAt ? new Date(r.sentAt).toISOString().slice(0, 10) : null;
      const gSent = pr.sentAt ? new Date(pr.sentAt).toISOString().slice(0, 10) : null;
      if (fSent !== gSent) diffs.push({ where: "invoices." + id + ".sentAt", file: fSent, pg: gSent });
    }
    for (const id of pgInvs.keys()) {
      if (!fileInvs.has(id)) diffs.push({ where: "invoices." + id, file: "missing", pg: "present" });
    }
  }
  for (const s of pgSites) {
    if (!fileIds.has(s.id)) diffs.push({ where: "sites." + s.id, file: "missing", pg: "present" });
  }
  // --- approvals (status only; updatedAt compared as epoch ms) ---
  const fileAppr = store.loadApprovals();
  const pgAppr = await store.loadApprovalsPg();
  for (const [k, v] of Object.entries(fileAppr)) {
    const p = pgAppr[k];
    if (!p) {
      if (expectedDrops.has(k)) continue;  // intentionally dropped by migration
      diffs.push({ where: "approvals." + k, file: "present", pg: "missing" }); continue;
    }
    if (p.status !== v.status) diffs.push({ where: "approvals." + k + ".status", file: v.status, pg: p.status });
    const fT = v.updatedAt ? Date.parse(v.updatedAt) : null;
    const pT = p.updatedAt ? Date.parse(p.updatedAt) : null;
    if (fT !== pT) diffs.push({ where: "approvals." + k + ".updatedAt", file: v.updatedAt, pg: p.updatedAt });
  }
  for (const k of Object.keys(pgAppr)) {
    if (!fileAppr[k]) diffs.push({ where: "approvals." + k, file: "missing", pg: "present" });
  }
  // --- reminder state ("due" normalized away; it is redundant with the key) ---
  const normRs = (m) => {
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      const e = { ...v };
      delete e.due;
      out[k] = e;
    }
    return out;
  };
  const fileRs = normRs(store.loadReminderState());
  const pgRs = normRs(await store.loadReminderStatePg());
  for (const [k, v] of Object.entries(fileRs)) {
    if (!pgRs[k]) { diffs.push({ where: "reminder_state." + k, file: "present", pg: "missing" }); continue; }
    if (!same(v, pgRs[k])) diffs.push({ where: "reminder_state." + k, file: v, pg: pgRs[k] });
  }
  for (const k of Object.keys(pgRs)) {
    if (!fileRs[k]) diffs.push({ where: "reminder_state." + k, file: "missing", pg: "present" });
  }
  return { match: diffs.length === 0, diffs: diffs.slice(0, 50), totalDiffs: diffs.length };
}

module.exports = { compareState };
