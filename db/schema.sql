-- Apex King Digital dashboard — Phase 1 Postgres schema.
-- Migrates the live file-backed state (sites, invoices, approvals,
-- reminder state) to Postgres. The HKL bridge (bridge.json) stays on disk
-- during Phase 1 and is NOT part of this schema.
-- Source of truth for the migration is the live Render disk snapshot,
-- never the repo seed (data/sites.json is the Oct 19 seed).
-- Run with: psql "$DATABASE_URL" -f db/schema.sql  (idempotent)

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

-- Customers: the CRM spine. One row per customer; sites, emails, audits,
-- bots and builds all hang off this.
CREATE TABLE IF NOT EXISTS customers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  contact_name TEXT,
  email        CITEXT,
  phone        TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_unique
  ON customers (email) WHERE email IS NOT NULL;

-- Sites: keep the existing string ids verbatim — they are embedded in
-- reminder keys, gate keys and Stripe metadata (apex_site_id).
CREATE TABLE IF NOT EXISTS sites (
  id                 TEXT PRIMARY KEY,
  customer_id        UUID REFERENCES customers(id),
  name               TEXT NOT NULL,
  url                TEXT NOT NULL,
  render_service_id  TEXT,
  domain_renewal     DATE,
  hosting_renewal    DATE,
  client_email       TEXT NOT NULL DEFAULT '',
  contact_name       TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  invoice_gate_hold  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sites_customer_id_idx ON sites (customer_id);
CREATE INDEX IF NOT EXISTS sites_domain_renewal_idx ON sites (domain_renewal);
CREATE INDEX IF NOT EXISTS sites_hosting_renewal_idx ON sites (hosting_renewal);

-- Invoices: the embedded site.invoices[] array, flattened. PK is the
-- Stripe invoice id, so the dashboard's Stripe calls need no mapping.
CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id),
  number         TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','open','paid','void','uncollectible','deleted')),
  amount_cents   INTEGER NOT NULL DEFAULT 10000,
  currency       TEXT NOT NULL DEFAULT 'usd',
  is_test        BOOLEAN NOT NULL DEFAULT FALSE,
  is_auto        BOOLEAN NOT NULL DEFAULT FALSE,
  renewal_date   DATE,
  due_date       DATE,
  recipient      TEXT,
  hosted_url     TEXT,
  pdf_url        TEXT,
  attachment_name TEXT,
  attachment     BYTEA,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invoices_site_id_idx ON invoices (site_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);
CREATE INDEX IF NOT EXISTS invoices_renewal_date_idx ON invoices (renewal_date);

-- Approvals: Upcoming-panel decisions. Key strings preserved exactly.
CREATE TABLE IF NOT EXISTS approvals (
  key        TEXT PRIMARY KEY,
  site_id    TEXT REFERENCES sites(id),
  kind       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('approved','held','cleared')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_site_id_idx ON approvals (site_id);

-- Reminder state: single canonical store, replacing BOTH
-- /data/reminders-state.json (server) and hidden_files/reminders-sent.json
-- (cron box). Key format matches approvals for reminders.
CREATE TABLE IF NOT EXISTS reminder_state (
  key                TEXT PRIMARY KEY,
  site_id            TEXT REFERENCES sites(id),
  kind               TEXT,
  window_days        INTEGER,
  due_date           DATE,
  sent_at            DATE,
  sent_to            TEXT,
  skipped_paid       BOOLEAN NOT NULL DEFAULT FALSE,
  suppressed_by_ryan BOOLEAN NOT NULL DEFAULT FALSE,
  note               TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_state_site_id_idx ON reminder_state (site_id);
