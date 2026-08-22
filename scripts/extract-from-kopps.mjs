#!/usr/bin/env node
// Build one admission cohort's study plan from KTH's public study-plan data.
//
// Usage:
//   node scripts/extract-from-kopps.mjs CTFYS                  # newest cohort
//   node scripts/extract-from-kopps.mjs CTFYS --cohort HT2023
//   node scripts/extract-from-kopps.mjs CINEK --all-cohorts     # 2023..newest
//   node scripts/extract-from-kopps.mjs CTFYS --specializations # programs.json snippet
//   node scripts/extract-from-kopps.mjs CTFYS --dump-state 2    # raw SSR state, then exit
//
// Output: `src/data/cohorts/<PROG>-HT<year>.json`, one file per cohort, holding
// a `cohortMeta` provenance header followed by the course entries. The curated
// `src/data/<PROG>.json` files are never touched.
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
// Why a cohort's plan has to be stitched together
// ---------------------------------------------------------------------------
//
// The goal is what a student admitted in a given autumn actually studies across
// their years — not one calendar läsår sliced across three different cohorts.
// KTH does not publish that in one place. It keeps the läsår currently being
// taught and the next one, deletes the years a cohort has already passed, and
// lists a cohort's future years with all-zero `creditsPerPeriod`.
//
// So each missing year is borrowed from the nearest cohort that does publish it
// (see `resolveYear`), and every year records where it came from in the
// `cohortMeta` header: `sourceCohort`, `approximated`, and a `confidence` from
// the corroboration check in `corroborate()`. The UI can then show a student
// which parts of the chart are really theirs.
//
// Years 4-5 of a 300 hp civilingenjör programme are deliberately not extracted.
// KTH says why in the year-4 payload's own `supplementaryInformation`:
// "Utbildningens två sista år läses inom ramen för ett masterprogram." Those
// years belong to a different programme code, and both curated 300 hp files
// stop at year 3.
//
// ---------------------------------------------------------------------------
// Why the archive is committed
// ---------------------------------------------------------------------------
//
// KTH deletes each läsår as it passes, so a cohort's early years stop being
// retrievable a year or two after they are taught — HT2023's years 1 and 2 are
// already gone. Committing `src/data/cohorts/*.json` is what stops that erasing
// our data too: re-running extraction only ever adds.
//
// These files live inside `src/data/` on purpose, unlike the ad-hoc `--out`
// candidates. The app must load whichever cohort the user picks at runtime, and
// `useCourseModel.ts`'s ``import(`@/data/${dataFile}`)`` code-splits each JSON
// into its own async chunk (measured 604 B - 6.2 kB each), so cohorts nobody
// selected cost nothing at page load. They do count toward the `size-limit`
// budget, which sums every static chunk — worth watching as cohorts accumulate.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dataDir = join(repoRoot, 'src', 'data');
// Per-cohort archive. This one IS inside src/data, on purpose: the app has to
// load a cohort the user picks at runtime, and `useCourseModel.ts`'s dynamic
// import code-splits each JSON into its own async chunk (measured: 604 B-6.2 kB
// each), so an unselected cohort costs nothing at page load. Archiving matters
// because KTH deletes each läsår — without it, a cohort's early years become
// unrecoverable a year or two after they are taught.
const cohortsDir = join(dataDir, 'cohorts');
// Coordinator worklists for the one field that needs human judgement.
const reviewDir = join(repoRoot, 'prerequisite-review');

/**
 * Read a text file, or return null when it is not there.
 *
 * Doing the read and handling its failure — rather than asking `existsSync`
 * first and reading afterwards — closes the gap between the check and the use
 * (CodeQL js/file-system-race). It is also simply more accurate: an existence
 * check passes for a directory, a broken symlink and a file the process cannot
 * read, all of which fail at the actual read a moment later.
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

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
// 'R' = rekommenderad. Found only in ITM programmes — CMAST year 3 lists 69 such
// participations across its 14 inriktningar, each a course recommended for the
// master track that inriktning leads to (AEE recommends MG1024, MJ1401, SD1116,
// ME1003, LS1416). They carry real period data, unlike a bare recommendation.
//
// They are a pool, not a prescribed set: adding them to the mandatory and
// villkorligt valfria load takes AEE year 3 from 15/15/0/0 to 15/33/30/6 hp,
// far past full-time. So they get the same treatment as 'V' — reported, and
// written only on request — because writing them all would claim a student takes
// every recommendation.
const COND_RECOMMENDED = 'R';           // rekommenderad
const KNOWN_CONDITIONS = new Set([
  COND_MANDATORY, COND_CONDITIONAL, COND_ELECTIVE, COND_RECOMMENDED]);

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
  const notes = [];

  for (const info of infos) {
    if (info.supplementaryInformation) notes.push(decodeHtmlText(info.supplementaryInformation));
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
  return { records, specNames, notes };
}

// ---------------------------------------------------------------------------
// KOPPS course enrichment
// ---------------------------------------------------------------------------

// The course page is the live source; the KOPPS API is frozen.
//
// KOPPS was retired. It still answers, but it stopped receiving updates, and the
// gap is measurable. DD1328's page carries two syllabus versions — valid from
// VT2026 and VT2024 — and the KOPPS API returns only the VT2024 one:
//
//   page  VT2026: "…slutförd kurs DD1333/DD1310-DD1319/DD1331/DD1337/DD100N/ID1018/ID1022"
//   page  VT2024: "…slutförd kurs DD1310-DD1319/DD1331/DD1337/DD100N/ID1018"
//   KOPPS       : the VT2024 text, verbatim
//
// DD1333 is CTMAT's own first-year programming course, so reading KOPPS made
// DD1328, DD1380 and DD1385 come out with no prerequisites at all. Measured over
// all 217 course codes in the six programmes: 166 identical, 51 different, and
// where they differ the page is the fuller text (EI1320: KOPPS says
// "Slutförd kurs motsvarande SI1200", the page says "…SI1200 eller SF1693").
//
// So the page is primary for everything it carries, and KOPPS is the fallback.
// The one thing only KOPPS has is the ENGLISH title: the English course page
// (`kth.se/en/student/kurser/kurs/<CODE>`) returns HTTP 500, exactly like the
// English study-plan route. English titles therefore inherit KOPPS's staleness,
// including its typos — KD1000 is "Chemical Principles for Sustainabillty" there
// and the curated file corrects it by hand.
const ELIGIBILITY_MARKER = '%22course_eligibility%22';
// The page writes this placeholder where a field is simply unset.
const NO_INFO = /^ingen information tillagd\.?$/i;
// "LABB - Datorlaboration, 2,0 hp, betygsskala: A, B, C, D, E, FX, F"
const PAGE_MODULE_RE = /([A-Z]{2,4}\d?)\s*-\s*[^,]+,\s*([\d,.]+)\s*hp,\s*betygsskala:\s*([^|<]+)/g;

// A kursplan version's `course_valid_from` IS the KTH term code: { year: 2026,
// semesterNumber: 1 } is 20261. Verified against the kursplan archive
// (kth.se/kursutveckling/EI1320/arkiv) — EI1320 offers PDFs for 20261, 20212,
// 20192, 20191 and 20182, and the page's syllabusList has exactly those five
// versions. The page therefore carries the whole history in structured form and
// the PDFs never need parsing.
const syllabusTerm = (sy) => {
  const y = sy?.course_valid_from?.year;
  const n = sy?.course_valid_from?.semesterNumber;
  return (typeof y === 'number' && typeof n === 'number') ? y * 10 + n : null;
};

/** Newest-first by valid-from term. */
const syllabusOrder = (a, b) => (syllabusTerm(b) ?? 0) - (syllabusTerm(a) ?? 0);

// KTH term codes end in 1 for spring (VT) and 2 for autumn (HT).
const TERM_SPRING = 1;
const TERM_AUTUMN = 2;

/**
 * The term a cohort actually sits a course in.
 *
 * Study year Y of cohort C falls in läsår C+Y-1. P1/P2 are the autumn of that
 * läsår; P3/P4 are the spring of the following calendar year. So CTFYS HT2023
 * takes EI1320 (year 3, P1+P2) in 20252, while HT2024 takes it in 20262 — and
 * those two land on different kursplan versions.
 */
function termForCourse(cohort, studyYear, firstPeriodIndex) {
  const lasar = cohort + studyYear - 1;
  return firstPeriodIndex <= 1
    ? lasar * 10 + TERM_AUTUMN
    : (lasar + 1) * 10 + TERM_SPRING;
}

/**
 * First year of the läsår that `academic-periods.json` currently describes.
 *
 * That file is the single statement of which läsår the app renders, so the
 * curated data files resolve their kursplan versions against it rather than
 * against a second, drifting notion of "now".
 */
function lasarFromPeriods() {
  const f = join(dataDir, 'academic-periods.json');
  try {
    const raw = readTextOrNull(f);
    if (raw === null) return null;
    const p1 = JSON.parse(raw).find((p) => p.id === 'P1');
    return p1?.start ? Number(p1.start.slice(0, 4)) : null;
  } catch { return null; }
}

/**
 * The kursplan version in force for a given term: the newest one that had taken
 * effect by then.
 *
 * This is what keeps a cohort's prerequisites consistent with the rest of its
 * plan. EI1320's prerequisite changed from "Slutförd kurs motsvarande SI1200" to
 * "…motsvarande slutförd kurs SI1200 eller SF1693" with the 20261 version, so
 * showing the new text to a cohort that sat the course in 2025 would be wrong.
 * Falls back to the oldest version when a course is taken before any recorded
 * version — better a real historical text than nothing.
 */
function versionForTerm(versions, term) {
  if (!versions?.length) return null;
  const inForce = versions.filter((v) => v.term <= term);
  return inForce.length > 0 ? inForce[0] : versions[versions.length - 1];
}

