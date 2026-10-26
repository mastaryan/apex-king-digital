#!/usr/bin/env python3
"""Dashboard invoicing pass — delegates to the dashboard's review gate.

The gate lives in the dashboard service (invoices.js): at 45 days out it
creates a DRAFT renewal invoice and nudges Ryan; at 30 days out an
untouched draft sends itself. This module just triggers it from the daily
cron and reports what happened, preserving the old interface for
reminders.py: process_invoices(sites, state) -> [{"key": "invoice:<site>:<year>", ...}]
for invoices sent during this run.

Env: DASHBOARD_URL, DASHBOARD_TOKEN (or API_TOKEN in ./.secrets.env).
DRYRUN=1 prints the sites currently inside the gate windows.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import date, datetime

BASE = os.environ.get("DASHBOARD_URL", "https://dashboard.apexkingdigital.com").rstrip("/")
TOKEN = os.environ.get("DASHBOARD_TOKEN", "")


def _token() -> str:
    global TOKEN
    if TOKEN:
        return TOKEN
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        for line in open(os.path.join(here, ".secrets.env")):
            line = line.strip()
            if line.startswith("API_TOKEN="):
                TOKEN = line.split("=", 1)[1]
    except Exception:
        pass
    return TOKEN


def process_invoices(sites: list, state: dict, dryrun: bool = False) -> list:
    """Trigger the dashboard review gate; return records for invoices sent."""
    if dryrun:
        today = date.today()
        for s in sites:
            dues = [s.get(k) for k in ("domainRenewal", "hostingRenewal") if s.get(k)]
            for ds in dues:
                try:
                    due = datetime.strptime(ds, "%Y-%m-%d").date()
                except ValueError:
                    continue
                days = (due - today).days
                if 0 <= days <= 45 and (s.get("clientEmail") or "").strip():
                    print(f"[dryrun] gate window: {s.get('name')} renewal {ds} in {days}d")
        return []
    tok = _token()
    if not tok:
        print("invoice gate skipped: no DASHBOARD_TOKEN/API_TOKEN", file=sys.stderr)
        return []
    req = urllib.request.Request(
        BASE + "/api/invoice-gate/run",
        data=b"{}",
        method="POST",
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        summary = json.load(r)
    for d in summary.get("drafted", []):
        print(f"invoice draft created: {d.get('site')} (renews {d.get('renewal')})")
    for w in summary.get("waiting", []):
        print(f"invoice waiting approval: {w.get('site')} ({w.get('reason')})")
    out = []
    for snt in summary.get("sent", []):
        print(f"invoice sent: {snt.get('site')}")
        out.append({"key": snt.get("key"), "id": snt.get("id"), "site": snt.get("site")})
    for err in summary.get("errors", []):
        print(f"invoice gate error for {err.get('site')}: {err.get('error')}", file=sys.stderr)
    return out


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--dryrun", action="store_true")
    ap.add_argument("--sites-json")
    ns = ap.parse_args(argv)
    sites = []
    if ns.sites_json:
        sites = json.load(open(ns.sites_json))
    else:
        tok = _token()
        req = urllib.request.Request(BASE + "/api/sites", headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=30) as r:
            sites = json.load(r)
    new = process_invoices(sites, {}, dryrun=ns.dryrun)
    print(json.dumps({"sent": len(new), "invoices": new}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
