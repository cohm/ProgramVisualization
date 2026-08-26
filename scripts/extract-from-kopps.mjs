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

// Does an examination module occupy a scheduled examination slot, and so justify
// an exam marker?
//
// This used to be a prefix list, `['TEN', 'HEM']`, and the HEM half was wrong.
// It was added because DD1327's curated `exams` said `["P4"]` while its modules
// are HEM1+PRO1 — but that curated value was itself the error, so the rule was
// derived from the bug it then propagated to every other cohort. Measured over
// all 278 courses in the data: **all 48 `HEM*` modules are titled
// "hemuppgift(er)"** — homework — and not one is a tentamen. Meanwhile the only
// genuine take-home exam in the whole dataset is coded `EXA1` ("Hemtentamen"),
// which a HEM prefix misses entirely.
//
// So: `TEN*` (569 modules, titled "tentamen" / "skriftlig tentamen" /
// "problemtentamen") OR a title that says tentamen. The code test keeps the
// handful of TEN modules with an unusual title — `TEN1 "Examination"`,
// `TEN1 "Skriftlig test"`, `TEN1 "Kontrollskrivning"` — and the title test picks
// up `EXA2 "Hemtentamen"`. LAB / INL / PRO / DIA / SEM / KON / VN are coursework
// and get no marker, so a course with only those correctly ends up with
// `exams: []` rather than a fabricated one.
const isExamModule = (m) =>
  m.code.toUpperCase().startsWith('TEN') || /tentamen|tentamina/i.test(m.title || '');

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
// Deduped: exam derivation runs twice per course (once during enrichment, once
// after the cohort's kursplan version is chosen), so an identical message would
// otherwise appear twice in the review list for no reason.
const seenFlags = new Set();
const flag = (msg) => { if (!seenFlags.has(msg)) { seenFlags.add(msg); review.push(msg); } };

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
// The villkorligt-valfri rule, as the study plan states it
// ---------------------------------------------------------------------------
//
// `curriculumInfo.conditionallyElectiveCoursesInformation` is a field we ignored
// for a long time, and it carries exactly what the schema could not otherwise
// know: how many of a VV group's courses a student actually takes, and which
// master programme each one qualifies them for. Without it a group can only be
// guessed at, and the guess was wrong — CFATE year 3 was modelled as pick-one
// when Teknisk fysik (TTFYM) requires SI1146 *and* SH1014.
//
// MEASURED over the eight programmes, three läsår, years 1-3: 39 of 166
// curriculumInfos populate it. The phrasings that carry machine-readable rules:
//
//   "Minst en av de villkorligt valfria kurserna ... ska läsas"     -> minCredits/pickN ≥ 1
//   "För civilingenjörsexamen ska minst två av följande kurser"     -> ≥ 2      (CMAST)
//   "En villkorligt valfri kurs ska läsas"                          -> exactly 1 (CTMAT)
//   "antingen SA114X eller EF112X"                                  -> exactly 1 (CTFYS)
//   "Kurser som krävs: SI1146 och SH1014"                           -> per-master requirement
//
// Everything else is prose for a human — year-flexibility notes, and TIEMM's
// per-master "Välj fyra kurser", which depends on a *degree* the student has not
// applied for yet and so cannot be a property of the group.

const SWEDISH_NUMBERS = { en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6 };

// "Minst en av de villkorligt valfria kurserna", "ska minst två av följande".
//
// The trailing boundary is `(?!\p{L})`, not `\b`. JavaScript's `\b` is
// ASCII-only, so in "minst två av" it looks for a boundary between `v` and `å`
// and finds none — the word simply fails to match, silently. That dropped every
// Swedish-numeral count in the data (CMAST's "minst två av följande kurser") and
// only the digit and `en`/`tre` forms worked.
const MIN_COUNT_RE = /\bminst\s+(en|ett|två|tre|fyra|fem|sex|\d+)(?!\p{L})/iu;
// "En villkorligt valfri kurs ska läsas" — exactly one, stated as prose.
const EXACT_ONE_RE = /^\s*(en|ett)\s+villkorligt\s+valfri\s+kurs\s+ska\s+läsas/i;
// "Endast en av kurserna SG1217 och SG1220 kan ingå i examen." — a mutual
// exclusion, not a group rule: it caps what may count toward the degree rather
// than saying how many to take. Recognised so it is not reported as unread, but
// deliberately not turned into a pickN.
const MUTUAL_EXCLUSION_RE = /^\s*endast\s+(en|ett)\s+av\s+kurserna\b/i;
// "ska antingen SA114X eller EF112X läsas"
const EITHER_OR_RE = /\bantingen\b[^.]*\beller\b/i;
// "Kurs som krävs: MJ1401" / "Kurser som krävs: SI1146 och SH1014"
const REQUIRED_FOR_RE = /^\s*kurs(?:en|erna|er)?\s+som\s+krävs\s*:\s*(.+)$/i;
// "Teknisk fysik (TTFYM)" / "Industriell produktutveckling (TIPUM) spår IPUC"
const MASTER_HEADING_RE = /^\s*(.+?)\s*\(([A-Z]{4,6})\)\s*(?:spår\s+([A-Z]{3,5}))?\s*:?\s*$/;
// "Samt SI1155 för tre av spåren: TFYA, TFYB och TFYG"
const ALSO_FOR_TRACKS_RE = /^\s*samt\s+(.+?)\s+för\s+.*?spåren?\s*:?\s*(.*)$/i;

const swedishCount = (word) => (/^\d+$/.test(word)
  ? Number(word)
  : SWEDISH_NUMBERS[word.toLowerCase()] ?? null);

/**
 * Read the VV rule and the per-master requirements out of the free text.
 *
 * Returns `{ minCount, exactCount, requiredFor }`. `requiredFor` maps a course
 * code to the master programmes that require it, which is the answer to the
 * question a year-3 student is actually asking when they look at a VV box.
 * Anything not recognised is left for a human — this text is prose, so the
 * parser reports what it is sure of rather than guessing.
 */
function parseConditionallyElectiveInfo(text) {
  const out = { minCount: null, exactCount: null, requiredFor: new Map(), exclusions: [], unparsed: [] };
  if (!text) return out;

  let currentMaster = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = MASTER_HEADING_RE.exec(line);
    if (heading) {
      currentMaster = {
        name: heading[1].trim(),
        code: heading[2],
        track: heading[3] || null,
      };
      continue;
    }

    const required = REQUIRED_FOR_RE.exec(line);
    if (required && currentMaster) {
      for (const code of required[1].match(COURSE_CODE_RE) || []) {
        const list = out.requiredFor.get(code) ?? [];
        list.push({ ...currentMaster });
        out.requiredFor.set(code, list);
      }
      continue;
    }

    const also = ALSO_FOR_TRACKS_RE.exec(line);
    if (also && currentMaster) {
      const tracks = (also[2].match(/\b[A-Z]{3,5}\b/g) || []);
      for (const code of (also[1].match(COURSE_CODE_RE) || [])) {
        const list = out.requiredFor.get(code) ?? [];
        list.push({ ...currentMaster, tracks: tracks.length ? tracks : undefined });
        out.requiredFor.set(code, list);
      }
      continue;
    }

    if (MUTUAL_EXCLUSION_RE.test(line)) {
      out.exclusions.push(line);
      continue;
    }

    if (EXACT_ONE_RE.test(line) || EITHER_OR_RE.test(line)) {
      out.exactCount = 1;
      continue;
    }

    const min = MIN_COUNT_RE.exec(line);
    if (min) {
      const n = swedishCount(min[1]);
      if (n != null) out.minCount = Math.max(out.minCount ?? 0, n);
      continue;
    }

    // Not a rule. Some of these are simply prose and are silently ignored:
    // the section header, a master heading with no course under it, and
    // year-flexibility notes. Anything else is surfaced, because an unread line
    // could be a rule this parser does not yet know.
    if (!/^behörighetsgivande/i.test(line)
      && !/kan läsas år/i.test(line)
      && !MASTER_HEADING_RE.test(line)) {
      out.unparsed.push(line);
    }
  }
  return out;
}





// ---------------------------------------------------------------------------
// Preserving hand-added decoration across re-extraction
// ---------------------------------------------------------------------------
//
// Some fields cannot be derived from KTH's data and can only be written by a
// human: a group's free-text `comment`, a readable `name` in place of the
// extractor's "Villkorligt valfri grupp 1", and the `teacher` / `description`
// that CLAUDE.md has always listed as not extractable. Overwriting the file on
// every run destroyed them, which put the archive in an awkward position: a
// cohort plan could be either regenerable or annotated, but not both.
//
// So a re-run now UPDATES: it re-derives everything it knows and carries these
// fields forward from the previous file. Everything the extractor owns is still
// replaced outright, so a change at KTH always wins — this is not a merge, it is
// a re-derivation that preserves the parts it has no opinion about.

/** Fields the extractor never derives, per entry kind. */
const EDITORIAL_COURSE_FIELDS = ['teacher', 'description', 'webpage', 'briefName', 'briefNameEn'];
const EDITORIAL_GROUP_FIELDS = ['name', 'nameEn', 'comment', 'commentEn'];

