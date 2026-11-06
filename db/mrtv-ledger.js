// Apex dashboard — M.R. TV profit-split ledger (Mark + Ryan, 50/50).
//
// Event-sourced: every money/credit movement is an event row, and the
// boxes are derived by replaying events in seq order. Deleting an event
// reverses its effect exactly (replay from scratch).
//
// Rules (Ryan — current as of 2026-11-06 redesign; reserves REMOVED):
//  - NO reserves. The old $2/credit reserve waterfall is gone (2026-11-06).
//    Credits are NOT money: they are tracked separately and never counted
//    in what's owed. Owed is always cash/2 per partner.
//  - Every order's NET revenue splits straight 50/50 to Mark/Ryan owed
//    (and to their lifetime earnings). Free/comp lines (net $0) add $0.
//    Revenue tracked NET of fees. Historical (pre-tracker) orders count
//    lifetime + credits only — no split.
//  - A pack purchase splits its cost 50/50 OUT of the owed boxes
//    (markOwed -= cost/2, ryanOwed -= cost/2) and adds its credits.
//  - Cash-out / payout record cash a partner already took: they raise
//    that partner's "paid" figure and reduce their owed box. Bookkeeping
//    only — real money moves by hand.
//  - 'reconcile' sets the owed (and optionally earned/paid) boxes to
//    explicit target values — used to pin the books to Ryan's cash count.
//  - 'reset_boxes' zeroes owed + earned + paid; lifetime + credits kept.
//  - All money math in integer cents. No invented figures.
//
// "Earned" is cumulative and display-only (lifetime earnings per partner).
// "Paid" is cumulative cash taken (payout + cashout events, plus any
// reconcile seed). Owed is what's left to pay out. Cashing out zeroes the
// owed box but never resets earned or paid.
//
// Panel credits are LIVE, not replayed: GET /api/mrtv/ledger fetches
// reseller_info from the panel and returns panelCredits. The replayed
// credit count stays in the response as ledgerCredits (audit trail only)
// — the UI must display panelCredits. If the panel call fails,
// panelCredits is null and the UI says so instead of faking a number.
"use strict";
const { getPool, pgEnabled } = require("./pg");

const PACK_COST_C = 15000;         // $150 per 120-credit pack (smallest pack)
const CREDIT_COST_C = 125;         // $1.25 per credit at cost (120-pack rate)
const PACKS = [
  { credits: 120, costC: 15000 },
  { credits: 300, costC: 35000 },
  { credits: 500, costC: 55000 },
];

