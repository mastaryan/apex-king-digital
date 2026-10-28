// Apex dashboard — Audits (Phase 2, Tracking Health Score).
// PG is the store for audits: there is no legacy file state to mirror, so
// there is no dual-write here — audits live in Postgres only. Full data
// (real domains) lives here behind Ryan's login; the public tool gets only
// a masked build-time export (see tracking-health-score/mask_data.py).
// Money flows are NOT built in this slice: charge-to-uncover, fix quotes
// and invoice-to-start plug into audits.unlock_status (see schema.sql)
// once Ryan decides prices.
"use strict";
const { getPool, pgEnabled } = require("./pg");

// Masking rule (vision doc): first 2 letters + ****** + TLD.
// brotides.com -> br******.com. Same rule as the Python generator —
// the import and the public build must agree exactly (verified).
function maskDomain(domain) {
  const d = String(domain || "");
  const i = d.lastIndexOf(".");
  if (i <= 0) return d;
  return d.slice(0, 2) + "******" + d.slice(i);
}

// Scoring rubric (same as tracking-health-score/build_data.py): base 100,
// -12 per critical, -5 per warning, info 0, floor 0. Thin audits
// (verdict starts with "thin") carry no score. Scores are COMPUTED from
// the findings, never assigned by an audit.
function scoreFor(issues, verdict) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const iss of issues || []) {
    if (counts[iss.severity] !== undefined) counts[iss.severity]++;
  }
  const thin = (verdict || "").startsWith("thin");
  if (thin) return { thin: true, score: null, label: "Limited audit", counts };
  const score = Math.max(0, 100 - 12 * counts.critical - 5 * counts.warning);
  const label = score >= 85 ? "Healthy" : score >= 70 ? "Fair" : "Needs Attention";
  return { thin: false, score, label, counts };
}

// Opaque stable ids, assigned in alphabetical domain order so the JS
// import and the Python masked-data generator agree exactly.
function auditIds(domains) {
  const sorted = [...domains].sort();
  const out = {};
  sorted.forEach((d, i) => { out[d] = "a" + String(i + 1).padStart(3, "0"); });
  return out;
}

function rowToAudit(r) {
  return {
    id: r.id, domain: r.domain, maskedDomain: r.masked_domain,
    date: r.audit_date ? r.audit_date.toISOString().slice(0, 10) : null,
    scope: r.audit_scope, verdict: r.verdict, thin: r.is_thin,
    score: r.score, label: r.label, unlockStatus: r.unlock_status,
    counts: { critical: r.critical, warning: r.warning, info: r.info },
    trackers: r.trackers,
  };
}

async function listAudits(pool, q) {
  const params = [];
  let where = "";
  if (q) {
    params.push("%" + q.replace(/[%_\\]/g, "\\$&") + "%");
    where = "WHERE a.domain ILIKE $1 OR a.masked_domain ILIKE $1";
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.domain, a.masked_domain, a.audit_date, a.audit_scope, a.verdict,
            a.is_thin, a.score, a.label, a.unlock_status,
            COUNT(f.id) FILTER (WHERE f.kind = 'issue' AND f.severity = 'critical')::int AS critical,
            COUNT(f.id) FILTER (WHERE f.kind = 'issue' AND f.severity = 'warning')::int AS warning,
            COUNT(f.id) FILTER (WHERE f.kind = 'issue' AND f.severity = 'info')::int AS info,
            COUNT(f.id) FILTER (WHERE f.kind = 'tracker')::int AS trackers
     FROM audits a LEFT JOIN audit_findings f ON f.audit_id = a.id
     ${where}
     GROUP BY a.id
     ORDER BY a.score ASC NULLS LAST, a.domain ASC`,
    params);
  return rows.map(rowToAudit);
}

async function getAudit(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, domain, masked_domain, audit_date, audit_scope, verdict,
            is_thin, score, label, unlock_status
     FROM audits WHERE id = $1`,
    [id]);
  if (!rows.length) return null;
  const a = rows[0];
  const { rows: fr } = await pool.query(
    `SELECT kind, severity, name, text FROM audit_findings
     WHERE audit_id = $1 ORDER BY sort_order`,
    [id]);
  const issues = fr.filter(r => r.kind === "issue").map(r => ({ severity: r.severity, text: r.text }));
  const trackers = fr.filter(r => r.kind === "tracker").map(r => ({ name: r.name, status: r.text }));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) if (counts[i.severity] !== undefined) counts[i.severity]++;
  return {
    id: a.id, domain: a.domain, maskedDomain: a.masked_domain,
    date: a.audit_date ? a.audit_date.toISOString().slice(0, 10) : null,
    scope: a.audit_scope, verdict: a.verdict, thin: a.is_thin,
    score: a.score, label: a.label, unlockStatus: a.unlock_status,
    counts, trackers, issues,
  };
}

function mountAudits(app, authRequired) {
  app.get("/api/audits", authRequired, async (req, res) => {
    try {
      if (!pgEnabled()) return res.status(503).json({ error: "audits unavailable (Postgres not configured)" });
      const rows = await listAudits(getPool(), (req.query.q || "").trim() || null);
      res.json({ total: rows.length, audits: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get("/api/audits/:id", authRequired, async (req, res) => {
    try {
      if (!pgEnabled()) return res.status(503).json({ error: "audits unavailable (Postgres not configured)" });
      const a = await getAudit(getPool(), req.params.id);
      if (!a) return res.status(404).json({ error: "not found" });
      res.json(a);
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { maskDomain, scoreFor, auditIds, listAudits, getAudit, mountAudits };