function mapPageGradingScale(text) {
  const t = (text || '').toUpperCase().replace(/\s/g, '');
  if (!t) return null;
  if (t.includes('FX')) return 'A-F';           // A,B,C,D,E,FX,F
  if (t.startsWith('P,F') || t === 'PF') return 'P/F';
  if (t.includes('VG')) return 'VG/G/U';
  return null;
}

/**
 * Read the course page's own render state: prerequisites, grading scale, cycle
 * level and examination modules, all from the newest syllabus version.
 */
async function fetchCoursePage(code) {
  let html;
  try {
    html = await getText(`https://www.kth.se/student/kurser/kurs/${code}`);
  } catch { return null; }

  const marker = html.indexOf(ELIGIBILITY_MARKER);
  if (marker < 0) return null;
  let start = marker;
  while (start > 0 && PCT_SAFE.test(html[start - 1])) start--;
  let end = marker;
  while (end < html.length && PCT_SAFE.test(html[end])) end++;

  let state;
  try {
    const decoded = decodeURIComponent(html.slice(start, end));
    state = JSON.parse(decoded.slice(decoded.indexOf('{')));
  } catch { return null; }

  const cd = state?.courseData;
  if (!cd) return null;
  const info = cd.courseInfo || {};

  // Every version, newest first, each tagged with the KTH term it takes effect.
  const versions = [...(cd.syllabusList || [])].sort(syllabusOrder).map((sy) => {
    const eligibility = decodeHtmlText(sy.course_eligibility);
    const modules = [];
    const examText = decodeHtmlText(sy.course_examination).replace(/\s+/g, ' ');
    for (const m of examText.matchAll(PAGE_MODULE_RE)) {
      modules.push({ code: m[1], scale: mapPageGradingScale(m[3]) });
    }
    return {
      term: syllabusTerm(sy),
      eligibility: (!eligibility || NO_INFO.test(eligibility)) ? null : eligibility,
      examModules: modules,
    };
  }).filter((v) => v.term != null);

  return {
    versions,
    gradingScale: mapPageGradingScale(decodeHtmlText(info.course_grade_scale)),
    courseLevel: info.course_level_code === '1' ? 'G'
      : info.course_level_code === '2' ? 'A' : null,
  };
}

const courseCache = new Map();

async function fetchCourseMeta(code) {
  if (courseCache.has(code)) return courseCache.get(code);

  const meta = {
    nameEn: null, gradingScale: null, courseLevel: null,
    examModules: [], eligibility: null,
    // Every kursplan version, newest first, for per-cohort selection.
    versions: [],
  };

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

    // Fallback only — see fetchPageEligibility for why the page wins.
    const syl = (detail.publicSyllabusVersions || [])[0]?.courseSyllabus;
    if (syl?.eligibility) meta.eligibility = decodeHtmlText(syl.eligibility);
  }

  // Page wins wherever it has something; KOPPS values already loaded above stay
  // as the fallback. nameEn is untouched here — only KOPPS has it.
  const page = await fetchCoursePage(code);
  if (page) {
    meta.versions = page.versions;
    if (page.gradingScale) meta.gradingScale = page.gradingScale;
    if (page.courseLevel) meta.courseLevel = page.courseLevel;
    // Newest version as the default; callers with a cohort override per term.
    const newest = page.versions[0];
    if (newest?.eligibility) meta.eligibility = newest.eligibility;
    if (newest?.examModules.length > 0) meta.examModules = newest.examModules;
  }
  if (meta.eligibility && NO_INFO.test(meta.eligibility)) meta.eligibility = null;

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
      : 'recommended'; // both 'V' and 'R' land here
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
    const optionCodes = [...new Set(recs.map((r) => r.code))];
    // A VALBOX with a single option is not a choice. Kopps marks such courses
    // villkorligt valfri, but modelling them as a group gives the reader a
    // selection modal with one item and clutters the chart. Emit only the course,
    // which buildCourseEntry already categorises as conditionallyElective. None
    // of the six curated files models a single-option group as a group, so this
    // matches the convention; 15 of 34 extracted groups were of this shape,
    // 5 of CFATE's 7 and 10 of TIEMM's 23.
    if (optionCodes.length < 2) continue;
    n++;
    const first = recs[0];
    const options = optionCodes.slice().sort();
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
// Resolving one cohort's years
// ---------------------------------------------------------------------------
//
// A cohort's own plan is only partly published. KTH keeps the läsår currently
// being taught and the next one, deletes the years a cohort has already passed,
// and lists its future years with all-zero creditsPerPeriod. Measured on CTFYS
// and CINEK in August 2026:
//
//   cohort   year 1   year 2   year 3
//   HT2023   gone     gone     yes
//   HT2024   gone     yes      yes
//   HT2025   yes      yes      future
//   HT2026   yes      future   future
//
// So no cohort has all three of its own years, and the gap runs in *both*
// directions: recent cohorts are missing later years, older cohorts are missing
// earlier ones. For each missing year we borrow from the nearest cohort that
// does publish it, searching outwards and preferring the earlier cohort on a
// tie. That makes the common case ("year 3 not scheduled yet") resolve to the
// previous cohort, while still rescuing HT2023's year 1 from a later one.
//
// Availability is PROBED, not computed from the table above. The publishing
// window moves every year, and a probe is self-correcting where a formula would
// silently go stale.

const EARLIEST_COHORT = 2023; // oldest cohort the tool offers

const SEARCH_RADIUS = 4; // cohorts to try either side before giving up

// A year counts as published when this fraction of its listed courses carry
// period data. "At least one course has credits" is NOT enough: a course that
// spans study years (CTMAT's SA1006 runs in years 1-3) is listed under a future
// year and carries its own credits there, which made unscheduled years look
// scheduled and produced provenance claiming exact data for läsår 2028/29.
//
// Measured scheduled/listed ratios, CTFYS + CTMAT, cohorts 2025-2026:
//   published years      10/10, 12/12, 10/10, 10/10   = 1.00
//   unpublished years    0/27, 0/10, 1/36, 1/12       = 0.00 - 0.08
// The gap is wide enough that the exact threshold does not matter; 0.5 sits in
// the middle of it rather than being tuned to either side.
const PUBLISHED_RATIO = 0.5;

/** Cohorts to try for a study year: own first, then outwards, earlier first. */
function candidateCohorts(cohort) {
  const out = [cohort];
  for (let d = 1; d <= SEARCH_RADIUS; d++) out.push(cohort - d, cohort + d);
  return out;
}

// (prog, cohort, year) -> { records, specNames } | null, so probing the same
// cell twice across years or cohorts costs one fetch.
const stateCache = new Map();

async function readYear(prog, cohort, year) {
  const key = `${prog}::${cohort}::${year}`;
  if (stateCache.has(key)) return stateCache.get(key);

  let result = null;
  try {
    const state = await fetchStudyPlanState(prog, termFor(cohort), year);
    const { records, specNames, notes } = readCurriculum(state, prog, year);
    const scheduled = records.filter((r) => hasAnyCredits(r.periodCredits));
    result = { records: scheduled, listed: records.length, specNames, notes };
  } catch {
    result = null; // page missing entirely
  }
  stateCache.set(key, result);
  return result;
}

/**
 * Find the nearest cohort publishing period data for `year`.
 * Returns { sourceCohort, records, specNames, approximated } or null.
 */
async function resolveYear(prog, cohort, year) {
  let anyListed = false;
  for (const cand of candidateCohorts(cohort)) {
    if (cand < EARLIEST_COHORT - SEARCH_RADIUS) continue;
    const got = await readYear(prog, cand, year);
    if (!got) continue;
    if (got.listed > 0) anyListed = true;
    if (got.listed > 0 && got.records.length / got.listed >= PUBLISHED_RATIO) {
      return {
        sourceCohort: cand,
        records: got.records,
        specNames: got.specNames,
        notes: got.notes || [],
        approximated: cand !== cohort,
      };
    }
  }
  // No cohort lists any course for this year: the programme does not define it
  // here. COPEN (Öppen ingång) is the real case — students choose a programme
  // after year 1, so its years 2-3 have no curriculum of their own, and the
  // curated COPEN.json is year 1 only. That is structural, not a gap.
  return anyListed ? null : 'undefined-year';
}

/**
 * The user's stability check, made testable: when year Y is borrowed from
 * another cohort, look for a *different* year that both cohorts publish and
 * compare it. Agreement there is evidence the two cohorts follow the same
 * programme layout, so the borrowed year is more likely to be right.
 *
 * It cannot always run — HT2023 and HT2025 have no year in common at all — and
 * agreement is evidence, not proof: CTFYS year 1 is identical between 2025 and
 * 2026 while its year 3 changed between 2023 and 2024.
 */
