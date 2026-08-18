#!/usr/bin/env python3
"""Convert the approved NEDS Q&A spreadsheet into data/faq.json.

This is the Python side of the split: an OFFLINE tool that turns the source of
truth (John's xlsx) into the JSON the TypeScript service reads. It does not run
in the request path and shares no runtime with the service.

Usage:
    python3 tooling/ingest_xlsx.py path/to/neds-qa.xlsx

Expected columns (case-insensitive, flexible):
    question | answer            (required)
    keywords                     (optional; comma/semicolon separated)
    id                           (optional; auto-slugged from question if absent)

Writes data/faq.json in the shape the service expects. Run the service after to
pick up the new knowledge.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError:
    sys.exit(
        "openpyxl is required. Create a venv and install it:\n"
        "  python3 -m venv tooling/.venv\n"
        "  tooling/.venv/bin/pip install -r tooling/requirements.txt"
    )

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "faq.json"


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:48] or "faq"


def norm(header: str) -> str:
    return re.sub(r"[^a-z]", "", (header or "").lower())


def main(xlsx_path: str) -> None:
    wb = load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)

    header = [norm(str(c)) for c in next(rows)]

    def col(name: str) -> int | None:
        return header.index(name) if name in header else None

    q_i, a_i = col("question"), col("answer")
    k_i, id_i = col("keywords"), col("id")
    if q_i is None or a_i is None:
        sys.exit("Spreadsheet must have 'question' and 'answer' columns.")

    faqs = []
    seen: set[str] = set()
    for row in rows:
        q = (row[q_i] or "").strip() if q_i < len(row) else ""
        a = (row[a_i] or "").strip() if a_i < len(row) else ""
        if not q or not a:
            continue
        fid = (row[id_i] if id_i is not None and id_i < len(row) else None) or slug(q)
        fid = str(fid)
        while fid in seen:
            fid += "-x"
        seen.add(fid)
        kw_raw = row[k_i] if k_i is not None and k_i < len(row) else ""
        keywords = [w.strip().lower() for w in re.split(r"[,;]", str(kw_raw or "")) if w.strip()]
        faqs.append({"id": fid, "question": q, "answer": a, "keywords": keywords})

    payload = {
        "_note": f"Generated from {Path(xlsx_path).name} by tooling/ingest_xlsx.py. Do not edit by hand.",
        "faqs": faqs,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(faqs)} Q&A entries to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 tooling/ingest_xlsx.py path/to/neds-qa.xlsx")
    main(sys.argv[1])
