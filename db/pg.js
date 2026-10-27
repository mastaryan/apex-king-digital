// Apex dashboard — Postgres pool helper (Phase 1).
// The dashboard service reaches the DB over Render's private network
// (internal connection string, no SSL needed). Anything connecting from
// outside Render (e.g. a migration script on another host) uses the
// external connection string, which requires SSL.
// This box cannot open direct DB connections (Muse permission: databases
// Deny) — DB-touching code runs ON the Render service, or against a local
// Postgres during development.
"use strict";
const { Pool } = require("pg");

let pool = null;

function sslFor(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    // Render external endpoints live under *.render.com and require SSL.
    if (host.endsWith(".render.com")) return { rejectUnauthorized: false };
  } catch { /* fall through */ }
  return false; // localhost + Render internal bare hostnames: plain
}

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL not set");
  pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 5 });
  pool.on("error", (e) => console.error("pg pool error:", e.message));
  return pool;
}

// Dual-write is ON only when explicitly flagged. Files remain the source
// of truth until cutover (Ryan confirms); a PG failure must never break
// a user-facing request.
function pgEnabled() {
  return process.env.USE_POSTGRES === "1" && !!process.env.DATABASE_URL;
}

async function closePool() {
  if (pool) { const p = pool; pool = null; await p.end().catch(() => {}); }
}

module.exports = { getPool, pgEnabled, closePool, sslFor };
