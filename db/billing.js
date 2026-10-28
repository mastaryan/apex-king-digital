// Apex dashboard — Audits billing catalog (Phase 2 money flows).
// Prices DECIDED by Ryan 2026-10-27 — do not change without his word.
//   Audit alone: $25 (the uncover — paying it shows the buyer the full audit)
//   Fix guide alone: $25 (audit-first buyers pay the full $25 again — NO
//     $15 add-on, NO retroactive bundle discount; they should have bundled)
//   Bundle upfront (audit + guide): $40 (save $10 vs $50)
//   Done-for-you fixes: $100/hr, $200 minimum, estimate first.
"use strict";

// Existing audit product (DO NOT touch): "Website Tracking Audit"
// prod_VW346dr0Mb7ptF, $25 price_1UV0yMIlE5qVTzRelnUAgla3.
const PRICES = {
  audit: { amountCents: 2500, label: "Website Tracking Audit" },
  guide: { amountCents: 2500, label: "Tracking Fix Guide" },
  bundle: { amountCents: 4000, label: "Audit + Fix Guide Bundle" },
};

// Payment links. All three exist; the guide + bundle links were created
// in the Stripe Dashboard 2026-10-28 (connector writes were 403).
// The dashboard and the public tool hide the guide/bundle buttons while null;
// nothing in the unlock model depends on these URLs (purchases are
// recorded manually in the dashboard with their Stripe reference).
const LINKS = {
  audit: "https://buy.stripe.com/7sY6oH9zd5nR9tz2gQ4Ni00",
  guide: "https://buy.stripe.com/14AaEX5iXdUn8pvbRq4Ni01", // "Tracking Fix Guide" $25 prod_VWRDMSRid8pRnS
  bundle: "https://buy.stripe.com/00wdR99zdbMf49fbRq4Ni02", // "Audit + Fix Guide Bundle" $40 prod_VWRFcFTPsiid7F
};

const FIX_RATE_CENTS_PER_HOUR = 10000; // $100/hr
const FIX_MIN_CENTS = 20000; // $200 minimum

// Unlock lifecycle states (audits.unlock_status).
const UNLOCK_STATUSES = ["listed", "audit_paid", "guide_paid", "bundle_paid"];
const GUIDE_STATUSES = ["none", "draft", "ready", "delivered"];
const FIX_STATUSES = ["none", "quoted", "invoiced", "paid", "done"];

// What a recorded purchase of `kind` does to unlock_status. Returns the
// new status, or null when the transition is not allowed.
function unlockAfterPurchase(current, kind) {
  if (kind === "audit") {
    if (current === "listed") return "audit_paid";
    return null; // already paid for the audit (or bundled)
  }
  if (kind === "guide") {
    if (current === "bundle_paid") return null; // bundle already includes it
    return "guide_paid";
  }
  if (kind === "bundle") {
    if (current === "listed" || current === "audit_paid") return "bundle_paid";
    return null;
  }
  return null;
}

// Fix quote amount: hours x $100/hr, floored at the $200 minimum.
function fixAmountCents(hours) {
  const h = Number(hours);
  if (!isFinite(h) || h <= 0) throw new Error("hours must be a positive number");
  return Math.max(FIX_MIN_CENTS, Math.round(h * FIX_RATE_CENTS_PER_HOUR));
}

module.exports = {
  PRICES, LINKS, FIX_RATE_CENTS_PER_HOUR, FIX_MIN_CENTS,
  UNLOCK_STATUSES, GUIDE_STATUSES, FIX_STATUSES,
  unlockAfterPurchase, fixAmountCents,
};