/**
 * Identity of an option group, for matching across runs.
 *
 * NOT the name: the name is itself editorial, so keying on it would lose the
 * annotation the moment someone renamed the group — which is exactly what the
 * extractor asks them to do. Year, period layout and option set are all derived,
 * so they are stable under renaming.
 */
const groupIdentity = (g) =>
  `${g.year}::${PERIOD_IDS.map((p) => g.periodCredits?.[p] ?? 0).join(',')}::${(g.options ?? []).slice().sort().join('+')}`;

/**
 * Carry hand-written fields from the file being replaced into the new entries.
 * Returns a short description of what was preserved, for the run's report.
 */
function carryForwardEditorial(outPath, entries) {
  const raw = readTextOrNull(outPath);
  if (raw === null) return null;
  let previous;
  try { previous = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(previous)) return null;

  const prevCourses = new Map();
  const prevGroups = new Map();
  for (const e of previous) {
    if (e?.type === 'optionGroup') prevGroups.set(groupIdentity(e), e);
    else if (e?.code) prevCourses.set(e.code, e);
  }

  const kept = [];
  for (const entry of entries) {
    const isGroup = entry.type === 'optionGroup';
    const prev = isGroup ? prevGroups.get(groupIdentity(entry)) : prevCourses.get(entry.code);
    if (!prev) continue;
    for (const field of isGroup ? EDITORIAL_GROUP_FIELDS : EDITORIAL_COURSE_FIELDS) {
      const value = prev[field];
      if (value == null || value === '') continue;
      // Only fill what this run left empty. A field the extractor now derives
      // (an English title it previously lacked) must not be reverted to the old
      // hand-written value.
      if (entry[field] != null && entry[field] !== '') continue;
      entry[field] = value;
      kept.push(`${isGroup ? entry.name : entry.code}.${field}`);
    }
    // A renamed group keeps its name, which the loop above only applies when the
    // new name is empty — and it never is, since the extractor always emits one.
    // So handle it explicitly: a human-chosen name outranks the placeholder.
    if (isGroup && prev.name && prev.name !== entry.name
        && !/^Villkorligt valfri grupp \d+$/.test(prev.name)) {
      kept.push(`${entry.name} → ${prev.name} (name)`);
      entry.nameEn = prev.nameEn ?? entry.nameEn;
      entry.name = prev.name;
    }
  }
  return kept.length > 0 ? kept : null;
}

// ---------------------------------------------------------------------------
// Inriktning or master programme?
// ---------------------------------------------------------------------------
//
// Kopps returns BOTH under `curriculumInfos[].code`, and CMAST shows why the
// difference matters. Its 17 "specialisations" are:
//
//   "Internationell inriktning, franska/spanska/tyska"   3 real inriktningar
//   "Master, flyg- och rymdteknik" (and 7 more)          8 master programmes
//   "Spår, mekatronik" (and 5 more)                      6 master-programme spår
//
// Only the first three are bachelor-level inriktningar of the kind CINEK has
// (Datateknik, Tillämpad matematik, …) — a dimension a year-1-3 student is
// actually filtered by. The other 14 are years 4-5 destinations, and a year-3
// course tagged with them is not "a course for this inriktning" but "a course
// required for eligibility to that master", which is exactly what `qualifiesFor`
// expresses.
//
// Modelling them as inriktningar put 17 filter chips in the UI for a programme
// that has three, and made a course required for 3 of 14 masters look like an
// inriktning-specific course. The name prefix is the discriminator, and it is
// KTH's own wording rather than a guess.
const MASTER_SPEC_RE = /^\s*(master|spår)\b/i;

// ...but the same wording means the opposite thing inside a master's programme.
// TIEMM is "Masterprogram, industriell ekonomi" and its nine specialisations are
// all "Spår, X" — those ARE its inriktningar, the only such dimension it has.
// Stripping them by prefix alone deleted the whole registry of a programme that
// legitimately needs it, so the rule is gated on the programme's own kind: a
// master programme named inside a *civilingenjör* programme is a years 4-5
// destination; a spår named inside a master's programme is its own structure.
const MASTER_PROGRAMME_RE = /^\s*(masterprogram|master's programme)\b/i;

const isMasterProgramme = (program) => MASTER_PROGRAMME_RE.test(program?.name || '');

/**
 * True for a registry entry that names a years 4-5 destination rather than a
 * bachelor inriktning. Always false for a master's programme, whose spår are its
 * own inriktningar.
 */
const isMasterSpec = (entry, program) =>
  !isMasterProgramme(program) && MASTER_SPEC_RE.test(entry?.name || '');

// ---------------------------------------------------------------------------
// Which period an elective actually runs in
// ---------------------------------------------------------------------------
//
// The study plan lists the courses that may fill a programme's elective space
// but gives them NO `creditsPerPeriod` — measured on CTFYS and CTMAT year 3, 0 of
// 20 and 0 of 31 listed courses carry any. Without a period an elective cannot be
// placed on the timeline, so the boxes could only show an undifferentiated list.
//
// The course page has it. Each entry in `roundsBySemester` carries
// `round_periods`, rendered HTML of the form
//
//     <p class="periode-list">VT 2027: P4 (3.8 hp), P3 (3.7 hp)</p>
//
// which is the authoritative per-period split for that round. Measured: 20 of 20
// CTFYS candidates and 31 of 31 CTMAT candidates have it.
//
// Two details the parser has to respect. A course can run in SEVERAL semesters
// with different splits (AK2011 is P1+P2 in the autumn and P4 in the spring;
// DD1380 runs twice in one autumn), so the round has to be chosen by the term the
// cohort would take it in rather than by taking the first. And the periods are
// not listed in order — SF1677 reports "P4 … , P3 …" — so they must be sorted,
// not read positionally.

// "VT 2027: P4 (3.8 hp), P3 (3.7 hp)" — one period and its credits.
const ROUND_PERIOD_RE = /\bP([1-4])\s*\(([\d.,]+)\s*hp\)/g;

/**
 * Parse one round's `round_periods` into a {P1..P4} map.
 *
 * Returns null when the string carries no period at all, so a caller can tell
 * "no data" from "genuinely zero credits".
 */
function periodsFromRound(html) {
  const text = decodeHtmlText(html);
  if (!text) return null;
  const out = Object.fromEntries(PERIOD_IDS.map((p) => [p, 0]));
  let found = false;
  for (const m of text.matchAll(ROUND_PERIOD_RE)) {
    out[`P${m[1]}`] = round(Number(m[2].replace(',', '.')) || 0);
    found = true;
  }
  return found ? out : null;
}

/**
 * The period split for a course in the term a cohort would take it.
 *
 * Prefers a round in that exact term; falls back to the same season (autumn vs
 * spring) in another year, since a course's period placement is far more stable
 * across years than across seasons — an autumn round tells you nothing about
 * where a spring round sits. Returns null rather than guessing when neither
 * exists.
 */
function electivePeriods(roundsBySemester, wantedTerm) {
  if (!roundsBySemester) return null;
  const season = wantedTerm % 10;
  const candidates = [];
  for (const [term, rounds] of Object.entries(roundsBySemester)) {
    const t = Number(term);
    if (!Number.isFinite(t)) continue;
    for (const rd of rounds || []) {
      const pc = periodsFromRound(rd?.round_periods);
      if (!pc) continue;
      candidates.push({ term: t, periodCredits: pc, applicationCode: rd?.round_application_code });
    }
  }
  if (candidates.length === 0) return null;

  const exact = candidates.filter((c) => c.term === wantedTerm);
  if (exact.length > 0) return { term: wantedTerm, rounds: exact };

  const sameSeason = candidates.filter((c) => c.term % 10 === season);
  if (sameSeason.length > 0) {
    // Nearest year in the same season.
    const nearestTerm = sameSeason.reduce((best, c) =>
      Math.abs(c.term - wantedTerm) < Math.abs(best.term - wantedTerm) ? c : best).term;
    return {
      term: nearestTerm,
      rounds: sameSeason.filter((c) => c.term === nearestTerm),
      approximate: true,
    };
  }
  return null;
}

/** First teaching period of a round — its stable id in the data files. */
const firstPeriodOf = (pc) => PERIOD_IDS.find((p) => (pc?.[p] || 0) > 0) ?? 'P1';

/**
 * Order rounds by first period and drop duplicates.
 *
 * Rounds used to be collapsed here by taking the per-period MAXIMUM across
 * offerings, on the reasoning that alternatives must not be summed. That avoided
 * double-counting but still produced a single bar covering every period the
 * course is ever given in: DD1380 (1.5 hp, given in all four periods) came out
 * as {P1:1.5, P2:1.5, P3:1.5, P4:1.5}, and `totalCredits` — recomputed from the
 * periods to keep Σ consistent — became 6, four times the real course.
 *
 * Alternatives need to stay alternatives, so they are kept as a list and the
 * schema carries them (see CourseRound). One round can legitimately span several
 * periods — AK2011's autumn offering is {P1:4, P2:3.5} — which is why a round is
 * a period MAP and not a single period.
 */
function orderRounds(rounds) {
  const seen = new Set();
  const out = [];
  for (const r of rounds) {
    const key = PERIOD_IDS.map((p) => r.periodCredits[p] || 0).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) =>
    PERIOD_IDS.indexOf(firstPeriodOf(a.periodCredits)) -
    PERIOD_IDS.indexOf(firstPeriodOf(b.periodCredits)));
}


