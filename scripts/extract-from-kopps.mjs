#!/usr/bin/env node
// Build a candidate `src/data/<PROG>.json` from KTH's public study-plan data.
//
// Usage:
//   node scripts/extract-from-kopps.mjs CTFYS
//   node scripts/extract-from-kopps.mjs CINEK --years 3
//   node scripts/extract-from-kopps.mjs CTFYS --lasar 2024
//   node scripts/extract-from-kopps.mjs CTFYS --specializations   # programs.json snippet
//   node scripts/extract-from-kopps.mjs CTFYS --dump-state 2      # raw SSR state, then exit
//
// Output goes to `extracted/<PROG>.kopps.json` — a *candidate* for human
// diff-and-merge. The verified `src/data/<PROG>.json` is never touched.
// Validate a candidate with:
//   node scripts/validate-data.mjs --include CTFYS=extracted/CTFYS.kopps.json
//
// Candidates must NOT be written into `src/data/`. `useCourseModel.ts` loads
// program data with `await import(`@/data/${dataFile}`)` — a dynamic import with
// a template literal, so the bundler builds a context module over the whole
// directory and every JSON file in it lands in the client bundle whether or not
// anything references it. Measured: six candidate files in `src/data/` grew the
// brotlied client JS from 201.33 kB to 212.87 kB and shipped unverified course
// data to browsers. A top-level directory keeps them out of the graph entirely.
//
// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
//
// 1. The study plan — `kth.se/student/kurser/program/<PROG>/<TERM>/arskurs<N>`.
//    These pages are server-rendered and carry their whole render state as one
//    percent-encoded JSON blob in the HTML. That blob holds `curriculumInfos`:
//    one entry per inriktning plus a COMMON entry, each with `participations`
//    keyed by `electiveCondition`, each participation carrying
//    `creditsPerPeriod`. This is structured data, not prose — we decode it
//    rather than scraping text.
//
//    This is an *undocumented internal payload*. There is no public JSON
//    endpoint (probed: /api/programme/…, /api/curriculum/…, `.json` suffixes —
//    all 404). It can change without notice, so every assumption about its
//    shape is asserted in `readCurriculum()` below: a format change then fails
//    loudly instead of silently producing wrong credits.
//
// 2. KOPPS course API — `api.kth.se/api/kopps/v2/course/<CODE>` for the English
//    title, and `/detailedinformation` for grading scale, cycle level and the
//    examination modules used to decide `exams`. The study-plan page's own
//    `/en/` route returns HTTP 500, so English titles must come from here.
//
// 3. KOPPS programme API — `api.kth.se/api/kopps/v2/programme/<PROG>/<TERM>`
//    returns the inriktning registry (code + sv/en names), which is the shape
//    `programs.json` → `specializations` already expects.
//
// ---------------------------------------------------------------------------
// Why one läsår is assembled from several cohorts
// ---------------------------------------------------------------------------
//
// `creditsPerPeriod` is only populated for läsår that are actually scheduled.
// Asking cohort 20252 about its year 3 returns all-zero arrays, because that
// year falls in 2027/28.
//
// `academic-periods.json` holds one läsår at a time, so we assemble the same
// way the app renders: study year N comes from the cohort currently taking it.
// For läsår 2025/26 that is y1←20252, y2←20242, y3←20232. Rolling to a new
// läsår is then just the `--lasar` default moving, mirroring the shift that
// `academic-periods.json` needs anyway.
//
// This composition is FORCED, not merely tidy. KTH publishes each cohort's plan
// only for the year it is currently taking (plus future years, without period
// data), and drops the years it has passed. Measured on CTFYS year 1: cohorts
// 20252 and 20262 return course participations, while 20242 and every older
// cohort return zero — yet cohort 20242 *does* answer for year 2, and 20232 for
// year 3. Asking one cohort for all its years therefore cannot work in either
// direction: past years are gone and future years have no period data.
//
// The corollary is that this extractor can only ever describe the current and
// upcoming läsår. Historical study plans are not recoverable from here; the
// sibling academic-performance-portal reached the same conclusion for the
// läsårsindelning ("a search of kth.se, intra.kth.se and the period calendar in
// August 2026 found nothing before 2024-25").
//
// Years 4-5 are deliberately not extracted. Both curated files stop at year 3,
// and KTH says why in the year-4 payload's own `supplementaryInformation`:
// "Utbildningens två sista år läses inom ramen för ett masterprogram." Those
// years belong to a different programme code.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dataDir = join(repoRoot, 'src', 'data');
// Deliberately outside src/data — see the note on bundling in the header.
const outDir = join(repoRoot, 'extracted');

const PERIOD_IDS = ['P1', 'P2', 'P3', 'P4'];

// `creditsPerPeriod` is a 6-element array indexed [P0, P1, P2, P3, P4, P5].
// Index 0 is the summer period, so P1..P4 live at indices 1..4. Credits landing
// in P0/P5 are reported rather than silently dropped.
const CPP_LENGTH = 6;
const CPP_P1_OFFSET = 1;

