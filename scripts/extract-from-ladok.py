#!/usr/bin/env python3
"""Extract a KTH study plan from Ladok + KOPPS into the project's JSON format.

Combines two data sources:

- ladok3 (https://github.com/dbosk/ladok3) — programme structure, course
  period scheduling, credits, Swedish/English titles.
- KTH public kursplan pages (https://www.kth.se/student/kurser/kurs/<code>) —
  prerequisites (Särskild behörighet), examination moments, grading scale.

Auth: requires a one-time `ladok login` to cache credentials in the system
keyring. KOPPS/HTML scraping needs no auth.

Environment: talks to start.test.ladok.se by default — safer for iterating.
Pass --use-production-server to hit start.ladok.se instead. Note: ladok3's
CLI cannot pre-authenticate against the test environment, so test-env runs
construct a fresh session per invocation and trigger MFA every time.
Production-env runs reuse the session cached by ladok3.cli.get_session().

Output: candidate JSON written next to the verified files.
Existing src/data/<PROG>.json is NEVER overwritten — diff and merge by hand.

  src/data/<PROG>.ladok.json                       (single cohort)
  src/data/historical/<PROG>-HT<YY>.ladok.json     (--cohort-range mode)

Usage:
  python scripts/extract-from-ladok.py CTFYS
  python scripts/extract-from-ladok.py CTFYS --cohort HT25
  python scripts/extract-from-ladok.py CTFYS --cohort-range 2023-2025
  python scripts/extract-from-ladok.py CTFYS --use-production-server --verbose
  python scripts/extract-from-ladok.py CTFYS --list-rounds         # show all rounds, exit
  python scripts/extract-from-ladok.py CTFYS --round-uid <uuid>    # use this round exactly
  python scripts/extract-from-ladok.py CTFYS --inspect-round       # dump round record (incl. Link array)
  python scripts/extract-from-ladok.py CTFYS --inspect-programme   # dump resolved struktur tree

The extractor logs all field-shape guesses to stderr in --verbose mode so a
maintainer can correct the response-shape assumptions when LADOK or KOPPS
changes the contract.
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable

# Heavy deps (ladok3, requests, bs4) are imported lazily inside main() so
# that `--help` works on a fresh checkout before pip install.


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "src" / "data"

PERIOD_IDS = ("P1", "P2", "P3", "P4")

# Required for /utbildningsinformation/* endpoints (incl. struktur) — without
# this ladok3's get_query falls back to the resultat content type and Ladok
# rejects with HTTP 415.
LADOK_UTBILDNINGSINFO_CT = "application/vnd.ladok-utbildningsinformation+json"
COURSE_CODE_RE = re.compile(r"\b([A-Z]{1,3}[A-Z0-9]?[0-9]{3,4}[A-Z]?)\b")

log = logging.getLogger("extract")


# ---------------------------------------------------------------------------
# Generic helpers for navigating Ladok response shapes
# ---------------------------------------------------------------------------

def first_present(d: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Return d[k] for the first k that exists. Tolerates Ladok aliasing."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def benamning(node: dict[str, Any]) -> tuple[str | None, str | None]:
    """Pull (sv, en) names from a Ladok node.

    Ladok variously uses:
      - "Benamning": "Foo"                                  (string)
      - "Benamning": {"sv": ..., "en": ...}                  (dict)
      - "Benamningar": {"sv": ..., "en": ...}                (dict, common)
      - "Benamningar": [{"Sprakkod": "sv", "Text": ...}, …]  (list of entries)
    """
    sv = en = None
    b = node.get("Benamning")
    if isinstance(b, str):
        sv = b
    elif isinstance(b, dict):
        sv = b.get("sv") or b.get("SV")
        en = b.get("en") or b.get("EN")
    for arr_key in ("Benamningar", "Beskrivningar"):
        value = node.get(arr_key)
        if isinstance(value, dict):
            sv = sv or value.get("sv") or value.get("SV")
            en = en or value.get("en") or value.get("EN")
        elif isinstance(value, list):
            for entry in value:
                if not isinstance(entry, dict):
                    continue
                code = (entry.get("Sprakkod") or "").lower()
                text = entry.get("Text") or entry.get("Benamning")
                if code == "sv" and not sv:
                    sv = text
                elif code == "en" and not en:
                    en = text
    return sv, en


# ---------------------------------------------------------------------------
# Cohort handling
# ---------------------------------------------------------------------------

def parse_cohort_arg(s: str) -> tuple[str, int] | None:
    """Parse 'HT25' or 'VT26' → ('HT', 2025). Returns None on bad input."""
    m = re.fullmatch(r"(HT|VT)(\d{2,4})", s.strip().upper())
    if not m:
        return None
    term, year = m.group(1), int(m.group(2))
    if year < 100:
        year = 2000 + year
    return term, year


def cohort_matches_round(round_record: dict[str, Any], term: str, year: int) -> bool:
    """Does the Ladok round entry correspond to the requested HT/VT YYYY cohort?"""
    period = round_record.get("SammanslagenTillfallesperiod") or {}
    start = period.get("Startdatum") or ""
    if len(start) < 7:
        return False
    try:
        y = int(start[:4])
        m = int(start[5:7])
    except ValueError:
        return False
    if y != year:
        return False
    return (term == "HT" and m >= 7) or (term == "VT" and m < 7)


def default_cohort_for_today() -> tuple[str, int]:
    """Current läsår's cohort: HT if month ≥ 7, else VT of same calendar year."""
    today = datetime.date.today()
    if today.month >= 7:
        return ("HT", today.year)
    return ("HT", today.year - 1)  # Jan–Jun is the spring half of last autumn's cohort