function noPg(res) { res.status(503).json({ error: "unavailable (Postgres not configured)" }); return true; }
function cleanStr(s, n) { return String(s == null ? "" : s).trim().slice(0, n || 200); }
function dollarsToCents(s) {
  const v = parseFloat(String(s == null ? "" : s).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}
function nyToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function fmtC(c) { return "$" + (c / 100).toFixed(2); }
function fmtSignedC(c) { return (c < 0 ? "-$" : "+$") + (Math.abs(c) / 100).toFixed(2); }

// Pure: replay events -> { state, effects }.
// effects[id] = per-event deltas {markC, ryanC, credits, markEarnedC, ryanEarnedC, markPaidC, ryanPaidC, lifetimeGrossC}.
// Exported for local verification (node harness, no DB needed).
function computeLedger(events) {
  const evs = [...(events || [])].sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : 1));
  const st = { lifetimeGrossC: 0, markOwedC: 0, ryanOwedC: 0, credits: 0, markEarnedC: 0, ryanEarnedC: 0, markPaidC: 0, ryanPaidC: 0 };
  const effects = {};
  for (const e of evs) {
    const before = { ...st };
    const p = e.payload || {};
    switch (e.kind) {
      case "seed":
        st.credits = p.credits | 0;
        st.lifetimeGrossC = p.lifetime_gross_c | 0;
        st.markOwedC = p.mark_owed_c | 0;
        st.ryanOwedC = p.ryan_owed_c | 0;
        st.markEarnedC = p.mark_earned_c | 0;
        st.ryanEarnedC = p.ryan_earned_c | 0;
        st.markPaidC = p.mark_paid_c | 0;
        st.ryanPaidC = p.ryan_paid_c | 0;
        break;
      case "order": {
        const grossC = p.gross_c | 0, netC = p.net_c | 0, cr = p.credits | 0;
        st.lifetimeGrossC += grossC;
        st.credits -= cr;
        if (!p.historical) {
          // Straight 50/50 — no reserve skim (removed 2026-11-06).
          const m = Math.floor(netC / 2);
          st.markOwedC += m;
          st.ryanOwedC += netC - m;
          st.markEarnedC += m;
          st.ryanEarnedC += netC - m;
        }
        break;
      }
      case "credit_use":
        st.credits -= p.credits | 0;
        break;
      case "pack": {
        // Cost splits 50/50 OUT of the owed boxes; credits are added.
        // No floor: the formula is literal. If a pack is ever bought with
        // near-empty boxes the boxes go negative — reconcile fixes it.
        const costC = p.cost_c | 0;
        const half = Math.floor(costC / 2);
        st.markOwedC -= half;
        st.ryanOwedC -= (costC - half);
        st.credits += p.credits_added | 0;
        break;
      }
      case "cashout_mark":
        st.markPaidC += st.markOwedC;
        st.markOwedC = 0;
        break;
      case "cashout_ryan":
        st.ryanPaidC += st.ryanOwedC;
        st.ryanOwedC = 0;
        break;
      case "reset_boxes":
        // Ryan: fresh start. Zeroes owed + earned + paid. Lifetime sales
        // and credits are untouched. Future sales split straight 50/50.
        st.markOwedC = 0;
        st.ryanOwedC = 0;
        st.markEarnedC = 0;
        st.ryanEarnedC = 0;
        st.markPaidC = 0;
        st.ryanPaidC = 0;
        break;
      case "payout":
        // Cash a partner already took. Raises their paid figure and
        // deducts from their owed box only (floored at $0).
        if (p.who === "mark") { st.markPaidC += p.amount_c | 0; st.markOwedC = Math.max(0, st.markOwedC - (p.amount_c | 0)); }
        else if (p.who === "ryan") { st.ryanPaidC += p.amount_c | 0; st.ryanOwedC = Math.max(0, st.ryanOwedC - (p.amount_c | 0)); }
        break;
      case "reconcile":
        // Pin the books to explicit targets (Ryan's cash count). Owed is
        // always set; earned/paid are set when provided, else untouched.
        st.markOwedC = p.mark_owed_c | 0;
        st.ryanOwedC = p.ryan_owed_c | 0;
        if (p.mark_earned_c !== undefined && p.mark_earned_c !== null) st.markEarnedC = p.mark_earned_c | 0;
        if (p.ryan_earned_c !== undefined && p.ryan_earned_c !== null) st.ryanEarnedC = p.ryan_earned_c | 0;
        if (p.mark_paid_c !== undefined && p.mark_paid_c !== null) st.markPaidC = p.mark_paid_c | 0;
        if (p.ryan_paid_c !== undefined && p.ryan_paid_c !== null) st.ryanPaidC = p.ryan_paid_c | 0;
        break;
      default:
        // Retired kinds (cashout_reserve, reserve_adjust) are no-ops now —
        // the reserve concept is gone, so their old effects don't replay.
        break;
    }
    effects[e.id] = {
      markC: st.markOwedC - before.markOwedC,
      ryanC: st.ryanOwedC - before.ryanOwedC,
      credits: st.credits - before.credits,
      markEarnedC: st.markEarnedC - before.markEarnedC,
      ryanEarnedC: st.ryanEarnedC - before.ryanEarnedC,
      markPaidC: st.markPaidC - before.markPaidC,
      ryanPaidC: st.ryanPaidC - before.ryanPaidC,
      lifetimeGrossC: st.lifetimeGrossC - before.lifetimeGrossC,
    };
  }
  return { state: st, effects };
}