// Kopps `electiveCondition`, per *Riktlinje om utbildningsplan*.
const COND_MANDATORY = 'O';             // obligatorisk
const COND_CONDITIONAL = 'VV';          // villkorligt valfri
const COND_ELECTIVE = 'V';              // valfri
const KNOWN_CONDITIONS = new Set([COND_MANDATORY, COND_CONDITIONAL, COND_ELECTIVE]);

// Examination-module prefixes that occupy a scheduled examination slot, and so
// justify an exam marker. TEN = salstentamen, HEM = hemtentamen (DD1327 is
// HEM1+PRO1 and the curated data does mark an exam for it). LAB / INL / PRO /
// DIA / SEM are coursework and get no marker — a course with only those
// correctly ends up with `exams: []` rather than a fabricated one.
const EXAM_MODULE_PREFIXES = ['TEN', 'HEM'];

const CREDIT_TOLERANCE = 0.05; // hp; matches validate-data.mjs

const rel = (p) => relative(repoRoot, p);

// KOPPS titles occasionally carry doubled spaces (e.g. SF1693's English title),
// which the curated files silently fix. Collapsing runs of whitespace is safe —
// it can't change meaning — so do it. Genuine typos in the source (KD1000's
// "Sustainabillty") are left alone: correcting spelling is the reviewer's call,
// not something to do behind their back.
const tidy = (s) => (s || '').replace(/\s+/g, ' ').trim();

let warningCount = 0;
const review = []; // items a human must check before merging