/**
 * Period split for one elective in the läsår a cohort takes `studyYear` in.
 *
 * The term cannot be derived from the period the way `termForCourse` does it,
 * because the period is precisely what is unknown here. So both halves of the
 * läsår are tried — autumn (P1/P2) and the following spring (P3/P4) — and
 * whichever the course actually has a round in wins. A course offered in both
 * (AK2011, DD2421) is reported for review rather than silently placed in one.
 */
async function electivePeriodsForYear(code, cohort, studyYear, preferredApplicationCode) {
  let meta;
  try { meta = await fetchCourseMeta(code); } catch { return null; }
  if (!meta?.roundsBySemester) return null;

  const lasar = cohort + studyYear - 1;
  const autumn = lasar * 10 + TERM_AUTUMN;
  const spring = (lasar + 1) * 10 + TERM_SPRING;

  const inAutumn = electivePeriods(meta.roundsBySemester, autumn);
  const inSpring = electivePeriods(meta.roundsBySemester, spring);

  const exact = [inAutumn, inSpring].filter((x) => x && !x.approximate);
  let collected;
  let approximate = false;
  if (exact.length > 0) {
    collected = exact.flatMap((x) => x.rounds);
  } else {
    // Neither term has a round: fall back to the nearest same-season one, which
    // `electivePeriods` marks approximate.
    const near = inAutumn ?? inSpring;
    if (!near) return null;
    collected = near.rounds;
    approximate = true;
    flag(`${code}: no round in läsår ${lasar}/${lasar + 1}; periods taken from the ` +
      `nearest ${near.term % 10 === TERM_AUTUMN ? 'autumn' : 'spring'} round (${near.term}) — verify.`);
  }

  const rounds = orderRounds(collected);
  if (rounds.length === 0) return null;

  // Which offering is the DEFAULT — what a consumer that ignores `rounds` will
  // draw. The study plan's participation names a specific kurstillfälle in its
  // `applicationCode`, so when we have it, KTH has already answered the question
  // and we do not have to guess. Otherwise the earliest offering wins.
  const preferred = preferredApplicationCode
    ? rounds.find((r) => r.applicationCode === String(preferredApplicationCode))
    : undefined;
  const chosen = preferred ?? rounds[0];

  if (rounds.length > 1) {
    flag(`${code}: given ${rounds.length} times in läsår ${lasar}/${lasar + 1} ` +
      `(${rounds.map((r) => JSON.stringify(pcOnly(r))).join(', ')}) — emitted as ` +
      `alternative rounds, default ${firstPeriodOf(chosen.periodCredits)}` +
      `${preferred ? ' (the offering the study plan points at)' : ''}. A student takes one.`);
  }

  return {
    periodCredits: chosen.periodCredits,
    rounds,
    ...(approximate ? { approximate: true } : {}),
  };
}

const pcOnly = (x) => Object.fromEntries(
  PERIOD_IDS.filter((p) => (x?.periodCredits?.[p] || 0) > 0).map((p) => [p, x.periodCredits[p]]));

/** True when any offering of this course teaches in `pid`. */
const offeredInPeriod = (got, pid) =>
  (got?.rounds ?? []).some((r) => (r.periodCredits?.[pid] || 0) > 0);

// ---------------------------------------------------------------------------
// Master-programme eligibility from `supplementaryInformation`
// ---------------------------------------------------------------------------
//
// CFATE states its master requirements in
// `conditionallyElectiveCoursesInformation`; CTFYS and CTMAT state theirs in
// `supplementaryInformation`, in two further formats. All three say the same kind
// of thing — which courses a master programme needs — so all three are read.
//
//   CTFYS, inline:   "Matematik (TMAKM)"
//                    "behörighetsgivande kurser: SF1677 Analysens grunder 7,5 hp
//                     och SF1678 Grupper och ringar 7,5 hp"
//
//   CTMAT, block:    "Matematik TMAKM"                        <- no parentheses
//                    "Behörighetsgivande kurser (måste vara avslutade):"
//                    "SF1677 Analysens grunder"
//                    "SF1678 Grupper och ringar"
//                    "Rekommenderade kurser:"
//                    "SF1691 Komplex analys"
//
// The distinction that matters is *required* versus *recommended*: the first is
// a hard eligibility condition ("måste vara avslutade"), the second is advice.
// Conflating them would tell a student a course is mandatory when it is not.

// The master-programme code, ANYWHERE in the line: "Matematik (TMAKM)",
// "Matematik TMAKM", or — as läsår 2024/25 writes it — the programme and its
// requirement heading run together in one paragraph:
//
//   "Teknisk fysik TTFYM Behörighetsgivande kurser (måste vara avslutade):"
//
// An earlier version anchored the code to end-of-line, which silently failed on
// that form: the heading was not recognised, so the courses under it were
// attributed to the PREVIOUS programme. EI1320 came out as required for TSCRM
// (Systemteknik och robotik) when the plan says TTFYM (Teknisk fysik) — a wrong
// answer rather than a missing one, which is why the code is now found wherever
// it sits and the heading tested independently.
//
// The T…M shape is required rather than any run of capitals, so ordinary prose
// and course codes cannot match.
const MASTER_CODE_RE = /\b(T[A-Z]{2,4}M)\b/;
const REQUIRED_HEADING_RE = /behörighetsgivande\s+kurs(?:er)?/i;
const RECOMMENDED_HEADING_RE = /rekommenderade?\s+kurs(?:er)?/i;
// A line that is itself a course listing: starts with a code.
const COURSE_LINE_RE = /^\s*([A-Z]{2,3}\d{3,4}[A-Z]?)\b/;

/**
 * Read master-programme eligibility out of a study plan's prose.
 *
 * Returns a Map from course code to the programmes that require or recommend it.
 * `required` distinguishes the two, because the plan does: CTMAT writes
 * "Behörighetsgivande kurser (måste vara avslutade)" for one and
 * "Rekommenderade kurser" for the other, and a student needs to know which.
 */
function parseMasterEligibility(text) {
  const out = new Map();
  if (!text) return out;

  let master = null;
  let mode = null; // 'required' | 'recommended'

  const attach = (codes, required) => {
    if (!master) return;
    for (const code of codes) {
      const list = out.get(code) ?? [];
      // One programme can appear twice for the same course (required in one
      // läsår's wording, recommended in another); keep the stronger claim.
      const existing = list.find((m) => m.code === master.code);
      if (existing) { existing.required = existing.required || required; continue; }
      list.push({ code: master.code, name: master.name, required });
      out.set(code, list);
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // A line can carry a programme heading, a requirement heading and courses all
    // at once, so each is handled in turn rather than as exclusive branches.
    const codeMatch = MASTER_CODE_RE.exec(line);
    if (codeMatch) {
      master = { code: codeMatch[1], name: line.slice(0, codeMatch.index).trim() || codeMatch[1] };
      mode = null;
    }

    const isRequired = REQUIRED_HEADING_RE.test(line);
    const isRecommended = RECOMMENDED_HEADING_RE.test(line);
    if (isRequired || isRecommended) {
      mode = isRequired ? 'required' : 'recommended';
      // CTFYS puts the courses on the same line as the heading; CTMAT puts them
      // on the following lines. Handle both by reading any codes present here.
      const inline = line.match(COURSE_CODE_RE) || [];
      if (inline.length > 0) attach(inline, mode === 'required');
      continue;
    }
    if (codeMatch) continue;

    // A bare course line continues whichever heading was last seen.
    if (mode && COURSE_LINE_RE.test(line)) {
      attach(line.match(COURSE_CODE_RE) || [], mode === 'required');
      continue;
    }

    // "eller" on its own line joins two alternatives, so it must not end the
    // list: CTMAT writes "DD2350 …" / "eller" / "DD2352 …" for TCSCM, and
    // dropping the second would tell a student only one course qualifies.
    if (/^(eller|och|samt)$/i.test(line)) continue;

    // Any other prose ends the current list, so a later course line cannot be
    // silently attributed to a heading it does not belong to.
    if (!COURSE_LINE_RE.test(line)) mode = null;
  }
  return out;
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
  const noteLines = [];
  const vvInfo = [];

  for (const info of infos) {
    if (info.supplementaryInformation) {
      notes.push(decodeHtmlText(info.supplementaryInformation));
      // A line-preserving copy: `notes` is collapsed to one line for prose regex
      // matching (elective-space wording), but the master-eligibility parser is
      // line-based — a heading and the courses under it are separate <p> blocks.
      noteLines.push(decodeHtmlLines(info.supplementaryInformation));
    }
    // The VV rule and per-master requirements, kept per inriktning so a group
    // built from one curriculumInfo gets its own programme's wording.
    if (info.conditionallyElectiveCoursesInformation) {
      vvInfo.push({
        spec: info.isCommon ? null : (info.code || null),
        // Newlines matter: the CFATE text is a list of master programmes, each a
        // heading line followed by its "Kurs som krävs" line.
        text: decodeHtmlLines(info.conditionallyElectiveCoursesInformation),
      });
    }
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
          // The kurstillfälle this programme places the course in. Only used for
          // courses given several times a läsår, where it names the default round.
          applicationCode: part.applicationCode,
        });
      }
    }
  }
  return { records, specNames, notes, noteLines, vvInfo };
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
// One examination module: "LABB - Datorlaboration, 2,0 hp, betygsskala: A, B, C,
// D, E, FX, F". The page concatenates every module of a kursplan into one string
// with no separator, so they have to be split before being parsed.
//
// The previous single regex ended in a greedy `([^|<]+)` for the grading scale,
// which swallowed the rest of the string — every module after the first. It
// parsed **933 modules where a correct split finds 2275**, truncating 66% of all
// kursplan versions, and silently defeated the "one exam per exam-bearing
// module" rule that `examsForPeriods` documents: `examBearing.length` could
// never exceed 1.
//
// Two details the old pattern also got wrong. A module code can end in a
// **letter** (`TENA`, `TENB`), not just a digit — SF2930's `TENA - Skriftlig
// tentamen` is a real exam. And Swedish initials matter: `ÖVN1` was matched from
// the `V`, yielding a phantom `VN` prefix (61 of them).
const MODULE_CODE = '[A-ZÅÄÖ]{2,4}[A-Z0-9]';
const MODULE_SPLIT_RE = new RegExp(`(?=\\b${MODULE_CODE}\\s*-\\s*)`, 'u');
const MODULE_ITEM_RE = new RegExp(
  `^(${MODULE_CODE})\\s*-\\s*(.+?),\\s*([\\d,.]+)\\s*hp,\\s*betygsskala:\\s*(.+?)\\s*$`, 'u');