// Human-readable one-liners for the history list.
function describeEvent(e, fx) {
  const p = e.payload || {};
  const at = e.created_at ? String(e.created_at).slice(0, 10) : "";
  const out = { id: e.id, kind: e.kind, at, canDelete: e.kind !== "seed", title: "", detail: "" };
  const split = (fx && !p.historical) ? (() => {
    const bits = [];
    if (fx.markC) bits.push("Mark " + fmtSignedC(fx.markC));
    if (fx.ryanC) bits.push("Ryan " + fmtSignedC(fx.ryanC));
    return bits.length ? " · split: " + bits.join(", ") : "";
  })() : "";
  switch (e.kind) {
    case "seed":
      out.title = "Opening balances";
      out.detail = e.note || "";
      break;
    case "order":
      out.title = (p.customer || "Sale") + (p.date ? " · " + p.date : "");
      out.detail = "Gross " + fmtC(p.gross_c | 0) + " · fee " + fmtC(p.fee_c | 0) +
        " · net " + fmtC(p.net_c | 0) + " · " + (p.credits | 0) + " credits" +
        (p.plan ? " · " + p.plan : "") + (p.historical ? " · pre-tracker" : "") + split;
      break;
    case "credit_use":
      out.title = "Credit use · " + (p.credits | 0) + " credits";
      out.detail = e.note || p.note || "";
      break;
    case "pack": {
      const costC = p.cost_c | 0, half = Math.floor(costC / 2);
      out.title = "Pack purchase · +" + (p.credits_added | 0) + " credits";
      out.detail = "Cost " + fmtC(costC) + " · " + fmtC(half) + " each from Mark/Ryan owed" +
        (e.note ? " · " + e.note : "");
      break;
    }
    case "cashout_mark":
      out.title = "Mark cashed out";
      out.detail = "Cleared " + fmtC(p.cleared_c | 0) + " · counts as paid · bookkeeping only, no money moved";
      break;
    case "cashout_ryan":
      out.title = "Ryan cashed out";
      out.detail = "Cleared " + fmtC(p.cleared_c | 0) + " · counts as paid · bookkeeping only, no money moved";
      break;
    case "reset_boxes":
      out.title = "Reset all to $0";
      out.detail = "Cleared Mark owed " + fmtC(p.cleared_mark_c | 0) +
        " · Ryan owed " + fmtC(p.cleared_ryan_c | 0) +
        " · Mark earned " + fmtC(p.cleared_mark_earned_c | 0) +
        " · Ryan earned " + fmtC(p.cleared_ryan_earned_c | 0) +
        " · Mark paid " + fmtC(p.cleared_mark_paid_c | 0) +
        " · Ryan paid " + fmtC(p.cleared_ryan_paid_c | 0) +
        " · lifetime + credits kept";
      break;
    case "payout":
      out.title = "Payout to " + (p.who === "mark" ? "Mark" : "Ryan") + " · " + fmtC(p.amount_c | 0);
      out.detail = (e.note ? e.note + " · " : "") + "cash already taken, deducted from owed box";
      break;
    case "reconcile":
      out.title = "Reconcile to cash count";
      out.detail = "Mark owed " + fmtC(p.mark_owed_c | 0) + " · Ryan owed " + fmtC(p.ryan_owed_c | 0) +
        ((p.mark_earned_c != null) ? " · Mark earned " + fmtC(p.mark_earned_c | 0) : "") +
        ((p.ryan_earned_c != null) ? " · Ryan earned " + fmtC(p.ryan_earned_c | 0) : "") +
        ((p.mark_paid_c != null) ? " · Mark paid " + fmtC(p.mark_paid_c | 0) : "") +
        ((p.ryan_paid_c != null) ? " · Ryan paid " + fmtC(p.ryan_paid_c | 0) : "") +
        (e.note ? " · " + e.note : "");
      break;
    default:
      out.title = e.kind;
      out.detail = e.note || "";
  }
  return out;
}

