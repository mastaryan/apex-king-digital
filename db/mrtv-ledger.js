// Apex dashboard — M.R. TV profit-split ledger (Mark + Ryan, 50/50).
//
// Event-sourced: every money/credit movement is an event row, and the four
// boxes + credits remaining are derived by replaying events in seq order.
// Deleting an event reverses its effect exactly (replay from scratch).
//
// "Mark earned" is a fifth derived figure, cumulative and display-only: it
// counts UP by Mark's waterfall share on every (non-historical) order.
// Cashing Mark out zeroes the owed box but never resets earned (earned is
// informational; owed is what can be cleared).
//
// Rules (Ryan — current as of 2026-10-29 settlement):
//  - Reserve: $2.00 per credit sold, taken from each sale's net revenue,
//    PAID LINES ONLY. Free/comp lines (net $0) generate zero reserve.
//    The reserve funds the next $150 pack.
//  - Revenue tracked NET of fees (Cash App ~2.75%).
//  - Waterfall per new net dollar: (1) $2/credit into reserves ->
//    (2) straight 50/50 Mark / Ryan. The old 75/25 payback phase ENDED
//    2026-10-29: Mark was cashed out ($43 real + 4 free yearly TVs as final
//    settlement for his $50 pack contribution — Ryan's call: he's even),
//    his box is $0 and the phase is locked (repayAllocated = target).
//  - 'reserve_adjust' events are manual reserve corrections (e.g. catch-up
//    for a paid line that never ran the waterfall). Reversible like any
//    other event.
//  - 'reset_boxes' zeroes reserves + both owed boxes + Mark earned (Ryan's
//    fresh start 2026-10-29); lifetime, credits and the locked repay phase
//    are kept, and future sales run the 50/50 waterfall with $2/credit
//    reserves from there on out.
//  - All money math in integer cents. No invented figures.
//
// Cash-out buttons are BOOKKEEPING ONLY: they zero a box and record the
// cleared amount. Real money moves by hand (Ryan pays Mark via Cash App
// whenever he chooses, then clears the box; when reserves hit $150 he
// buys the next pack manually and clears the reserve box).
// Either partner can also apply their owed balance toward a pack purchase:
// the applied amounts come off their owed boxes and reduce what the pack
// draws from reserves.
"use strict";
const { getPool, pgEnabled } = require("./pg");