# ---------------------------------------------------------------------------
# Ladok shape constants (verified against dbosk/ladok3 + cohm/academic-perf...)
# ---------------------------------------------------------------------------

# Hypermedia rel for a programme round's course-tree structure.
_REL_STRUKTUR = "http://relations.ladok.se/utbildningsinformation/struktur"

# KTH course codes:
#   - Regular courses:  2–3 letters + 4 digits, optional trailing letter
#     (SF1672, DD1331, SI1336, also SG1218X).
#   - Project / X-courses (bachelor & master theses): 2–3 letters + 3 digits + X
#     (SA114X, EF112X). The bachelor thesis VALBOX uses this 3-digit form and a
#     stricter 4-digit pattern silently drops it.
_KTH_COURSE_CODE_RE = re.compile(r"^[A-Z]{2,3}\d{3,4}[A-Z]?$")


def is_course_code(code: str) -> bool:
    """Distinguish a course (e.g. SF1672, SA114X) from a sub-programme code (e.g. LMAFI)."""
    return bool(_KTH_COURSE_CODE_RE.match((code or "").strip()))


def is_valid_round_code(code: str) -> bool:
    """Filter out special-purpose programme rounds.

    Regular cohort rounds use a numeric code (e.g. "50085") or "OP\\d+"
    (year-2 entry rounds). Codes like DTF*/DTM*/DFA*/DFY* are
    double-degree / exchange / partner-university rounds and should be
    skipped when extracting a study plan.
    """
    c = (code or "").strip()
    return c.isdigit() or bool(re.match(r"^OP\d+$", c, re.IGNORECASE))


def parse_tillfallesperioder(perioder: list[Any]) -> dict[str, float]:
    """Convert Ladok Tillfallesperioder into {P1:hp, P2:hp, ...}.

    Ladok uses two shapes depending on cohort vintage:

    1. **Structured** (HT25+): one `tp` entry per course-round, with a
       `Lasperiodsfordelning.Fordelningsposter` array of
       `{Lasperiodskod, Omfattningsvarde}` pairs.

    2. **Legacy / date-based** (HT23 and earlier): MULTIPLE `tp` entries,
       one per study period, each carrying `ForstaUndervisningsdatum`,
       `SistaUndervisningsdatum`, and `Omfattningsvarde` — no
       `Lasperiodsfordelning`. The period is implied by the start date.

    Both shapes are handled; credits across multiple entries sum together.
    """
    result: dict[str, float] = {}
    for tp in perioder or []:
        fordelningsposter = (tp.get("Lasperiodsfordelning") or {}).get("Fordelningsposter") or []
        if fordelningsposter:
            for fp in fordelningsposter:
                kod = fp.get("Lasperiodskod")
                try:
                    val = float(fp.get("Omfattningsvarde") or 0)
                except (TypeError, ValueError):
                    val = 0.0
                if kod in PERIOD_IDS and val > 0:
                    result[kod] = result.get(kod, 0.0) + val
            continue
        # Legacy shape: derive Lasperiodskod from ForstaUndervisningsdatum.
        start = tp.get("ForstaUndervisningsdatum") or tp.get("Startdatum")
        try:
            val = float(tp.get("Omfattningsvarde") or 0)
        except (TypeError, ValueError):
            val = 0.0
        if start and val > 0:
            kod = startdate_to_period(start)
            if kod in PERIOD_IDS:
                result[kod] = result.get(kod, 0.0) + val
    return result