async function corroborate(prog, cohort, sourceCohort, years) {
  for (const y of years) {
    const published = (g) => g && g.listed > 0 && g.records.length / g.listed >= PUBLISHED_RATIO;
    const mine = await readYear(prog, cohort, y);
    const theirs = await readYear(prog, sourceCohort, y);
    if (!published(mine) || !published(theirs)) continue;
    const sig = (rs) => JSON.stringify(rs
      .map((r) => [r.spec ?? '', r.code, r.condition, PERIOD_IDS.map((p) => r.periodCredits[p])])
      .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)));
    return { year: y, agrees: sig(mine.records) === sig(theirs.records) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------
//
// KOPPS states prerequisites only as free text, in the syllabus `eligibility`
// field (*Särskild behörighet*). The schema needs two typed lists —
// `prerequisitesCompleted` ("slutförd") and `prerequisitesParticipation`
// ("aktivt deltagande") — so the text has to be interpreted, and interpretation
// is exactly what a program coordinator must sign off on. Everything uncertain
// is therefore reported rather than silently committed.
//
// WHAT THE SOURCE ACTUALLY LOOKS LIKE (surveyed over 238 courses, 215 with text)
//   "Aktivt deltagande i SF1673 Analys i en variabel."            -> participation
//   "Slutförd kurs SF1672 Linjär algebra"                        -> completed
//   "SG1112 Mekanik I eller motsvarande"                          -> completed, implicit
//   "SF1673 …, SF1672 … samt SF1674 …. Dessa läses parallellt"    -> participation
//   "Kunskaper … motsvarande slutförd kurs DD1310/DD1311/…/DD1331" -> long alternative list
//   "Kunskaper i engelska motsvarande gymnasiekursen Engelska B"   -> not a course at all
//   "Minst 104 högskolepoäng … ska vara avklarade"                 -> credit threshold
//
// THREE THINGS MAKE THIS TRACTABLE
//   1. Alternative lists collapse when intersected with the programme's own
//      courses: of DD1310/DD1311/…/DD1331 only DD1331 is in CTFYS. This is also
//      what keeps cross-programme codes out of the arrows.
//   2. Type is decided per clause, so one text can yield both kinds.
//   3. A clause with no type marker inherits one signalled elsewhere in the same
//      text — SK1104 lists its courses in one sentence and qualifies them in the
//      next ("Dessa läses parallellt med denna kurs").
//
// MEASURED against the 19 hand-curated CTFYS prerequisites: 19/19 exact, no
// misses, no spurious entries. Two rules were derived from that set — tolerating
// KOPPS's "Aktivit deltagande" typo, and treating "läses parallellt" as
// participation — so treat 19/19 as a fit to the only labelled data available,
// not as proof it generalises. CTFYS is the only program with curated
// prerequisites to check against.

// Every entity is decoded exactly once, in one left-to-right pass.
//
// This used to be a chain of `.replace()` calls run twice over, which let one
// replacement's output be re-read by the next: unescaping `&amp;` to `&` before
// the `&quot;` step turned "&amp;quot;" into '"' rather than the literal
// "&quot;" it encodes. A single regex cannot do that, because `replace` never
// rescans what it has written. (Flagged by CodeQL as js/double-escaping.)
//
// MEASURED over 87 KTH pages — all eight programmes, three terms, 15 course
// pages, 146 819 string values: nothing KTH publishes is double-encoded, and
// this decoder is byte-identical to the old one on every one of those strings.
// So the second pass was never load-bearing; it only created the hazard.
//
// `&lt;` and `&gt;` are deliberately NOT decoded. The tag stripper below runs
// afterwards, so turning them into `<` and `>` would hand it markup that was
// never markup and delete the text between. Neither entity occurs in the
// measured data.
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'" };
const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;

/** Decode HTML entities and strip tags. */
function decodeHtmlText(input) {
  const decoded = String(input || '').replace(ENTITY_RE, (m, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    // A code point outside Unicode's range is left as written rather than
    // crashing String.fromCodePoint on malformed source.
    const cp = Number.parseInt(dec ?? hex, dec !== undefined ? 10 : 16);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const COURSE_CODE_RE = /\b[A-Z]{2,3}\d{3,4}[A-Z]?\b/g;

// KOPPS writes alternative sets as ranges as well as lists: "DD1310-DD1319",
// "SF1914-SF1924". A plain code scan sees only the endpoints, so a course in the
// middle is invisible — CINEK's DD1418 lists DD1310-DD1319, DD1320-DD1328 and
// SF1914-SF1924, and expanding them recovers DD1317, DD1324 and SF1918, all real
// in-programme prerequisites that were being dropped. 43 range expressions
// appear across the six programmes.
const COURSE_RANGE_RE = /\b([A-Z]{2,3})(\d{3,4})\s*-\s*(?:[A-Z]{2,3})?(\d{3,4})\b/g;
const RANGE_MAX_SPAN = 40; // guards against a hyphen that is not a range

function codesInClause(clause) {
  const found = new Set(clause.match(COURSE_CODE_RE) || []);
  for (const m of clause.matchAll(COURSE_RANGE_RE)) {
    const prefix = m[1];
    const from = Number(m[2]);
    const to = Number(m[3]);
    if (to <= from || to - from > RANGE_MAX_SPAN) continue;
    for (let n = from; n <= to; n++) found.add(`${prefix}${n}`);
  }
  return [...found];
}

// --- suggesting a course the text describes but never names ----------------
//
// KOPPS states many prerequisites as a knowledge area plus a list of courses
// that satisfy it: "Kunskaper och färdigheter i grundläggande programmering,
// 5 hp, motsvarande slutförd kurs DD1310-DD1319/DD1331/DD1337/…". Those lists go
// stale. CTMAT's own first-year programming course is DD1333, which appears in
// none of them, so DD1328, DD1380 and DD1385 come out with no prerequisites at
// all even though they plainly depend on it.
//
// The area description is still there, though, and the programme has a course
// whose *name* matches it. So when a clause yields no in-programme code, match
// the described area against in-programme course names and put the candidate in
// the review file. This only ever suggests — nothing is written to the data from
// a name match, because "the names are similar" is not evidence a coordinator
// should have decided for them.
const AREA_RE = /kunskaper(?:\s+och\s+färdigheter)?\s+i\s+([^,.;]{4,60})/gi;
const AREA_STOPWORDS = new Set([
  'och', 'i', 'för', 'med', 'av', 'en', 'ett', 'den', 'det', 'grundläggande',
  'grundkurs', 'kurs', 'hp', 'samt', 'eller', 'motsvarande',
]);
const normalise = (s) => s.toLowerCase()
  .replace(/[^\wåäöéü\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => normalise(s).split(' ').filter((w) => w.length > 2 && !AREA_STOPWORDS.has(w));

function suggestByName(clause, nameByCode, selfCode) {
  const out = [];
  for (const m of clause.matchAll(AREA_RE)) {
    const area = tokens(m[1]);
    if (area.length === 0) continue;
    let best = null;
    for (const [code, name] of nameByCode) {
      if (code === selfCode) continue;
      const nameToks = new Set(tokens(name));
      const hit = area.filter((w) => nameToks.has(w));
      if (hit.length === 0) continue;
      const score = hit.length / area.length;
      if (!best || score > best.score) best = { code, name, score, hit };
    }
    // Require the whole described area to be present in the name. A partial
    // overlap ("programmering" against "Javaprogrammering för …") is too weak to
    // put in front of a coordinator as a candidate.
    if (best && best.score === 1) out.push({ area: m[1].trim(), code: best.code, name: best.name });
  }
  return out;
}

// Clauses that are about something other than a course in this programme.
const PREREQ_NOISE = [
  /engelska\s*(b|6)\b/i, /gymnasiekurs/i, /grundläggande behörighet/i,
  /särskild behörighet motsvarande/i, /fristående kursstuderande/i,
];
// `aktiv\w*` deliberately: KOPPS contains "Aktivit deltagande" (SK1105, SG1113).
const PREREQ_PARTICIPATION =
  /aktiv\w*\s+deltagande|deltagit\s+i|deltagande\s+i|deltar\s+i|läses\s+parallellt|samläses|parallellt\s+med/i;
const PREREQ_COMPLETED =
  /slutförd|slutförda|avklarad|avklarade|avslutad|avslutade|godkänd|godkänt/i;
const PREREQ_THRESHOLD =
  /minst\s+[\d,.]+\s*(hp|högskolepoäng)|[\d,.]+\s*(hp|högskolepoäng)\s+(från|inom|av)/i;

// Requirements are not reliably separated by punctuation.
//
// EI1320's 20261 kursplan runs two separate requirements together with no period
// between them:
//
//   "…motsvarande slutförd kurs SI1200 eller SF1693 Kunskaper i grundläggande
//    elektromagnetism och vågrörelselära…, motsvarande slutförd kurs SK1104/SH1017…"
//
// Split only on sentence boundaries and that is one clause, so SI1200 and SK1104
// — which are both required — get reported as if they were alternatives, and the
// review file tells the coordinator to "decide which applies". Wrong advice.
//
// A new requirement starts with a capitalised opener ("Kunskaper", "Slutförd",
// "Aktivt deltagande", …). Within a requirement the same words appear in lower
// case ("motsvarande slutförd kurs X"), so capitalisation is what separates an
// opener from a mid-clause mention — which is why the split is case-sensitive.
// Split on a sentence end, a bullet, a semicolon, or whitespace that is followed
// by a capitalised requirement opener mid-text.
const REQ_SPLIT = /(?<=\.)\s+|•|;|(?<=[^.\s])\s+(?=(?:Kunskaper|Slutförd|Slutförda|Avklarad|Avklarade|Avslutad|Avslutade|Aktivt|Aktiv|Deltagit|Godkänd|Godkänt|Åtminstone|Minst)\b)/;

function splitRequirements(text) {
  return text.split(REQ_SPLIT).map((c) => (c || '').trim()).filter(Boolean);
}

// "slutfört moment LAB1 i SH1017" — a requirement on one examination module of
// another course. The schema has no shape for that, so it is reported instead of
// being silently reduced to a whole-course dependency.
const MODULE_REQ_RE = /moment\s+([A-Z]{2,4}\d)\s+i\s+([A-Z]{2,3}\d{3,4}[A-Z]?)/i;

/**
 * Interpret one course's eligibility text.
 * @returns {{completed: string[], participation: string[], notes: object[]}}
 */
function parsePrerequisites(text, inProgramme, selfCode, nameByCode = new Map()) {
  const t = decodeHtmlText(text);
  const empty = { completed: [], participation: [], notes: [] };
  if (!t) return empty;

  const clauses = splitRequirements(t);
  const completed = new Set();
  const participation = new Set();
  const notes = [];
  let sawCodes = false;

  for (const c of clauses) {
    const codes = codesInClause(c).filter((x) => x !== selfCode);
    const noise = PREREQ_NOISE.some((r) => r.test(c));
    if (codes.length === 0) {
      if (!noise && PREREQ_THRESHOLD.test(c)) {
        notes.push({ kind: 'credit-threshold', clause: c });
      }
      continue;
    }
    sawCodes = true;
    const inProg = codes.filter((x) => inProgramme.has(x));
    if (inProg.length === 0) continue; // cross-programme alternative; see below

    const selfPart = PREREQ_PARTICIPATION.test(c);
    const selfDone = PREREQ_COMPLETED.test(c);
    const explicit = selfPart || selfDone;
    const isPart = selfPart || (!explicit && PREREQ_PARTICIPATION.test(t));

    for (const x of inProg) (isPart ? participation : completed).add(x);

    if (!explicit) {
      notes.push({ kind: 'type-implicit', clause: c, codes: inProg, chose: isPart ? 'participation' : 'completed' });
    }
    // A hyphenated range is itself a set of alternatives, so it counts even when
    // the clause has no "eller" or "/" to give it away.
    const offersChoice = /\beller\b|\//.test(c) || COURSE_RANGE_RE.test(c);
    COURSE_RANGE_RE.lastIndex = 0; // the regex is global; .test advances it
    if (inProg.length > 1 && offersChoice) {
      notes.push({ kind: 'alternatives', clause: c, codes: inProg });
    }
    if (PREREQ_THRESHOLD.test(c)) notes.push({ kind: 'credit-threshold', clause: c });
    const mod = MODULE_REQ_RE.exec(c);
    if (mod) notes.push({ kind: 'module-level', clause: c, codes: [`${mod[1]} i ${mod[2]}`] });
  }

  // Only worth reporting when nothing at all was extracted despite the text
  // naming courses — otherwise it is the ordinary cross-programme-alternative
  // case, which the in-programme filter is *meant* to drop (124 occurrences
  // across the six programmes; reporting them all would bury the real items).
  if (sawCodes && completed.size === 0 && participation.size === 0) {
    const suggestions = [];
    for (const c of clauses) suggestions.push(...suggestByName(c, nameByCode, selfCode));
    // A name match means this programme teaches the thing the text asks for while
    // the course's own list of qualifying courses omits it. That is a defect in
    // the *course's* syllabus, not in this programme's data, so it is reported
    // separately: the fix belongs with whoever maintains that course.
    notes.push({
      kind: suggestions.length > 0 ? 'upstream-stale' : 'nothing-extracted',
      clause: t,
      suggestions,
    });
  }

  return {
    completed: [...completed].sort(),
    participation: [...participation].sort(),
    notes,
  };
}

/**
 * Flag prerequisites that do not actually precede the course requiring them.
 *
 * A `completed` prerequisite has to finish before the course starts. A
 * `participation` one only has to overlap — CTFYS's SK1104 runs P2-P3 and
 * requires participation in SF1674 (P3), which is legitimate — so it is only
 * flagged when it starts after the requiring course has finished.
 *
 * These are real defects rather than extraction noise: either the prerequisite
 * is wrong, or the course sits in the wrong place in the programme. Both need a
 * human. Measured 15 across the six programmes, most of them in TIEMM.
 */
function checkPrerequisiteOrder(entries) {
  const span = (e) => {
    const maps = alignYearMaps(e);
    const years = Object.keys(maps).map(Number).sort((a, b) => a - b);
    const first = years[0];
    const last = years[years.length - 1];
    const idx = (year, pick) => {
      const pc = maps[year] || {};
      const present = PERIOD_IDS.map((p, i) => (Number(pc[p] || 0) > 0 ? i : -1)).filter((i) => i >= 0);
      return present.length ? pick(present) : null;
    };
    const startP = idx(first, (a) => Math.min(...a));
    const endP = idx(last, (a) => Math.max(...a));
    if (startP == null || endP == null) return null;
    return { start: first * 10 + startP, end: last * 10 + endP };
  };

  const pos = new Map();
  for (const e of entries) if (e.code) { const sp = span(e); if (sp) pos.set(e.code, sp); }

  const problems = [];
  for (const e of entries) {
    const me = pos.get(e.code);
    if (!me) continue;
    for (const [field, label] of [['prerequisitesCompleted', 'slutförd'], ['prerequisitesParticipation', 'deltagande']]) {
      for (const req of e[field] || []) {
        const them = pos.get(req);
        if (!them) continue;
        const bad = field === 'prerequisitesCompleted'
          ? them.start >= me.start   // must finish before this course begins
          : them.start > me.end;     // may overlap, but not start after it ends
        if (bad) problems.push({ code: e.code, req, kind: 'not-earlier', label });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Elective space: making the periods add up to full-time
// ---------------------------------------------------------------------------
//
// Full-time study is 15 hp per period, so a programme's courses should add up to
// 15 in every (year, period) cell. When they do not, the missing hp is almost
// always the space for valfria kurser — which KTH states in the study plan's
// prose but never lists as courses. CTMAT year 3 is the clean example: every
// period sums to 7.5, and the descriptive text says
//
//   "Utrymmet för valfria kurser är 7,5 hp per period hela läsåret."
//
// CTFYS says the same thing differently for its spring:
//
//   "På våren i årskurs 3 finns ett utrymme på 15,0 hp valfria kurser."
//
// and the curated CTFYS.json duly carries two `electivePlaceholder` entries
// (XY123Z/XY456Z, 7.5 hp each in P3 and P4) — which is the convention this
// mirrors.
//
// The credit shortfall is the primary signal, because it is computed from period
// data we trust. The prose is used to corroborate the amount, and any
// disagreement is reported rather than reconciled silently. TIEMM's text talks
// about elective space only qualitatively ("några helt valfria kurser"), with no
// figure to check against, so nothing is filled there.

const FULL_TIME_HP = 15;
const LOAD_TOLERANCE = 0.01;

// "Utrymmet för valfria kurser är 7,5 hp per period hela läsåret."
const ELECTIVE_PER_PERIOD_RE = /utrymme\w*\s+för\s+valfria\s+kurser\s+är\s+([\d]+(?:[,.]\d+)?)\s*hp\s+per\s+period/i;
// "På våren i årskurs 3 finns (ett) utrymme på 15,0 hp valfria kurser."
const ELECTIVE_SEASON_RE = /på\s+(våren|hösten)\s+i\s+årskurs\s+(\d)\s+finns\s+(?:ett\s+)?utrymme\s+på\s+([\d]+(?:[,.]\d+)?)\s*hp\s+valfria/i;

const hpFromText = (x) => Number(String(x).replace(',', '.'));

/** What the descriptive text claims about elective space, if anything. */
function statedElectiveSpace(notes) {
  const out = [];
  for (const note of notes || []) {
    const perPeriod = ELECTIVE_PER_PERIOD_RE.exec(note);
    if (perPeriod) {
      out.push({ kind: 'per-period', hp: hpFromText(perPeriod[1]), periods: PERIOD_IDS, quote: perPeriod[0] });
    }
    const season = ELECTIVE_SEASON_RE.exec(note);
    if (season) {
      const periods = season[1].toLowerCase() === 'våren' ? ['P3', 'P4'] : ['P1', 'P2'];
      out.push({ kind: 'season', hp: hpFromText(season[3]), year: Number(season[2]), periods, quote: season[0] });
    }
  }
  return out;
}

/** Scheduled hp per "year|period", counting an option group once. */
function scheduledLoad(entries) {
  const groups = entries.filter((e) => e.type === 'optionGroup');
  const members = new Set(groups.flatMap((g) => g.options || []));
  const totals = new Map();
  for (const e of entries) {
    if (e.type !== 'optionGroup' && members.has(e.code)) continue;
    for (const [year, map] of Object.entries(alignYearMaps(e))) {
      for (const pid of PERIOD_IDS) {
        const v = Number((map || {})[pid] || 0);
        if (v > 0) {
          const k = `${year}|${pid}`;
          totals.set(k, (totals.get(k) || 0) + v);
        }
      }
    }
  }
  return totals;
}

/**
 * Add `electivePlaceholder` entries so each period reaches full-time.
 *
 * Deliberately conservative: a year is only filled when it is short *and* has no
 * period over full-time. An excess means the model of that year is incomplete —
 * usually courses that are alternatives without being expressed as an option
 * group, which is the state CINEK's and TIEMM's inriktningar are in — and adding
 * placeholders on top of that would pile invention on a wrong base.
 */
function fillElectiveSpace(entries, notes, hasSpecialisations) {
  const stated = statedElectiveSpace(notes);
  const totals = scheduledLoad(entries);
  const years = [...new Set([...totals.keys()].map((k) => Number(k.split('|')[0])))].sort();
  const added = [];
  const reports = [];

  for (const year of years) {
    const load = PERIOD_IDS.map((pid) => round(totals.get(`${year}|${pid}`) || 0));
    const short = load.map((hp) => round(FULL_TIME_HP - hp));
    const anyExcess = load.some((hp, i) => hp > 0 && short[i] < -LOAD_TOLERANCE);
    const anyShort = load.some((hp, i) => hp > 0 && short[i] > LOAD_TOLERANCE);
    if (!anyShort) continue;

    if (anyExcess || hasSpecialisations) {
      // Where the excess comes from villkorligt valfria courses, the arithmetic
      // usually reveals a "minst N hp ur grupp" pool: more VV credits are listed
      // than a student can take, because they choose a subset. CFATE year 3 is
      // 36 hp mandatory + a 15 hp thesis choice + 7 VV courses totalling 38 hp,
      // of which only ~9 hp fits. The schema can express that as
      // `kind: 'minCredits'`, but which courses form the pool and what the
      // threshold is are editorial calls, so the arithmetic is reported rather
      // than guessed.
      const yearEntries = entries.filter((e) => Object.keys(alignYearMaps(e)).map(Number).includes(year));
      const hpOf = (e) => PERIOD_IDS.reduce((a, q) => a + Number((alignYearMaps(e)[year] || {})[q] || 0), 0);
      const mandatory = round(yearEntries.filter((e) => e.category === 'mandatory').reduce((a, e) => a + hpOf(e), 0));
      const groupsHere = yearEntries.filter((e) => e.type === 'optionGroup');
      const groupHp = round(groupsHere.reduce((a, g) => a + hpOf(g), 0));
      const inGroups = new Set(groupsHere.flatMap((g) => g.options || []));
      const loose = yearEntries.filter((e) => e.type !== 'optionGroup'
        && e.category === 'conditionallyElective' && !inGroups.has(e.code));
      const looseHp = round(loose.reduce((a, e) => a + hpOf(e), 0));
      const target = FULL_TIME_HP * PERIOD_IDS.length;
      const remaining = round(target - mandatory - groupHp);

      let detail = `load ${load.join('/')} hp across P1-P4; ${anyExcess ? 'another period is over full-time' : 'the programme has inriktningar'}, so the shortfall was reported rather than filled`;
      if (loose.length > 1 && looseHp > remaining + LOAD_TOLERANCE) {
        detail += `. Arithmetic: ${mandatory} hp obligatorisk + ${groupHp} hp in option groups = ${round(mandatory + groupHp)} of ${target} hp, leaving ${remaining} hp — but ${loose.length} villkorligt valfria courses totalling ${looseHp} hp are listed (${loose.map((e) => e.code).join(', ')}). That is a "minst ${remaining} hp ur grupp" pool; the schema's kind: 'minCredits' can express it, but which courses belong and what the threshold is are editorial calls`;
      }
      reports.push({ kind: 'elective-space-unfilled', year, detail });
      continue;
    }

    // Corroborate against the prose where it says something for this year.
    const claim = stated.find((c) => c.kind === 'per-period' || c.year === year);
    for (let i = 0; i < PERIOD_IDS.length; i++) {
      const pid = PERIOD_IDS[i];
      if (load[i] <= 0 || short[i] <= LOAD_TOLERANCE) continue;
      const expected = claim
        ? (claim.kind === 'per-period'
          ? claim.hp
          : (claim.periods.includes(pid) ? round(claim.hp / claim.periods.length) : null))
        : null;

      const entry = {
        // Stable synthetic code: same year+period always yields the same one, so
        // re-running does not churn the file.
        code: `XY${year}${i + 1}0Z`,
        name: 'Plats för valfri kurs',
        nameEn: 'Space for elective course',
        totalCredits: short[i],
        periodCredits: Object.fromEntries(PERIOD_IDS.map((q) => [q, q === pid ? short[i] : 0])),
        year,
        prerequisites: [],
        // Mirrors the curated CTFYS placeholders, which mark an exam in their own
        // period rather than leaving it blank.
        exams: [pid],
        category: 'electivePlaceholder',
      };
      entries.push(entry);
      added.push(entry);
      reports.push({
        kind: 'elective-space-filled', year, period: pid, hp: short[i],
        expected, quote: claim?.quote ?? null,
      });
    }
  }
  return { added, reports };
}

// ---------------------------------------------------------------------------
// Vertical alignment: ordering within a study year
// ---------------------------------------------------------------------------
//
// The renderer stacks each period's bars in file order, so a course spanning
// several periods sits at whatever cumulative height the courses listed before
// it happen to occupy in each one. When those differ, the bar is drawn at
// different vertical levels in different periods and the connector becomes a
// diagonal staircase — visible on CTFYS's SI1121, SK1104, SF1544 and SE1055.
//
// Perfect alignment is often geometrically impossible: when the set of parallel
// courses changes between periods, something has to shift. So this minimises
// total drift rather than pretending to eliminate it.
//
// WHY A SEARCH AND NOT A SORT
// Measured over CTFYS/CTMAT/CFATE/CINEK, every simple sort was *worse* than the
// hand-curated order (drift 226-487 against 203) — Christian's ordering already
// encodes alignment a comparator cannot see. A local search that starts from the
// existing order and only accepts moves that do not increase drift cut it to 62,
// a 75 % reduction, and by construction can never make a file worse.
//
//   drift, summed over CTFYS/CTMAT/CFATE/CINEK + one cohort file: 250 -> 62
//   courses still misaligned:                                     40/66 -> 31/66
//
// The residual is the geometrically unavoidable part; CINEK year 2 goes to zero,
// CFATE year 1 only from 44 to 18.

const ALIGN_MIN_ECTS = 2;  // matches MIN_ECTS_FOR_HEIGHT in TimelineVisualization
const ALIGN_GAP = 4;       // matches STACK_GAP_PX
const ALIGN_ITERATIONS = 40000;

/** Per-year {P1..P4} credit maps for an entry, flat or by-year shape. */
function alignYearMaps(e) {
  const pc = e.periodCredits || {};
  if (Object.keys(pc).some((k) => k.startsWith('Year'))) {
    const out = {};
    for (const [k, v] of Object.entries(pc)) out[Number(k.slice(4))] = v;
    return out;
  }
  return { [e.year ?? 1]: pc };
}

/**
 * Total vertical drift for one year's ordering: for each course spanning more
 * than one period, how far its top edge moves between periods.
 */
function yearDrift(list, year) {
  const cols = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const tops = new Map();
  for (const e of list) {
    const pc = alignYearMaps(e)[year] || {};
    for (const p of PERIOD_IDS) {
      const c = Number(pc?.[p] || 0);
      if (c <= 0) continue;
      const key = e.code || e.name;
      if (!tops.has(key)) tops.set(key, []);
      tops.get(key).push(cols[p]);
      cols[p] += Math.max(c, ALIGN_MIN_ECTS) + ALIGN_GAP;
    }
  }
  let drift = 0;
  for (const arr of tops.values()) {
    if (arr.length < 2) continue;
    drift += Math.max(...arr) - Math.min(...arr);
  }
  return drift;
}

/**
 * Reorder one year's entries to reduce drift. Deterministic: the RNG is seeded,
 * so the same input always produces the same file. Monotone: only moves that do
 * not increase drift are accepted, so the starting order is a floor on quality.
 */
function hillClimb(start, year, rngSeed) {
  let best = [...start];
  let bestDrift = yearDrift(best, year);
  let cur = best;
  let curDrift = bestDrift;
  let seed = rngSeed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < ALIGN_ITERATIONS; i++) {
    const from = Math.floor(rnd() * cur.length);
    const to = Math.floor(rnd() * cur.length);
    if (from === to) continue;
    // Insertion move rather than a swap: stacking order is positional, so
    // lifting one course past several others is the move that matters.
    const cand = [...cur];
    const [item] = cand.splice(from, 1);
    cand.splice(to, 0, item);
    const d = yearDrift(cand, year);
    if (d <= curDrift) {
      cur = cand;
      curDrift = d;
      if (d < bestDrift) { best = cand; bestDrift = d; }
    }
  }
  return { order: best, drift: bestDrift };
}

/**
 * Reorder one year's entries to reduce drift, from several starting points.
 *
 * A single start gets trapped: the search only accepts non-worsening moves, so
 * it converges to whatever local optimum its seed order leads to. Measured on
 * the curated files, that left real headroom — CTMAT sat at drift 26 while its
 * own generated cohort file reached 7 from a different seed, and CFATE at 24
 * against 15. Trying the file's own order, a code-sorted order and the reverse,
 * then keeping the best, closes that:
 *
 *   CTMAT 26 -> 5    CFATE 24 -> 15    CINEK 16 -> 9    TIEMM 6 -> 4    CTFYS 6 -> 6
 *
 * CTFYS finding no improvement is the reassuring case: a hand-curated order that
 * is already optimal stays untouched.
 *
 * The safety property survives, because the file's own order is one of the
 * candidates and the winner is chosen by drift — so a file can never come out
 * worse than it went in. Every seed is fixed, so output stays reproducible.
 */
function alignYear(list, year) {
  if (list.length < 3) return list;
  if (yearDrift(list, year) === 0) return [...list];

  const byCode = [...list].sort((a, b) =>
    (a.code || a.name || '').localeCompare(b.code || b.name || '', 'sv'));
  const starts = [
    { order: list, rng: 12345 },        // the file's own order — the safety floor
    { order: byCode, rng: 6789 },
    { order: [...list].reverse(), rng: 24680 },
  ];

  let best = null;
  for (const s of starts) {
    const r = hillClimb(s.order, year, s.rng);
    if (!best || r.drift < best.drift) best = r;
  }
  return best.order;
}

/** Apply alignYear per study year, preserving the year grouping. */
function alignEntries(entries) {
  const firstYear = (e) => Math.min(...Object.keys(alignYearMaps(e)).map(Number));
  const years = [...new Set(entries.map(firstYear))].sort((a, b) => a - b);
  const out = [];
  let before = 0;
  let after = 0;
  for (const y of years) {
    const inYear = entries.filter((e) => firstYear(e) === y);
    before += yearDrift(inYear, y);
    const aligned = alignYear(inYear, y);
    after += yearDrift(aligned, y);
    out.push(...aligned);
  }
  return { entries: out, before: Math.round(before), after: Math.round(after) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    prog: null, years: null, cohort: null, allCohorts: false, out: null,
    specializations: false, dumpState: null, electives: false, align: false,
    prereqs: false, fillElectives: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--years') args.years = Number(argv[++i]);
    else if (a === '--cohort') args.cohort = parseCohort(argv[++i]);
    else if (a === '--all-cohorts') args.allCohorts = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--specializations') args.specializations = true;
    else if (a === '--electives') args.electives = true;
    else if (a === '--dump-state') args.dumpState = Number(argv[++i]);
    else if (a === '--align') args.align = true;
    else if (a === '--prereqs') args.prereqs = true;
    else if (a === '--fill-electives') args.fillElectives = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  args.prog = rest[0] || null;
  return args;
}

/** Accepts 2023, "2023" or "HT2023". */
function parseCohort(s) {
  const m = /^(?:HT)?(\d{4})$/i.exec(String(s || '').trim());
  if (!m) throw new Error(`--cohort expects a year like 2023 or HT2023, got '${s}'`);
  return Number(m[1]);
}

const USAGE = `Build a cohort's study plan from KTH's public study-plan data.

  node scripts/extract-from-kopps.mjs <PROG> [options]

Options:
  --cohort <year>      admission cohort, e.g. 2023 or HT2023 (default: the
                       newest cohort whose year 1 is published)
  --all-cohorts        extract every supported cohort (${EARLIEST_COHORT}..newest)
  --years <n>          study years to extract (default: the programme's own
                       length from KOPPS, capped at 3 for a 5-year civilingenjör
                       whose years 4-5 are a separate master programme)
  --out <path>         output file (default src/data/cohorts/<PROG>-HT<year>.json)
  --specializations    print a programs.json 'specializations' snippet and exit
  --electives          also emit 'V' (valfri) and 'R' (rekommenderad) courses,
                       both as category 'recommended'
                       (default: report them only — the curated files abstract
                       them into 'Plats för valfri kurs' placeholders instead)
  --dump-state <year>  print the raw SSR state for one study year and exit

  --prereqs            fill in missing prerequisites in the curated
                       src/data/<PROG>.json and write the coordinator review
                       file, then exit. Additive only: a course that already has
                       prerequisites is left exactly as it is.
  --fill-electives     add 'Plats för valfri kurs' placeholders to the curated
                       src/data/<PROG>.json wherever a period falls short of
                       full-time (15 hp), sized to the shortfall and checked
                       against the study plan's own wording. Additive: existing
                       entries are never touched.
  --align <file>...    reorder existing data file(s) in place to reduce vertical
                       bar drift, then exit. Reordering only — no field is
                       added, changed or removed, and each file's trailing-
                       newline convention is preserved, so the diff is purely
                       moved lines. Safe on hand-curated files: the search never
                       accepts a worsening move.
`;

/** Autumn term code for an admission cohort. */
const termFor = (cohort) => `${cohort}2`;
const cohortLabel = (cohort) => `HT${cohort}`;

/** Newest cohort whose year 1 is published — the sensible default. */
async function newestPublishedCohort(prog, from) {
  for (let c = from + 2; c >= EARLIEST_COHORT; c--) {
    const got = await readYear(prog, c, 1);
    if (got && got.records.length > 0) return c;
  }
  return null;
}

async function extractCohort(prog, cohort, args, registryEntries) {
  review.length = 0; // report per cohort

  console.log(`\n═══ ${prog} ${cohortLabel(cohort)} — years 1-${args.years} ═══`);

  const allRecords = [];
  const specNames = new Map();
  const provenance = [];
  const versionsByCode = new Map();
  const planNotes = [];

  for (let year = 1; year <= args.years; year++) {
    process.stdout.write(`• year ${year} … `);
    const src = await resolveYear(prog, cohort, year);
    if (src === 'undefined-year') {
      console.log('not part of this programme');
      continue; // no provenance entry: there is no year to show
    }
    if (!src) {
      console.log('not published by any nearby cohort');
      warn(`${cohortLabel(cohort)} year ${year}: no cohort within ±${SEARCH_RADIUS} publishes it — year omitted`);
      provenance.push({ year, sourceCohort: null, approximated: true, note: 'no data available' });
      continue;
    }

    for (const [k, v] of src.specNames) specNames.set(k, v);
    allRecords.push(...src.records);
    planNotes.push(...(src.notes || []));

    const entry = {
      year,
      sourceCohort: cohortLabel(src.sourceCohort),
      approximated: src.approximated,
    };

    if (src.approximated) {
      const check = await corroborate(prog, cohort, src.sourceCohort, [1, 2, 3, 4, 5]
        .filter((y) => y !== year && y <= args.years));
      if (check) {
        entry.corroboratedBy = { year: check.year, agrees: check.agrees };
        entry.confidence = check.agrees ? 'high' : 'low';
      } else {
        entry.confidence = 'unknown';
      }
      console.log(`${src.records.length} course(s) ← ${cohortLabel(src.sourceCohort)} (approximated, confidence ${entry.confidence})`);
      const why = entry.corroboratedBy
        ? (entry.corroboratedBy.agrees
          ? `year ${entry.corroboratedBy.year} is identical between the two cohorts`
          : `year ${entry.corroboratedBy.year} DIFFERS between the two cohorts — treat with suspicion`)
        : 'no year in common to compare, so this is unverified';
      flag(`year ${year}: not published for ${cohortLabel(cohort)}; borrowed from ${cohortLabel(src.sourceCohort)} — ${why}.`);
    } else {
      entry.confidence = 'exact';
      console.log(`${src.records.length} course(s) (own data)`);
    }
    provenance.push(entry);
  }

  if (allRecords.length === 0) {
    warn(`${cohortLabel(cohort)}: no courses found in any year — skipped`);
    return null;
  }

  // Inriktningar actually referenced by the extracted years.
  const usedSpecs = [...new Set(allRecords.map((r) => r.spec).filter(Boolean))].sort();

  // --- group and build ---------------------------------------------------
  const vv = allRecords.filter((r) => r.condition === COND_CONDITIONAL);
  // 'V' (valfri) and 'R' (rekommenderad) are both pools the student picks from,
  // so both are held back by default — see COND_RECOMMENDED.
  const elective = allRecords.filter((r) => r.condition === COND_ELECTIVE
    || r.condition === COND_RECOMMENDED);
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
    versionsByCode.set(e.code, meta.versions || []);
  }
  console.log('done');

  // --- prerequisites ------------------------------------------------------
  // Resolved after enrichment because the in-programme filter needs the full
  // set of codes this file contains.
  const inProgramme = new Set(entries.map((e) => e.code).filter(Boolean));
  const nameByCode = new Map(entries.filter((e) => e.code).map((e) => [e.code, e.name || '']));
  const prereqReview = [];
  let withPrereqs = 0;
  let versioned = 0;
  for (const e of entries) {
    // Use the kursplan that was in force when THIS cohort sat the course, not
    // the newest one. EI1320's prerequisite gained an alternative (SF1693) in the
    // 20261 version, so CTFYS HT2023 — which sat it in 20252 — must not show it.
    const versions = versionsByCode.get(e.code) || [];
    const firstPeriod = PERIOD_IDS.findIndex((pid) => {
      const maps = alignYearMaps(e);
      return Object.values(maps).some((m) => Number(m?.[pid] || 0) > 0);
    });
    const studyYear = Math.min(...Object.keys(alignYearMaps(e)).map(Number));
    const term = termForCourse(cohort, studyYear, firstPeriod < 0 ? 0 : firstPeriod);
    const chosen = versionForTerm(versions, term);
    if (chosen && versions.length > 1) {
      versioned++;
      if (chosen.term !== versions[0].term) {
        flag(`${e.code}: using the kursplan valid from ${chosen.term} (this cohort sits the course in ${term}); a newer version ${versions[0].term} exists`);
      }
      if (chosen.examModules.length > 0) e.exams = deriveExams(e, chosen.examModules);
    }
    const parsed = parsePrerequisites(
      chosen ? chosen.eligibility : null, inProgramme, e.code, nameByCode);
    if (parsed.completed.length > 0) e.prerequisitesCompleted = parsed.completed;
    if (parsed.participation.length > 0) e.prerequisitesParticipation = parsed.participation;
    // `prerequisites` is the legacy flat field. The validator warns when it is
    // set alongside the typed lists (useCourseModel silently drops it), so only
    // keep it when there is nothing typed to say.
    if (parsed.completed.length > 0 || parsed.participation.length > 0) {
      delete e.prerequisites;
      withPrereqs++;
    }
    for (const n of parsed.notes) prereqReview.push({ code: e.code, ...n });
  }
  prereqReview.push(...checkPrerequisiteOrder(entries));

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

  // Fill in the space for valfria kurser so each period reaches full-time. Done
  // before ordering so the placeholders take part in the alignment.
  // Option groups count toward the load (the student takes one option), so the
  // combined list is what gets measured and extended.
  const allEntries = [...entries, ...groups];
  const electiveSpace = fillElectiveSpace(allEntries, planNotes, usedSpecs.length > 0);
  for (const r of electiveSpace.reports) {
    if (r.kind === 'elective-space-filled') {
      const vs = r.expected != null
        ? (Math.abs(r.expected - r.hp) < 0.01
          ? `the study plan text agrees (${r.expected} hp)`
          : `NOTE: the study plan text says ${r.expected} hp, the shortfall is ${r.hp} hp`)
        : 'no figure in the study plan text to check against';
      flag(`year ${r.year} ${r.period}: added a ${r.hp} hp 'Plats för valfri kurs' to reach full-time — ${vs}${r.quote ? ` ("${r.quote}")` : ''}`);
    } else {
      flag(`year ${r.year}: periods do not add up to full-time and were NOT filled — ${r.detail}`);
    }
  }

  // Start from a stable, readable order, then let the aligner improve the
  // vertical stacking within each year (see alignEntries).
  const seeded = [...allEntries].sort((a, b) => {
    const ay = sortYear(a); const by = sortYear(b);
    if (ay !== by) return ay - by;
    const at = a.type === 'optionGroup' ? 1 : 0;
    const bt = b.type === 'optionGroup' ? 1 : 0;
    if (at !== bt) return at - bt;
    return (a.code || a.name).localeCompare(b.code || b.name, 'sv');
  });
  const aligned = alignEntries(seeded);
  const ordered = aligned.entries;

  // The provenance header. Kept inside the array so a cohort is one file and
  // one fetch; `type` discriminates it exactly as it does for optionGroup, and
  // both the validator and useCourseModel skip entries they don't own.
  const meta = {
    type: 'cohortMeta',
    program: prog,
    cohort: cohortLabel(cohort),
    years: provenance,
  };

  const outPath = args.out
    ? join(repoRoot, args.out)
    : join(cohortsDir, `${prog}-${cohortLabel(cohort)}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify([meta, ...ordered], null, 2)}\n`, 'utf8');

  // --- report -------------------------------------------------------------
  const courses = ordered.filter((e) => e.type !== 'optionGroup');
  const hasExams = (e) => (Array.isArray(e.exams) ? e.exams.length : Object.keys(e.exams || {}).length) > 0;
  const withExams = courses.filter(hasExams).length;
  const approx = provenance.filter((p) => p.approximated);

  console.log(`\nWrote ${rel(outPath)}`);
  console.log(`  ${courses.length} course(s), ${groups.length} option group(s)`);
  console.log(`  exams derived for ${withExams}/${courses.length} course(s)`);
  if (usedSpecs.length > 0) console.log(`  inriktningar: ${usedSpecs.join(', ')}`);
  console.log(`  provenance: ${provenance.map((p) => `y${p.year}=${p.sourceCohort ?? 'none'}${p.approximated ? '*' : ''}`).join(' ')}`);
  console.log(`  vertical drift: ${aligned.before} -> ${aligned.after} (bar-alignment across periods)`);
  console.log(`  prerequisites: ${withPrereqs}/${courses.length} course(s), ${prereqReview.length} item(s) needing coordinator review`);
  console.log(`  kursplan versions: ${versioned} course(s) have more than one; each resolved to the version in force for this cohort`);
  if (approx.length > 0) {
    console.log(`  ${approx.length} of ${provenance.length} year(s) approximated (marked * above)`);
  }

  if (elective.length > 0 && !args.electives) {
    const v = [...new Set(elective.filter((r) => r.condition === COND_ELECTIVE).map((r) => r.code))];
    const rec = [...new Set(elective.filter((r) => r.condition === COND_RECOMMENDED).map((r) => r.code))];
    const bits = [];
    if (v.length) bits.push(`${v.length} 'valfri' (V)`);
    if (rec.length) bits.push(`${rec.length} 'rekommenderad' (R)`);
    console.log(`  ${bits.join(' and ')} course(s) not written (see --electives)`);
  }

  if (registryEntries.length > 0) {
    const needed = registryEntries.filter((r) => usedSpecs.includes(r.code));
    if (needed.length > 0 && !args.quietSpecs) {
      console.log(`\n  programs.json → '${prog}' → specializations needs: ${needed.map((n) => n.code).join(', ')}`);
    }
  }

  if (review.length > 0) {
    console.log(`\n  ${review.length} item(s) for review:`);
    for (const r of review) console.log(`    - ${r}`);
  }
  return {
    outPath, courses: courses.length, groups: groups.length, provenance,
    specs: needed(registryEntries, usedSpecs),
    entries, prereqReview,
  };
}

function needed(registryEntries, usedSpecs) {
  return registryEntries.filter((r) => usedSpecs.includes(r.code));
}

/**
 * Reorder existing data files in place to reduce vertical drift.
 *
 * Rewrites only the order of the top-level array. Everything else — every field,
 * the 2-space indentation, the presence or absence of a trailing newline — is
 * preserved, so `git diff` shows moved lines and nothing else. That matters most
 * for the hand-curated files: the point is to improve alignment without
 * quietly editing anyone's data.
 */
function alignFiles(paths) {
  let anyChanged = false;
  for (const rel0 of paths) {
    const abs = join(repoRoot, rel0);
    const raw = readTextOrNull(abs);
    if (raw === null) { warn(`${rel0}: not found`); continue; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { warn(`${rel0}: ${e.message}`); continue; }
    if (!Array.isArray(data)) { warn(`${rel0}: expected an array`); continue; }

    // Refuse anything that is not a course data file. programs.json,
    // academic-periods.json and the cosmetics files are all JSON arrays too, so
    // without this check a shell glob like `src/data/*.json` silently rewrites
    // them: the order survives (they have no periodCredits to sort by) but the
    // re-serialisation expands their compact single-line arrays, turning a
    // 5-line diff into a 400-line one. Ask for a positive signal instead.
    const looksLikeCourses = data.some((e) => e && typeof e === 'object'
      && (e.periodCredits || e.type === 'optionGroup' || e.type === 'cohortMeta'));
    if (!looksLikeCourses) {
      warn(`${rel0}: not a course data file (no periodCredits / optionGroup / cohortMeta entries) — skipped`);
      continue;
    }

    // A cohortMeta header must stay first; it is not a chart entry.
    const head = data.filter((e) => e?.type === 'cohortMeta');
    const body = data.filter((e) => e?.type !== 'cohortMeta');

    const { entries, before, after } = alignEntries(body);
    const out = JSON.stringify([...head, ...entries], null, 2)
      + (raw.endsWith('\n') ? '\n' : '');

    if (out === raw) {
      console.log(`  ${rel0}: drift ${before} — already optimal, unchanged`);
      continue;
    }
    writeFileSync(abs, out, 'utf8');
    anyChanged = true;
    console.log(`  ${rel0}: drift ${before} -> ${after}`);
  }
  if (anyChanged) {
    console.log('\nReordering only. Review with:\n  git diff --stat -- src/data');
  }
}

/**
 * Fill in missing prerequisites in a curated data file.
 *
 * Additive by design: any course that already carries `prerequisites`,
 * `prerequisitesCompleted` or `prerequisitesParticipation` is skipped untouched.
 * Hand-curated prerequisites reflect a coordinator's reading of the same free
 * text and outrank anything derived here, so overwriting them would be throwing
 * away the better source.
 */
async function fillPrereqs(prog) {
  const file = join(dataDir, `${prog}.json`);
  const raw = readTextOrNull(file);
  if (raw === null) throw new Error(`${rel(file)} not found`);
  const data = JSON.parse(raw);
  const courses = data.filter((e) => e?.code && e.type !== 'optionGroup' && e.type !== 'cohortMeta');
  const inProgramme = new Set(courses.map((e) => e.code));
  const nameByCode = new Map(courses.map((e) => [e.code, e.name || '']));

  // A curated file is a snapshot of the programme as taught in the läsår the app
  // is configured for, so each course resolves against that läsår rather than
  // against a cohort. `academic-periods.json` is the single place that läsår is
  // stated, so read it from there instead of inventing a second source of truth.
  const lasar = lasarFromPeriods();
  process.stdout.write(`Reading kursplan text for ${courses.length} course(s) (läsår ${lasar ?? '?'}) … `);
  const texts = new Map();
  for (const e of courses) {
    try {
      const meta = await fetchCourseMeta(e.code);
      if (!lasar || !meta.versions?.length) { texts.set(e.code, meta.eligibility); continue; }
      const firstPeriod = PERIOD_IDS.findIndex((pid) => {
        const maps = alignYearMaps(e);
        return Object.values(maps).some((m) => Number(m?.[pid] || 0) > 0);
      });
      // Cohort = the one currently in this study year, so the term lands in the
      // current läsår whatever the course's study year is.
      const studyYear = Math.min(...Object.keys(alignYearMaps(e)).map(Number));
      const term = termForCourse(lasar - studyYear + 1, studyYear, firstPeriod < 0 ? 0 : firstPeriod);
      const chosen = versionForTerm(meta.versions, term);
      texts.set(e.code, chosen ? chosen.eligibility : meta.eligibility);
    } catch { texts.set(e.code, null); }
  }
  console.log('done');

  const review = [];
  let added = 0;
  let skipped = 0;
  for (const e of courses) {
    const has = (e.prerequisitesCompleted?.length || e.prerequisitesParticipation?.length
      || e.prerequisites?.length);
    const parsed = parsePrerequisites(texts.get(e.code), inProgramme, e.code, nameByCode);
    for (const n of parsed.notes) review.push({ code: e.code, ...n });
    if (has) { skipped++; continue; }
    if (parsed.completed.length === 0 && parsed.participation.length === 0) continue;
    if (parsed.completed.length > 0) e.prerequisitesCompleted = parsed.completed;
    if (parsed.participation.length > 0) e.prerequisitesParticipation = parsed.participation;
    delete e.prerequisites;
    added++;
  }

  review.push(...checkPrerequisiteOrder(courses));

  const out = JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  if (out !== raw) writeFileSync(file, out, 'utf8');
  console.log(`  ${rel(file)}: added to ${added} course(s), left ${skipped} existing untouched`);
  const rp = writePrereqReview(prog, courses, review, `läsår ${lasar}/${(lasar ?? 0) + 1} (curated file)`);
  console.log(`  ${rel(rp)}: ${review.length} item(s) for coordinator review`);
}

/**
 * Add elective-space placeholders to a curated data file.
 *
 * Same rule as the cohort path, applied to the läsår in academic-periods.json:
 * the shortfall against full-time is the amount, the study plan's prose is the
 * corroboration, and a year with any period *over* full-time is reported instead
 * of filled. Additive — nothing existing is modified, so a file that already
 * carries placeholders (CTFYS) comes out unchanged.
 */
async function fillElectivesInCuratedFile(prog) {
  const file = join(dataDir, `${prog}.json`);
  const raw = readTextOrNull(file);
  if (raw === null) throw new Error(`${rel(file)} not found`);
  const data = JSON.parse(raw);

  const lasar = lasarFromPeriods();
  if (!lasar) throw new Error('could not read the läsår from academic-periods.json');

  // Collect the study plan's descriptive text for each year of this läsår.
  const notes = [];
  const years = [...new Set(data.filter((e) => e?.periodCredits)
    .flatMap((e) => Object.keys(alignYearMaps(e)).map(Number)))].sort();
  for (const y of years) {
    const got = await readYear(prog, lasar - y + 1, y);
    if (got?.notes) notes.push(...got.notes);
  }

  const before = data.length;
  // Whether the *data* actually splits by inriktning, not whether KOPPS lists
  // any. KOPPS returns the master-programme choices for years 4-5 as
  // "specialisations" — 46 of them for CMAST, 24 for CMATD, and the same for
  // CTFYS — none of which affect years 1-3. Keying off the registry would refuse
  // to fill elective space in every civilingenjör programme. extractCohort
  // already keys off the courses it actually placed; match that.
  const hasSpecs = data.some((e) => Array.isArray(e?.specializations) && e.specializations.length > 0);

  const { added, reports } = fillElectiveSpace(data, notes, hasSpecs);
  for (const r of reports) {
    if (r.kind === 'elective-space-filled') {
      const vs = r.expected != null
        ? (Math.abs(r.expected - r.hp) < 0.01
          ? `study plan text agrees (${r.expected} hp)`
          : `study plan text says ${r.expected} hp, shortfall is ${r.hp} hp`)
        : 'no figure in the study plan text to check against';
      console.log(`  year ${r.year} ${r.period}: +${r.hp} hp 'Plats för valfri kurs' — ${vs}`);
    } else {
      console.log(`  year ${r.year}: NOT filled — ${r.detail}`);
    }
  }
  if (added.length === 0) {
    console.log(`  ${rel(file)}: nothing to add (${before} entries unchanged)`);
    return;
  }
  const out = JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  writeFileSync(file, out, 'utf8');
  console.log(`  ${rel(file)}: added ${added.length} placeholder(s) — ${added.map((e) => e.code).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.align) {
    const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
    if (files.length === 0) throw new Error('--align needs one or more .json paths');
    alignFiles(files);
    if (warningCount > 0) console.log(`\n${warningCount} warning(s).`);
    return;
  }

  if (args.help || !args.prog) { console.log(USAGE); process.exit(args.prog ? 0 : 1); }

  const prog = args.prog.toUpperCase();

  if (args.prereqs) { await fillPrereqs(prog); return; }
  if (args.fillElectives) { await fillElectivesInCuratedFile(prog); return; }

  if (args.dumpState != null) {
    const cohort = args.cohort ?? await newestPublishedCohort(prog, new Date().getFullYear());
    console.log(JSON.stringify(
      await fetchStudyPlanState(prog, termFor(cohort), args.dumpState), null, 1));
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
  const thisYear = new Date().getFullYear();
  const newest = await newestPublishedCohort(prog, thisYear);
  if (!newest) throw new Error(`no published study plan found for ${prog}`);

  const specRegistry = await getJson(
    `https://api.kth.se/api/kopps/v2/programme/${prog}/${termFor(newest)}`, { allow404: true });
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

  const cohorts = args.allCohorts
    ? Array.from({ length: newest - EARLIEST_COHORT + 1 }, (_, i) => EARLIEST_COHORT + i)
    : [args.cohort ?? newest];

  // Prerequisites are per course, not per cohort, so one review file per
  // programme is enough — built from the last cohort extracted.
  let lastEntries = null;
  let lastReview = [];
  for (const c of cohorts) {
    if (c < EARLIEST_COHORT) {
      warn(`${cohortLabel(c)} is older than the supported floor ${cohortLabel(EARLIEST_COHORT)} — skipped`);
      continue;
    }
    const res = await extractCohort(prog, c, args, registryEntries);
    if (res) { lastEntries = res.entries; lastReview = res.prereqReview; }
  }

  if (lastEntries) {
    const rp = writePrereqReview(prog, lastEntries.filter((e) => e.code), lastReview, `cohort ${cohortLabel(cohorts[cohorts.length - 1])}`);
    console.log(`\nWrote ${rel(rp)} — ${lastReview.length} item(s) for coordinator review`);
  }

  writeCohortIndex();

  if (warningCount > 0) console.log(`\n${warningCount} warning(s).`);
  console.log(`\nValidate with:\n  node scripts/validate-data.mjs --cohorts`);
}

/**
 * Rebuild src/data/cohorts/index.json from the files actually present.
 *
 * The client needs to know which cohorts it can offer, and it cannot read a
 * directory at runtime. Deriving the index from disk rather than appending to it
 * means a deleted cohort file disappears from the selector too, instead of
 * leaving an entry that 404s.
 */
/**
 * Write the coordinator review file for one programme's prerequisites.
 *
 * Prerequisites are the one field that comes from free text, so this is what a
 * program coordinator actually has to check. It is written as markdown next to
 * the data rather than printed, because the person who needs it is not the
 * person running the script.
 */
function writePrereqReview(prog, entries, review, basis) {
  const withC = entries.filter((e) => e.prerequisitesCompleted?.length);
  const withP = entries.filter((e) => e.prerequisitesParticipation?.length);
  const byKind = {};
  for (const r of review) (byKind[r.kind] ??= []).push(r);

  const L = [];
  L.push(`# ${prog} — prerequisites to verify`);
  L.push('');
  // Kursplan versions differ per cohort, so the same course can yield different
  // prerequisites depending on what this file was generated for. Say which.
  L.push(`Resolved for: **${basis}**. Kursplan versions differ between cohorts, so a`);
  L.push('run for a different cohort can legitimately produce a different worklist.');
  L.push('');
  L.push('Generated by `scripts/extract-from-kopps.mjs`. Prerequisites are the only field taken from');
  L.push('free text (KOPPS *Särskild behörighet*), so every judgement below needs a program');
  L.push('coordinator to confirm or correct. Edit `src/data/cohorts/` (or the curated');
  L.push(`\`src/data/${prog}.json\`) directly — this file is a worklist, not a source.`);
  L.push('');
  L.push('## What was extracted');
  L.push('');
  L.push(`- \`prerequisitesCompleted\` (slutförd kurs): **${withC.length}** course(s)`);
  L.push(`- \`prerequisitesParticipation\` (aktivt deltagande): **${withP.length}** course(s)`);
  L.push(`- items flagged below: **${review.length}**`);
  L.push('');
  for (const e of [...withC, ...withP].sort((a, b) => a.code.localeCompare(b.code))) {
    const parts = [];
    if (e.prerequisitesCompleted?.length) parts.push(`slutförd: ${e.prerequisitesCompleted.join(', ')}`);
    if (e.prerequisitesParticipation?.length) parts.push(`deltagande: ${e.prerequisitesParticipation.join(', ')}`);
    L.push(`- \`${e.code}\` — ${parts.join('; ')}`);
  }

  const HEADINGS = {
    'upstream-stale': ["The course's own prerequisite list looks out of date — report it",
      'These courses require a knowledge area that **this programme teaches**, but their list of qualifying courses does not include our course. CTMAT is the worked example: DD1385 and DD1380 ask for "programmering" while listing only `DD1310/DD1311/.../DD1331`, and CTMAT\'s own first-year programming course is DD1333. Neither syllabus has been revised since HT2021.\n\nThis is a defect in the **other course\'s** syllabus, not in this programme\'s data, so nothing was recorded automatically. Confirm the suggested course is really the intended prerequisite, add it here, and **report it to the coordinator or administrator of that course** so it is corrected at source — otherwise it stays wrong for every programme that uses the course. DD1328 needed exactly this and has since been fixed upstream: its VT2026 syllabus lists DD1333.'],
    'not-earlier': ['Prerequisite does not precede the course',
      'The prerequisite is recorded, but it does not come earlier in this programme. A *slutförd* requirement has to finish before the course starts; a *deltagande* one may overlap but cannot start after the course ends. Either the prerequisite is wrong or the course sits in the wrong place — both need a decision, and both are worth raising with the course owner.'],
    'type-implicit': ['Type inferred, not stated',
      'The text names a course but never says "slutförd" or "aktivt deltagande". The type below was inferred — from a signal elsewhere in the same text, or defaulted to *slutförd*. **This is the most likely place for an error.**'],
    'alternatives': ['Several alternatives survived the in-programme filter',
      'The text offers a choice ("eller", "/") and more than one option is a course in this programme. All were recorded, which is wrong if the student only needs one. Decide which applies.'],
    'module-level': ['Requirement on a single examination module',
      'The text requires one module of another course (for example "slutfört moment LAB1 i SH1017") rather than the whole course. The schema has no shape for that, so nothing was recorded from this clause — recording the whole course would overstate the requirement. Worth deciding whether the whole course is the right approximation here.'],
    'credit-threshold': ['Credit thresholds, not expressible',
      'The requirement is a credit total ("minst N hp"), which the schema cannot represent as a course dependency. Nothing was recorded for these.'],
    'nothing-extracted': ['Text names courses, but none in this programme',
      'Usually correct — KOPPS lists alternatives from other programmes and the in-programme filter drops them. But the lists also go stale: where the text describes a knowledge area and this programme has a course of that name, the candidate is called out below as **suggested**. Nothing is written to the data from a name match — confirm it first.'],
  };
  for (const [kind, [title, blurb]] of Object.entries(HEADINGS)) {
    const items = byKind[kind];
    if (!items?.length) continue;
    L.push('');
    L.push(`## ${title} (${items.length})`);
    L.push('');
    L.push(blurb);
    L.push('');
    for (const r of items) {
      if (r.kind === 'not-earlier') {
        L.push(`- \`${r.code}\` requires \`${r.req}\` (${r.label}) — not earlier in the programme`);
        continue;
      }
      const chose = r.chose ? ` → recorded as **${r.chose}**` : '';
      const codes = r.codes ? ` \`${r.codes.join(', ')}\`` : '';
      L.push(`- \`${r.code}\`${codes}${chose}`);
      L.push(`  > ${r.clause.slice(0, 300)}`);
      for (const sug of r.suggestions || []) {
        L.push(`  - **suggested:** \`${sug.code}\` ${sug.name} — the text asks for "${sug.area}" and this programme has that course, but KOPPS never lists it`);
      }
    }
  }
  L.push('');

  mkdirSync(reviewDir, { recursive: true });
  const out = join(reviewDir, `${prog}.md`);
  writeFileSync(out, `${L.join('\n')}\n`, 'utf8');
  return out;
}

function writeCohortIndex() {
  // Same read-then-handle shape as readTextOrNull: no separate existence check.
  let names;
  try {
    names = readdirSync(cohortsDir).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const byProgram = {};
  for (const f of names) {
    const m = /^([A-Z0-9]+)-(HT\d{4})\.json$/.exec(f);
    if (!m) continue;
    (byProgram[m[1]] ??= []).push(m[2]);
  }
  for (const list of Object.values(byProgram)) list.sort().reverse(); // newest first
  const indexPath = join(cohortsDir, 'index.json');
  writeFileSync(indexPath, `${JSON.stringify(byProgram, null, 2)}\n`, 'utf8');
  console.log(`\nUpdated ${rel(indexPath)}: ` +
    Object.entries(byProgram).map(([k, v]) => `${k} (${v.length})`).join(', '));
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