const RESERVE_PER_CREDIT_C = 200;  // $2.00 per credit sold
const MARK_REPAY_TARGET_C = 5000;  // Mark's $50 contribution toward the $150 pack
const PACK_COST_C = 15000;         // $150 per 120-credit pack

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
// effects[id] = per-event deltas {reserveC, markC, ryanC, credits, lifetimeGrossC}.
// Exported for local verification (node harness, no DB needed).
function computeLedger(events) {
  const evs = [...(events || [])].sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : 1));
  const st = { lifetimeGrossC: 0, reserveC: 0, markOwedC: 0, ryanOwedC: 0, credits: 0, repayAllocatedC: 0, markEarnedC: 0 };
  const effects = {};
  for (const e of evs) {
    const before = { ...st };
    const p = e.payload || {};
    switch (e.kind) {
      case "seed":
        st.credits = p.credits | 0;
        st.lifetimeGrossC = p.lifetime_gross_c | 0;
        st.reserveC = p.reserve_c | 0;
        st.markOwedC = p.mark_owed_c | 0;
        st.ryanOwedC = p.ryan_owed_c | 0;
        st.repayAllocatedC = p.repay_allocated_c | 0;
        st.markEarnedC = p.mark_earned_c | 0;
        break;
      case "order": {
        const grossC = p.gross_c | 0, netC = p.net_c | 0, cr = p.credits | 0;
        st.lifetimeGrossC += grossC;
        st.credits -= cr;
        if (!p.historical) {
          // Ryan 2026-10-29: reserve ONLY on paid lines. Free/comp lines
          // (net $0) generate zero reserve. Net is never negative, so the
          // guard is equivalent to the plain min() for every paid order.
          const take = netC > 0 ? Math.min(RESERVE_PER_CREDIT_C * cr, netC) : 0;
          st.reserveC += take;
          const rem = netC - take;
          if (st.repayAllocatedC < MARK_REPAY_TARGET_C) {
            // 75% Mark / 25% Ryan while Mark's $50 is being repaid.
            const need = MARK_REPAY_TARGET_C - st.repayAllocatedC;
            const mark75 = Math.floor(rem * 75 / 100);
            if (mark75 <= need) {
              st.markOwedC -= mark75;
              st.ryanOwedC += rem - mark75;
              st.repayAllocatedC += mark75;
              st.markEarnedC += mark75;
            } else {
              // This sale finishes Mark's repayment; the leftover of the
              // remainder splits 50/50 from here on.
              st.markOwedC -= need;
              st.repayAllocatedC = MARK_REPAY_TARGET_C;
              const rest = rem - need;
              const m = Math.floor(rest / 2);
              st.markOwedC += m;
              st.ryanOwedC += rest - m;
              st.markEarnedC += need + m;
            }
          } else {
            // 50/50 after Mark is repaid.
            const m = Math.floor(rem / 2);
            st.markOwedC += m;
            st.ryanOwedC += rem - m;
            st.markEarnedC += m;
          }
        }
        break;
      }
      case "credit_use":
        st.credits -= p.credits | 0;
        break;
      case "pack": {
        // Partners can apply their owed balance toward the pack (Ryan
        // 2026-10-29): the applied amounts come off their owed boxes and
        // reduce what the pack draws from reserves.
        const mApp = Math.max(0, Math.min(p.mark_applied_c | 0, st.markOwedC));
        const rApp = Math.max(0, Math.min(p.ryan_applied_c | 0, st.ryanOwedC));
        st.markOwedC -= mApp;
        st.ryanOwedC -= rApp;
        st.credits += p.credits_added | 0;
        // Reserve never goes negative: a pack bought with outside money
        // just zeroes it (the clear button exists for the same reason).
        st.reserveC = Math.max(0, st.reserveC - Math.max(0, (p.cost_c | 0) - mApp - rApp));
        break;
      }
      case "cashout_mark":
        // Cleared box = Mark settled => his contribution is repaid.
        st.markOwedC = 0;
        st.repayAllocatedC = MARK_REPAY_TARGET_C;
        break;
      case "cashout_ryan":
        st.ryanOwedC = 0;
        break;
      case "cashout_reserve":
        st.reserveC = 0;
        break;
      case "reset_boxes":
        // Ryan 2026-10-29: fresh start. Zeroes reserves + both owed boxes +
        // Mark's earned figure. Lifetime sales, credits and the locked
        // repay phase are untouched. Future sales keep the 50/50 waterfall
        // with $2/credit reserves from here on out.
        st.reserveC = 0;
        st.markOwedC = 0;
        st.ryanOwedC = 0;
        st.markEarnedC = 0;
        break;
      case "reserve_adjust":
        // Manual reserve correction (Ryan 2026-10-29). Reversible like any
        // other event. Floored at $0 — a correction can't drive reserves
        // negative.
        st.reserveC = Math.max(0, st.reserveC + (p.amount_c | 0));
        break;
      default:
        break;
    }
    effects[e.id] = {
      reserveC: st.reserveC - before.reserveC,
      markC: st.markOwedC - before.markOwedC,
      ryanC: st.ryanOwedC - before.ryanOwedC,
      credits: st.credits - before.credits,
      markEarnedC: st.markEarnedC - before.markEarnedC,
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
  const wf = (fx && !p.historical) ? (() => {
    const bits = [];
    if (fx.reserveC) bits.push("reserve " + fmtSignedC(fx.reserveC));
    if (fx.markC) bits.push("Mark " + fmtSignedC(fx.markC));
    if (fx.ryanC) bits.push("Ryan " + fmtSignedC(fx.ryanC));
    return bits.length ? " · waterfall: " + bits.join(", ") : "";
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
        (p.plan ? " · " + p.plan : "") + (p.historical ? " · pre-tracker" : "") + wf;
      break;
    case "credit_use":
      out.title = "Credit use · " + (p.credits | 0) + " credits";
      out.detail = e.note || p.note || "";
      break;
    case "pack":
      out.title = "Pack purchase · +" + (p.credits_added | 0) + " credits";
      out.detail = "Cost " + fmtC(p.cost_c | 0) + " from reserves" +
        ((p.mark_applied_c | 0) ? " · Mark applied " + fmtC(p.mark_applied_c | 0) : "") +
        ((p.ryan_applied_c | 0) ? " · Ryan applied " + fmtC(p.ryan_applied_c | 0) : "") +
        (e.note ? " · " + e.note : "");
      break;
    case "cashout_mark":
      out.title = "Mark cashed out";
      out.detail = "Cleared " + fmtC(p.cleared_c | 0) + " · bookkeeping only, no money moved";
      break;
    case "cashout_ryan":
      out.title = "Ryan cashed out";
      out.detail = "Cleared " + fmtC(p.cleared_c | 0) + " · bookkeeping only, no money moved";
      break;
    case "cashout_reserve":
      out.title = "Reserve spent";
      out.detail = "Cleared " + fmtC(p.cleared_c | 0) + " · bookkeeping only, no money moved";
      break;
    case "reset_boxes":
      out.title = "Reset all to $0";
      out.detail = "Cleared reserve " + fmtC(p.cleared_reserve_c | 0) +
        " · Mark owed " + fmtC(p.cleared_mark_c | 0) +
        " · Ryan owed " + fmtC(p.cleared_ryan_c | 0) +
        " · Mark earned " + fmtC(p.cleared_earned_c | 0) +
        " · lifetime + credits kept";
      break;
    case "reserve_adjust":
      out.title = "Reserve adjustment";
      out.detail = fmtSignedC(p.amount_c | 0) + (e.note ? " · " + e.note : "");
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

  // Full ledger: the four boxes + credits + rules + history (newest first).
  app.get("/api/mrtv/ledger", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows, state, effects } = await currentState();
      res.json({
        boxes: state,
        rules: { reservePerCreditC: RESERVE_PER_CREDIT_C, markRepayTargetC: MARK_REPAY_TARGET_C, packCostC: PACK_COST_C },
        events: rows.slice().reverse().map((e) => describeEvent(e, effects[e.id])),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // New order: runs the waterfall on save.
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

  // Delete any non-seed event (reverses its waterfall exactly via replay).
  app.delete("/api/mrtv/ledger/events/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rowCount } = await getPool().query(
        "DELETE FROM mrtv_ledger_events WHERE id = $1 AND kind <> 'seed'", [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not found (opening balances can't be deleted)" });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Pack purchase: credits in, cost out of reserves (floored at $0).
  app.post("/api/mrtv/ledger/packs", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const creditsAdded = parseInt(b.credits_added, 10);
      if (!Number.isInteger(creditsAdded) || creditsAdded <= 0 || creditsAdded > 100000)
        return res.status(400).json({ error: "credits added must be a positive whole number" });
      const costC = dollarsToCents(b.cost === undefined || b.cost === "" ? "150" : b.cost);
      if (costC === null) return res.status(400).json({ error: "cost must be a number" });
      const markAppC = dollarsToCents(b.mark_applied === undefined || b.mark_applied === "" ? "0" : b.mark_applied);
      if (markAppC === null) return res.status(400).json({ error: "Mark applied must be a number" });
      const ryanAppC = dollarsToCents(b.ryan_applied === undefined || b.ryan_applied === "" ? "0" : b.ryan_applied);
      if (ryanAppC === null) return res.status(400).json({ error: "Ryan applied must be a number" });
      const { state } = await currentState();
      if (markAppC > state.markOwedC) return res.status(400).json({ error: "Mark can't apply more than he's owed (" + fmtC(state.markOwedC) + ")" });
      if (ryanAppC > state.ryanOwedC) return res.status(400).json({ error: "Ryan can't apply more than he's owed (" + fmtC(state.ryanOwedC) + ")" });
      const payload = { credits_added: creditsAdded, cost_c: costC, mark_applied_c: markAppC, ryan_applied_c: ryanAppC };
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('pack', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), cleanStr(b.note, 300)]);
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

  // Cash-out: BOOKKEEPING ONLY. Clears the box to $0, records what was cleared.
  app.post("/api/mrtv/ledger/cashout/:who", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const who = String(req.params.who || "");
      if (!["mark", "ryan", "reserve"].includes(who))
        return res.status(400).json({ error: "who must be mark, ryan or reserve" });
      const { state } = await currentState();
      const clearedC = who === "mark" ? state.markOwedC : who === "ryan" ? state.ryanOwedC : state.reserveC;
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ($1, $2::jsonb, $3) RETURNING id",
        ["cashout_" + who, JSON.stringify({ cleared_c: clearedC }), "bookkeeping only — no money moved"]);
      res.json({ ok: true, id: rows[0].id, clearedC });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  // Reserve adjustment: manual correction (Ryan 2026-10-29). Positive adds to
  // reserves, negative removes (floored at $0 by the replay). Reversible —
  // deleting the event reverses it exactly.
  app.post("/api/mrtv/ledger/reserve-adjust", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const rawAmt = String(b.amount == null ? "" : b.amount).trim();
      const neg = rawAmt.startsWith("-");
      const amountC = dollarsToCents(neg ? rawAmt.slice(1) : rawAmt);
      if (amountC === null) return res.status(400).json({ error: "amount must be a number" });
      const signedC = neg ? -amountC : amountC;
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('reserve_adjust', $1::jsonb, $2) RETURNING id",
        [JSON.stringify({ amount_c: signedC }), cleanStr(b.note, 300) || "reserve adjustment"]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Reset all boxes to $0 (Ryan 2026-10-29): fresh start. Zeroes reserves +
  // both owed boxes + Mark's earned figure; lifetime sales, credits and the
  // locked repay phase are kept. Reusable — after any future payout he can
  // press it again. Reversible: deleting the event restores via replay.
  app.post("/api/mrtv/ledger/reset", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { state } = await currentState();
      const payload = {
        cleared_reserve_c: state.reserveC,
        cleared_mark_c: state.markOwedC,
        cleared_ryan_c: state.ryanOwedC,
        cleared_earned_c: state.markEarnedC,
      };
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_ledger_events (kind, payload, note) VALUES ('reset_boxes', $1::jsonb, $2) RETURNING id",
        [JSON.stringify(payload), "fresh start — lifetime + credits kept"]);
      res.json({ ok: true, id: rows[0].id, cleared: payload });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { mountMrtvLedger, computeLedger, describeEvent, RESERVE_PER_CREDIT_C, MARK_REPAY_TARGET_C, PACK_COST_C };