/** Every examination module in one kursplan's examination text. */
function parseExamModules(text) {
  const out = [];
  for (const chunk of String(text || '').split(MODULE_SPLIT_RE)) {
    const m = MODULE_ITEM_RE.exec(chunk.trim());
    // The title is kept because it, not the code, is what identifies a
    // tentamen — see isExamModule.
    if (m) out.push({ code: m[1], title: m[2], hp: m[3], scale: mapPageGradingScale(m[4]) });
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// Links into KTH's own pages
// ---------------------------------------------------------------------------
//
// The review files are handed to program directors to sign off, so every claim
// has to be checkable in one click rather than by searching kth.se. Three URL
// shapes carry that, all verified to resolve (August 2026):
//
//   course page      /student/kurser/kurs/EI1320
//   one kursplan     /student/kurser/kurs/kursplan/EI1320-20212.pdf?lang=sv
//   version archive  /kursutveckling/EI1320/arkiv
//
// The kursplan route was found in the course page's own render state, as
// `paths.SyllabusPdf.getPdfProxy.uri` = `/student/kurser/kurs/kursplan/
// :course_semester`. The `.pdf` suffix is required — without it the endpoint
// answers 500 for every input, including valid ones, which is what makes this
// easy to get wrong.
//
// Passing a term that is not itself a version boundary still works: the
// endpoint resolves it to the version in force then, so EI1320-20231.pdf
// returns the 20212 kursplan byte-for-byte. We nevertheless link the version's
// own `valid_from` term, because that is the identifier the kursutveckling
// archive prints next to each entry, so the reviewer sees the same label in
// both places.
const courseUrl = (code) => `https://www.kth.se/student/kurser/kurs/${code}`;
const kursplanUrl = (code, term) =>
  `https://www.kth.se/student/kurser/kurs/kursplan/${code}-${term}.pdf?lang=sv`;
const archiveUrl = (code) => `https://www.kth.se/kursutveckling/${code}/arkiv`;

// Not every string in a review item is a course code. The module-level section
// carries things like "LAB1 i SH1017", and linking that verbatim produced a
// kth.se URL with a space in it that answers 400 — exactly the kind of dead link
// that costs a reviewer's trust in the rest of the file. So: link a bare code as
// itself, and inside free text link only the substrings that are codes. LAB1 is
// not one, because a module tag has fewer than the three digits a code needs.
const CODE_ONLY_RE = /^[A-Z]{2,3}\d{3,4}[A-Z]?$/;
function codeLink(text) {
  const t = String(text ?? '');
  if (CODE_ONLY_RE.test(t)) return `[${t}](${courseUrl(t)})`;
  return t.replace(/\b[A-Z]{2,3}\d{3,4}[A-Z]?\b/g, (m) => `[${m}](${courseUrl(m)})`);
}

/** 20212 -> "HT 2021", 20261 -> "VT 2026". Matches the archive page's labels. */
function termLabel(term) {
  if (!term) return '?';
  const year = Math.floor(term / 10);
  return `${term % 10 === TERM_AUTUMN ? 'HT' : 'VT'} ${year}`;
}

/** "HT 2021 - HT 2025" / "VT 2026 - tillsvidare", as the archive page writes it. */
function validityLabel(version) {
  if (!version?.term) return 'okänd version';
  return `${termLabel(version.term)} – ${version.validTo ? termLabel(version.validTo) : 'tillsvidare'}`;
}

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
    const examText = decodeHtmlText(sy.course_examination).replace(/\s+/g, ' ');
    const modules = parseExamModules(examText);
    return {
      term: syllabusTerm(sy),
      // `course_valid_to` is absent on the version currently in force, which is
      // what makes "HT 2021 - HT 2025" vs "VT 2026 - tillsvidare" expressible.
      validTo: sy.course_valid_to
        ? sy.course_valid_to.year * 10 + sy.course_valid_to.semesterNumber : null,
      eligibility: (!eligibility || NO_INFO.test(eligibility)) ? null : eligibility,
      examModules: modules,
    };
  }).filter((v) => v.term != null);

  return {
    versions,
    // Kept for elective placement: `round_periods` on each round is the only
    // source of a per-period split for a course the study plan lists without one.
    roundsBySemester: cd.roundsBySemester ?? null,
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
    examModules: [], eligibility: null, roundsBySemester: null,
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
    meta.roundsBySemester = page.roundsBySemester;
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
  const examBearing = examModules.filter(isExamModule);

  // A muntlig tentamen is a tentamen, so it counts — but an oral exam is usually
  // booked individually rather than sitting in the scheduled examination period,
  // which is what the marker on the chart means. Only 3 exist across the whole
  // data set (ME2322, ME2323, MJ1141), too few to justify inventing a rule from,
  // so they are counted and reported for a coordinator to overrule.
  for (const m of examBearing) {
    if (/muntlig/i.test(m.title || '')) {
      flag(`${entry.code}: examination module ${m.code} is "${m.title}" — an ORAL exam. ` +
        `Counted as occupying an examination slot, but an oral exam is often booked ` +
        `individually instead; confirm whether it belongs on the chart.`);
    }
  }

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
function buildOptionGroups(vvRecords, vvInfo = []) {
  // The study plan's own rule for each (year, inriktning), when it states one.
  const ruleFor = new Map();
  for (const info of vvInfo) {
    const parsed = parseConditionallyElectiveInfo(info.text);
    ruleFor.set(`${info.year}::${info.spec ?? ''}`, parsed);
    for (const line of parsed.unparsed) {
      flag(`year ${info.year}${info.spec ? ` [${info.spec}]` : ''}: ` +
        `villkorligt valfri text not machine-read: "${line.slice(0, 140)}"`);
    }
  }

  // Grouping key. Period layout is the fallback, but it is a proxy: it bundles
  // courses that merely happen to share a slot and splits ones the plan treats
  // as a single choice. CFATE year 3 is both failures at once — its five autumn
  // options are 4 hp P1, 4 hp P2, 6 hp P1, 6 hp P2 and 5+1, so the layout key
  // makes five singletons, each then dropped by the single-option rule below,
  // losing the block entirely.
  //
  // When the study plan names the courses a master programme requires, those
  // names ARE the grouping: they are the plan's own statement of what belongs
  // together. So courses that appear in one `conditionallyElectiveCoursesInformation`
  // block, in the same term, are grouped as one.
  const groups = new Map();
  for (const r of vvRecords) {
    const rule = ruleFor.get(`${r.year}::${r.spec ?? ''}`) ?? ruleFor.get(`${r.year}::`) ?? null;
    const named = rule?.requiredFor.has(r.code) ?? false;
    // Autumn (P1/P2) and spring (P3/P4) are separate choices even inside one
    // block: a bachelor thesis in P3+P4 is not an alternative to a 4 hp course
    // in P1. Splitting on term is what keeps CFATE's thesis box distinct.
    const term = PERIOD_IDS.filter((pid) => r.periodCredits[pid] > 0)
      .every((pid) => pid === 'P1' || pid === 'P2') ? 'HT' : 'VT';
    const key = named
      ? `${r.year}::${r.spec ?? ''}::named::${term}`
      : `${r.year}::${pcKey(r.periodCredits)}::${r.credits}`;
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
    // Options in a named group have DIFFERENT layouts (that is why the layout key
    // could not find them), so the group's bar cannot be any one option's shape.
    // Use the per-period maximum: the envelope of the slot, which is what an
    // `electivePlaceholder` bar means too. The first record's layout is right
    // only when every option shares it, which is the layout-keyed case.
    const uniform = recs.every((r) => pcKey(r.periodCredits) === pcKey(first.periodCredits));
    const periodCredits = Object.fromEntries(PERIOD_IDS.map((p) => [
      p,
      uniform ? round(first.periodCredits[p])
        : round(Math.max(...recs.map((r) => r.periodCredits[p] || 0))),
    ]));
    // Same reconciliation as buildCourseEntry: the validator requires
    // Σ periodCredits == totalCredits for groups too, so the periods win.
    const placed = sumCredits(periodCredits);
    let total = uniform ? round(first.credits) : placed;
    if (placed > 0 && Math.abs(placed - total) > CREDIT_TOLERANCE) {
      flag(
        `optionGroup for [${options.join(' / ')}]: options are ${total} hp but only ${placed} hp ` +
        `falls in the extracted years — totalCredits set to ${placed}. Verify.`,
      );
      total = placed;
    }
    // How many of these the student takes, per the study plan's own wording.
    // Default 1, which was the only rule the schema could express before this
    // field was read — and which CFATE year 3 shows to be wrong there.
    const rule = ruleFor.get(`${first.year}::${first.spec ?? ''}`)
      ?? ruleFor.get(`${first.year}::`)
      ?? null;
    let stated = rule?.exactCount ?? rule?.minCount ?? null;
    let statedFrom = stated != null ? 'the stated rule' : null;

    // When the plan states requirements per master programme instead of a group
    // rule, the count is implied: the most any single master requires from this
    // group. CFATE year 3 is the case — the text never says "välj N", but
    // Teknisk fysik (TTFYM) requires SI1146 AND SH1014, so a student heading
    // there takes two, and a pick-one box would make their plan impossible to
    // express. Counted per (master, track) so TTFYM's extra SI1155 for three of
    // its tracks does not inflate the autumn group.
    if (stated == null && rule?.requiredFor.size) {
      const perMaster = new Map();
      for (const code of optionCodes) {
        for (const m of rule.requiredFor.get(code) ?? []) {
          const key = `${m.code}::${m.track ?? ''}`;
          perMaster.set(key, (perMaster.get(key) ?? 0) + 1);
        }
      }
      const most = Math.max(0, ...perMaster.values());
      if (most > 1) {
        stated = most;
        const which = [...perMaster.entries()].filter(([, n]) => n === most).map(([k]) => k.split('::')[0]);
        statedFrom = `the per-master requirements (${which.join(', ')} needs ${most})`;
      }
    }
    const pickN = stated ?? 1;

    // Which master programmes require each option, when the plan says. This is
    // the answer to what a student is actually asking of a VV box, and it exists
    // nowhere else in the data we read.
    const qualifiesFor = {};
    for (const code of options) {
      const masters = rule?.requiredFor.get(code);
      if (masters?.length) {
        qualifiesFor[code] = masters.map((m) => ({
          code: m.code,
          name: m.name,
          ...(m.track ? { track: m.track } : {}),
          ...(m.tracks ? { tracks: m.tracks } : {}),
        }));
      }
    }

    const entry = {
      type: 'optionGroup',
      name: `Villkorligt valfri grupp ${n}`,
      nameEn: `Conditionally elective group ${n}`,
      year: first.year,
      totalCredits: total,
      periodCredits,
      options,
      allowedNumberOfOptions: pickN,
      kind: 'pickN',
      pickN,
      exams: [],
      category: 'conditionallyElective',
      ...(Object.keys(qualifiesFor).length > 0 ? { qualifiesFor } : {}),
    };
    if (stated != null) {
      flag(`optionGroup "${entry.name}" (year ${entry.year}): pickN set to ${stated} from ` +
        `${statedFrom}, not defaulted to 1 — verify against the study plan.`);
    }
    if (Object.keys(qualifiesFor).length > 0) {
      const summary = Object.entries(qualifiesFor)
        .map(([c, ms]) => `${c} → ${ms.map((m) => m.code).join('+')}`).join(', ');
      flag(`optionGroup "${entry.name}" (year ${entry.year}): master eligibility read from the plan: ${summary}`);
    }
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

// Oldest cohort the tool offers. HT2022 students admitted to a five-year
// civilingenjör programme are nominally in year 5 now, but those behind schedule
// are still taking bachelor-level courses and need their plan.
//
// MEASURED (August 2026): KTH has deleted HT2022 entirely. Its pages still
// render — "Utbildningsplan kull HT2022, Årskurs 1", HTTP 200 — but
// `curriculumInfos` carries one common entry with no participations at all, for
// every programme and every year. So none of HT2022's three years can come from
// HT2022; all three are borrowed from the nearest cohort that still publishes
// them, and `corroborate()` cannot run because there is no year the two cohorts
// both publish. Every HT2022 year is therefore `approximated` with confidence
// `unknown`, which the chart says out loud above the plan.
//
// That is the honest state of the source rather than a shortcoming of the
// extractor, and it is the whole reason the archive under src/data/cohorts is
// committed: HT2023's years 1-2 were readable a year ago and are not any more.
const EARLIEST_COHORT = 2022;

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
    const { records, specNames, notes, noteLines, vvInfo } = readCurriculum(state, prog, year);
    const scheduled = records.filter((r) => hasAnyCredits(r.periodCredits));
    result = { records: scheduled, listed: records.length, specNames, notes, noteLines, vvInfo };
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
        noteLines: got.noteLines || [],
        vvInfo: got.vvInfo || [],
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

/**
 * Like decodeHtmlText, but keeps block boundaries as newlines.
 *
 * `conditionallyElectiveCoursesInformation` is a list of <p> elements where the
 * structure carries meaning: a master-programme heading, then the courses it
 * requires. Collapsing all whitespace runs the two together
 * ("Teknisk fysik (TTFYM): Kurser som krävs: SI1146 och SH1014 Industriell
 * ekonomi (TINEM) ..."), which makes the heading-then-requirement pairing
 * unrecoverable.
 */
function decodeHtmlLines(input) {
  const withBreaks = String(input || '').replace(/<\/p\s*>|<br\s*\/?>/gi, '\n');
  return withBreaks
    .split('\n')
    .map((line) => decodeHtmlText(line))
    .filter(Boolean)
    .join('\n');
}

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
function fillElectiveSpace(entries, notes, hasSpecialisations, electiveRecords = [], eligibility = new Map(), electivePeriods = new Map(), electiveNames = new Map()) {
  const stated = statedElectiveSpace(notes);
  const totals = scheduledLoad(entries);
  const years = [...new Set([...totals.keys()].map((k) => Number(k.split('|')[0])))].sort();
  const added = [];
  const reports = [];
  // Option courses for the elective groups, emitted once per code.
  const electiveCourses = [];
  const emittedElectiveCourses = new Set();
  // Codes the programme already carries, so an elective option is never emitted
  // twice under one code.
  const existingCodes = new Set(entries.filter((e) => e?.code).map((e) => e.code));

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

      // The study plan lists the courses that may fill this space (Kopps
      // `electiveCondition: V`), and for some of them says which master
      // programme they qualify the student for. Both are attached so the box can
      // say what a student may choose and why it matters, instead of being an
      // anonymous gap.
      //
      // They are NOT split per period, because the source does not say: measured
      // on CTFYS and CTMAT year 3, 0 of 20 and 0 of 31 V courses carry any
      // `creditsPerPeriod` at all. So every placeholder in a year carries the
      // same candidate list, and the period shown is the slot's, not the course's.
      // Only the electives that actually run in THIS period. Before the course
      // pages were read, every box in a year had to list every candidate, since
      // the study plan gives no period; now a P3 box offers P3 courses. A course
      // whose period could not be resolved is still listed, with a flag, rather
      // than dropped — omitting it would silently shorten the student's options.
      const recordByCode = new Map();
      for (const r of electiveRecords) {
        if (r.year === year && !recordByCode.has(r.code)) recordByCode.set(r.code, r);
      }
      const candidates = [...recordByCode.keys()]
        .filter((code) => {
          const got = electivePeriods.get(`${year}::${code}`);
          if (!got) return true;                // unknown: keep, and flag below
          // ANY offering teaching in this period qualifies the course for this
          // box — that is the whole point of a course given several times a
          // year. DD1380 is therefore offered by the P3 box and the P4 box, and
          // the chart resolves which round to draw from the box it was picked
          // from.
          return offeredInPeriod(got, pid);
        })
        .sort();
      const unplaced = [...new Set(electiveRecords
        .filter((r) => r.year === year && !electivePeriods.has(`${r.year}::${r.code}`))
        .map((r) => r.code))];
      if (unplaced.length > 0) {
        notes.push(`year ${year} ${pid}: no period data for ${unplaced.join(', ')} — ` +
          `listed in every box for this year rather than dropped.`);
      }
      // An elective slot with listed options IS an option group — "minst 7,5 hp
      // out of these" — so it is emitted as one rather than as a placeholder with
      // a parallel mechanism bolted on. The renderer already substitutes a picked
      // option for the group's bar and opens the selection modal; a group gets all
      // of that for free, which a placeholder cannot.
      //
      // The options are emitted as real course entries too, exactly as the
      // villkorligt-valfri groups do, because the renderer resolves `options[]`
      // against the course list.
      if (candidates.length > 0) {
        entry.type = 'optionGroup';
        entry.name = electiveGroupName(pid, year);
        entry.nameEn = electiveGroupNameEn(pid, year);
        entry.options = candidates;
        entry.kind = 'minCredits';
        entry.minCredits = short[i];
        entry.allowedNumberOfOptions = candidates.length;
        delete entry.code;
        delete entry.prerequisites;
        const quals = {};
        for (const code of candidates) {
          const masters = eligibility.get(`${year}::${code}`);
          if (masters?.length) quals[code] = masters;
        }
        if (Object.keys(quals).length > 0) entry.qualifiesFor = quals;

        for (const code of candidates) {
          if (emittedElectiveCourses.has(code)) continue;
          // The code may already be a course in the programme — CTMAT lists
          // SF1677/SF1678/SF1691 as villkorligt valfria in year 2 AND as elective
          // candidates in year 3. One entry per code is the schema's rule (the
          // validator rejects duplicates, and the loader would silently sum their
          // credits), so the existing entry serves as the option and the group
          // simply references it.
          if (existingCodes.has(code)) {
            flag(`${code}: listed as an elective for year ${year} but already a ` +
              `course in this programme — the elective box references the existing ` +
              `entry, which sits in its own year. Verify that is the intended reading.`);
            continue;
          }
          emittedElectiveCourses.add(code);
          const rec = recordByCode.get(code);
          const got = electivePeriods.get(`${year}::${code}`);
          const pc = got?.periodCredits
            ?? Object.fromEntries(PERIOD_IDS.map((q) => [q, q === pid ? short[i] : 0]));
          // `totalCredits` is the size of ONE offering, because that is what the
          // student takes. Summing across offerings is exactly the bug this
          // whole shape exists to prevent (DD1380: 1.5 hp, not 4 × 1.5).
          const roundEntries = (got?.rounds ?? []).length > 1
            ? got.rounds.map((r) => ({
              id: firstPeriodOf(r.periodCredits),
              periodCredits: Object.fromEntries(
                PERIOD_IDS.map((q) => [q, round(r.periodCredits[q] || 0)])),
              ...(r.applicationCode ? { applicationCode: String(r.applicationCode) } : {}),
            }))
            : null;
          electiveCourses.push({
            code,
            name: rec?.name || code,
            ...(electiveNames.get(code) ? { nameEn: electiveNames.get(code) } : {}),
            totalCredits: round(PERIOD_IDS.reduce((a, q) => a + (pc[q] || 0), 0)),
            periodCredits: Object.fromEntries(PERIOD_IDS.map((q) => [q, round(pc[q] || 0)])),
            ...(roundEntries ? { rounds: roundEntries } : {}),
            year,
            prerequisites: [],
            exams: [],
            teacher: '',
            description: '',
            // 'recommended' rather than 'conditionallyElective': the study plan
            // suggests these for free elective space, it does not require a pick.
            category: 'recommended',
          });
        }
      }
      entries.push(entry);
      added.push(entry);
      reports.push({
        kind: 'elective-space-filled', year, period: pid, hp: short[i],
        expected, quote: claim?.quote ?? null,
      });
    }
  }
  return { added, reports, electiveCourses };
}

// A period-specific name, so the four boxes of a year are distinguishable in the
// legend and in `selectedOptionPerGroup` (which is keyed by name).
const electiveGroupName = (pid, year) => `Valfri kurs, årskurs ${year} ${pid}`;
const electiveGroupNameEn = (pid, year) => `Elective course, year ${year} ${pid}`;

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
    prereqs: false, fillElectives: false, exams: false,
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
    else if (a === '--exams') args.exams = true;
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
  --exams              reconcile the curated src/data/<PROG>.json 'exams' with
                       the examination modules in each course's kursplan, then
                       exit. Fills a course that has no exam but whose kursplan
                       carries a tentamen, clears one that has an exam but whose
                       kursplan carries none, and REPORTS rather than overwrites
                       a disagreement about which period — a coordinator's
                       placement outranks our highest-credit convention.
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
  // The programme's own entry, needed to tell a civilingenjör programme (whose
  // "Master, X" specialisations are years 4-5 destinations) from a master's
  // programme (whose "Spår, X" specialisations are its own inriktningar).
  const programMeta = (() => {
    const raw = readTextOrNull(join(dataDir, 'programs.json'));
    if (!raw) return null;
    try {
      return JSON.parse(raw).find((p) => p?.code === prog) ?? null;
    } catch { return null; }
  })();
  review.length = 0; // report per cohort

  console.log(`\n═══ ${prog} ${cohortLabel(cohort)} — years 1-${args.years} ═══`);

  const allRecords = [];
  const specNames = new Map();
  const provenance = [];
  const versionsByCode = new Map();
  const planNotes = [];
  // Per-year VV rule text, keyed for the group builder below.
  const planVvInfo = [];
  // Master-programme eligibility parsed from each year's prose, per year.
  const planEligibility = new Map();

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
    for (const v of src.vvInfo || []) planVvInfo.push({ ...v, year });
    // CTFYS and CTMAT state master eligibility in `supplementaryInformation`
    // rather than the VV field, so both are read; see parseMasterEligibility.
    for (const note of src.noteLines || []) {
      for (const [code, masters] of parseMasterEligibility(note)) {
        const key = `${year}::${code}`;
        const existing = planEligibility.get(key) ?? [];
        for (const m of masters) {
          const dup = existing.find((x) => x.code === m.code);
          if (dup) { dup.required = dup.required || m.required; continue; }
          existing.push(m);
        }
        planEligibility.set(key, existing);
      }
    }

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
  const groups = buildOptionGroups(vv, planVvInfo);
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
  // The kursplan each course was actually read from, so the review file can link
  // it. A cohort reads the version in force when IT sits the course, so this map
  // is per cohort, not per course.
  const chosenByCode = new Map();
  const prereqTexts = new Map();
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
    chosenByCode.set(e.code, chosen ? { ...chosen, sitsTerm: term, newest: versions[0]?.term ?? null } : null);
    if (chosen?.eligibility) prereqTexts.set(e.code, chosen.eligibility);
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
    for (const n of parsed.notes) prereqReview.push({ code: e.code, version: chosenByCode.get(e.code), ...n });
  }
  prereqReview.push(...checkPrerequisiteOrder(entries)
    .map((n) => ({ ...n, version: chosenByCode.get(n.code) })));

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
  // Resolve each listed elective's actual periods, so a placeholder box can offer
  // only the courses that really run in its period. The study plan gives no
  // period for these; the course page's `round_periods` does.
  const electiveCodes = [...new Set(elective.map((r) => r.code))];
  const electivePeriodsByCode = new Map();
  const electiveNamesByCode = new Map();
  if (electiveCodes.length > 0) {
    process.stdout.write(`  resolving periods for ${electiveCodes.length} listed elective(s) … `);
    for (const r of elective) {
      const key = `${r.year}::${r.code}`;
      if (electivePeriodsByCode.has(key)) continue;
      // `r.applicationCode` is the kurstillfälle the study plan itself points
      // at, which decides the default round when the course has several.
      const got = await electivePeriodsForYear(r.code, cohort, r.year, r.applicationCode);
      if (got) electivePeriodsByCode.set(key, got);
      // The English title comes only from KOPPS, and fetchCourseMeta has already
      // been called (and cached) by the period resolver above.
      try {
        const meta = await fetchCourseMeta(r.code);
        if (meta?.nameEn) electiveNamesByCode.set(r.code, meta.nameEn);
      } catch { /* title is optional */ }
    }
    console.log(`${electivePeriodsByCode.size}/${elective.length} placed`);
  }

  const electiveSpace = fillElectiveSpace(
    allEntries, planNotes, usedSpecs.length > 0, elective, planEligibility,
    electivePeriodsByCode, electiveNamesByCode);
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

  // Master programmes and their spår are not inriktningar (see isMasterSpec), so
  // a tag naming one is eligibility information, not a filter dimension. Move it
  // to `qualifiesFor` and leave only the real inriktningar in `specializations`.
  const masterSpecs = new Map(
    registryEntries.filter((r) => isMasterSpec(r, programMeta)).map((r) => [r.code, r.name]));
  if (masterSpecs.size > 0) {
    let moved = 0;
    for (const e of allEntries) {
      if (!e.specializations?.length) continue;
      const masters = e.specializations.filter((c) => masterSpecs.has(c));
      if (masters.length === 0) continue;
      const rest = e.specializations.filter((c) => !masterSpecs.has(c));
      if (rest.length > 0) {
        e.specializations = rest;
      } else {
        delete e.specializations;
        // `periodCreditsBySpecialization` keys the specs that just went away, and
        // the validator requires a non-empty `specializations` alongside it.
        if (e.periodCreditsBySpecialization) {
          flag(`${e.code}: dropped 'periodCreditsBySpecialization' with its ` +
            `master-programme tags — a period override keyed by a destination is ` +
            `not an inriktning-specific layout.`);
          delete e.periodCreditsBySpecialization;
        }
      }
      // Required for those masters: the study plan lists the course under them.
      // `required` is true because a tagged course is what the master demands —
      // the recommended/required distinction only arises in the prose parser.
      e.qualifiesFor = {
        ...(e.qualifiesFor || {}),
        [e.code ?? e.name]: masters.map((c) => ({
          code: c, name: masterSpecs.get(c), required: true })),
      };
      moved++;
    }
    if (moved > 0) {
      flag(`${moved} entr${moved === 1 ? 'y' : 'ies'}: master-programme tags moved from ` +
        `'specializations' to 'qualifiesFor' — they are years 4-5 destinations, not ` +
        `bachelor inriktningar, so they must not drive the inriktning filter.`);
    }
  }

  // The elective groups' options must exist as course entries for the renderer to
  // resolve `options[]` — same requirement the villkorligt-valfri groups have.
  if (electiveSpace.electiveCourses.length > 0) {
    allEntries.push(...electiveSpace.electiveCourses);
    console.log(`  ${electiveSpace.electiveCourses.length} elective option course(s) emitted`);
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
  // Update rather than overwrite: keep the hand-written decoration from the file
  // being replaced (see carryForwardEditorial).
  const carried = carryForwardEditorial(outPath, ordered);
  writeFileSync(outPath, `${JSON.stringify([meta, ...ordered], null, 2)}\n`, 'utf8');

  // --- report -------------------------------------------------------------
  const courses = ordered.filter((e) => e.type !== 'optionGroup');
  const hasExams = (e) => (Array.isArray(e.exams) ? e.exams.length : Object.keys(e.exams || {}).length) > 0;
  const withExams = courses.filter(hasExams).length;
  const approx = provenance.filter((p) => p.approximated);

  console.log(`\nWrote ${rel(outPath)}`);
  if (carried) {
    console.log(`  kept ${carried.length} hand-written field(s) from the previous file: ` +
      `${carried.slice(0, 6).join(', ')}${carried.length > 6 ? `, … +${carried.length - 6}` : ''}`);
  }
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
    const needed = registryEntries
      .filter((r) => usedSpecs.includes(r.code))
      .filter((r) => !isMasterSpec(r, programMeta));
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
    entries, prereqReview, chosenByCode, prereqTexts,
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
  // The kursplan each course was read from, for the review file's links.
  const chosenByCode = new Map();
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
      chosenByCode.set(e.code, chosen ? { ...chosen, sitsTerm: term } : null);
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
    for (const n of parsed.notes) review.push({ code: e.code, version: chosenByCode.get(e.code), ...n });
    if (has) { skipped++; continue; }
    if (parsed.completed.length === 0 && parsed.participation.length === 0) continue;
    if (parsed.completed.length > 0) e.prerequisitesCompleted = parsed.completed;
    if (parsed.participation.length > 0) e.prerequisitesParticipation = parsed.participation;
    delete e.prerequisites;
    added++;
  }

  review.push(...checkPrerequisiteOrder(courses)
    .map((n) => ({ ...n, version: chosenByCode.get(n.code) })));

  const out = JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  if (out !== raw) writeFileSync(file, out, 'utf8');
  console.log(`  ${rel(file)}: added to ${added} course(s), left ${skipped} existing untouched`);
  // One "cohort" here: the curated file describes a single läsår, not a kull.
  const rp = writePrereqReview(prog, [{
    label: `läsår ${lasar}/${(lasar ?? 0) + 1} (curated file)`,
    entries: courses, prereqReview: review, chosenByCode,
  }]);
  console.log(`  ${rel(rp)}: ${review.length} item(s) for coordinator review`);
}

