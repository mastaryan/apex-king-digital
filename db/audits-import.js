// Apex dashboard — Audits import (Phase 2).
// Loads audits.json (the canonical manual-audit source) into the audits +
// audit_findings tables. Repeatable: truncates both tables and reloads in
// one transaction. No customer records are invented; audits carry no
// customer/site link (audits.customer_id does not exist).
//
// Usage (local dev DB or any host that can reach the DB):
//   node db/audits-import.js --file <audits.json>
//   node db/audits-import.js --file <audits.json> --remote <dashboard-url>
// --remote POSTs to the dashboard's TEMPORARY /api/admin/audits/import
// endpoint (runs on Render, where the DB is reachable) because this box
// cannot open direct DB connections. API_TOKEN from env or .secrets.env.
// NOTE: the endpoint was removed from server.js after the one-time import
// on 2026-10-27 — re-add the route to use --remote again.
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { sslFor } = require("./pg");
const { maskDomain, scoreFor, auditIds } = require("./audits");

async function importAudits(pool, audits) {
  if (!Array.isArray(audits) || !audits.length) throw new Error("audits array required");
  const domains = audits.map(a => a.domain);
  if (new Set(domains).size !== domains.length) throw new Error("duplicate domains in import");
  const ids = auditIds(domains);
  const report = { audits: 0, findings: 0, issues: 0, trackers: 0, scored: 0, thin: 0, spotChecks: {} };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE audit_findings, audits CASCADE");
    for (const s of audits) {
      const { thin, score, label } = scoreFor(s.issues, s.verdict);
      const id = ids[s.domain];
      await client.query(
        `INSERT INTO audits (id, domain, masked_domain, audit_date, audit_scope, verdict, is_thin, score, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, s.domain, maskDomain(s.domain), s.date || null, s.audit_scope || null,
         s.verdict || null, thin, score, label]);
      report.audits++;
      if (thin) report.thin++; else report.scored++;
      let order = 0;
      for (const iss of (s.issues || [])) {
        await client.query(
          "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'issue',$2,NULL,$3,$4)",
          [id, iss.severity, iss.text, order++]);
        report.issues++; report.findings++;
      }
      for (const t of (s.trackers || [])) {
        await client.query(
          "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'tracker',NULL,$2,$3,$4)",
          [id, t.name, t.status, order++]);
        report.trackers++; report.findings++;
      }
    }
    // Spot-checks (expected values from the verified source data).
    const { rows } = await client.query(
      "SELECT domain, score FROM audits WHERE domain IN ('oneaminos.com','saltydogresearch.com','biolongevitylabs.com')");
    for (const r of rows) report.spotChecks[r.domain] = r.score;
    await client.query("COMMIT");
    return report;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx === -1) { console.error("usage: node db/audits-import.js --file <audits.json> [--remote <dashboard-url>]"); process.exit(2); }
  const audits = JSON.parse(fs.readFileSync(args[fileIdx + 1], "utf8"));
  const remoteIdx = args.indexOf("--remote");
  if (remoteIdx !== -1) {
    const base = args[remoteIdx + 1].replace(/\/$/, "");
    let token = process.env.DASHBOARD_TOKEN || "";
    if (!token) {
      for (const line of fs.readFileSync(path.join(__dirname, "..", ".secrets.env"), "utf8").split("\n")) {
        if (line.startsWith("API_TOKEN=")) token = line.slice("API_TOKEN=".length).trim();
      }
    }
    if (!token) { console.error("API_TOKEN not set"); process.exit(2); }
    const res = await fetch(base + "/api/admin/audits/import", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ audits }),
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
        if (line.startsWith("DATABASE_URL=")) url = line.slice("DATABASE_URL=".length).trim();
      }
    } catch { /* no local secrets file */ }
  }
  if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }
  const pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 2 });
  try {
    // Schema first (idempotent — includes the Phase 2 audits tables).
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(schema);
    const report = await importAudits(pool, audits);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(e => { console.error("AUDITS IMPORT FAILED:", e.message); process.exit(1); });
}

module.exports = { importAudits };
