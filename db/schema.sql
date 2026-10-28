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

-- ---------- Phase 2 — Audits (Tracking Health Score) ----------
-- Audited vendors are NOT customers: no invented customer records, no
-- link to customers/sites unless a real link exists. Full data (real
-- domains) lives here, behind Ryan's login; the public tool gets only a
-- masked build-time export (see tracking-health-score/mask_data.py).
CREATE TABLE IF NOT EXISTS audits (
  id            TEXT PRIMARY KEY,  -- opaque id, e.g. 'a001' — stable across rebuilds; also the public tool's selection key (masked domains collide: bi******.com x3, pe******.com x4)
  domain        CITEXT NOT NULL,
  masked_domain TEXT NOT NULL,
  audit_date    DATE,
  audit_scope   TEXT,
  verdict       TEXT,
  is_thin       BOOLEAN NOT NULL DEFAULT FALSE,
  score         INTEGER,           -- NULL when thin (limited audit)
  label         TEXT NOT NULL,     -- Healthy | Fair | Needs Attention | Limited audit
  -- Money-flow placeholder (NOT built — needs Ryan's pricing calls):
  -- charge-to-uncover / fix quotes / invoice-to-start plug in here.
  unlock_status TEXT NOT NULL DEFAULT 'listed'
                CHECK (unlock_status IN ('listed','locked','unlocked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audits_domain_unique ON audits (domain);
CREATE INDEX IF NOT EXISTS audits_score_idx ON audits (score);

CREATE TABLE IF NOT EXISTS audit_findings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id   TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('issue','tracker')),
  severity   TEXT,              -- issues: critical|warning|info; trackers: NULL
  name       TEXT,              -- tracker name; NULL for issues
  text       TEXT NOT NULL,     -- issue text, or tracker status string
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS audit_findings_audit_id_idx ON audit_findings (audit_id);

-- ---------- Phase 2 — Money flows (audit/guide/fix billing) ----------
-- Unlock lifecycle (replaces the foundation placeholder states
-- 'locked'/'unlocked', which were never used):
--   listed       — no purchase yet; the audit is the public sample listing
--   audit_paid   — $25 audit paid (the uncover: paying shows the buyer
--                   their full audit)
--   guide_paid   — $25 fix guide paid after the audit (no retroactive
--                   bundle discount: audit-first buyers pay the full $25)
--   bundle_paid  — $40 audit + fix guide bundle paid upfront
-- Guide and fix pipelines have their own status columns so a purchase,
-- a guide delivery and a fix job can each be tracked independently.
ALTER TABLE audits DROP CONSTRAINT IF EXISTS audits_unlock_status_check;
ALTER TABLE audits ADD CONSTRAINT audits_unlock_status_check
  CHECK (unlock_status IN ('listed','audit_paid','guide_paid','bundle_paid'));
ALTER TABLE audits ADD COLUMN IF NOT EXISTS guide_status TEXT NOT NULL DEFAULT 'none'
  CHECK (guide_status IN ('none','draft','ready','delivered'));
ALTER TABLE audits ADD COLUMN IF NOT EXISTS fix_status TEXT NOT NULL DEFAULT 'none'
  CHECK (fix_status IN ('none','quoted','invoiced','paid','done'));

-- Purchases: the payment trail. Payment-link purchases are recorded
-- manually in the dashboard (Stripe notifies Ryan; no webhook) — kind +
-- amount must match the decided catalog (audit $25, guide $25, bundle $40).
CREATE TABLE IF NOT EXISTS audit_purchases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id     TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('audit','guide','bundle')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_ref   TEXT,
  buyer_email  CITEXT,
  is_test      BOOLEAN NOT NULL DEFAULT FALSE,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_purchases_audit_id_idx ON audit_purchases (audit_id);

-- Fix guides: the per-audit write-up (per-finding fix steps). Drafted from
-- the findings by template, reviewed/edited by Ryan in the dashboard,
-- delivered by email (body + .md attachment) and unlocked on the public
-- report page via unlock_token once delivered. Guides go out ONLY once
-- marked ready in the dashboard — never auto-generated + auto-sent.
CREATE TABLE IF NOT EXISTS audit_guides (
  audit_id     TEXT PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
  body         TEXT NOT NULL DEFAULT '',
  platform     TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','ready','delivered')),
  unlock_token TEXT UNIQUE,
  delivered_to TEXT,
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fix quotes: done-for-you work, $100/hr, $200 minimum, estimate first.
-- One bundled job per quote (banner + gate the stack + un-hardcode grants
-- + policy alignment), NOT priced per finding. Work starts only after the
-- Stripe invoice is paid.
CREATE TABLE IF NOT EXISTS audit_fix_quotes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id          TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  hours             NUMERIC NOT NULL CHECK (hours > 0),
  rate_cents        INTEGER NOT NULL DEFAULT 10000,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 20000),
  platform          TEXT,
  access_needed     TEXT,
  buyer_email       CITEXT,
  stripe_invoice_id TEXT,
  stripe_number     TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','paid','void')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_fix_quotes_audit_id_idx ON audit_fix_quotes (audit_id);

-- ---------- Phase 2 refinements (Ryan 2026-10-27 ~22:29) ----------
-- (1) PAY FIRST, THEN SEND. Nothing deliverable (audit report or fix
-- guide) goes out unpaid: the invoice/payment comes first, Ryan confirms
-- payment (recorded purchase), THEN the report/guide is sent. Deliveries
-- are recorded here so the dashboard can show payment + delivery status
-- per audit and gate the Send actions on payment confirmed.
CREATE TABLE IF NOT EXISTS audit_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id     TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('report','guide')),
  delivered_to CITEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_test      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS audit_deliveries_audit_id_idx ON audit_deliveries (audit_id);

-- Ryan's per-audit notes (contact, access, what he told them, next steps).
ALTER TABLE audits ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- (3) RE-RUN / REFRESH. Audits are not frozen: findings can be marked
-- fixed as sites improve, with a note + date kept as history, and the
-- score recomputes from OPEN issues only. New findings can be added
-- (re-audit found something new) and fixed ones reopened.
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open','fixed'));
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fixed_note TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fixed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS audit_finding_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id   TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  finding_id UUID REFERENCES audit_findings(id) ON DELETE SET NULL,
  action     TEXT NOT NULL CHECK (action IN ('fixed','reopened','added','note')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_finding_events_audit_id_idx ON audit_finding_events (audit_id);