function mountMrtvLedger(app, authRequired) {
  const needPg = (req, res) => !pgEnabled() && noPg(res);

  async function currentState() {
    const { rows } = await getPool().query(
      "SELECT id, seq, kind, payload, note, created_at FROM mrtv_ledger_events ORDER BY seq ASC");
    return { rows, ...computeLedger(rows) };
  }

  // Full ledger: the boxes + live panel credits + history (newest first).
  // panelCredits comes from the panel (reseller_info), NOT the replay.
  // If the panel call fails, panelCredits is null — the UI says so.
  // Retired reserve events are hidden from the history (dead concept).
  app.get("/api/mrtv/ledger", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows, state, effects } = await currentState();
      let panelCredits = null;
      try {
        const { getPanelCredits } = require("./mrtv-provision");
        panelCredits = await getPanelCredits();
      } catch (e) { console.error("panel credits (ledger):", e.message); }
      res.json({
        boxes: state,
        panelCredits,
        ledgerCredits: state.credits,
        rules: { packCostC: PACK_COST_C, creditCostC: CREDIT_COST_C, packs: PACKS },
        events: rows.slice().reverse()
          .filter((e) => e.kind !== "cashout_reserve" && e.kind !== "reserve_adjust")
          .map((e) => describeEvent(e, effects[e.id])),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // New order: net splits straight 50/50 on save.
  app.post("/api/mrtv/ledger/orders", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const customer = cleanStr(b.customer, 120);
      if (!customer) return res.status(400).json({ error: "customer required" });
      const grossC = dollarsToCents(b.gross);
      if (grossC === null) return res.status(400).json({ error: "gross must be a number" });
      const feeC = dollarsToCents(b.fee === undefined || b.fee === "" ? "0" : b.fee);
      if (feeC === null) return res.status(400).json({ error: "fee must be a number" });
      const netRaw = (b.net === undefined || b.net === "") ? null : dollarsToCents(b.net);
      const netC = netRaw === null ? grossC - feeC : netRaw;
      if (netC < 0) return res.status(400).json({ error: "net can't be negative" });
      const credits = parseInt(b.credits, 10);
      if (!Number.isInteger(credits) || credits < 0 || credits > 100000)
        return res.status(400).json({ error: "credits must be a whole number" });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : nyToday();
      const payload = { customer, date, gross_c: grossC, fee_c: feeC, net_c: netC, credits, plan: cleanStr(b.plan, 60) };
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('order', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), cleanStr(b.note, 300)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Delete any non-seed event (reverses its effect exactly via replay).
  app.delete("/api/mrtv/ledger/events/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rowCount } = await getPool().query(
        "DELETE FROM mrtv_ledger_events WHERE id = $1 AND kind <> 'seed'", [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not found (opening balances can't be deleted)" });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Pack purchase: cost splits 50/50 out of the owed boxes, credits in.
  app.post("/api/mrtv/ledger/packs", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const creditsAdded = parseInt(b.credits_added, 10);
      if (!Number.isInteger(creditsAdded) || creditsAdded <= 0 || creditsAdded > 100000)
        return res.status(400).json({ error: "credits added must be a positive whole number" });
      const costC = dollarsToCents(b.cost === undefined || b.cost === "" ? "150" : b.cost);
      if (costC === null) return res.status(400).json({ error: "cost must be a number" });
      const payload = { credits_added: creditsAdded, cost_c: costC };
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('pack', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), cleanStr(b.note, 300) || "pack purchase"]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Non-sale credit use (demo tickets, comps...).
  app.post("/api/mrtv/ledger/credit-use", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const credits = parseInt(b.credits, 10);
      if (!Number.isInteger(credits) || credits <= 0 || credits > 100000)
        return res.status(400).json({ error: "credits must be a positive whole number" });
      const note = cleanStr(b.note, 300) || "credit use";
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('credit_use', $1::jsonb, $2) RETURNING id",
        [JSON.stringify({ credits }), note]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Cash-out: BOOKKEEPING ONLY. Clears the box to $0, records what was cleared
  // (counts as paid). Real money moves by hand.
  app.post("/api/mrtv/ledger/cashout/:who", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const who = String(req.params.who || "");
      if (!["mark", "ryan"].includes(who))
        return res.status(400).json({ error: "who must be mark or ryan" });
      const { state } = await currentState();
      const clearedC = who === "mark" ? state.markOwedC : state.ryanOwedC;
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ($1, $2::jsonb, $3) RETURNING id",
        ["cashout_" + who, JSON.stringify({ cleared_c: clearedC }), "bookkeeping only — no money moved"]);
      res.json({ ok: true, id: rows[0].id, clearedC });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Partner payout (Ryan 2026-11-05): record cash a partner already took,
  // e.g. Mark keeping his half of a sale he collected, or Ryan paying
  // himself. Raises their paid figure, deducts from their owed box only
  // (floored at $0). Reversible — deleting the event restores the box.
  app.post("/api/mrtv/ledger/payout", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const who = String(b.who || "");
      if (who !== "mark" && who !== "ryan") return res.status(400).json({ error: "who must be mark or ryan" });
      const amountC = dollarsToCents(b.amount);
      if (amountC === null || amountC <= 0) return res.status(400).json({ error: "amount must be a positive number" });
      const { state } = await currentState();
      const owed = who === "mark" ? state.markOwedC : state.ryanOwedC;
      if (amountC > owed) return res.status(400).json({ error: "payout exceeds what's owed (" + fmtC(owed) + ")" });
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('payout', $1::jsonb, $2) RETURNING id",
        [JSON.stringify({ who, amount_c: amountC }), cleanStr(b.note, 300) || "partner payout"]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Reconcile (Ryan 2026-11-06): pin the boxes to explicit target values
  // (Ryan's cash count). Owed is always set; earned/paid are set when
  // provided, else left at their replayed values. Reversible — deleting
  // the event restores via replay.
  app.post("/api/mrtv/ledger/reconcile", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const markOwedC = dollarsToCents(b.mark_owed);
      const ryanOwedC = dollarsToCents(b.ryan_owed);
      if (markOwedC === null || ryanOwedC === null)
        return res.status(400).json({ error: "mark_owed and ryan_owed must be numbers" });
      const payload = { mark_owed_c: markOwedC, ryan_owed_c: ryanOwedC };
      const opt = (key, field) => {
        if (b[key] === undefined || b[key] === "" || b[key] === null) return;
        const v = dollarsToCents(b[key]);
        if (v !== null) payload[field] = v;
      };
      opt("mark_earned", "mark_earned_c"); opt("ryan_earned", "ryan_earned_c");
      opt("mark_paid", "mark_paid_c"); opt("ryan_paid", "ryan_paid_c");
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('reconcile', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), cleanStr(b.note, 300) || "reconcile to cash count"]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Reset all boxes to $0 (Ryan 2026-10-29): fresh start. Zeroes owed +
  // earned + paid; lifetime sales and credits are kept. Reusable.
  // Reversible: deleting the event restores via replay.
  app.post("/api/mrtv/ledger/reset", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { state } = await currentState();
      const payload = {
        cleared_mark_c: state.markOwedC,
        cleared_ryan_c: state.ryanOwedC,
        cleared_mark_earned_c: state.markEarnedC,
        cleared_ryan_earned_c: state.ryanEarnedC,
        cleared_mark_paid_c: state.markPaidC,
        cleared_ryan_paid_c: state.ryanPaidC,
      };
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('reset_boxes', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), "fresh start — lifetime + credits kept"]);
      res.json({ ok: true, id: rows[0].id, cleared: payload });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { mountMrtvLedger, computeLedger, describeEvent, PACK_COST_C, CREDIT_COST_C, PACKS };