def startdate_to_period(date_str: str) -> str | None:
    """Map a Startdatum (YYYY-MM-DD) to KTH study period P1–P4."""
    try:
        dt = datetime.datetime.strptime(date_str[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    m, d = dt.month, dt.day
    if m in (8, 9): return "P1"
    if m in (10, 11, 12): return "P2"
    if m in (1, 2): return "P3"
    if m == 3: return "P3" if d < 15 else "P4"
    return "P4"


# ---------------------------------------------------------------------------
# Ladok extraction
# ---------------------------------------------------------------------------

class LadokExtractor:
    def __init__(self, session: ladok3.LadokSession):
        self.ls = session

    # ----- programme-round selection -----

    def list_programme_rounds(self, program_code: str) -> list[dict[str, Any]]:
        """Fetch all programme rounds for a code, logging each one."""
        rounds = self.ls.program_rounds_JSON(program_code)
        log.info("Found %d programme rounds for %s:", len(rounds), program_code)
        for r in rounds:
            sv, en = benamning(r)
            rcode = r.get("Utbildningstillfalleskod") or ""
            keep = "✓" if is_valid_round_code(rcode) else "skip"
            log.info(
                "  [%s] Uid=%s code=%s startdatum=%s name=%s",
                keep, r.get("Uid"), rcode,
                (r.get("SammanslagenTillfallesperiod") or {}).get("Startdatum"),
                sv or en or "?",
            )
        return rounds

    def find_programme_round(
        self, program_code: str, term: str, year: int
    ) -> dict[str, Any] | None:
        """Pick the regular admission round matching the cohort.

        Multiple rounds can match a cohort: e.g. HT23 returns both a numeric
        code (32114 = regular admission, full struktur) and an OP* code
        (year-2 entry round for COPEN→main-programme transfers, no full
        struktur). Numeric codes win the sort so the study-plan extraction
        targets the regular admission round.
        """
        rounds = self.list_programme_rounds(program_code)
        matches = [
            r for r in rounds
            if is_valid_round_code(r.get("Utbildningstillfalleskod") or "")
            and cohort_matches_round(r, term, year)
        ]
        if not matches:
            return None
        # Numeric codes (regular admission) before OP* (year-2 entry).
        matches.sort(key=lambda r: (
            not (r.get("Utbildningstillfalleskod") or "").isdigit(),
            r.get("Utbildningstillfalleskod") or "",
        ))
        if len(matches) > 1:
            log.info(
                "Multiple rounds match %s%d — preferring the regular "
                "admission round. Use --round-uid <uid> to override.",
                term, year % 100,
            )
            for r in matches:
                marker = "→" if r is matches[0] else " "
                log.info(
                    "  %s Uid=%s code=%s startdatum=%s",
                    marker, r.get("Uid"), r.get("Utbildningstillfalleskod"),
                    (r.get("SammanslagenTillfallesperiod") or {}).get("Startdatum"),
                )
        sel = matches[0]
        log.info(
            "Selected round Uid=%s code=%s startdatum=%s",
            sel.get("Uid"), sel.get("Utbildningstillfalleskod"),
            (sel.get("SammanslagenTillfallesperiod") or {}).get("Startdatum"),
        )
        return sel

    # ----- struktur fetching -----

    def fetch_struktur(self, programme_round: dict[str, Any]) -> dict[str, Any]:
        """Follow the round's hypermedia struktur link.

        The rel is the full URI _REL_STRUKTUR, verified against the working
        reference implementation in cohm/academic-performance-portal.
        Fails loudly if the link is absent — silent fallbacks (e.g. to
        utbildningsinstans_underliggande) return master-specialisation
        trees instead of the cohort's course tree.
        """
        full = self.ls.program_round_by_uid_JSON(programme_round["Uid"])
        links = full.get("link") or full.get("Link") or []
        rels = [l.get("rel") or l.get("Rel") for l in links if isinstance(l, dict)]
        log.debug("Round %s exposes %d link rels", programme_round.get("Uid"), len(links))
        struktur_uri = next(
            (l.get("uri") or l.get("Uri")
             for l in links if isinstance(l, dict)
             and (l.get("rel") or l.get("Rel")) == _REL_STRUKTUR),
            None,
        )
        if not struktur_uri:
            raise RuntimeError(
                f"No struktur link on round {programme_round.get('Uid')}. "
                f"Rels seen: {rels}. "
                "Re-run with --inspect-round to dump the raw response."
            )
        log.info("Following struktur: %s", struktur_uri)
        return self.ls.fetch_linked_uri_JSON(struktur_uri, LADOK_UTBILDNINGSINFO_CT)

    # ----- struktur walking -----

    def iter_course_boxes(
        self,
        boxes: list[Any],
        valbox: dict[str, Any] | None = None,
        depth: int = 0,
        breadcrumb: str = "",
    ) -> Iterable[tuple[dict[str, Any], dict[str, Any] | None]]:
        """Yield (course_box, enclosing_valbox_or_None) leaves.

        Ladok struktur uses an Innehall list of typed boxes:
          - UTBILDNINGSTILLFALLESBOX = a course round OR a sub-programme link
          - VALBOX                   = elective container (children become options)
          - SEKVENSBOX etc.          = generic containers, recurse through

        Sub-programme references (inriktningar like LMAFI, or the
        kandidatexamensarbete container at KTH) have an Utbildningskod
        that does NOT match the course-code regex; we follow their own
        struktur link, allowing two levels of recursion so a sub-programme
        nested inside another sub-programme is still reached.

        The enclosing VALBOX is propagated so callers can group leaves into
        optionGroup entries by Python object identity.
        """
        for i, box in enumerate(boxes):
            boxtyp = box.get("Boxtyp", "")
            here = f"{breadcrumb}/{boxtyp}[{i}]"

            if boxtyp == "VALBOX":
                sv, _ = benamning(box)
                log.info("VALBOX %s  name=%r  %d children",
                         here, sv or "<anon>", len(box.get("Innehall") or []))

            child_valbox = box if boxtyp == "VALBOX" else valbox

            if boxtyp == "UTBILDNINGSTILLFALLESBOX":
                proj = box.get("UtbildningstillfalleProjektion") or {}
                code = proj.get("Utbildningskod", "")
                tillfalle_uid = box.get("UtbildningstillfalleUID", "")

                if is_course_code(code):
                    log.debug("  leaf %s  in VALBOX=%s", code, valbox is not None)
                    yield box, valbox
                elif tillfalle_uid and depth < 2:
                    # Sub-programme box (inriktning / kandidatexamensarbete /
                    # similar). Follow its own struktur. depth<2 so we can
                    # reach a sub-programme nested inside another sub-prog.
                    log.info("Following sub-programme %s code=%s depth=%d  at %s",
                             tillfalle_uid[:8], code, depth, here)
                    try:
                        sub_round = self.ls.program_round_by_uid_JSON(tillfalle_uid)
                        sub_links = sub_round.get("link") or sub_round.get("Link") or []
                        sub_uri = next(
                            (l.get("uri") or l.get("Uri")
                             for l in sub_links if isinstance(l, dict)
                             and (l.get("rel") or l.get("Rel")) == _REL_STRUKTUR),
                            None,
                        )
                        if sub_uri:
                            sub_data = self.ls.fetch_linked_uri_JSON(
                                sub_uri, LADOK_UTBILDNINGSINFO_CT
                            )
                            yield from self.iter_course_boxes(
                                sub_data.get("Innehall") or [],
                                valbox=child_valbox,  # propagate VALBOX context across sub-prog boundary
                                depth=depth + 1,
                                breadcrumb=f"{here}→{code}",
                            )
                        else:
                            rels = [(l.get("rel") or l.get("Rel"))
                                    for l in sub_links if isinstance(l, dict)]
                            log.warning("Sub-programme %s (%s): no struktur "
                                        "link. Rels: %s", code,
                                        tillfalle_uid[:8], rels)
                    except Exception as exc:
                        log.warning("sub-programme %s (%s): %s",
                                    code, tillfalle_uid[:8], exc)

            nested = box.get("Innehall")
            if nested:
                yield from self.iter_course_boxes(
                    nested, valbox=child_valbox, depth=depth, breadcrumb=here,
                )

    def walk_struktur(
        self,
        struktur: dict[str, Any],
        admission_year: int,
    ) -> list[dict[str, Any]]:
        """Walk the struktur tree, returning one leaf record per course.

        Each leaf carries everything needed to build a Course JSON entry:
        code, names, year-in-programme, period scheduling, period credits,
        whether it's a mandatory course or an elective option, and (for
        electives) the VALBOX node that anchors its option group.
        """
        leaves: list[dict[str, Any]] = []
        root_boxes = struktur.get("Innehall") or []
        log.info("Programme struktur has %d top-level boxes", len(root_boxes))

        for box, valbox in self.iter_course_boxes(root_boxes):
            proj = box.get("UtbildningstillfalleProjektion") or {}
            code = proj.get("Utbildningskod", "")
            cr_uid = box.get("UtbildningstillfalleUID", "")
            cv_uid = proj.get("UtbildningsinstansUID")
            start_str = box.get("Startdatum", "")

            # Names: Benamningar = {sv, en} dict, Benamning = sv string fallback.
            ben = proj.get("Benamningar") or {}
            name_sv = ben.get("sv") or proj.get("Benamning")
            name_en = ben.get("en")

            # Year-in-programme from Startdatum vs admission year.
            year_in_program: int | None = None
            period_from_startdate: str | None = None
            if start_str:
                try:
                    dt = datetime.datetime.strptime(start_str[:10], "%Y-%m-%d")
                    acad_year = dt.year if dt.month >= 7 else dt.year - 1
                    year_in_program = acad_year - admission_year + 1
                    period_from_startdate = startdate_to_period(start_str)
                except ValueError:
                    pass

            # Per-period HP breakdown comes from the course-round's
            # Tillfallesperioder. The course-version (utbildningsinstans)
            # endpoint doesn't carry it — empirically always None.
            # parse_tillfallesperioder handles both the structured shape
            # (HT25+) and the legacy date-based shape (HT23-).
            period_credits: dict[str, float] = {}
            if cr_uid:
                try:
                    ui = self.ls.course_round_utbildningsinformation_JSON(cr_uid)
                    period_credits = parse_tillfallesperioder(
                        ui.get("Tillfallesperioder") or []
                    )
                except Exception as exc:
                    log.warning("Tillfallesperioder for %s (%s…): %s",
                                code, cr_uid[:8], exc)
            log.debug("TP %s parsed=%s", code, period_credits)

            leaves.append({
                "code": code,
                "name_sv": name_sv,
                "name_en": name_en,
                "cr_uid": cr_uid,
                "cv_uid": cv_uid,
                "year": year_in_program or 1,
                "period_credits": period_credits,
                "period_from_startdate": period_from_startdate,
                "is_compulsory": valbox is None,
                "valbox": valbox,
            })
            log.debug("leaf %s year=%s pc=%s valbox=%s",
                      code, year_in_program, period_credits, valbox is not None)
        return leaves


# ---------------------------------------------------------------------------
# KOPPS enrichment (prerequisites, English fallback, grading, level)
# ---------------------------------------------------------------------------

class KoppsClient:
    """Thin wrapper around KOPPS HTTP endpoints + kursplan HTML scraping."""

    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "kth-programviz-extractor/1.0"
        self._cache: dict[str, dict[str, Any]] = {}

    def fetch(self, course_code: str) -> dict[str, Any]:
        if course_code in self._cache:
            return self._cache[course_code]
        info: dict[str, Any] = {"code": course_code}
        # Step 1: structured KOPPS basic course info.
        try:
            r = self.s.get(
                f"https://api.kth.se/api/kopps/v2/course/{course_code}",
                timeout=15,
            )
            if r.ok:
                payload = r.json()
                title = payload.get("title") or {}
                info["nameSv"] = title.get("sv")
                info["nameEn"] = title.get("en")
                info["credits"] = payload.get("credits")
                lvl = (payload.get("level") or {}).get("level")
                if lvl == "1":
                    info["courseLevel"] = "G"
                elif lvl == "2":
                    info["courseLevel"] = "A"
        except requests.RequestException as exc:
            log.warning("KOPPS v2/course/%s failed: %s", course_code, exc)

        # Step 2: scrape the public kursplan page for prerequisites + moments.
        try:
            r = self.s.get(
                f"https://www.kth.se/student/kurser/kurs/{course_code}",
                params={"l": "sv"}, timeout=20,
            )
            if r.ok:
                self._parse_kursplan_html(r.text, info)
        except requests.RequestException as exc:
            log.warning("kursplan page %s failed: %s", course_code, exc)

        self._cache[course_code] = info
        return info

    @staticmethod
    def _parse_kursplan_html(html: str, info: dict[str, Any]) -> None:
        soup = BeautifulSoup(html, "html.parser")
        # Prerequisites: KTH currently renders the section with a heading like
        # "Särskild behörighet" or "Förkunskapskrav". We look for any heading
        # containing those words and pull text from the next sibling.
        prereq_text = None
        for tag in soup.find_all(["h2", "h3", "h4"]):
            heading = tag.get_text(" ", strip=True).lower()
            if "förkunskap" in heading or "särskild behör" in heading or "behörighet" in heading:
                # Concatenate text until the next heading.
                buf: list[str] = []
                for sib in tag.next_siblings:
                    if getattr(sib, "name", None) in {"h2", "h3", "h4"}:
                        break
                    if hasattr(sib, "get_text"):
                        buf.append(sib.get_text(" ", strip=True))
                joined = " ".join(s for s in buf if s).strip()
                if joined:
                    prereq_text = joined
                    break
        if prereq_text:
            info["prereqText"] = prereq_text
            codes = sorted({m.group(1) for m in COURSE_CODE_RE.finditer(prereq_text)})
            # Drop the course's own code if it accidentally appears.
            codes = [c for c in codes if c != info.get("code")]
            info["prerequisitesCompleted"] = codes

        # Grading scale: searches for "Betygsskala" in dl/dt-style metadata.
        for tag in soup.find_all(["dt", "th", "strong"]):
            if tag.get_text(" ", strip=True).lower().startswith("betygsskala"):
                nxt = tag.find_next(["dd", "td", "span"])
                if nxt:
                    val = nxt.get_text(" ", strip=True).upper()
                    if "A" in val and "F" in val and "P" not in val.split(",")[0]:
                        info["gradingScale"] = "A-F"
                    elif "P" in val and "F" in val:
                        info["gradingScale"] = "P/F"
                    elif "VG" in val:
                        info["gradingScale"] = "VG/G/U"
                    break


# ---------------------------------------------------------------------------
# Building the final JSON
# ---------------------------------------------------------------------------

def build_course_entry(
    leaf: dict[str, Any], kopps: dict[str, Any] | None
) -> dict[str, Any]:
    pc = dict(leaf["period_credits"] or {})
    # Make sure all four periods are present (validator tolerates 0).
    for p in PERIOD_IDS:
        pc.setdefault(p, 0.0)
    total_pc = sum(pc.values())
    total = total_pc or float((kopps or {}).get("credits") or 0)

    if total_pc == 0 and leaf.get("period_from_startdate"):
        # Tillfallesperioder was empty — fall back to the Startdatum-derived
        # period bucket, using KOPPS credits if available.
        p = leaf["period_from_startdate"]
        pc[p] = float((kopps or {}).get("credits") or 0)
        total = pc[p]
        log.warning(
            "%s: no Tillfallesperioder; placed full %s hp in %s from Startdatum",
            leaf["code"], total, p,
        )

    entry: dict[str, Any] = OrderedDict()
    entry["code"] = leaf["code"]
    entry["name"] = leaf.get("name_sv") or (kopps or {}).get("nameSv") or ""
    name_en = leaf.get("name_en") or (kopps or {}).get("nameEn")
    if name_en:
        entry["nameEn"] = name_en
    entry["totalCredits"] = round(total, 2)
    entry["periodCredits"] = {p: round(pc[p], 2) for p in PERIOD_IDS}
    entry["year"] = leaf.get("year") or 1

    if kopps and kopps.get("prerequisitesCompleted"):
        entry["prerequisitesCompleted"] = kopps["prerequisitesCompleted"]
    else:
        entry["prerequisites"] = []

    # Exams and reexams stay manual (need läsårets förläggning verification).
    entry["exams"] = []

    if kopps and kopps.get("courseLevel"):
        entry["courseLevel"] = kopps["courseLevel"]
    if kopps and kopps.get("gradingScale"):
        entry["gradingScale"] = kopps["gradingScale"]
    return entry


def build_option_group(
    valbox: dict[str, Any],
    leaves_in_group: list[dict[str, Any]],
    fallback_name_sv: str,
    fallback_name_en: str,
) -> dict[str, Any]:
    options = [leaf["code"] for leaf in leaves_in_group if leaf.get("code")]
    sv, en = benamning(valbox)
    # totalCredits: prefer the VALBOX's own Omfattning, else fall back to the
    # period-credit sum of the first option (works when all options share
    # the same slot, e.g. the SA114X / EF112X bachelor thesis).
    total = first_present(valbox, "Omfattning", "Omfattningsvarde")
    if isinstance(total, str):
        try:
            total = float(total)
        except ValueError:
            total = None
    if not total and leaves_in_group:
        total = sum(leaves_in_group[0]["period_credits"].values()) or 0

    pc = {p: 0.0 for p in PERIOD_IDS}
    if leaves_in_group:
        for p, hp in (leaves_in_group[0]["period_credits"] or {}).items():
            if p in PERIOD_IDS:
                pc[p] = float(hp)

    entry: dict[str, Any] = OrderedDict()
    entry["type"] = "optionGroup"
    entry["name"] = sv or fallback_name_sv
    entry["nameEn"] = en or fallback_name_en
    entry["year"] = leaves_in_group[0]["year"] if leaves_in_group else 1
    entry["totalCredits"] = float(total or 0)
    entry["periodCredits"] = {p: round(pc[p], 2) for p in PERIOD_IDS}
    entry["options"] = options
    entry["allowedNumberOfOptions"] = 1
    entry["kind"] = "pickN"
    entry["pickN"] = 1
    entry["exams"] = []
    return entry


def assemble_json(
    leaves: list[dict[str, Any]],
    kopps: KoppsClient,
    skip_kopps: bool,
) -> list[dict[str, Any]]:
    # Group leaves by enclosing VALBOX (Python identity).
    bare: list[dict[str, Any]] = []
    grouped: dict[int, list[dict[str, Any]]] = {}
    for leaf in leaves:
        vb = leaf.get("valbox")
        if vb is not None:
            grouped.setdefault(id(vb), []).append(leaf)
        else:
            bare.append(leaf)

    out: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    for leaf in bare:
        code = leaf.get("code")
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        k = None if skip_kopps else kopps.fetch(code)
        out.append(build_course_entry(leaf, k))

    # OptionGroup entries: emit the group itself, then each option as a
    # Course entry (validator requires options[] to reference real courses).
    # `grouped` iterates in insertion order, which is the order each VALBOX
    # was first encountered while walking — i.e. chronological through the
    # programme — so the "Valbart block N" numbering matches study order.
    anon_n = 0
    for leaves_in_group in grouped.values():
        valbox = leaves_in_group[0]["valbox"]
        sv, _ = benamning(valbox)
        if sv:
            fallback_sv = fallback_en = ""  # ignored when Benamning is present
        else:
            anon_n += 1
            fallback_sv = f"Valbart block {anon_n}"
            fallback_en = f"Optional block {anon_n}"
        out.append(build_option_group(valbox, leaves_in_group,
                                      fallback_sv, fallback_en))
        for leaf in leaves_in_group:
            code = leaf.get("code")
            if not code or code in seen_codes:
                continue
            seen_codes.add(code)
            k = None if skip_kopps else kopps.fetch(code)
            out.append(build_course_entry(leaf, k))

    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("program", help="Programme code, e.g. CTFYS")
    cohort_group = p.add_mutually_exclusive_group()
    cohort_group.add_argument("--cohort", help="Specific cohort, e.g. HT25")
    cohort_group.add_argument(
        "--cohort-range",
        help="Range of HT cohorts to extract (inclusive), e.g. 2016-2025",
    )
    p.add_argument(
        "--use-production-server", action="store_true",
        help="Talk to start.ladok.se. Default is the test environment "
             "start.test.ladok.se — bootstrap that with `ladok login`.",
    )
    p.add_argument("--skip-kopps", action="store_true",
                   help="Skip the KOPPS prerequisite-enrichment pass")
    p.add_argument("--list-rounds", action="store_true",
                   help="List all programme rounds Ladok knows for this code and exit")
    p.add_argument("--round-uid",
                   help="Bypass cohort selection and use this exact programme-round Uid")
    p.add_argument("--inspect-round", action="store_true",
                   help="Dump the raw programme-round record (incl. Link array) and exit")
    p.add_argument("--inspect-programme", action="store_true",
                   help="Dump the resolved programme struktur tree as JSON and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--output-dir", default=str(DATA_DIR),
                   help=f"Directory for the candidate JSON (default: {DATA_DIR})")
    return p.parse_args(argv)


def resolve_cohorts(args: argparse.Namespace) -> list[tuple[str, int]]:
    if args.cohort_range:
        m = re.fullmatch(r"(\d{4})-(\d{4})", args.cohort_range)
        if not m:
            sys.exit("--cohort-range must look like 2016-2025")
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return [("HT", y) for y in range(lo, hi + 1)]
    if args.cohort:
        parsed = parse_cohort_arg(args.cohort)
        if not parsed:
            sys.exit(f"--cohort must look like HT25 or VT26 (got {args.cohort!r})")
        return [parsed]
    return [default_cohort_for_today()]


def output_path(
    program: str, term: str, year: int, is_range: bool, output_dir: Path
) -> Path:
    if is_range:
        return output_dir / "historical" / f"{program}-{term}{year % 100:02d}.ladok.json"
    return output_dir / f"{program}.ladok.json"


def _import_heavy_deps() -> None:
    """Import ladok3 / requests / bs4 lazily so --help works without them."""
    global ladok3, requests, BeautifulSoup
    try:
        import ladok3 as _ladok3
        import ladok3.cli  # noqa: F401
        ladok3 = _ladok3
    except ImportError:
        sys.exit(
            "error: ladok3 is not installed. Run:\n"
            "  python3 -m venv .venv && source .venv/bin/activate\n"
            "  pip install -r scripts/requirements.txt\n"
        )
    try:
        import requests as _requests
        from bs4 import BeautifulSoup as _BS
        requests = _requests
        BeautifulSoup = _BS
    except ImportError:
        sys.exit(
            "error: requests / beautifulsoup4 not installed. Run:\n"
            "  python3 -m venv .venv && source .venv/bin/activate\n"
            "  pip install -r scripts/requirements.txt\n"
        )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
        stream=sys.stderr,
    )

    # weblogin's AzureMFA handler prints the MFA number via subprocess
    # (figlet → fallback to plain `print()` on stdout). When the user
    # redirects our stdout (e.g. `--inspect-programme > file.json`), the
    # MFA number disappears into that file. Force the notification to the
    # controlling terminal so it's visible regardless of redirection.
    if not sys.stdout.isatty() and "WEBLOGIN_MFA_NOTIFICATION" not in os.environ:
        os.environ["WEBLOGIN_MFA_NOTIFICATION"] = (
            "sh -c 'printf \"\\n*** MFA: %s ***\\n\\n\" \"$1\" > /dev/tty' _"
        )
        log.info(
            "stdout is redirected — MFA number will be printed on the "
            "controlling terminal (/dev/tty), not in the output file."
        )

    _import_heavy_deps()

    test_environment = not args.use_production_server
    env_name = "TEST" if test_environment else "PRODUCTION"
    log.info(
        "Want Ladok %s environment. `ladok login` caches credentials only; "
        "the CLI has no flag to pre-authenticate against a specific env, "
        "so test-env runs construct a fresh session and trigger MFA "
        "every time.", env_name,
    )

    # Prefer the cached session from `ladok login` — it has cookies attached.
    # Only fall back to constructing a fresh session (which forces a full
    # re-authentication, including a new MFA round) if the cached env
    # doesn't match what was requested.
    ls = None
    try:
        cached_ls, _ = ladok3.cli.get_session()
        cached_is_test = "test.ladok.se" in cached_ls.base_url
        if cached_is_test == test_environment:
            log.info("Reusing cached session for %s", cached_ls.base_url)
            ls = cached_ls
        else:
            log.warning(
                "Cached session is %s but you asked for %s — will construct "
                "a fresh session (MFA prompt expected). To skip MFA each "
                "run, use --use-production-server (reuses the cached prod "
                "session).",
                "TEST" if cached_is_test else "PRODUCTION", env_name,
            )
    except Exception as exc:
        log.debug("get_session() failed: %s", exc)

    if ls is None:
        try:
            creds = ladok3.cli.load_credentials()
            ls = ladok3.LadokSession(*creds, test_environment=test_environment)
        except Exception as exc:
            sys.exit(
                f"failed to open Ladok session: {exc}\n"
                "Hint: run `ladok login` first to cache credentials."
            )

    extractor = LadokExtractor(ls)
    kopps = KoppsClient()
    output_dir = Path(args.output_dir).resolve()

    # --list-rounds: just enumerate and exit.
    if args.list_rounds:
        extractor.list_programme_rounds(args.program)
        return 0

    # Build the iteration plan: either one explicit round (--round-uid) or
    # one entry per cohort. Each entry is (term, year, round_record_or_None).
    plan: list[tuple[str, int, dict[str, Any] | None]] = []
    is_range = bool(args.cohort_range)
    if args.round_uid:
        try:
            round_record = ls.program_round_by_uid_JSON(args.round_uid)
        except Exception as exc:
            sys.exit(f"failed to fetch round {args.round_uid}: {exc}")
        start = (round_record.get("SammanslagenTillfallesperiod") or {}).get("Startdatum") or ""
        try:
            y = int(start[:4])
        except ValueError:
            y = 0
        plan.append(("HT" if not start[5:7] or int(start[5:7]) >= 7 else "VT", y, round_record))
    else:
        for term, year in resolve_cohorts(args):
            plan.append((term, year, None))
        log.info("Extracting %s for cohorts: %s",
                 args.program, ", ".join(f"{t}{y % 100:02d}" for t, y, _ in plan))

    written: list[Path] = []
    for term, year, round_record in plan:
        if round_record is None:
            round_record = extractor.find_programme_round(args.program, term, year)
        if not round_record:
            log.warning("No %s%d programme round found for %s — skipping",
                        term, year % 100, args.program)
            continue
        if args.inspect_round:
            json.dump(
                ls.program_round_by_uid_JSON(round_record["Uid"]),
                sys.stdout, indent=2, ensure_ascii=False,
            )
            sys.stdout.write("\n")
            return 0
        try:
            struktur = extractor.fetch_struktur(round_record)
        except Exception as exc:
            log.error("Failed to fetch struktur for %s%d: %s", term, year % 100, exc)
            continue
        if args.inspect_programme:
            json.dump(struktur, sys.stdout, indent=2, ensure_ascii=False)
            sys.stdout.write("\n")
            return 0
        # Admission year drives the year-in-programme calculation for each leaf.
        admission_year = year
        if admission_year < 1900:
            start = (round_record.get("SammanslagenTillfallesperiod") or {}).get("Startdatum") or ""
            try:
                admission_year = int(start[:4])
            except (TypeError, ValueError):
                admission_year = datetime.date.today().year
        leaves = extractor.walk_struktur(struktur, admission_year=admission_year)
        log.info("Walked %d leaf course nodes", len(leaves))
        entries = assemble_json(leaves, kopps, args.skip_kopps)
        out_path = output_path(args.program, term, year, is_range, output_dir)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", encoding="utf-8") as fh:
            json.dump(entries, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        log.info("Wrote %d entries → %s", len(entries), out_path)
        written.append(out_path)

    if not written:
        log.error("Nothing was written.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
