#!/usr/bin/env python3
"""Convert the reviewed NEDS pricing sheet into data/prices.json.

This is the Python side of the split: an OFFLINE tool (see the "Stack split"
note in CLAUDE.md) that turns the source of truth for prices — the
"NEDS pricing review" CSV, reconciled from CWHR010 and the Chartwise Order
Hub catalogue, then signed off row-by-row in the two JOHN columns — into the
JSON the TypeScript service reads. It does not run in the request path.

Usage:
    python3 tooling/ingest_prices_csv.py path/to/NEDS-prices.csv

Row shape: a "Ref" short-code (e.g. "C1-1"), a "Service" (maps to a
data/services.json id), an "Item" description, Ex VAT / Inc VAT / All-in /
Deposit amounts, a free-text notes column, and the two JOHN review columns
("✎ JOHN — amend to", "✎ JOHN — OK? (Y/N)"). Every row in this sheet has
been reviewed to one of:
  - OK "Y"     — approved as shown.
  - OK "Amend" — approved once ROW_OVERRIDES below applies John's correction.
Rows whose Status is "Excluded" (not an actual NEDS offering — e.g. the taxi
medical) are dropped, and rows with no price at all (a note-only correction,
not a line item — e.g. the stray "Free for members" note) are skipped.
Section-header banner lines (course-category headings with no Service/Item)
are skipped structurally.

The quoted customer-facing amount is the "Inc VAT £" price for the item as
literally described — NOT the "All-in / package £" figure, which is usually
a *different*, larger bundle (e.g. training + medical + theory tests) than
the plain item in that row; quoting it under this row's label would misstate
what it buys. That bundle price is preserved in the row's own notes text
instead, which the model may mention as a supporting detail.

Writes data/prices.json in the shape the service expects. Restart the service
after to pick up new prices.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "prices.json"

# Service (CSV) -> serviceId (data/services.json). "Cat C / CE" (the shared
# driving-assessment row, Ref C-5) is handled via MULTI_SERVICE_REFS instead,
# since it applies to three services at once, not a single mapped id.
SERVICE_MAP = {
    "Cat C1": "hgv-c1",
    "Cat C": "hgv-c",
    "Cat C+E": "hgv-ce",
    "Cat C → C+E": "hgv-ce",  # combined package — end qualification is C+E
    "B+E": "be",
    "Driver CPC": "driver-cpc",
    "Initial CPC": "driver-cpc",  # no separate service; a Driver CPC sub-item
    "ADR": "adr",
    "Forklift": "forklift",
    "Medical": "driver-medical",
}
MULTI_SERVICE_REFS = {"C-5": ["hgv-c1", "hgv-c", "hgv-ce"]}

EXCLUDED_STATUS_PREFIXES = ("excluded",)

# Hand-reviewed corrections for the rows John marked "Amend", plus the rows
# where the sheet's own review commentary ("CHECK ...", "Confirm ...") would
# otherwise leak into a fact the model reads verbatim. Kept as an explicit
# table rather than a text-stripping heuristic, since each of these was a
# genuine judgment call, not a mechanical transform — see the CSV's Status/
# JOHN columns for the discrepancy each one resolves.
ROW_OVERRIDES: dict[str, dict] = {
    "C1-4": {"note": None},  # drop the internal Order-Hub line-code reference
    "C-5": {
        "note": "A medical is needed first if you're on a provisional licence.",
    },
    "CPC-3": {
        "note": "Delivered via Enterprise Training. Returning to driving after a break is charged at £80 inc VAT.",
    },
    "ICPC-3": {
        "note": "This reduced £60 rate applies when booked alongside a Cat C or Cat C+E package; Cat C1 customers pay the full £144 Mod 4 hire rate.",
    },
    "FLT-0": {
        "label": "1 Day Training",
        "amountGBP": 595.0,
        "unit": "per day (from)",
        "note": "Advertised as a starting/'from' price — actual cost depends on group size and experience level.",
    },
    "MED-1": {"note": "No VAT. Available Monday to Friday."},
}


def money(raw: str) -> float | None:
    raw = (raw or "").strip().replace("£", "").replace(",", "")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def infer_unit(item: str) -> str:
    # Word-boundary matches, checked most-specific-first — e.g. "hire" must
    # win over a bare "pack" substring match inside "package".
    low = item.lower()
    if re.search(r"\bmedical\b", low):
        return "per medical"
    if re.search(r"\bhire\b", low):
        return "per hire"
    if re.search(r"\bassessment\b", low):
        return "per assessment"
    if "candidate" in low and re.search(r"\bmodule\b", low):
        return "per candidate per module"
    if re.search(r"\bmodule\b", low):
        return "per module"
    if re.search(r"\bcard\b", low):
        return "per card"
    if "extra tuition day" in low:
        return "per extra day"
    if "group booking" in low or "block booking" in low:
        return "per day"
    if "resit" in low or "single day" in low:
        return "per day"
    if re.search(r"training package|combined package|\bpack\b", low):
        return "per course"
    return "per course"


def build_entry(row: list[str]) -> dict | None:
    ref, service, item, ex_vat, _vat, inc_vat, _all_in, deposit, notes, _source, status, _amend_to, ok = row

    status_l = status.strip().lower()
    if status_l.startswith(EXCLUDED_STATUS_PREFIXES):
        return None

    ok_l = ok.strip().lower()
    if ok_l not in ("y", "amend"):
        # Every row in this reviewed sheet is Y or Amend; anything else is
        # genuinely unreviewed and not safe to quote yet.
        return None

    amount = money(inc_vat) or money(ex_vat)
    if amount is None:
        return None  # note-only correction row, not an actual line item

    label = item.strip()
    unit = infer_unit(item)
    note_parts = [notes.strip()] if notes.strip() else []
    if deposit.strip():
        note_parts.append(f"Deposit {deposit.strip()} required.")

    override = ROW_OVERRIDES.get(ref, {})
    if "label" in override:
        label = override["label"]
    if "amountGBP" in override:
        amount = override["amountGBP"]
    if "unit" in override:
        unit = override["unit"]
    if "note" in override:
        note_parts = [override["note"]] if override["note"] else []

    service_ids = MULTI_SERVICE_REFS.get(ref, [SERVICE_MAP.get(service)])
    service_ids = [s for s in service_ids if s]
    if not service_ids:
        sys.exit(f"No serviceId mapping for CSV Service '{service}' (Ref {ref}).")

    return {
        "ref": ref,
        "service_ids": service_ids,
        "label": label,
        "amountGBP": amount,
        "unit": unit,
        "note": " ".join(note_parts).strip() or None,
    }


def main(csv_path: str) -> None:
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))

    header_i = next(i for i, r in enumerate(rows) if r and r[0].strip() == "Ref")
    data_rows = rows[header_i + 1 :]

    prices = []
    skipped_header = skipped_excluded = skipped_unreviewed = skipped_no_price = 0
    for row in data_rows:
        if not row or len(row) < 13:
            continue
        ref, service, item = row[0].strip(), row[1].strip(), row[2].strip()
        if not service and not item:
            skipped_header += 1  # section-header banner row
            continue
        if not ref:
            continue

        status_l = row[10].strip().lower()
        ok_l = row[12].strip().lower()
        entry = build_entry(row)
        if entry is None:
            if status_l.startswith(EXCLUDED_STATUS_PREFIXES):
                skipped_excluded += 1
            elif ok_l not in ("y", "amend"):
                skipped_unreviewed += 1
            else:
                skipped_no_price += 1
            continue

        multi = len(entry["service_ids"]) > 1
        for service_id in entry["service_ids"]:
            price_id = f"{entry['ref'].lower()}-{service_id}" if multi else entry["ref"].lower()
            prices.append(
                {
                    "id": price_id,
                    "serviceId": service_id,
                    "label": entry["label"],
                    "amountGBP": entry["amountGBP"],
                    "unit": entry["unit"],
                    **({"note": entry["note"]} if entry["note"] else {}),
                }
            )

    payload = {
        "_note": (
            f"Generated from {Path(csv_path).name} by "
            "tooling/ingest_prices_csv.py. Reconciled from CWHR010, the "
            "Chartwise Order Hub catalogue, and John's corrections; every "
            "row is reviewed (JOHN OK = Y or Amend). amountGBP is the "
            "Inc VAT price for the item as described in its own label — "
            "NOT the sheet's separate All-in/package figure, which is "
            "usually a different, larger bundle and is described in the "
            "row's own note instead where relevant. Do not edit by hand — "
            "re-run the ingest script instead."
        ),
        "prices": prices,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(prices)} price entries to {OUT.relative_to(ROOT)}")
    print(
        f"Skipped: {skipped_header} section headers, {skipped_excluded} excluded, "
        f"{skipped_unreviewed} not reviewed, {skipped_no_price} no price given"
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 tooling/ingest_prices_csv.py path/to/NEDS-prices.csv")
    main(sys.argv[1])