/**
 * Reconcile a curated file's `exams` with what the kursplan actually examines.
 *
 * The audit that motivated this: comparing every curated `exams` array against
 * the examination modules of the kursplan in force for the current läsår,
 * CTFYS agreed on 25 of 26 courses, but CINEK agreed on only 17 of 50 — 33 of
 * its courses record no exam while their kursplan carries an explicit `TEN`
 * module (SG1109 carries two, a Problemtentamen and a Teoritentamen). CTMAT was
 * missing 5 and CFATE 1. Those are unpopulated fields rather than considered
 * judgements, so filling them is a correction, not an override.
 *
 * The one case in the other direction was DD1327, whose curated `["P4"]` is what
 * originally justified treating `HEM` modules as exams — a wrong value that then
 * propagated to every cohort. It is cleared here.
 *
 * What is deliberately NOT changed: a course where both we and the curated file
 * name an exam but disagree about the period. SE1055 puts its single tentamen in
 * the last of its two periods and SI1121 in the credit-majority one, so no simple
 * rule gets both; our convention picks the highest-credit periods and is measured
 * at roughly half. A coordinator's placement outranks that, exactly as with
 * prerequisites, so those are reported for a human to settle.
 */
async function fixCuratedExams(prog) {
  const file = join(dataDir, `${prog}.json`);
  const raw = readTextOrNull(file);
  if (raw === null) throw new Error(`${rel(file)} not found`);
  const data = JSON.parse(raw);
  const courses = data.filter((e) => e?.code && e.type !== 'optionGroup' && e.type !== 'cohortMeta');

  const lasar = lasarFromPeriods();
  if (!lasar) throw new Error('could not read the läsår from academic-periods.json');

  process.stdout.write(`  reading ${courses.length} kursplan(er) … `);
  let filled = 0; let cleared = 0; const disputed = []; const unknown = [];
  for (const e of courses) {
    let meta;
    try { meta = await fetchCourseMeta(e.code); } catch { unknown.push(e.code); continue; }
    const maps = alignYearMaps(e);
    const firstPeriod = PERIOD_IDS.findIndex((pid) =>
      Object.values(maps).some((m) => Number(m?.[pid] || 0) > 0));
    const studyYear = Math.min(...Object.keys(maps).map(Number));
    const term = termForCourse(lasar - studyYear + 1, studyYear, firstPeriod < 0 ? 0 : firstPeriod);
    const chosen = versionForTerm(meta.versions, term);
    const modules = chosen?.examModules ?? meta.examModules ?? [];
    if (!chosen && (meta.examModules ?? []).length === 0) { unknown.push(e.code); continue; }

    const derived = deriveExams(e, modules);
    const hasNow = Array.isArray(e.exams) ? e.exams.length > 0
      : Object.keys(e.exams || {}).length > 0;
    const hasDerived = Array.isArray(derived) ? derived.length > 0
      : Object.keys(derived).length > 0;

    if (!hasNow && hasDerived) {
      e.exams = derived;
      filled++;
      console.log(`\n    ${e.code}: no exam recorded, kursplan has ` +
        `${modules.filter(isExamModule).map((m) => `${m.code} ${m.title}`).join(' + ')} — set to ${JSON.stringify(derived)}`);
    } else if (hasNow && !hasDerived) {
      const was = JSON.stringify(e.exams);
      e.exams = Array.isArray(e.exams) ? [] : {};
      cleared++;
      console.log(`\n    ${e.code}: recorded ${was} but the kursplan examines only ` +
        `${modules.map((m) => m.code).join(', ') || '(nothing listed)'} — cleared`);
    } else if (hasNow && hasDerived && JSON.stringify(e.exams) !== JSON.stringify(derived)) {
      disputed.push({ code: e.code, curated: e.exams, derived, modules: modules.filter(isExamModule) });
    }
  }
  console.log('done');

  const out = JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  if (out !== raw) writeFileSync(file, out, 'utf8');
  console.log(`  ${rel(file)}: filled ${filled}, cleared ${cleared}, left ${disputed.length} disagreement(s) untouched`);
  if (unknown.length > 0) {
    console.log(`  no kursplan modules readable for: ${unknown.join(', ')}`);
  }
  for (const d of disputed) {
    console.log(`    ${d.code}: curated ${JSON.stringify(d.curated)} vs derived ` +
      `${JSON.stringify(d.derived)} from ${d.modules.length} tentamen module(s) ` +
      `[${d.modules.map((m) => m.code).join(', ')}] — kept the curated value; ` +
      `${courseUrl(d.code)}`);
  }
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
  if (args.exams) { await fixCuratedExams(prog); return; }
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

  // Prerequisites are NOT per course alone: a cohort reads the kursplan version
  // in force when it sits the course, so the same course can yield different
  // prerequisites in different cohorts. Measured across the eight programmes,
  // the chosen version differs between cohorts for 5 of 28 CTFYS courses
  // (EI1320 among them), 1 of 28 in CTMAT (DD1328), 4 of 28 in CMATD and 43 of
  // 115 in TIEMM. Reviewing only the last cohort extracted therefore hid real
  // differences from the person signing them off, so every cohort is collected
  // and the review file is grouped by kursplan version instead.
  const perCohort = [];
  for (const c of cohorts) {
    if (c < EARLIEST_COHORT) {
      warn(`${cohortLabel(c)} is older than the supported floor ${cohortLabel(EARLIEST_COHORT)} — skipped`);
      continue;
    }
    const res = await extractCohort(prog, c, args, registryEntries);
    if (res) perCohort.push({ cohort: c, ...res });
  }

  if (perCohort.length > 0) {
    const rp = writePrereqReview(prog, perCohort);
    const total = new Set(perCohort.flatMap((r) => r.prereqReview.map(reviewKey))).size;
    console.log(`\nWrote ${rel(rp)} — ${total} distinct item(s) for coordinator review across ${perCohort.length} cohort(s)`);
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
/**
 * Identity of a review item, ignoring which cohort raised it.
 *
 * Two cohorts reading the same kursplan sentence raise the same item, and a
 * coordinator should sign that off once rather than once per cohort. The clause
 * is part of the key because it is the thing being judged: when a kursplan
 * revision rewords a requirement, that genuinely is a new item to check.
 */
function reviewKey(r) {
  return JSON.stringify([r.kind, r.code, r.codes ?? null, r.chose ?? null,
    r.req ?? null, r.label ?? null, (r.clause ?? '').slice(0, 300)]);
}

const REVIEW_HEADINGS = {
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
    'Usually correct — the syllabus lists alternatives from other programmes and the in-programme filter drops them. But the lists also go stale: where the text describes a knowledge area and this programme has a course of that name, the candidate is called out below as **suggested**. Nothing is written to the data from a name match — confirm it first.'],
};

/**
 * Write the coordinator worklist for one programme.
 *
 * `runs` is one entry per cohort (or a single entry for the curated file), each
 * carrying that cohort's entries, review items and chosen kursplan versions.
 *
 * The document is organised for someone who signs it off rather than for someone
 * who maintains the data: every course and every kursplan is a link into KTH's
 * own pages, so a claim can be checked by clicking rather than by searching. The
 * unit of review is a **kursplan text**, not a cohort — a sentence that four
 * cohorts share is one decision, and the cohorts affected are listed on the item.
 */
function writePrereqReview(prog, runs) {
  const cohortNames = runs.map((r) => r.label ?? cohortLabel(r.cohort));

  // --- merge the flagged items across cohorts ------------------------------
  const items = new Map(); // reviewKey -> { item, cohorts, versions }
  for (const [i, run] of runs.entries()) {
    for (const r of run.prereqReview) {
      const k = reviewKey(r);
      const g = items.get(k) ?? { item: r, cohorts: [], versions: new Map() };
      if (!g.cohorts.includes(cohortNames[i])) g.cohorts.push(cohortNames[i]);
      if (r.version?.term && !g.versions.has(r.version.term)) g.versions.set(r.version.term, r.version);
      items.set(k, g);
    }
  }
  const byKind = {};
  for (const g of items.values()) (byKind[g.item.kind] ??= []).push(g);

  // --- merge the extracted prerequisites across cohorts -------------------
  // Keyed on the recorded lists, so a course whose prerequisites are the same in
  // every cohort appears once, and one that differs appears once per variant.
  const extracted = new Map();
  for (const [i, run] of runs.entries()) {
    for (const e of run.entries.filter((x) => x.code)) {
      const c = e.prerequisitesCompleted ?? [];
      const pt = e.prerequisitesParticipation ?? [];
      if (c.length === 0 && pt.length === 0) continue;
      const k = `${e.code}|${c.join(',')}|${pt.join(',')}`;
      const g = extracted.get(k) ?? { code: e.code, completed: c, participation: pt, cohorts: [], versions: new Map() };
      if (!g.cohorts.includes(cohortNames[i])) g.cohorts.push(cohortNames[i]);
      const v = run.chosenByCode?.get(e.code);
      if (v?.term && !g.versions.has(v.term)) g.versions.set(v.term, v);
      extracted.set(k, g);
    }
  }

  // --- where cohorts read different kursplan versions ---------------------
  const perCourseVersions = new Map(); // code -> Map(cohortName -> version)
  for (const [i, run] of runs.entries()) {
    for (const [code, v] of run.chosenByCode ?? []) {
      (perCourseVersions.get(code) ?? perCourseVersions.set(code, new Map()).get(code))
        .set(cohortNames[i], v);
    }
  }
  const divergent = [...perCourseVersions.entries()]
    .filter(([, m]) => new Set([...m.values()].map((v) => v?.term ?? null)).size > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const cohortList = (names) => names.length === cohortNames.length && cohortNames.length > 1
    ? 'alla kullar' : names.join(', ');
  const versionLinks = (code, versions) => (versions.size === 0
    ? `kursplan okänd — [arkiv](${archiveUrl(code)})`
    : [...versions.values()].sort((a, b) => b.term - a.term)
      .map((v) => `[${validityLabel(v)}](${kursplanUrl(code, v.term)})`).join(' / '));

  const L = [];
  L.push(`# ${prog} — prerequisites to verify`);
  L.push('');
  L.push(`Covers **${cohortNames.join(', ')}**.`);
  L.push('');
  L.push('**How to sign this off.** Every course below links to its page on kth.se, and every');
  L.push('judgement links the *exact kursplan* it was read from — the PDF KTH publishes in the');
  L.push("course's own version archive. Open the kursplan, read *Särskild behörighet*, and");
  L.push('confirm or correct. Nothing here needs the data files to be read.');
  L.push('');
  L.push('A kursplan text is the unit of review, not a cohort: where several cohorts share the');
  L.push('same wording they are listed together on one item, and where a revision changed the');
  L.push('wording each version appears separately. Kursplan versions are per cohort because a');
  L.push('student is examined against the version in force when they sit the course.');
  L.push('');
  L.push('Generated by `scripts/extract-from-kopps.mjs`. Prerequisites are the only field taken');
  L.push('from free text (*Särskild behörighet* on the course page), so every judgement below');
  L.push('needs a program coordinator to confirm or correct. Edit `src/data/cohorts/` (or the');
  L.push(`curated \`src/data/${prog}.json\`) directly — this file is a worklist, not a source.`);
  L.push('');

  L.push('## What was extracted');
  L.push('');
  L.push('| kull | slutförd | aktivt deltagande | flaggat |');
  L.push('|---|---|---|---|');
  for (const [i, run] of runs.entries()) {
    const withC = run.entries.filter((e) => e.code && e.prerequisitesCompleted?.length).length;
    const withP = run.entries.filter((e) => e.code && e.prerequisitesParticipation?.length).length;
    const flagged = new Set(run.prereqReview.map(reviewKey)).size;
    L.push(`| ${cohortNames[i]} | ${withC} | ${withP} | ${flagged} |`);
  }
  L.push('');
  L.push(`**${items.size}** distinct item(s) need review across all cohorts (an item shared by`);
  L.push('several cohorts is counted once).');
  L.push('');

  for (const g of [...extracted.values()].sort((a, b) => a.code.localeCompare(b.code) || a.cohorts[0].localeCompare(b.cohorts[0]))) {
    const parts = [];
    if (g.completed.length) {
      parts.push(`slutförd: ${g.completed.map(codeLink).join(', ')}`);
    }
    if (g.participation.length) {
      parts.push(`deltagande: ${g.participation.map(codeLink).join(', ')}`);
    }
    const scope = g.cohorts.length === cohortNames.length ? '' : ` — *${cohortList(g.cohorts)}*`;
    L.push(`- ${codeLink(g.code)} — ${parts.join('; ')} · kursplan ${versionLinks(g.code, g.versions)}${scope}`);
  }

  if (divergent.length > 0) {
    L.push('');
    L.push(`## Cohorts read different kursplan versions (${divergent.length})`);
    L.push('');
    L.push('These courses were revised while the cohorts below were studying, so each cohort is');
    L.push('held to a different text. That is intended — a student is examined against the');
    L.push('version in force when they sit the course — but it is also where a single "correct"');
    L.push('answer does not exist, so it is worth a glance to confirm the split looks right.');
    L.push('');
    for (const [code, m] of divergent) {
      const byTerm = new Map();
      for (const [name, v] of m) {
        const t = v?.term ?? null;
        (byTerm.get(t) ?? byTerm.set(t, []).get(t)).push(name);
      }
      const bits = [...byTerm.entries()].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0)).map(([t, names]) => {
        const v = [...m.values()].find((x) => (x?.term ?? null) === t);
        return t ? `${names.join(', ')} → [${validityLabel(v)}](${kursplanUrl(code, t)})` : `${names.join(', ')} → ingen kursplan`;
      });
      L.push(`- ${codeLink(code)} ([alla versioner](${archiveUrl(code)}))`);
      for (const b of bits) L.push(`  - ${b}`);
    }
  }

  for (const [kind, [title, blurb]] of Object.entries(REVIEW_HEADINGS)) {
    const groups = byKind[kind];
    if (!groups?.length) continue;
    L.push('');
    L.push(`## ${title} (${groups.length})`);
    L.push('');
    L.push(blurb);
    L.push('');
    for (const g of groups.sort((a, b) => a.item.code.localeCompare(b.item.code))) {
      const r = g.item;
      const scope = g.cohorts.length === cohortNames.length && cohortNames.length > 1
        ? '' : ` · *${cohortList(g.cohorts)}*`;
      const kp = ` · kursplan ${versionLinks(r.code, g.versions)}`;
      if (r.kind === 'not-earlier') {
        L.push(`- ${codeLink(r.code)} requires ${codeLink(r.req)} (${r.label}) — not earlier in the programme${kp}${scope}`);
        continue;
      }
      const chose = r.chose ? ` → recorded as **${r.chose}**` : '';
      // "EI1320 LAB1 i SH1017" reads as two unrelated codes; the arrow says which
      // course is the one with the requirement and which is what it depends on.
      const codes = r.codes?.length ? ` ← ${r.codes.map(codeLink).join(', ')}` : '';
      L.push(`- ${codeLink(r.code)}${codes}${chose}${kp}${scope}`);
      L.push(`  > ${(r.clause ?? '').slice(0, 300)}`);
      for (const sug of r.suggestions || []) {
        L.push(`  - **suggested:** ${codeLink(sug.code)} ${sug.name} — the text asks for "${sug.area}" and this programme has that course, but the kursplan never lists it`);
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
