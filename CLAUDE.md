# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start Next.js dev server at http://localhost:3000
npm run build          # Production build
npm run lint           # ESLint
npm run validate-data  # Validate src/data/*.json (also runs in CI)
npx tsc --noEmit       # Type-check without emitting

npm run extract-plan CTFYS                      # newest cohort -> src/data/cohorts/
npm run extract-plan CTFYS -- --cohort HT2023   # one cohort
npm run extract-plan CTFYS -- --all-cohorts     # HT2023..newest
npm run extract-plan CTFYS -- --prereqs         # fill missing prereqs in curated file
npm run extract-plan CTMAT -- --fill-electives  # add 'Plats för valfri kurs' where short of 15 hp
npm run extract-plan CTFYS -- --align src/data/CTFYS.json   # reorder for alignment
npm run extract-plan CTFYS -- --help
node scripts/validate-data.mjs --include CTFYS=extracted/CTFYS.kopps.json
```

There are no automated tests in this project, but `validate-data` enforces the data-file schema and cross-reference invariants.

## What This Is

A Next.js + D3.js visualization app that renders KTH engineering degree programs (CTFYS, CTMAT, CFATE, COPEN) as interactive SVG timeline charts. Courses are laid out across academic periods (P1–P4 per year), stacked by credit weight, with prerequisite arrows, exam markers, and optional course groups. Supports SVG, PNG, and server-side PDF export. Bilingual (Swedish/English) with URL-based state (`?program=CTFYS&l=sv&cohort=HT2023`).

## Architecture

### Data Flow

1. User selects a program → `HomeClient.tsx` loads `src/data/<PROGRAM>.json` + `<PROGRAM>-cosmetics.json`
2. A merge step normalises both `periodCredits` shapes into a uniform `Course[]` (see `src/lib/useCourseModel.ts`)
3. Merged courses + cosmetics are passed to `TimelineVisualization`, which renders everything in D3
4. Export: SVG/PNG is client-side; PDF POSTs HTML to `/api/export-pdf` where Puppeteer renders it

### Key Components

- **`src/app/HomeClient.tsx`** — Main client component: program selector, language toggle, export menu, course merge logic, data loading orchestration.
- **`src/components/TimelineVisualization.tsx`** — ~2950-line D3 component; renders SVG, handles focus mode, interactivity, exports, and (inlined at the bottom of the file) the option-group selection modal. This is where most feature work happens.
- **`src/app/api/export-pdf/route.ts`** — Puppeteer-based PDF generation; uses `@sparticuz/chromium` on Vercel for serverless Chrome.

### Data Files (`src/data/`)

- **`programs.json`** — Registry of programs with metadata (data file, cosmetics file, study plan URL, optional comment).
- **`<PROGRAM>.json`** — Array of courses and option groups. Each course's `periodCredits` is in **one of two shapes**:
  - **flat**: `{ "P1": 3, "P2": 3, "P3": 0, "P4": 0 }` plus a top-level `"year": 1`, OR
  - **by-year**: `{ "Year1": { "P1": 2.5, ... }, "Year2": { ... } }` for courses that span academic years (e.g. `SA1006` in `CTMAT.json`).

  The same dual shape applies to `exams` / `reexams`: either an array `["P2"]` or a `Year<n>`-keyed object `{ "Year1": ["P2"], "Year2": ["P4"] }`. The `Course` type exposes the parsed by-year form as `examsByYear` / `reexamsByYear`.

  Optional `periodCreditsBySpecialization: { <specCode>: { P1, P2, P3, P4 } }` overrides the period layout when the user has selected the matching inriktning. Used when a single KTH course slots into a different period for one inriktning (e.g. `SK1110` in `CINEK.json` runs in P3 for DTOI/EHUI/TMAI but P4 for PPUI). Flat-shape only; the renderer applies the override in the spec filter (`TimelineVisualization.tsx:77–107`) and the validator enforces that each override's sum equals `totalCredits`. When both the base course and the override sit in a single period, `exams` and `reexams` auto-shift to the override's period (the exam slot tracks the lecture period per Riktlinje om läsårets förläggning §1.1); multi-period bars are left untouched and would need an explicit mapping if/when that case arises.
- **`<PROGRAM>-cosmetics.json`** — Maps course codes to color family groups (blue/green/turquoise/brick/yellow). Hard-capped at 5 families.

  **Palette convention:** `Matematik` is always **blue** and elective space is
  always **yellow**; the remaining categories take green, brick and turquoise and
  may differ between programmes, because those categories themselves differ. Two
  consequences worth knowing:

  - Yellow must be left free (or held by an `Övrigt` group) in every programme.
    Before this convention it meant Datateknik in CTMAT and CFATE and
    Ingenjörsämnen in COPEN, which collided with the elective boxes.
  - Elective placeholders are coloured by **category**, not by a cosmetics entry —
    see `getCourseColors` in `TimelineVisualization.tsx`. Their codes are
    generated (`XY{year}{period}0Z`), so a cosmetics list would need re-syncing
    every time the data is regenerated. An explicit cosmetics entry still wins,
    which is why CTFYS's `XY123Z`/`XY456Z` in its `Övrigt` group behave the same.

  CINEK and TIEMM currently have `Matematik` = green, with blue held by
  `Industriell ekonomi`. Both are at the five-family cap, so aligning them needs a
  blue↔green swap rather than a new family.
- **`academic-periods.json`** — P1–P4 date ranges (lecture/exam/re-exam) for one läsår at a time (currently 2025/2026); converted to `Date` objects in `src/types/course.ts`. Note: the file's `reExamStart`/`reExamEnd` for period `P1` actually fall in December — i.e. between P1 and P2, per *Riktlinje om läsårets förläggning* §1.1. A course's `"reexams": ["P1"]` therefore means "uses the P1 re-exam slot (December)", not "re-exam during P1".

  The `reexams` field on a course is **optional**: when omitted, the loader defaults it to a copy of `exams`, which matches the riktlinje's rule that the re-exam slot is fixed by the ordinary exam period. Set it explicitly only to add EXTRA tillfällen (e.g. an additional re-exam for a critical first-year math course). Known limitation: extra slots in periods where the course has no credits aren't visualised yet — the renderer anchors markers to the course's bar in the same period (`TimelineVisualization.tsx:1659–1691`).
- **`cohorts/<PROGRAM>-HT<year>.json`** — Per-cohort archive written by
  `scripts/extract-from-kopps.mjs`, one file per admission year, each beginning
  with a `cohortMeta` provenance entry. Selected in the UI via `?cohort=HT2023`;
  when absent the curated program-wide file is used exactly as before.
  `cohorts/index.json` lists what is available per program.
- **`kth-colors.json`** — KTH official color palette.

### Study-Plan Extraction (`scripts/extract-from-kopps.mjs`)

Builds **one admission cohort's** study plan from KTH's public study-plan pages
into `src/data/cohorts/<PROGRAM>-HT<year>.json`, committed as an archive. The
curated `src/data/<PROGRAM>.json` files are never touched. Pure Node, no extra
dependencies. Run `--help` for options.

**A cohort's plan has to be stitched together.** KTH publishes the läsår
currently being taught and the next one, deletes the years a cohort has already
passed, and lists its future years with all-zero `creditsPerPeriod`. Measured
availability (CTFYS/CINEK, Aug 2026):

| cohort | year 1 | year 2 | year 3 |
|---|---|---|---|
| HT2023 | gone | gone | own |
| HT2024 | gone | own | own |
| HT2025 | own | own | future |
| HT2026 | own | future | future |

No cohort has all three of its own years, and the gap runs in **both**
directions. Each missing year is borrowed from the nearest cohort that publishes
it, searching outwards and preferring the earlier cohort on a tie — so "year 3
isn't scheduled yet" resolves to the previous cohort, while HT2023's year 1 comes
from a later one. Availability is **probed, not computed**: the publishing window
moves every year.

**Provenance is recorded and shown.** Each cohort file starts with a
`cohortMeta` entry (`type` discriminated, like `optionGroup`) listing per year:
`sourceCohort`, `approximated`, and a `confidence` of `exact` / `high` / `low` /
`unknown`. Confidence comes from `corroborate()`: when a year is borrowed, it
finds a *different* year both cohorts publish and compares it. Agreement is
evidence, not proof — CTFYS year 1 is identical between 2025 and 2026 while its
year 3 changed between 2023 and 2024. HomeClient renders this as a notice above
the chart; a student needs to know when they are looking at another cohort's year.

**"Published" needs a threshold, not a boolean.** A course spanning study years
(CTMAT's SA1006 runs in years 1–3) is listed under a future year *with* credits,
which made unscheduled years look scheduled and produced provenance claiming
exact data for läsår 2028/29. A year now counts as published when ≥50 % of its
listed courses carry period data. Measured: published years score 1.00,
unpublished 0.00–0.08 — the threshold sits in a wide gap rather than being tuned.

**A year listing zero courses is structural, not missing.** COPEN
(Öppen ingång) has no year 2–3 curriculum at all — students choose a programme
after year 1 — so those years are reported as "not part of this programme" and
get no provenance entry. The curated `COPEN.json` is year 1 only, consistent.

**Full-time load is the strongest data-quality signal.** Full-time study is 15 hp
per period, so a programme's courses should add up to 15 in every (inriktning,
year, period) cell. `validate-data` warns once per (year, inriktning), and merges lanes that say the
same thing — per-period output produced over 400 near-identical lines, and a
programme with many inriktningar repeated each line once per lane (CMAST has 17,
giving 34 identical warnings) — showing the whole load
shape (`load 17/17/13.5/13.5 hp — short in P3 1.5, P4 1.5`). The two directions
mean different things:

- **Short** — almost always the space for *valfria kurser*, which KTH states in
  the study plan's prose but never lists as courses. CTMAT year 3 summed to 7.5
  in all four periods before this was handled.
- **Over** — double-counted option groups, courses not tagged with an inriktning,
  or a "minst N hp ur grupp" pool the schema cannot express.

Counting rules: an optionGroup counts once and its member courses do not (the
student takes one); a course tagged with `specializations` counts only for those;
`periodCreditsBySpecialization` overrides the layout. A small excess can be
legitimate — CTFYS year 1 P1 is 16.5 hp because DD1301 is a genuinely optional
1.5 hp course — so only excesses of 3 hp or more are reported.

**Elective space is filled from the shortfall, corroborated by the prose.**
`fillElectiveSpace()` adds `electivePlaceholder` entries ("Plats för valfri
kurs") sized to the shortfall — automatically during cohort extraction, and via
`--fill-electives` for a curated file — mirroring the curated CTFYS convention
(`XY123Z`/`XY456Z`, one per period, exam marked in its own period). The credit
gap is the primary signal because it comes from period data we trust; the study
plan text is used to check the amount:

    CTMAT y3   "Utrymmet för valfria kurser är 7,5 hp per period hela läsåret."
    CTFYS y3   "På våren i årskurs 3 finns ett utrymme på 15,0 hp valfria kurser."

Both agree with the computed shortfall, and the CTFYS case reproduces the
hand-authored placeholders exactly. Agreement or disagreement is reported either
way. TIEMM's text mentions elective space only qualitatively, with no figure, so
nothing is filled there.

Filling is deliberately refused when a year also has a period *over* full-time,
or when the programme has inriktningar — an excess means the model of that year
is incomplete, and adding placeholders on top would pile invention on a wrong
base. CFATE year 3 is the case: 36 hp obligatorisk + 21 hp in option groups
leaves 3 hp, but five villkorligt valfria courses totalling 26 hp are listed. The
report spells that arithmetic out and names `kind: 'minCredits'` as the shape
that could express it, without guessing the membership.

**A single-option group is not a group.** Kopps marks such courses villkorligt
valfri, but emitting a selection modal with one item clutters the chart, and none
of the six curated files does it. 15 of 34 extracted groups were this shape —
5 of CFATE's 7 and 10 of TIEMM's 23 — and they are now emitted as plain courses
with `category: conditionallyElective`.

**Course order controls vertical alignment.** The renderer stacks each period's
bars in file order, so a course spanning periods sits at whatever cumulative
height the courses listed before it occupy in *each* period. When those differ
the bar is drawn at different levels and the connector becomes a diagonal
staircase. Perfect alignment is often geometrically impossible — when the set of
parallel courses changes between periods, something must shift — so
`alignEntries()` minimises total drift instead. It is a **multi-start** local search, not a sort:
measured over CTFYS/CTMAT/CFATE/CINEK, *every* simple comparator was worse than
the hand-curated order (drift 226–487 vs 203), because the hand order already
encodes alignment a comparator cannot see. The search starts from the seeded
order and only accepts non-worsening moves, so it can never degrade a file, and
it is seeded deterministically so output is reproducible. A single start gets
trapped in whatever local optimum its seed order leads to, so three starts are
tried — the file's own order, a code-sorted order, and the reverse — and the best
kept. That closed real headroom on the curated files: CTMAT 26→5, CFATE 24→15,
CINEK 16→9. CTFYS found no improvement, which is the reassuring case: an order
that is already optimal stays untouched, and because the file's own order is one
of the candidates a file can never come out worse. Measured on the
generated files: CTFYS 47→9, CTMAT 45→7, CFATE 131→19, COPEN 21→2, CINEK 127→15,
TIEMM 1069→12.

**The archive is committed on purpose.** KTH deletes each läsår as it passes, so
HT2023's years 1–2 are already unrecoverable. Committing the files is what stops
that erasing our copy; re-running extraction only ever adds. They live inside
`src/data/` (unlike the ad-hoc `--out` candidates) because the app must load
whichever cohort the user picks, and each JSON becomes its own lazily-loaded
chunk — an unselected cohort costs a viewer nothing. They do all count toward the
`size-limit` budget, which is why it is 330 kB and not 250 (~201 kB app,
~50 kB archive, ~2 kB per cohort file). `src/data/cohorts/index.json` is
regenerated from disk on every run and drives the UI's selector; the validator
cross-checks it both ways.

**Ad-hoc `--out` candidates stay out of `src/data/`.** `useCourseModel.ts` loads
data with ``await import(`@/data/${dataFile}`)`` — a template literal, so the
bundler builds a context module over the whole directory and *every* JSON file in
it becomes a chunk, referenced or not. That is fine for the cohort archive, which
the app genuinely needs to load on demand, but not for throwaway candidates:
unverified course data would be served to browsers. This is also why PR #37's
`src/data/<PROG>.ladok.json` convention should not be revived.

**Source.** `kth.se/student/kurser/program/<PROG>/<TERM>/arskurs<N>` is
server-rendered and embeds its whole render state as one percent-encoded JSON
blob. That blob's `curriculumInfos` carries per-inriktning course lists with
`creditsPerPeriod` — a **6-element array indexed `[P0,P1,P2,P3,P4,P5]`**, so
P1–P4 are indices 1–4. Undocumented internal payload; there is no public JSON
endpoint. Shape assumptions are asserted so a format change fails loudly.
Enriched from the KOPPS course API (English title, grading scale, cycle level,
examination modules) because the study-plan `/en/` route returns HTTP 500.

**One läsår, several cohorts.** KTH publishes each cohort's plan only for the year
it is currently taking, dropping past years and omitting period data for future
ones. So study year N is fetched from the cohort currently in year N (läsår
2025/26: y1←20252, y2←20242, y3←20232). This is forced, not a convenience — and
it means only the current and upcoming läsår are extractable.

**Study-plan structure follows the owning school; prerequisite wording does not.**
Worth knowing before adding a programme, because it predicts which parts of the
extraction will be easy.

*Structure* splits cleanly by school. The SCI programmes (CTFYS, CTMAT, CFATE,
COPEN) return a single `curriculumInfo` with no inriktningar in years 1-3. The ITM
ones split by inriktning from year 2: CINEK 4, CMATD 6, CMAST 3 in year 2 and 14
in year 3 — with 15 `curriculumInfos` and per-inriktning
`supplementaryInformation`. So CMAST and CMATD did follow CINEK's conventions
rather than the SCI ones, and needed the `specializations` registry that no SCI
programme does.

*Prerequisite wording* does not, because the text belongs to the **course**, not
the programme — 23 courses appear in both an SCI and an ITM programme and carry
identical text in each. Measured over the eight programmes, the phrasing
differences track the department mix and the level rather than the school: TIEMM
is the outlier (80% "motsvarande", 25% hyphen ranges, 31% gymnasium requirements)
because it is a *master's* programme drawing 28 DD courses, while CMAST and CMATD
read like the SCI bachelor programmes. The parser therefore needed no
school-specific handling.

**`electiveCondition` mapping.** `O`→`mandatory`; `VV`→an `optionGroup`
(`pickN: 1`); `V` and `R`→**reported but not written**, because the curated files
deliberately abstract electives into `Plats för valfri kurs` placeholders.
`--electives` overrides.

`R` (rekommenderad) appears in **CMAST only** — 144 participations, none in the
other seven programmes — one per course recommended for the master track a given
inriktning leads to. They carry real period data, but they are a pool rather than
a prescribed set: adding them to AEE year 3 takes the load from 15/15/0/0 to
15/33/30/6 hp, far past full-time. Hence the same treatment as `V`. They were
caught by the `KNOWN_CONDITIONS` assertion rather than silently dropped, which is
what that check exists for.

**Accuracy, measured against the six curated files** (231 overlapping courses):
`totalCredits` 231/231, `periodCredits` 228/231, `nameEn` 226/227, `exams` 50/58.
The `periodCredits` misses are all in TIEMM, whose curated file is an unverified
2024-cohort extraction; the live source agrees with the extractor and the 2024
plan is no longer online. Two `nameEn` misses are KOPPS typos the curated files
fixed by hand.

**Exams are two-tier.** Single-period courses are certain (the exam sits in the
teaching period, per *Riktlinje om läsårets förläggning* §1.1) — 13/13 on CTFYS.
Multi-period courses are **not derivable**: SE1055 puts its single exam in the
last period while SI1121 puts its in the credit-majority period, which rules out
every simple rule. Those get a convention — one exam per exam-bearing module, in
the highest-credit periods — measured at 10/17 over every multi-period course
with a curated value across all six programmes (placing them in the *last*
periods instead scores 8/17). Every such placement is flagged for review. The
7 residual misses are unreachable from module count in either direction, so
closing them needs real timetable data: Ladok's aktivitetstillfällen, which the
sibling `academic-performance-portal` already imports into its `exam_occasions`
table.

**KOPPS is retired — the course page is the live source.** KOPPS still answers but
stopped receiving updates, and the gap is measurable. DD1328's page carries two
syllabus versions (VT2026 and VT2024); the KOPPS API returns only the VT2024 one.
The newer text lists `DD1333`, which is CTMAT's own first-year programming course,
so reading KOPPS left DD1328/DD1380/DD1385 with no prerequisites at all. Measured
over all 217 course codes in the six programmes: **166 identical, 51 different**,
and where they differ the page is the fuller text (EI1320: KOPPS says
"Slutförd kurs motsvarande SI1200", the page says "…SI1200 eller SF1693").

So `fetchCoursePage()` reads the course page's own render state — prerequisites,
grading scale, cycle level and examination modules, from the newest entry in
`syllabusList` sorted by `course_valid_from` — and KOPPS is the fallback. The one
field only KOPPS has is the **English title**: the English course page
(`kth.se/en/student/kurser/kurs/<CODE>`) returns HTTP 500, exactly like the
English study-plan route, so English titles inherit KOPPS's staleness *and* its
typos (KD1000 is "Chemical Principles for Sustainabillty" there).

**Kursplan versions are per-cohort, and the page carries the whole history.**
Prerequisites change. EI1320's went from "Slutförd kurs motsvarande SI1200" to
"…motsvarande slutförd kurs SI1200 **eller SF1693**" with the version valid from
20261, so showing the new text to a cohort that sat the course in 2025 would be
wrong in exactly the way the cohort view exists to avoid.

The course page's `syllabusList` holds every version, each tagged with
`course_valid_from`, and **that value is the KTH term code** (`{year: 2026,
semesterNumber: 1}` = 20261). Verified against the kursplan archive at
`kth.se/kursutveckling/<CODE>/arkiv`: EI1320 publishes PDFs for 20261, 20212,
20192, 20191 and 20182, and the page lists exactly those five. **So the PDFs never
need parsing** — the structured history is already in the page.

Selection is therefore: work out the term the cohort sits the course in
(`termForCourse` — study year Y of cohort C falls in läsår C+Y−1; P1/P2 are its
autumn, P3/P4 the following spring), then take the newest version in force by
then (`versionForTerm`). CTFYS HT2023 sits EI1320 in 20252 and gets the 20212
kursplan (SI1200 alone); HT2024 sits it in 20262 and gets 20261 (SI1200 or
SF1693). Whenever a cohort resolves to anything other than the newest version the
extractor says so in the review file, so the difference is visible rather than
surprising. Curated files resolve against the läsår in
`academic-periods.json` instead of a cohort, matching their one-läsår semantics.

**Prerequisites come from free text and need coordinator sign-off.** They live in
the syllabus `eligibility` field (*Särskild behörighet*), while the
schema wants two typed lists — `prerequisitesCompleted` ("slutförd") and
`prerequisitesParticipation` ("aktivt deltagande"). Three things make the
interpretation tractable:

1. **Intersecting with the programme's own courses** collapses alternative lists.
   Of `DD1310/DD1311/…/DD1331` only DD1331 is in CTFYS, and the same filter keeps
   cross-programme codes out of the arrows.
2. **Type is decided per clause**, so one text can yield both kinds.
3. **A clause with no type marker inherits one signalled elsewhere in the text** —
   SK1104 lists its courses in one sentence and qualifies them in the next
   ("Dessa läses parallellt med denna kurs").

Two rules were derived from the labelled data: tolerating KOPPS's own
"Aktivit deltagande" typo (SK1105, SG1113), and reading "läses parallellt" as
participation. Measured against the 19 hand-curated CTFYS prerequisites: **19/19
exact, no misses, no spurious entries** — but CTFYS is the *only* program with
curated prerequisites, and those two rules were tuned against it, so treat that
as a fit to the available labels rather than proof of generalisation.

Requirements are split on capitalised openers, not just punctuation. EI1320's
20261 kursplan runs two requirements together with no period between them —
"…motsvarande slutförd kurs SI1200 eller SF1693 Kunskaper i grundläggande
elektromagnetism…, motsvarande slutförd kurs SK1104/SH1017…". Splitting on
sentence boundaries alone made that one clause, so SI1200 and SK1104 — both
required — were reported as alternatives, telling a coordinator to "decide which
applies". A new requirement starts with a capitalised opener (`Kunskaper`,
`Slutförd`, `Aktivt`, …); inside a requirement the same words are lower case
("motsvarande slutförd kurs X"), so capitalisation is what separates the two and
the split is deliberately case-sensitive.

Requirements on a single examination module ("slutfört moment LAB1 i SH1017")
have no shape in the schema. They are reported rather than reduced to a
whole-course dependency, which would overstate what is required.

Ranges are expanded: KOPPS writes alternative sets as `DD1310-DD1319` as well as
slash-lists, and a plain code scan sees only the endpoints. 43 range expressions
appear across the six programmes, and expanding CINEK's DD1418 recovers DD1317,
DD1324 and SF1918 — real in-programme prerequisites that were being dropped.

Everything uncertain is written to `prerequisite-review/<PROGRAM>.md` instead of
being committed silently. Two of those sections are aimed at the program director
rather than at data entry:

- **"The course's own prerequisite list looks out of date — report it"** — the
  course asks for a knowledge area this programme teaches, but its list of
  qualifying courses omits our course. That is a defect in the *other course's*
  syllabus, so the action is to confirm the suggested course and **report it to
  that course's coordinator** so it is fixed at source. DD1385 and DD1380 are the
  live examples; neither has been revised since HT2021.
- **"Prerequisite does not precede the course"** — a recorded prerequisite that
  does not come earlier in the programme. `slutförd` must finish before the course
  starts; `deltagande` may overlap but cannot start after it ends (CTFYS's SK1104
  spans P2-P3 and legitimately participates in SF1674 in P3). 15 across the six
  programmes, most in TIEMM.

The rest are data-entry items: type inferred rather than stated, several
alternatives surviving the filter, credit thresholds the schema cannot express,
and texts naming only out-of-programme courses. `--prereqs` fills a curated file's *missing*
prerequisites and never touches a course that already has them — a coordinator's
reading of the same text outranks anything derived here.

**Not extractable:** `teacher`, `description`, cosmetics files, and the case where
inriktningar take one course in *different study years* (CINEK's DD1320) — the
schema has no shape for it, so the extractor emits the widest-audience year and
flags the rest.

**Adding a programme from scratch** (CMAST and CMATD were added this way):

1. Confirm it exists: `api.kth.se/api/kopps/v2/programme/<CODE>`.
2. Append an entry to `programs.json` with `verified: false`. Point `dataFile` at
   `cohorts/<CODE>-HT<year>.json` rather than inventing a curated file — there is
   no hand-curated data for a new programme, and duplicating a cohort file would
   immediately drift out of sync.
3. `npm run extract-plan <CODE> -- --all-cohorts`.
4. If the extracted courses carry `specializations`, add a registry to
   `programs.json` — but only the codes the data actually uses. KOPPS returns the
   master-programme choices for years 4-5 as specialisations (46 for CMAST, 24 for
   CMATD, and CTFYS likewise has dozens); listing all of them would be wrong. The
   validator errors if a course names a code that is not registered, which is what
   surfaces the real set.
5. Write `<CODE>-cosmetics.json` following the palette convention above, grouping
   by course-code prefix (SF maths, SK/SG/SE physics and mechanics, MF/MG/MJ/MH
   mechanical, CK/KD chemistry, DD computing, LS languages), with thesis courses
   (codes ending in `X`) in Övrigt.
6. `npm run validate-data` and read the full-time warnings — they are the fastest
   check that the extraction is sane.

### Types (`src/types/`)

- **`course.ts`** — `Course`, `Period`, `CourseCredit`, `OptionGroup` interfaces
- **`cosmetics.ts`** — `CourseGroup`, `ProgramCosmetics` interfaces

## Non-Obvious Details

**Course merge logic**: A single course code can appear across multiple JSON entries or carry the by-year `periodCredits` shape. `src/lib/useCourseModel.ts` normalises both to a uniform per-year credits map (`HomeClient.tsx` no longer does this). Two foot-guns the validator catches: duplicate `code` entries are silently summed, and a flat `prerequisites` array is silently dropped if `prerequisitesCompleted` is also non-empty.

**Option groups**: `OptionGroup` is a special data-file entry (`type: "optionGroup"`) for course choices like thesis options. The current implementation only supports `allowedNumberOfOptions = 1` ("pick exactly one course from this list, all options share the same period layout"); it can't yet express "minst N hp ur grupp". The selection modal is rendered inline at the bottom of `TimelineVisualization.tsx` (~lines 2916–3140), not in a separate component.

**Chart height must stay a pure function of the data.** `TimelineVisualization`
used to seed its height from `svgRef.current.clientHeight` — the height its own
previous render had written onto that node — and then only ever grew it
(`if (requiredTotalHeight > height)`). Switching from a tall programme to a short
one therefore left the SVG at the tall size, stranding the legend far below the
chart; measured CTFYS 659 → TIEMM 2994 → CTFYS 3882 against 659 on a fresh load.
The height is now derived from `initialChartHeightRef` plus the data, and set
unconditionally so it shrinks as well as grows.

**SVG export**: Embeds Figtree font CSS inline so the exported SVG renders correctly outside the browser. The font is fetched fresh from Google Fonts on every export.

**Vercel PDF export**: `vercel.json` sets 1800 MB RAM and 60s timeout for the PDF endpoint (Hobby plan limit is 2048 MB). The `@sparticuz/chromium` binary must be bundled — configured via `serverExternalPackages` + `outputFileTracingIncludes` in `next.config.ts` and the matching `includeFiles` in `vercel.json` (the duplication is intentional but fragile).

**Build-time metadata**: `next.config.ts` injects `NEXT_PUBLIC_GIT_HASH`, `NEXT_PUBLIC_GIT_TIMESTAMP`, and `NEXT_PUBLIC_GIT_REPO_URL` at build time, falling back to `git` shell-outs when the Vercel env vars aren't present.

**Standing review**: Open issues, design discussion, and a ranked improvement list live in `REVIEW.md` at the repo root.

## Tech Stack

- **Next.js 16** (App Router), **React 19** with React Compiler, **TypeScript 5** (strict)
- **D3.js 7** for all SVG rendering
- **Tailwind CSS 4**
- **Puppeteer-core + @sparticuz/chromium** for server-side PDF

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