const warn = (msg) => { warningCount++; console.warn(`  WARN   ${msg}`); };
const flag = (msg) => { review.push(msg); };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// KTH's www host rejects requests without a browser-ish UA.
const UA = 'Mozilla/5.0 (compatible; ProgramVisualization data extractor)';

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function getJson(url, { allow404 = false } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Study-plan SSR state
// ---------------------------------------------------------------------------

// The blob is one contiguous run of percent-encoded characters. Rather than
// guess where it starts, find a marker we know is inside it and expand outwards
// to the run boundaries. `decodeURIComponent` then yields the JSON.
const PCT_SAFE = /[%0-9A-Za-z._~\-*!'()]/;
const STATE_MARKER = '%22programmeCode%22';

function decodeStateBlob(html, what) {
  const marker = html.indexOf(STATE_MARKER);
  if (marker < 0) throw new Error(`no SSR state blob found in ${what} (page structure changed?)`);

  let start = marker;
  while (start > 0 && PCT_SAFE.test(html[start - 1])) start--;
  let end = marker;
  while (end < html.length && PCT_SAFE.test(html[end])) end++;

  const decoded = decodeURIComponent(html.slice(start, end));
  const brace = decoded.indexOf('{');
  if (brace < 0) throw new Error(`no JSON object inside state blob for ${what}`);
  return JSON.parse(decoded.slice(brace));
}

async function fetchStudyPlanState(prog, term, year) {
  const url = `https://www.kth.se/student/kurser/program/${prog}/${term}/arskurs${year}`;
  return decodeStateBlob(await getText(url), `${prog}/${term}/arskurs${year}`);
}

// ---------------------------------------------------------------------------
// Reading one study year
// ---------------------------------------------------------------------------

/** Convert `creditsPerPeriod` into a flat {P1..P4} map, asserting its shape. */
function periodCreditsFrom(cpp, code) {
  if (!Array.isArray(cpp) || cpp.length !== CPP_LENGTH) {
    throw new Error(
      `${code}: expected creditsPerPeriod to be a ${CPP_LENGTH}-element array, ` +
      `got ${JSON.stringify(cpp)} — the source format has changed, stopping rather ` +
      `than guessing which index is P1`,
    );
  }

  const out = {};
  PERIOD_IDS.forEach((p, i) => { out[p] = Number(cpp[i + CPP_P1_OFFSET]) || 0; });

  // Credits outside P1-P4 (summer courses) can't be placed on the timeline.
  const outside = (Number(cpp[0]) || 0) + (Number(cpp[CPP_LENGTH - 1]) || 0);
  if (outside > 0) flag(`${code}: ${outside} hp outside P1-P4 (summer period) — not representable, dropped`);

  // The credits-vs-periods reconciliation happens per course in
  // `buildCourseEntry`, not here: a course spanning study years contributes
  // only part of its credits in each year, so checking one year in isolation
  // would flag every multi-year course.
  return out;
}

const hasAnyCredits = (pc) => PERIOD_IDS.some((p) => pc[p] > 0);
const periodsWithCredits = (pc) => PERIOD_IDS.filter((p) => pc[p] > 0);
const sumCredits = (pc) => round(PERIOD_IDS.reduce((a, p) => a + pc[p], 0));

/**
 * Flatten one study year's `curriculumInfos` into participation records.
 * Each record is one (course, inriktning, condition) triple.
 */
function readCurriculum(state, prog, year) {
  const infos = state.curriculumInfos;
  if (!Array.isArray(infos)) throw new Error(`${prog} year ${year}: curriculumInfos missing or not an array`);

  const records = [];
  const specNames = new Map();

  for (const info of infos) {
    // `isCommon` marks the shared curriculum; its `code` is the empty string.
    const spec = info.isCommon ? null : (info.code || null);
    if (spec) specNames.set(spec, info.specializationName || spec);

    const participations = info.participations;
    if (participations == null) continue;

    for (const [condition, list] of Object.entries(participations)) {
      if (!KNOWN_CONDITIONS.has(condition)) {
        // Don't guess a category for a condition we've never seen.
        flag(`${prog} year ${year}: unknown electiveCondition '${condition}' (${(list || []).length} course(s)) — skipped, needs mapping`);
        continue;
      }
      for (const part of list || []) {
        const course = part.course || {};
        const code = course.courseCode;
        if (!code) { flag(`${prog} year ${year}: participation with no courseCode — skipped`); continue; }
        const credits = Number(course.credits) || 0;
        records.push({
          code,
          name: tidy(course.title),
          credits,
          level: course.educationalLevel || '',
          condition,
          spec,
          year,
          periodCredits: periodCreditsFrom(part.creditsPerPeriod, code),
        });
      }
    }
  }
  return { records, specNames };
}

// ---------------------------------------------------------------------------
// KOPPS course enrichment
// ---------------------------------------------------------------------------

const courseCache = new Map();

async function fetchCourseMeta(code) {
  if (courseCache.has(code)) return courseCache.get(code);

  const meta = { nameEn: null, gradingScale: null, courseLevel: null, examModules: [] };

  const basic = await getJson(`https://api.kth.se/api/kopps/v2/course/${code}`, { allow404: true });
  if (basic?.title?.en) meta.nameEn = tidy(basic.title.en);

  const detail = await getJson(`https://api.kth.se/api/kopps/v2/course/${code}/detailedinformation`, { allow404: true });
  if (detail) {
    // `examinationSets` is keyed by the term the set took effect; the highest
    // key is the current one.
    const sets = detail.examinationSets || {};
    const latest = Object.keys(sets).sort().pop();
    if (latest) {
      for (const round of sets[latest].examinationRounds || []) {
        if (round.examCode) meta.examModules.push({ code: round.examCode, scale: round.gradeScaleCode });
      }
    }
    // A single-module P/F course grades P/F overall; otherwise take the scale
    // of the largest examination module.
    const scales = new Set(meta.examModules.map((m) => m.scale).filter(Boolean));
    if (scales.size === 1) meta.gradingScale = mapGradingScale([...scales][0]);
  }

  if (basic?.educationalLevelCode) meta.courseLevel = mapCourseLevel(basic.educationalLevelCode);

  courseCache.set(code, meta);
  return meta;
}

function mapGradingScale(code) {
  if (code === 'AF') return 'A-F';
  if (code === 'PF' || code === 'GU') return 'P/F';
  if (code === 'VU') return 'VG/G/U';
  return null; // unknown — leave unset rather than guess
}

function mapCourseLevel(level) {
  // 'BASIC' → grundnivå, 'ADVANCED' → avancerad nivå. `src/lib/courseLevel.ts`
  // infers this from the course code anyway, so we only set it when known.
  if (level === 'BASIC') return 'G';
  if (level === 'ADVANCED') return 'A';
  return null;
}

function levelFromSwedish(text) {
  if (/^grundniv/i.test(text)) return 'G';
  if (/^avancerad/i.test(text)) return 'A';
  return null;
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

// Exam placement has two tiers of confidence, and the output distinguishes them.
//
// TIER 1 — CERTAIN. A course taught in exactly one period is examined in that
// period's exam slot (*Riktlinje om läsårets förläggning* §1.1). All 13
// single-period CTFYS courses carrying curated `exams` reproduce exactly.
//
// TIER 2 — CONVENTION, with a measured error rate. Multi-period courses are not
// derivable from credits plus module structure, and the counterexamples rule
// out every simple rule:
//
//   SE1055 (P3 6, P4 3, one TEN)  -> curated ['P4']   = the LAST period
//   SI1121 (P1 5, P2 1, one TEN)  -> curated ['P1']   = the credit MAJORITY
//
// Those two are mutually exclusive, so no placement rule gets both. Measured
// over every multi-period course carrying a curated `exams` value across all
// six programmes (17 courses), placing one exam per exam-bearing module in the
// HIGHEST-CREDIT periods beats placing them in the LAST periods, 10/17 vs 8/17:
//
//   prog   course  periods              #mod curated       last-N     majority-N
//   CTFYS  EI1320  P1 6/P2 3             2   [P1,P2]       ok         ok
//   CTFYS  SE1055  P3 6/P4 3             1   [P4]          ok         MISS
//   CTFYS  SF1544  P2 1/P3 5             1   [P3]          ok         ok
//   CTFYS  SF1683  P1 5/P2 4             2   [P1,P2]       ok         ok
//   CTFYS  SG1112  P3 4/P4 5             2   [P4]          MISS       MISS
//   CTFYS  SI1121  P1 5/P2 1             1   [P1]          MISS       ok
//   CTFYS  SK1104  P2 4/P3 3.5           3   [P2,P3]       ok         ok
//   CFATE  SD1120  P3 3/P4 6             2   [P4]          MISS       MISS
//   CFATE  SE1010  P1 3/P2 9             1   [P2]          ok         ok
//   CFATE  SF1668  P1 6/P2 4             1   [P1,P2]       MISS       MISS
//   CFATE  SF1682  P1 6/P2 5             1   [P1,P2]       MISS       MISS
//   CFATE  SF1694  P1 3/P2 6.5/P3 1      1   [P2]          MISS       ok
//   CFATE  SG1132  P2 1.5/P3 4.5/P4 5    2   [P4]          MISS       MISS
//   CFATE  SK1112  P1 1/P4 8             1   [P4]          ok         ok
//   COPEN  SF1546  P3 4/P4 2             1   [P3]          MISS       ok
//   COPEN  SG1133  P3 2/P4 7             2   [P4]          MISS       MISS
//   COPEN  SK1115  P1 3.5/P2 4           1   [P2]          ok         ok
//
// Majority is used. The 7 residual misses are unreachable from module count in
// either direction: four have two TEN modules where the curated file lists one
// exam period (SG1112, SD1120, SG1132, SG1133), and two have one module where
// it lists two (SF1668, SF1682). Closing those needs real timetable data —
// Ladok's aktivitetstillfällen — not a better heuristic.
//
// Note the earlier CTFYS-only figure for this rule was 5/7, which read as more
// general than it was; 8/17 and 10/17 are the numbers across all six.
//
// Every tier-2 placement is flagged for review, so the reviewer sees a
// starting value and knows not to trust it. The definitive fix is to replace
// tier 2 with facts: Ladok's aktivitetstillfällen carry real exam dates, which
// the sibling `academic-performance-portal` already imports into its
// `exam_occasions` table (with `occasion_category` from Ladok's
// aktivitetstillfällestyp). Joining against that source would make this
// heuristic redundant.
//
// `reexams` is never emitted: the loader defaults it to a copy of `exams`, and
// validate-data.mjs warns when a file duplicates it needlessly. Only genuine
// extra tillfällen are authored by hand.
function examsForPeriods(code, periodCredits, examBearing, label) {
  const active = periodsWithCredits(periodCredits);
  if (active.length === 0) return [];

  // Tier 1.
  if (active.length === 1) return [active[0]];

  // Tier 2: one exam per exam-bearing module, in the highest-credit periods,
  // returned in period order.
  const n = Math.min(examBearing.length, active.length);
  const placed = active
    .slice()
    .sort((a, b) => periodCredits[b] - periodCredits[a])
    .slice(0, n)
    .sort((a, b) => PERIOD_IDS.indexOf(a) - PERIOD_IDS.indexOf(b));
  const mods = examBearing.map((m) => m.code).join(', ');
  flag(
    `${code}${label}: taught across ${active.length} periods [${active.join(', ')}] with ` +
    `${examBearing.length} examination module(s) [${mods}] — exams set to ` +
    `[${placed.join(', ')}] by convention (the ${n} highest-credit period(s)), NOT from a ` +
    `timetable. This rule scores 10/17 across the six curated programmes; verify.`,
  );
  return placed;
}

const isByYearShape = (pc) => Object.keys(pc).some((k) => k.startsWith('Year'));

function deriveExams(entry, examModules) {
  const examBearing = examModules.filter((m) =>
    EXAM_MODULE_PREFIXES.some((p) => m.code.toUpperCase().startsWith(p)));

  if (examBearing.length === 0) return isByYearShape(entry.periodCredits) ? {} : [];

  // A course spanning study years needs the matching by-year `exams` shape,
  // one entry per year that actually carries credits (see CTMAT's SA1006).
  if (isByYearShape(entry.periodCredits)) {
    const out = {};
    for (const [yearKey, pc] of Object.entries(entry.periodCredits)) {
      const periods = examsForPeriods(entry.code, pc, examBearing, ` ${yearKey}`);
      if (periods.length > 0) out[yearKey] = periods;
    }
    return out;
  }

  return examsForPeriods(entry.code, entry.periodCredits, examBearing, '');
}

// ---------------------------------------------------------------------------
// Assembling entries
// ---------------------------------------------------------------------------

function round(x) { return Math.round(x * 100) / 100; }

const pcKey = (pc) => PERIOD_IDS.map((p) => pc[p]).join('|');

/**
 * A course can appear under more than one study year, for two very different
 * reasons, and they must not be conflated:
 *
 *   (a) It genuinely spans study years for everyone — CTMAT's SA1006 runs in
 *       years 1, 2 and 3, contributing part of its credits each year. The
 *       schema expresses this with the by-year `periodCredits` shape
 *       ({ Year1: {P1..P4}, Year2: … }) and a matching by-year `exams`.
 *
 *   (b) Different inriktningar take the same course in different years —
 *       CINEK's DD1320 is year 2 for DTOI/TMAI and year 3 for PPUI. This is
 *       NOT expressible: `periodCreditsBySpecialization` overrides the periods
 *       but not the year, and its documented restriction is flat single-year
 *       courses only. Emitting the by-year shape here would claim the course
 *       runs in both years for everyone and double its credits.
 *
 * The discriminator is whether the years share an audience. If the same
 * inriktning (or COMMON) has the course in several years it is case (a); if the
 * year groups have disjoint inriktning sets it is case (b), where we emit the
 * majority year and flag it rather than fabricate a shape.
 */
function splitByYear(recs) {
  const byYear = new Map();
  for (const r of recs) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  return byYear;
}

function yearsShareAudience(byYear) {
  const audiences = [...byYear.values()].map((rs) =>
    new Set(rs.map((r) => r.spec ?? '__common__')));
  for (let i = 0; i < audiences.length; i++) {
    for (let j = i + 1; j < audiences.length; j++) {
      for (const a of audiences[i]) if (audiences[j].has(a)) return true;
    }
  }
  return false;
}

/**
 * Collapse the per-inriktning records for one course into a single Course
 * entry, using `periodCreditsBySpecialization` when inriktningar disagree
 * about the period layout.
 */
function buildCourseEntry(code, recs, allSpecs) {
  const first = recs[0];
  const inCommon = recs.some((r) => r.spec === null);
  const specs = [...new Set(recs.map((r) => r.spec).filter(Boolean))];

  // Group the distinct period layouts. The layout shared by the most
  // inriktningar becomes the base; the rest become overrides. This is how the
  // curated CINEK.json models SK1110 (base P3, PPUI overridden to P4).
  const byLayout = new Map();
  for (const r of recs) {
    const k = pcKey(r.periodCredits);
    if (!byLayout.has(k)) byLayout.set(k, { pc: r.periodCredits, specs: [] });
    if (r.spec) byLayout.get(k).specs.push(r.spec);
  }
  const layouts = [...byLayout.values()].sort((a, b) => b.specs.length - a.specs.length);
  const base = layouts[0];

  const entry = {
    code,
    name: first.name,
    totalCredits: round(first.credits),
    periodCredits: {},
    year: first.year,
    prerequisites: [],
    exams: [],
    teacher: '',
    description: '',
  };
  PERIOD_IDS.forEach((p) => { entry.periodCredits[p] = round(base.pc[p]); });

  // Periods must account for the course's credits — the validator enforces
  // Σ periodCredits == totalCredits, and the renderer sizes bars from the
  // periods, so a course claiming more credits than it places would draw wrong.
  //
  // A mismatch is real and happens: TIEMM's MF2079 is an 18 hp "utökad kurs"
  // of which Kopps places only 3 hp inside the extracted years. Rather than
  // emit an invalid entry, trust the periods (what will actually be drawn) and
  // say what was overridden.
  const placed = sumCredits(entry.periodCredits);
  if (placed > 0 && Math.abs(placed - entry.totalCredits) > CREDIT_TOLERANCE) {
    flag(
      `${code}: Kopps lists ${entry.totalCredits} hp but places only ${placed} hp in the ` +
      `extracted years — totalCredits set to ${placed} to keep Σ periodCredits consistent. ` +
      `Likely a course continuing outside the extracted year range; verify.`,
    );
    entry.totalCredits = placed;
  }

  // A course listed under COMMON applies to every inriktning, so it needs no
  // `specializations` (the type treats undefined as "common to all").
  if (!inCommon && specs.length > 0 && specs.length < allSpecs.length) {
    entry.specializations = specs.slice().sort();
  } else if (!inCommon && specs.length === allSpecs.length && allSpecs.length > 0) {
    // Present in every inriktning but not in COMMON — the curated files list
    // them explicitly (see SK1110), so match that convention.
    entry.specializations = specs.slice().sort();
  }

  if (layouts.length > 1) {
    entry.periodCreditsBySpecialization = {};
    for (const alt of layouts.slice(1)) {
      for (const s of alt.specs) {
        entry.periodCreditsBySpecialization[s] = Object.fromEntries(
          PERIOD_IDS.map((p) => [p, round(alt.pc[p])]));
      }
    }
    // The override is only honoured for inriktningar the course is tagged with.
    if (!entry.specializations) entry.specializations = specs.slice().sort();
    flag(
      `${code}: period layout differs by inriktning — base ${JSON.stringify(entry.periodCredits)}, ` +
      `override(s) ${JSON.stringify(entry.periodCreditsBySpecialization)}. Verify against the study plan.`,
    );
  }

  const cat = first.condition === COND_MANDATORY ? 'mandatory'
    : first.condition === COND_CONDITIONAL ? 'conditionallyElective'
      : 'recommended';
  entry.category = cat;

  return entry;
}

/**
 * Case (a) above: one course, several study years, same audience. Emits the
 * by-year `periodCredits` shape. `totalCredits` stays the course's own credit
 * figure from Kopps, and the per-year portions are checked to sum to it.
 */
function buildMultiYearEntry(code, byYear) {
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const allRecs = years.flatMap((y) => byYear.get(y));
  const first = allRecs[0];
  const inCommon = allRecs.some((r) => r.spec === null);
  const specs = [...new Set(allRecs.map((r) => r.spec).filter(Boolean))];

  const entry = {
    code,
    name: first.name,
    totalCredits: round(first.credits),
    periodCredits: {},
    prerequisites: [],
    exams: {},
    teacher: '',
    description: '',
  };

  let placed = 0;
  for (const y of years) {
    // Within one year, take the layout the most inriktningar agree on.
    const byLayout = new Map();
    for (const r of byYear.get(y)) {
      const k = pcKey(r.periodCredits);
      if (!byLayout.has(k)) byLayout.set(k, { pc: r.periodCredits, n: 0 });
      byLayout.get(k).n++;
    }
    const best = [...byLayout.values()].sort((a, b) => b.n - a.n)[0];
    if (byLayout.size > 1) {
      flag(`${code} year ${y}: inriktningar disagree on the period layout, and the by-year shape has no per-inriktning override — took the most common. Verify.`);
    }
    entry.periodCredits[`Year${y}`] = Object.fromEntries(
      PERIOD_IDS.map((p) => [p, round(best.pc[p])]));
    placed += sumCredits(best.pc);
  }

  if (Math.abs(placed - entry.totalCredits) > CREDIT_TOLERANCE) {
    flag(
      `${code}: spans years ${years.join(', ')} placing ${round(placed)} hp in total, but the ` +
      `course is ${entry.totalCredits} hp — verify which years belong to it`,
    );
  }

  if (!inCommon && specs.length > 0) entry.specializations = specs.slice().sort();
  entry.category = first.condition === COND_MANDATORY ? 'mandatory'
    : first.condition === COND_CONDITIONAL ? 'conditionallyElective'
      : 'recommended';

  flag(`${code}: spans study years ${years.join(', ')} — emitted with the by-year periodCredits shape; confirm against the study plan.`);
  return { entry, years };
}

/**
 * `VV` (villkorligt valfri) courses sharing a year and period layout are one
 * choice — e.g. CTFYS year 3 returns VV: [EF112X, SA114X], the bachelor thesis,
 * which the curated file models as a single `Kandidatexamensarbete` group.
 *
 * Only `allowedNumberOfOptions = 1` / `pickN: 1` is emitted: "minst N hp ur
 * grupp" isn't expressible in Kopps' flat VV list, and the renderer doesn't
 * support it for this shape either. The group name is not in the source, so a
 * placeholder is emitted for renaming during merge.
 */
function buildOptionGroups(vvRecords) {
  const groups = new Map();
  for (const r of vvRecords) {
    const key = `${r.year}::${pcKey(r.periodCredits)}::${r.credits}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  let n = 0;
  for (const recs of groups.values()) {
    n++;
    const first = recs[0];
    const options = [...new Set(recs.map((r) => r.code))].sort();
    const periodCredits = Object.fromEntries(
      PERIOD_IDS.map((p) => [p, round(first.periodCredits[p])]));
    // Same reconciliation as buildCourseEntry: the validator requires
    // Σ periodCredits == totalCredits for groups too, so the periods win.
    const placed = sumCredits(periodCredits);
    let total = round(first.credits);
    if (placed > 0 && Math.abs(placed - total) > CREDIT_TOLERANCE) {
      flag(
        `optionGroup for [${options.join(' / ')}]: options are ${total} hp but only ${placed} hp ` +
        `falls in the extracted years — totalCredits set to ${placed}. Verify.`,
      );
      total = placed;
    }
    const entry = {
      type: 'optionGroup',
      name: `Villkorligt valfri grupp ${n}`,
      nameEn: `Conditionally elective group ${n}`,
      year: first.year,
      totalCredits: total,
      periodCredits,
      options,
      allowedNumberOfOptions: 1,
      kind: 'pickN',
      pickN: 1,
      exams: [],
      category: 'conditionallyElective',
    };
    flag(`optionGroup "${entry.name}" (year ${entry.year}, ${entry.totalCredits} hp, options ${options.join(' / ')}): name is a placeholder — rename during merge.`);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { prog: null, years: null, lasar: null, out: null, specializations: false, dumpState: null, electives: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--years') args.years = Number(argv[++i]);
    else if (a === '--lasar') args.lasar = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--specializations') args.specializations = true;
    else if (a === '--electives') args.electives = true;
    else if (a === '--dump-state') args.dumpState = Number(argv[++i]);
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  args.prog = rest[0] || null;
  return args;
}

const USAGE = `Build a candidate src/data/<PROG>.json from KTH's public study-plan data.

  node scripts/extract-from-kopps.mjs <PROG> [options]

Options:
  --years <n>          study years to extract (default: the programme's own
                       length from KOPPS, capped at 3 for a 5-year civilingenjör
                       whose years 4-5 are a separate master programme)
  --lasar <year>       first year of the läsår, e.g. 2025 for 2025/26
                       (default: read from src/data/academic-periods.json)
  --out <path>         output file (default extracted/<PROG>.kopps.json)
  --specializations    print a programs.json 'specializations' snippet and exit
  --electives          also emit 'V' (valfri) courses as category 'recommended'
                       (default: report them only — the curated files abstract
                       them into 'Plats för valfri kurs' placeholders instead)
  --dump-state <year>  print the raw SSR state for one year and exit
`;

/** First year of the läsår that academic-periods.json currently describes. */
function lasarFromPeriods() {
  const f = join(dataDir, 'academic-periods.json');
  if (!existsSync(f)) return null;
  const p1 = JSON.parse(readFileSync(f, 'utf8')).find((p) => p.id === 'P1');
  return p1?.start ? Number(p1.start.slice(0, 4)) : null;
}

/** Autumn term code for the cohort that is in study year `year` this läsår. */
const termForStudyYear = (lasar, year) => `${lasar - (year - 1)}2`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.prog) { console.log(USAGE); process.exit(args.prog ? 0 : 1); }

  const prog = args.prog.toUpperCase();
  const lasar = args.lasar ?? lasarFromPeriods();
  if (!lasar) throw new Error('could not determine läsår; pass --lasar <year>');

  if (args.dumpState != null) {
    const term = termForStudyYear(lasar, args.dumpState);
    console.log(JSON.stringify(await fetchStudyPlanState(prog, term, args.dumpState), null, 1));
    return;
  }

  // --- how many study years to extract ------------------------------------
  // A 5-year civilingenjör programme's years 4-5 are taught inside a separate
  // master programme (KTH says so in the year-4 payload's own
  // supplementaryInformation), so those years have no courses of their own here
  // and both curated 300 hp files stop at 3. A master programme, by contrast,
  // is fully described by its own two years.
  const CIVING_BACHELOR_YEARS = 3;
  const programme = await getJson(
    `https://api.kth.se/api/kopps/v2/programme/${prog}`, { allow404: true });
  if (args.years == null) {
    const len = Number(programme?.lengthInStudyYears) || CIVING_BACHELOR_YEARS;
    args.years = len >= 5 ? CIVING_BACHELOR_YEARS : len;
  }

  // --- inriktning registry ------------------------------------------------
  const currentTerm = `${lasar}2`;
  const specRegistry = await getJson(
    `https://api.kth.se/api/kopps/v2/programme/${prog}/${currentTerm}`, { allow404: true });
  const registryEntries = [];
  for (const [code, names] of Object.entries(specRegistry || {})) {
    if (code === 'description' || code === 'COMMON') continue;
    if (!names || typeof names !== 'object' || !names.sv) continue;
    registryEntries.push({ code, name: names.sv, nameEn: names.en || names.sv });
  }

  if (args.specializations) {
    console.log(JSON.stringify(registryEntries, null, 2));
    return;
  }

  console.log(`Extracting ${prog}, läsår ${lasar}/${lasar + 1}, years 1-${args.years}\n`);

  // --- study plan ---------------------------------------------------------
  const allRecords = [];
  const specNames = new Map();
  for (let year = 1; year <= args.years; year++) {
    const term = termForStudyYear(lasar, year);
    process.stdout.write(`• year ${year} ← cohort ${term} … `);
    let state;
    try {
      state = await fetchStudyPlanState(prog, term, year);
    } catch (e) {
      console.log('FAILED');
      warn(`year ${year} (${term}): ${e.message}`);
      continue;
    }
    const { records, specNames: sn } = readCurriculum(state, prog, year);
    for (const [k, v] of sn) specNames.set(k, v);

    const scheduled = records.filter((r) => hasAnyCredits(r.periodCredits));
    const unscheduled = records.length - scheduled.length;
    console.log(`${records.length} course(s), ${scheduled.length} with period data`);
    if (unscheduled > 0 && scheduled.length === 0) {
      warn(`year ${year} (${term}): no period data at all — that läsår is probably not scheduled yet`);
    } else if (unscheduled > 0) {
      flag(`year ${year}: ${unscheduled} course(s) had no period data and were skipped`);
    }
    allRecords.push(...scheduled);
  }

  if (allRecords.length === 0) throw new Error('no courses with period data found — nothing to write');

  // Inriktningar actually referenced by the extracted years.
  const usedSpecs = [...new Set(allRecords.map((r) => r.spec).filter(Boolean))].sort();

  // --- group and build ---------------------------------------------------
  const vv = allRecords.filter((r) => r.condition === COND_CONDITIONAL);
  const elective = allRecords.filter((r) => r.condition === COND_ELECTIVE);
  const core = allRecords.filter((r) => r.condition === COND_MANDATORY);

  // Key by code alone: the data file must not contain a code twice (the
  // validator rejects it, because useCourseModel.ts would silently sum the
  // duplicates). `buildEntriesForCode` decides how to represent a code that
  // turns up under several study years.
  const buildEntriesForCode = (code, recs) => {
    const byYear = splitByYear(recs);
    if (byYear.size === 1) return [buildCourseEntry(code, recs, usedSpecs)];

    if (yearsShareAudience(byYear)) {
      return [buildMultiYearEntry(code, byYear).entry];
    }

    // Case (b): different inriktningar, different years. Not expressible —
    // emit the year with the widest audience and say so plainly.
    const years = [...byYear.keys()].sort((a, b) => byYear.get(b).length - byYear.get(a).length);
    const kept = years[0];
    const dropped = years.slice(1);
    const describe = (y) => {
      const ss = [...new Set(byYear.get(y).map((r) => r.spec ?? 'COMMON'))].sort();
      return `year ${y} (${ss.join('/')})`;
    };
    flag(
      `${code}: taken in different study years by different inriktningar — ` +
      `${years.map(describe).join(' vs ')}. The schema cannot express this ` +
      `(periodCreditsBySpecialization overrides periods, not the year), so only ` +
      `${describe(kept)} was emitted and ${dropped.map(describe).join(', ')} dropped. ` +
      `Resolve by hand.`,
    );
    return [buildCourseEntry(code, byYear.get(kept), usedSpecs)];
  };

  const byCode = new Map();
  for (const r of [...core, ...(args.electives ? elective : [])]) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  const entries = [];
  for (const [code, recs] of byCode) entries.push(...buildEntriesForCode(code, recs));

  // VV options must exist as real courses for the validator to resolve
  // `options[]`, so emit both the group and one entry per option.
  const groups = buildOptionGroups(vv);
  const vvByCode = new Map();
  for (const r of vv) {
    if (byCode.has(r.code)) continue; // already emitted as a core course
    if (!vvByCode.has(r.code)) vvByCode.set(r.code, []);
    vvByCode.get(r.code).push(r);
  }
  for (const [code, recs] of vvByCode) entries.push(...buildEntriesForCode(code, recs));

  // --- enrich -------------------------------------------------------------
  process.stdout.write(`\nEnriching ${entries.length} course(s) from KOPPS … `);
  for (const e of entries) {
    let meta;
    try {
      meta = await fetchCourseMeta(e.code);
    } catch (err2) {
      flag(`${e.code}: KOPPS lookup failed (${err2.message}) — nameEn/gradingScale/exams left unset`);
      continue;
    }
    if (meta.nameEn) e.nameEn = meta.nameEn;
    if (meta.gradingScale) e.gradingScale = meta.gradingScale;
    const lvl = meta.courseLevel
      ?? levelFromSwedish(allRecords.find((r) => r.code === e.code)?.level || '');
    if (lvl) e.courseLevel = lvl;
    e.exams = deriveExams(e, meta.examModules);
    if (meta.examModules.length === 0) {
      flag(`${e.code}: no examination modules in KOPPS — 'exams' left empty, confirm the course has no tentamen`);
    }
  }
  console.log('done');

  // Option groups inherit the exam slot of their options, which all share a
  // period layout by construction. Only flat-shape options can be copied here;
  // a year-spanning option would need the by-year form on the group too.
  for (const g of groups) {
    const optionExams = g.options
      .map((c) => entries.find((e) => e.code === c && e.year === g.year)?.exams)
      .filter((x) => Array.isArray(x) && x.length > 0);
    g.exams = optionExams.length > 0 ? optionExams[0] : [];
  }

  // --- order and write ----------------------------------------------------
  // Multi-year entries have no top-level `year`; sort them by their first year.
  const sortYear = (e) => e.year
    ?? Math.min(...Object.keys(e.periodCredits)
      .filter((k) => k.startsWith('Year'))
      .map((k) => Number(k.slice(4))));

  const ordered = [...entries, ...groups].sort((a, b) => {
    const ay = sortYear(a); const by = sortYear(b);
    if (ay !== by) return ay - by;
    const at = a.type === 'optionGroup' ? 1 : 0;
    const bt = b.type === 'optionGroup' ? 1 : 0;
    if (at !== bt) return at - bt;
    return (a.code || a.name).localeCompare(b.code || b.name, 'sv');
  });

  const outPath = args.out ? join(repoRoot, args.out) : join(outDir, `${prog}.kopps.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');

  // --- report -------------------------------------------------------------
  const courses = ordered.filter((e) => e.type !== 'optionGroup');
  const hasExams = (e) => (Array.isArray(e.exams) ? e.exams.length : Object.keys(e.exams || {}).length) > 0;
  const withExams = courses.filter(hasExams).length;

  console.log(`\nWrote ${rel(outPath)}`);
  console.log(`  ${courses.length} course(s), ${groups.length} option group(s)`);
  console.log(`  exams derived for ${withExams}/${courses.length} course(s)`);
  if (usedSpecs.length > 0) console.log(`  inriktningar: ${usedSpecs.join(', ')}`);

  if (elective.length > 0 && !args.electives) {
    const codes = [...new Set(elective.map((r) => r.code))].sort();
    console.log(
      `\n${codes.length} 'valfri' (V) course(s) were NOT written. The curated files abstract these\n` +
      `into 'Plats för valfri kurs' placeholders sized to the required hp, which is an editorial\n` +
      `choice this script won't overwrite. Re-run with --electives to emit them as 'recommended'.`);
    console.log(`  ${codes.join(', ')}`);
  }

  if (registryEntries.length > 0) {
    const needed = registryEntries.filter((r) => usedSpecs.includes(r.code));
    if (needed.length > 0) {
      console.log(`\nAdd to programs.json → '${prog}' → specializations:`);
      console.log(JSON.stringify(needed, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }

  if (review.length > 0) {
    console.log(`\n${review.length} item(s) need human review before merging:`);
    for (const r of review) console.log(`  - ${r}`);
  }
  if (warningCount > 0) console.log(`\n${warningCount} warning(s).`);

  console.log(`\nValidate with:\n  node scripts/validate-data.mjs --include ${prog}=${rel(outPath)}`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
