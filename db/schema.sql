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

-- ---------- Order flow (Ryan 2026-10-27 ~22:50) ----------
-- Visitor: masked list -> order form (website URL + store type, so the
-- platform is known) -> payment choice (audit $25 / bundle $40) -> pay
-- -> audit delivered -> guide upsell ($25 via link or invoice) ->
-- hire-us-to-fix offered at BOTH points (after the audit, and again
-- after the guide). The store-type answer is stored with the audit so
-- the fix guide / quote can be tailored to the platform.
-- Other services (local SEO, GBP setup, website builds) stay on
-- invoices — custom-priced, not fixed. NOTE: once Stripe's stablecoin
-- method is enabled on the account, Stripe invoices can take crypto
-- too — no separate crypto flow needed for those.
ALTER TABLE audits ADD COLUMN IF NOT EXISTS store_type TEXT
  CHECK (store_type IS NULL OR store_type IN ('shopify','woocommerce','wix','squarespace','custom','unknown'));
CREATE TABLE IF NOT EXISTS audit_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website      TEXT NOT NULL,   -- as the visitor typed it
  domain       TEXT,            -- normalized domain (lowercase, no scheme/www/path)
  store_type   TEXT NOT NULL CHECK (store_type IN ('shopify','woocommerce','wix','squarespace','custom','unknown')),
  choice       TEXT NOT NULL CHECK (choice IN ('audit','bundle')),
  buyer_email  CITEXT,
  status       TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','audited','cancelled')),
  audit_id     TEXT REFERENCES audits(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_orders_domain_idx ON audit_orders (domain);
CREATE INDEX IF NOT EXISTS audit_orders_status_idx ON audit_orders (status);

-- ---------- Card home (2026-10-28, Ryan: "Let's build it") ----------
-- One card per backend piece; each section below is a small table the
-- card opens into. No HKL data; no invented rows — seeds below are only
-- facts already verified in the thread (Grundy GBP unclaimed; the two
-- live Apex demo sites).

-- Customers: which Apex products each customer has (picked in the
-- dashboard when adding/editing a customer; used by the Customers card
-- "Has" line). Products are Apex service names, not free text.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS products TEXT[] NOT NULL DEFAULT '{}';

-- Local SEO: to-do lane (front-end signups land here) -> tracking lane
-- (setup done, flags monitored). kind: gbp = Google Business Profile.
CREATE TABLE IF NOT EXISTS local_seo_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'gbp' CHECK (kind IN ('gbp','local_seo','other')),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','tracking')),
  flags         JSONB NOT NULL DEFAULT '{}',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Grundy Insurance: GBP is NOT set up (verified Oct 2026) — Phil must
-- claim as owner; Ryan offers a 15-min walkthrough. The standing example
-- for the Local SEO to-do lane.
INSERT INTO local_seo_items (id, business_name, kind, status, flags, notes)
VALUES ('00000000-0000-0000-0000-000000000001', 'Grundy Insurance', 'gbp', 'todo',
        '{"profile_claimed": false}'::jsonb,
        'GBP not set up — Phil must claim as owner; Ryan offers a 15-min walkthrough.')
ON CONFLICT (id) DO NOTHING;

-- Bots: treated like websites — built, then added here; pending while
-- being built. No order form. Health (Phase 3) plugs into last_seen.
CREATE TABLE IF NOT EXISTS bots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company    TEXT NOT NULL,
  name       TEXT NOT NULL,
  platform   TEXT NOT NULL CHECK (platform IN ('telegram','discord','other')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','down')),
  last_seen  TIMESTAMPTZ,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mock-ups: Netlify draft demos, tracked draft -> changes -> approved ->
-- live. Clicking one reveals the full (non-censored) detail.
CREATE TABLE IF NOT EXISTS mockups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  client     TEXT,
  url        TEXT,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','changes','approved','live')),
  notes      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Live Apex demos (verified): Poured With Purpose demo v3, Nicely
-- Printed 3D demo. Both awaiting client decisions.
INSERT INTO mockups (id, name, client, url, status, notes)
VALUES ('00000000-0000-0000-0000-000000000002', 'Poured With Purpose demo', 'Poured With Purpose Lemonade Co.', 'https://poured-with-purpose-demo.netlify.app', 'draft',
        'Demo v3: 5-photo deck + fall menu. No invoice — free vs paid still open.')
ON CONFLICT (id) DO NOTHING;
INSERT INTO mockups (id, name, client, url, status, notes)
VALUES ('00000000-0000-0000-0000-000000000003', 'Nicely Printed 3D demo', 'Nicely Printed 3D', 'https://nicelyprinted-demo.netlify.app', 'draft',
        '3D printing demo site.')
ON CONFLICT (id) DO NOTHING;

-- M.R. TV: customers with a subscription. start = invoice date, end =
-- start + 1 year (yearly) or + 1 month (monthly); days left is the
-- headline number. NO credits tracking, NO pause. Invoice route
-- (through the TV provider vs through Apex) is OPEN — parked, not decided.
CREATE TABLE IF NOT EXISTS mrtv_customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      CITEXT,
  plan       TEXT NOT NULL DEFAULT 'yearly' CHECK (plan IN ('monthly','yearly')),
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS renewal_amount_cents INTEGER;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS renewal_email_sent_for DATE;
-- One-click provisioning (2026-10-29): per-TV panel credentials live in
-- `lines` (JSONB array: {tv, type, sub, pack, username, password, user_id,
-- demo, created_at, renewed_at}). needs_manual is a human-readable flag for
-- anything the panel couldn't do on its own. ledger_posted_for guards the
-- auto-posted ledger order against double-posting.
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS cell TEXT;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS tv_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS package TEXT NOT NULL DEFAULT 'usa' CHECK (package IN ('usa','all','custom'));
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS adult_ok BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS tivimate_bundle BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS lines JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ;
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS needs_manual TEXT NOT NULL DEFAULT '';
ALTER TABLE mrtv_customers ADD COLUMN IF NOT EXISTS ledger_posted_for DATE;
-- Sent-mail log (2026-10-29): every M.R. TV email the dashboard sends gets
-- a row — recipient, subject, SMTP message id + server response, ok/error.
-- This is the proof-of-send record.
CREATE TABLE IF NOT EXISTS mrtv_email_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL,
  customer_id UUID,
  to_email   TEXT,
  subject    TEXT,
  message_id TEXT,
  smtp_response TEXT,
  ok         BOOLEAN NOT NULL DEFAULT true,
  error      TEXT
);

-- M.R. TV profit-split ledger (Mark + Ryan, 50/50). Event-sourced: the four
-- boxes + credits remaining are derived by replaying events in seq order.
-- All money in integer cents. Cash-out events are BOOKKEEPING ONLY.
CREATE TABLE IF NOT EXISTS mrtv_ledger_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq        BIGSERIAL,
  kind       TEXT NOT NULL CHECK (kind IN ('seed','order','credit_use','pack','cashout_mark','cashout_ryan','cashout_reserve','reserve_adjust','reset_boxes')),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 2026-10-29: allow the 'reserve_adjust' and 'reset_boxes' event kinds
-- (Mark settlement; Ryan's fresh-start reset).
-- Idempotent: no-ops when the live constraint already permits them (e.g.
-- fresh databases, where the CREATE TABLE above already includes them).
-- NOTE: Postgres stores IN-lists as "= ANY (ARRAY[...])", so match on that.
DO $$
DECLARE
  cname text;
  cdef  text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO cname, cdef FROM pg_constraint
  WHERE conrelid = 'mrtv_ledger_events'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%kind = ANY%';
  IF cname IS NOT NULL AND cdef NOT LIKE '%reset_boxes%' THEN
    EXECUTE 'ALTER TABLE mrtv_ledger_events DROP CONSTRAINT ' || quote_ident(cname);
    ALTER TABLE mrtv_ledger_events ADD CONSTRAINT mrtv_ledger_events_kind_check
      CHECK (kind IN ('seed','order','credit_use','pack','cashout_mark','cashout_ryan','cashout_reserve','reserve_adjust','reset_boxes'));
  END IF;
END $$;
-- Seed (idempotent; figures verified against the M.R. TV ledger 2026-10-29):
-- 120-credit pack @ $150 bought 2026-10-28 (funded Lou $100 + Mark $50),
-- minus 5 demo-ticket credits, minus the Lou pre-tracker sale (no waterfall
-- on it). NOTE 2026-10-29: the Michelle pre-tracker row was deliberately
-- DELETED by Ryan (it duplicated her live order) — it must NOT be re-added
-- here, or re-running /api/admin/schema will resurrect it.
INSERT INTO mrtv_ledger_events (id, kind, payload, note, created_at) VALUES
('11111111-1111-4111-8111-111111111111', 'seed',
 '{"credits":120,"lifetime_gross_c":0,"reserve_c":0,"mark_owed_c":5000,"ryan_owed_c":0,"repay_allocated_c":0}'::jsonb,
 'Opening balances: 120-credit pack $150 bought 2026-10-28, funded Lou $100 + Mark $50 (personal transfers, no fees).',
 '2026-10-28T12:00:00Z'),
('22222222-2222-4222-8222-222222222222', 'credit_use',
 '{"credits":5}'::jsonb,
 'Demo tickets: 5 credits (160 tickets on hand).',
 '2026-10-28T12:00:01Z'),
('33333333-3333-4333-8333-333333333333', 'order',
 '{"customer":"Lou","date":"2026-10-28","gross_c":10000,"fee_c":0,"net_c":10000,"credits":24,"plan":"yearly (2 TVs)","historical":true}'::jsonb,
 'Pre-tracker sale — the $100 went to the pack; no waterfall applied.',
 '2026-10-28T12:00:02Z')
ON CONFLICT (id) DO NOTHING;
