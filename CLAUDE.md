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
npm run extract-plan CTFYS -- --all-cohorts     # HT2022..newest
npm run extract-plan CTFYS -- --prereqs         # fill missing prereqs in curated file
npm run extract-plan CINEK -- --exams           # reconcile curated 'exams' with the kursplan
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
- **`src/components/TimelineVisualization.tsx`** — ~2950-line D3 component; renders SVG, handles focus mode, interactivity, exports, and interactivity. This is where most feature work happens. (The option-group selection modal is its own component, `OptionGroupModal.tsx`.)
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
| HT2022 | gone | gone | gone |
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

`EARLIEST_COHORT = 2022` is the floor. **HT2022 has been deleted entirely** — its
pages still render ("Utbildningsplan kull HT2022, Årskurs 1", HTTP 200) but
`curriculumInfos` carries one common entry with no participations at all, for
every programme and every year. So all three of its years are borrowed
(y1←HT2025, y2←HT2024, y3←HT2023 for the SCI programmes) and `corroborate()`
cannot run, because it needs a year *both* cohorts publish and HT2022 publishes
none. Every HT2022 year is therefore `approximated` with confidence `unknown`,
which the chart states above the plan. HT2022 students are nominally in year 5,
but those behind schedule are still taking bachelor-level courses, so the plan is
worth offering with that caveat attached rather than withholding.

A consequence worth keeping straight: HT2022's *course layout* is identical to
HT2023's, because they borrow the same source years. What genuinely differs is
the kursplan versions, since `termForCourse` puts HT2022 a year earlier — see
below.

**"Zero courses" has two different causes, and they must not be conflated.** A
year with `curriculumInfos: []` has no curriculum defined at all — COPEN's years
2-3 and TIEMM's year 3 are the real cases, and they are correctly reported as
"not part of this programme". A year with one `curriculumInfo` carrying *no
participations* is a year whose course list is simply absent for that cohort:
deleted (HT2022, HT2023's years 1-2) or not yet published (HT2026's year 3).
`resolveYear` already separates the two by searching other cohorts — `anyListed`
is false only in the structural case — so the distinction is handled, but the
`curriculumInfos.length` signal is the cleaner discriminator if this ever needs
rewriting.

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

**The study plan states the villkorligt-valfri rule in prose, in a field we
ignored for a long time.** `curriculumInfo.conditionallyElectiveCoursesInformation`
carries what the schema could not otherwise know: how many of a VV group's courses
a student takes, and which master programme each one qualifies them for. Reading
it fixed a wrong model rather than adding a nicety — CFATE year 3 was pick-one
when Teknisk fysik (TTFYM) requires SI1146 **and** SH1014.

MEASURED over eight programmes, three läsår, years 1–3: 39 of 166
`curriculumInfos` populate it, 180 lines of text, of which **42 % carry a
machine-readable rule**. The phrasings that do:

    "Minst en av de villkorligt valfria kurserna … ska läsas"   -> at least 1
    "För civilingenjörsexamen ska minst två av följande"        -> at least 2  (CMAST)
    "En villkorligt valfri kurs ska läsas"                      -> exactly 1   (CTMAT)
    "ska antingen SA114X eller EF112X läsas"                    -> exactly 1   (CTFYS)
    "Kurser som krävs: SI1146 och SH1014"                       -> per-master requirement

**`pickN` is derived, not assumed.** When the plan states a count, it is used.
When it states only per-master requirements, the count is *implied*: the most any
single master programme requires from that group — counted per (programme, spår)
so TTFYM's extra SI1155 for three of its tracks does not inflate the autumn
group. CFATE year 3's autumn box comes out `pickN: 2` this way, from KTH's own
text rather than from a guess.

**`qualifiesFor` is the answer to what a student is actually asking.** It maps
each option to the master programmes that require it (`DD1320 → TIPUM`,
`SI1155 → TTFYM (TFYA/TFYB/TFYG)`), and the chart tooltip renders it as
"behörighetsgivande för TTFYM" beside the option. Nothing else in the data we read
contains this. It is per cohort on purpose: CFATE's HT2023 text requires SH1012
for Kärnenergiteknik, an entry the HT2024 text drops entirely — SH1012 is the
older, larger version of SH1014, so the requirement was simply stale.

**Grouping follows the plan's naming, not the period layout.** The layout key is
a proxy and CFATE year 3 breaks it both ways: its five autumn options have five
*different* layouts (4 hp P1, 4 hp P2, 6 hp P1, 6 hp P2, 5+1), so the key made
five singletons, each then dropped by the single-option rule below — losing the
block entirely and leaving those courses modelled as compulsory. When the plan
names courses under a master programme, that naming *is* the grouping. Autumn
(P1/P2) and spring (P3/P4) still split, because a 15 hp thesis in P3+P4 is not an
alternative to a 4 hp course in P1.

A non-uniform group's bar takes the per-period **maximum** of its options — the
envelope of the slot, as an `electivePlaceholder` bar means — since no single
option's shape can represent the group.

**`\b` is ASCII-only in JavaScript, which silently broke the count parser.**
`/\bminst\s+(en|två|…)\b/` never matched "minst två": the trailing `\b` looks
for a boundary between `v` and `å` and finds none, so the whole match fails
without error. Only digits and the vowel-final words worked. It is now
`(?!\p{L})` with the `u` flag. Worth remembering for any Swedish-language regex
in this codebase.

**Not turned into rules, deliberately.** TIEMM's *"Om du ska ansöka om
Masterexamen inom Datalogi: Välj fyra kurser"* depends on a degree the student has
not applied for, so it is not a property of the group. *"Endast en av kurserna
SG1217 och SG1220 kan ingå i examen"* is a mutual exclusion — it caps what may
count toward the degree rather than saying how many to take. Both are recognised
so they are not reported as unread, and neither sets `pickN`.

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
HT2023's years 1–2 are already unrecoverable, and the whole of HT2022 now is. Committing the files is what stops
that erasing our copy; re-running extraction only ever adds. They live inside
`src/data/` (unlike the ad-hoc `--out` candidates) because the app must load
whichever cohort the user picks, and each JSON becomes its own lazily-loaded
chunk — an unselected cohort costs a viewer nothing. They do all count toward the
`size-limit` budget, which is why it is 330 kB and not 250 (~201 kB app,
~50 kB archive, ~2 kB per cohort file). `src/data/cohorts/index.json` is
regenerated from disk on every run and drives the UI's selector; the validator
cross-checks it both ways.

Adding the HT2022 cohort costs **16.4 kB brotlied** across the eight programmes
(measured as the difference between two builds, and independently by brotliing
the eight files: 16.0 kB — TIEMM alone is 5.0 kB of it). That leaves the 330 kB
budget intact on the bundler CI uses.

**Measuring the budget locally needs `next build --webpack`, and the number is
not comparable.** The default Turbopack build spawns a PostCSS subprocess that
binds a port, which a sandboxed shell refuses (`Operation not permitted (os error
1)` from `evaluate_webpack_loader`); `npx next build --webpack` completes. But
webpack lays chunks out differently and measures **~82 kB higher** on the same
tree — 352.28 kB against Turbopack's 270.63 kB with the same data. So a
`--webpack` run "exceeding" the limit says nothing on its own; use it only to
measure a *delta* between two builds, and treat CI as the authority on the
absolute number.

A related wrinkle: `disabled` keeps a programme out of the UI but not out of the
bundle. TIEMM's five cohort files are 24.6 kB brotlied and still ship, because
`useCourseModel.ts` imports by template literal and the bundler therefore emits a
chunk for every JSON in the directory. Worth revisiting if the budget gets tight;
the archive rationale above is the reason they are kept for now.

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

**What counts as an exam is decided by the kursplan's examination modules**, and
getting that test right mattered more than the placement rule below.

It is `isExamModule`: the module code starts with `TEN`, **or** its title says
tentamen. Both halves are load-bearing. The code half keeps the handful of `TEN`
modules with an unusual title (`TEN1 "Examination"`, `TEN1 "Skriftlig test"`,
`TEN1 "Kontrollskrivning"`); the title half picks up `EXA2 "Hemtentamen"`, the
only genuine take-home exam in the data. `LAB` / `INL` / `PRO` / `DIA` / `SEM` /
`KON` / `ÖVN` are coursework and get no marker, so a course examined only that way
correctly ends up with `exams: []`.

This replaced a prefix list, `['TEN', 'HEM']`, whose `HEM` half was wrong in an
instructive way. Its comment recorded the reasoning: *"HEM = hemtentamen (DD1327
is HEM1+PRO1 and the curated data does mark an exam for it)"* — so the rule was
inferred from DD1327's curated value, which was itself the error, and then
propagated that error to every other cohort. Our own output was justifying the
rule that produced it. Measured over all 278 courses: **all 48 `HEM*` modules are
titled "hemuppgift(er)"**, homework, and not one is a tentamen.

**The module parser used to read only the first module of each kursplan.** The
page concatenates every module into one string with no separator, and the old
single regex ended in a greedy `([^|<]+)` for the grading scale, which swallowed
the rest. It parsed **933 modules where a correct split finds 2275**, truncating
**66% of all kursplan versions** — so `examBearing.length` could never exceed 1,
silently defeating the "one exam per exam-bearing module" rule below. Two further
details it got wrong: a module code can end in a **letter** (SF2930's
`TENA - Skriftlig tentamen` was never matched), and Swedish initials matter
(`ÖVN1` was matched from the `V`, giving 61 phantom `VN` prefixes). Hence
`MODULE_CODE = [A-ZÅÄÖ]{2,4}[A-Z0-9]`, a split on a lookahead for it, and
per-chunk parsing in `parseExamModules`.

**Exams are two-tier.** Single-period courses are certain (the exam sits in the
teaching period, per *Riktlinje om läsårets förläggning* §1.1). Multi-period
courses are **not derivable**: SE1055 puts its single exam in the last period
while SI1121 puts its in the credit-majority period, which rules out every simple
rule. Those get a convention — one exam per exam-bearing module, in the
highest-credit periods — and every such placement is flagged for review. Closing
the residual misses needs real timetable data: Ladok's aktivitetstillfällen, which
the sibling `academic-performance-portal` already imports into its
`exam_occasions` table.

Measured against the hand-authored CTFYS exams after both fixes: **16/26 → 23/26**
overall, single-period **12/15 → 14/15**, multi-period **4/11 → 9/11**. The one
remaining single-period miss is DD1327, where the curated value is the error, so
that tier is effectively exact — which is what the riktlinje implies.

**The curated files' `exams` were largely unpopulated, and `--exams` reconciles
them.** Audited against the kursplan in force for the current läsår: CTFYS agreed
on 25 of 26, but **CINEK on only 17 of 50** — 33 of its courses recorded no exam
while their kursplan carries an explicit `TEN` module, and SG1109 carries two (a
Problemtentamen and a Teoritentamen). CTMAT was missing 5, CFATE 1. Those are
empty fields rather than considered judgements, so filling them is a correction.

`--exams` therefore does three different things, and the third is the point:

- no exam recorded but the kursplan has a tentamen → **filled**;
- an exam recorded but the kursplan has none → **cleared**. Two cases, both wrong
  curated values: DD1327, and SA1006, which carried a by-year map while its
  kursplan examines `PRO1`–`PRO5`, five P/F projects and nothing else;
- both present but the period differs → **reported, curated value kept**. Our
  highest-credit convention is right about half the time on multi-period courses,
  so a coordinator's placement outranks it. Eight are left standing (SG1112,
  SE1055, SG1132, SF1668, SF1682, SD1120, SG1133). Same principle as `--prereqs`.

Net effect on the cohort files: courses carrying an exam marker went **127 → 229**
across the HT2026 files, most of it the parser fix making previously invisible
`TEN` modules visible.

**Oral exams are counted but flagged.** A *muntlig tentamen* is a tentamen, yet an
oral exam is usually booked individually rather than sitting in the scheduled
examination period, which is what the chart's marker means. Only three exist in
the whole data set (ME2322, ME2323, MJ1141) — too few to invent a rule from — so
they are counted and reported for a coordinator to overrule.

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
SF1693). Curated files resolve against the läsår in `academic-periods.json`
instead of a cohort, matching their one-läsår semantics.

**How often this actually bites**, measured over the committed cohort files: the
chosen kursplan differs between cohorts for 5 of 28 CTFYS courses (EI1320,
DD1331, DD1327, SK1105, SH1014), 1 of 28 in CTMAT (DD1328), 4 of 28 in CMATD,
1 of 9 in COPEN and 43 of 115 in TIEMM. So it is not an edge case, and a review
file built from one cohort hides it.

**The kursplan PDF has a stable public URL, which is what makes the review files
signable.** `/student/kurser/kurs/kursplan/<CODE>-<TERM>.pdf?lang=sv` returns the
version in force at `<TERM>`. The route came from the course page's own render
state (`paths.SyllabusPdf.getPdfProxy.uri` =
`/student/kurser/kurs/kursplan/:course_semester`); the **`.pdf` suffix is
required**, and without it the endpoint answers 500 for every input including
valid ones, which is an easy way to conclude wrongly that it does not work.
`?lang=en` also works, even though the English course *page* is HTTP 500.

Passing a term that is not itself a version boundary is fine — the endpoint
resolves it to the version in force, so `EI1320-20231.pdf` returns the 20212
kursplan byte-for-byte. The review files nevertheless link each version's own
`valid_from` term, because that is the label the kursutveckling archive prints
beside the same entry, so a reviewer sees one identifier in both places.

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
being committed silently.

**The review file is written to be signed off, not to be maintained.** It goes to
a program director who should not have to open a data file or search kth.se, so:

- Every course code is a link to its page, and every judgement links the **exact
  kursplan PDF** it was read from, labelled the way the archive labels it
  ("HT 2021 – HT 2025", "VT 2026 – tillsvidare"). A reviewer clicks the kursplan,
  reads *Särskild behörighet*, and confirms or corrects.
- **One file covers every cohort**, and the unit of review is a *kursplan text*
  rather than a cohort: items identical across cohorts are merged onto one line
  listing the cohorts affected, and a revision that reworded a requirement shows
  up as a separate line with its own version link. It used to be written from
  whichever cohort ran last, which for `--all-cohorts` meant the newest one only
  — so the HT2023 reading of EI1320 (SI1200 alone) was invisible while the file
  showed the HT2024+ reading (SI1200 *or* SF1693).
- A **"cohorts read different kursplan versions"** section lists exactly where
  cohorts are held to different texts, since that is where no single "correct"
  answer exists.

Only strings that really are course codes get linked: the module-level section
carries values like "LAB1 i SH1017", and linking that verbatim produced a URL
with a space in it that answers HTTP 400 — one dead link is enough to cost the
reviewer confidence in the rest, so `codeLink()` links codes inside free text and
leaves the rest alone. All 63 distinct URLs across the eight files were fetched
and checked to resolve (kursplan links additionally checked to return
`application/pdf`).

Two of the sections are aimed at the program director rather than at data entry:

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

### Transition plans (`src/data/transitions.json`)

COPEN (Öppen ingång) students take one common year and then transfer into a
five-year programme, so what they actually study is published nowhere: COPEN's
plan stops after year 1, and the target's plan assumes its own year 1. A
transition plan records the **difference** from the target's published plan, and
`src/lib/transitions.ts` composes the view at runtime.

```json
{ "from": "COPEN", "to": "CTFYS", "sourceYears": [1],
  "credited": [{ "code": "SF1626", "replaces": ["SF1674"] }, "…"],
  "exempt": [{ "code": "SF1544", "creditedBy": "SF1546", "note": "…" }],
  "added":  [{ "code": "SF1920", "year": 2, "periodCredits": { "P3": 6 },
               "substitutesFor": "SF1922", "fromProgram": "CELTE",
               "cosmeticsGroup": "Matematik", "…": "…" }],
  "moved":  [{ "code": "…", "fromYear": 1, "toYear": 2 }],
  "verified": false }
```

Three shapes of difference, and the third is the one that took a correction:

- **`exempt`** — a target course the student does not take, because a source
  course credits it. CTFYS drops SF1544, credited by COPEN's SF1546.
- **`moved`** — a target course shifted to a later year, keeping its periods.
  Nothing uses it today; kept because it is the natural shape for "take the
  target's own course, just later".
- **`added`** — a course from *neither* published plan. COPEN teaches no
  probability course and CTFYS teaches SF1922 in its year 1, which the transfer
  student was never present for. The plan therefore adds **SF1920 in P3 of year
  2, taken with CELTE's second year** — same subject, and it lands in the period
  the exemption emptied.

The first draft of this plan used `moved` for SF1922 into year 2 P4, which is
what issue #66 described. That is worse on the arithmetic *and* worse for the
student: it means waiting until P4 for a course the CELTE offering provides in
P3. Per-period load, composed year 2:

| variant | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| SF1922 moved to y2 P4 | 15 | 14 | **10** | **21** |
| SF1920 from CELTE in P3 | 15 | 14 | 16 | 15 |

Both total 60 hp, which is exactly why the check has to be per period. The
residual ±1 is structural: SF1544 carried 1 hp in P2 and 5 in P3, while SF1920 is
6 hp all in P3.

**`credited[].replaces` is what makes the prerequisite arrows right**, and it is
the reason `credited` is a list of objects rather than codes. A target course in
years 2-3 states its prerequisites in the target's own terms — CTFYS's SF1683 and
SI1146 both require SF1674 — but a transfer student never took SF1674; they took
SF1626, the same subject. Drawn to the letter, the arrow would start from a course
that is not in their plan and simply vanish, leaving those courses looking as
though they had no prerequisites at all.

`redirectPrerequisites` therefore rewrites every reference through the plan's own
equivalences. It is a general rule over the data, not a list of special cases:
exactly five CTFYS year-1 courses are referenced from years 2-3, and all five
resolve through it.

| target course referenced | credited course it becomes | arrows affected |
|---|---|---|
| SF1674 Flervariabelanalys | SF1626 | → SF1683, → SI1146 |
| SF1672 Linjär algebra | SF1624 | → SF1681 |
| DD1331 Grundläggande programmering | DD1310 | → DD1327 |
| SG1112 Mekanik I | SG1133 | → SE1055, → SG1113 |
| SK1104 Klassisk fysik | SK1115 | → SH1014 |

Three fields feed the same rewrite map, so an equivalence is stated once:
`credited[].replaces`, `exempt[].creditedBy` (SF1546 → SF1544, which is why
SF1546 carries no `replaces`), and `added[].substitutesFor`. A reference that
survives the rewrite but names a course outside the composed plan is **reported**
— that means an equivalence is missing, and the symptom would otherwise be a
silently absent arrow. `validate-data` checks the same invariant statically, so it
fails in CI rather than only in the browser.

**An `added` course needs its own data**, since it comes from a programme this
app does not model — CELTE is not in `programs.json`. It is embedded in the plan
in the same raw shape a data file uses and parsed with `parseCourseEntries`, the
loader's own parser, so there is no second implementation of the period/credit
normalisation. `cosmeticsGroup` is required in practice: without it the course
falls to the default colour, which beside the light-tone palette reads as a bug
rather than as "this came from elsewhere". SF1920's values were read from the
live sources the extractor uses — 6 hp and P3 from CELTE's year-2 study plan,
`TEN1` and the `SF1625` prerequisite from its course page — and that prerequisite
resolves inside the composed plan, because SF1625 is one of the nine COPEN
courses.

**Declarative on purpose.** A hand-written combined course list would go stale
the moment either programme is re-extracted, and silently: nothing would say the
composed plan no longer matches. Recording only the difference means the
composition is a pure function of both programmes' current data.

**Year numbering needs no adjustment.** The source contributes year 1 and the
target years 2-3, so the composed years already read 1/2/3. A `moved` course is
re-stamped to its new year but **keeps its periods** — CTFYS's SF1922 runs in P4
either way, because a transfer student sits the same P4 offering as CTFYS's own
year-1 students, just a year later.

**The two cosmetics files share no course codes**, so a composed chart rendered
from the target's file alone would draw all nine COPEN courses in the default
colour. `mergeCosmetics` merges by group *name* (so "Matematik" from both becomes
one legend row), the target's colour winning on conflict — CTFYS has
Ingenjörsämnen = brick where COPEN has it turquoise. A group only the source has
takes the first unused family rather than its own, since COPEN's `Programmering`
is brick, which CTFYS already spends on Ingenjörsämnen. COPEN+CTFYS lands on
exactly five families, which is the hard cap; an overflow is reported and those
courses fall back to the default colour.

**The composition is checked against full-time load per period**, the same signal
`validate-data` applies to the programme files, because a swap can balance across
a year while leaving individual periods lopsided — and the year total hides it
completely. COPEN→CTFYS now comes out 15/14/16/15 in year 2. Reported in the UI
rather than corrected: where the plan puts a course is the program director's
call.

**The chart is titled for both programmes** —
"Civilingenjörsutbildning Öppen ingång → Teknisk fysik (COPEN → CTFYS)". The
target's name is shortened by `shortProgramName`, because the qualification is
identical on both sides and pure noise the second time. That strips a **fixed**
set of openers rather than the longest common word prefix, which looks more
general but is wrong on the English names: "Degree Program in Engineering - Open
Entrance" and "Degree Program in Engineering Physics" share "Degree Program in
Engineering", which would reduce CTFYS to "Physics". An unrecognised name falls
through unchanged.

The composed code also reaches the export audit stamp ("COPEN → CTFYS · build … ·
date"), which is the wanted behaviour; export *filenames* are fixed strings and
unaffected.

`validate-data` cross-checks each plan both ways against both programmes:
`credited` must match what the source actually teaches in those years (a course
added to COPEN that nobody added to the plan would otherwise be dropped
silently), and every `exempt` / `moved` code must exist in the target with the
year the plan claims. `verified: false` warns, exactly like `programs.json`.

### Types (`src/types/`)

- **`course.ts`** — `Course`, `Period`, `CourseCredit`, `OptionGroup` interfaces
- **`cosmetics.ts`** — `CourseGroup`, `ProgramCosmetics` interfaces

## Non-Obvious Details

**Course merge logic**: A single course code can appear across multiple JSON entries or carry the by-year `periodCredits` shape. `src/lib/useCourseModel.ts` normalises both to a uniform per-year credits map (`HomeClient.tsx` no longer does this). Two foot-guns the validator catches: duplicate `code` entries are silently summed, and a flat `prerequisites` array is silently dropped if `prerequisitesCompleted` is also non-empty.

**Option groups**: `OptionGroup` is a special data-file entry (`type: "optionGroup"`) for course choices like thesis options. Two rules are supported, discriminated by `kind` (see `src/lib/optionGroupKind.ts`): `pickN` — pick exactly N, the historical default with N = 1 — and `minCredits`, "pick any number summing to at least N hp", which is the shape KTH's *villkorligt valfri* pools actually have. `minCredits` is implemented end to end (schema, validator, selection modal with a running "X / Y hp" banner and no selection cap) but **no data file uses it yet**; every committed group is `pickN: 1`.

The selection modal lives in `src/components/OptionGroupModal.tsx`. Two earlier notes in this file and in `REVIEW.md` said it had been inlined into `TimelineVisualization.tsx` — it was, and then extracted again; grepping only `TimelineVisualization.tsx` for `kind` therefore suggests `minCredits` is unimplemented when it is not.

**A picked option is drawn where the box was, not where the data files it.** One
course code can be offered by several boxes, and the boxes need not sit in the
same study year. CTMAT offers SF1677/SF1678/SF1691 as the year-2 *villkorligt
valfria* group **and** among the year-3 elective boxes, because a student picks
one of them in year 2 and may take another as a free elective in year 3. The data
file carries one entry per code, stamped `year: 2`, so resolving a pick straight
from that entry drew Komplex analys in year 2 however you got there — the box the
user clicked was not an input to the placement at all.

A picked option is therefore re-stamped to the year of the group it was picked
from, keeping its own period layout. Keeping the layout is not a compromise: the
group bar is only an *envelope* (its shape is the per-period maximum of its
options), so an option whose shape differs from the box has always drawn its own
— CTMAT's DD1351 picked in the "P2" box spans P1+P2. Only the year was ever
wrong. Measured over all eight programmes, the year mismatch is CTMAT-only:
exactly those three courses, all five cohorts, both spring boxes.

Selections are **mutually exclusive across groups** — a course is taken once, so
picking it in one box releases it from any other. Without that, "the box that was
clicked" has no single answer. This also bites the same-year case, which is far
more common (21 codes across CTFYS and CTMAT sit in two or three boxes of the
same year): picking MH1023 in the P3 box and then the P4 box now leaves the P3
box an unfilled placeholder instead of quietly holding both.

The trap when changing any of this: the bar-drawing loop has a defensive
`coursesInOptionGroups.has(code)` guard, and that set must keep meaning "an option
somewhere, picked nowhere". Widening it to all option codes makes picked courses
render their connector and exam markers with **no bars** — and neither `tsc` nor
`eslint` sees it, because nothing about the types changes.

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

**`import 'd3-transition'` is load-bearing and must not be tidied away.** It is a
side-effect import: it is what installs `.transition()` and `.interrupt()` on the
selection prototype, and `TimelineVisualization` calls `.interrupt()` 17 times.
Measured: `selection.prototype.interrupt` is `undefined` after importing only
`d3-selection` and a function after importing `d3-transition`. **Neither `tsc` nor
`eslint` catches its absence**, because `@types/d3-selection`/`@types/d3` declare
the augmentation regardless of which module provides it — so removing it
type-checks, lints, and then throws at runtime on all 17 call sites.

Related, and deliberately left alone: nothing in the codebase calls
`.transition()`, so those 17 `.interrupt()` calls are currently no-ops. Dropping
them would take the d3 install tree from 13 packages to 9, but that is a
behaviour decision rather than a packaging one.

**Why submodule imports at all**, given `import * as d3` was already tree-shaken
(verified by probing built chunks for minification-surviving string literals:
`__data__` and `getUTCMonth` present, `MultiPolygon`, `Invalid delimiter` and
`d8b365` absent; bundle 368.68 → 368.71 kB, i.e. unchanged). The win is the
install tree: **38 packages reachable from `d3` with 7 non-d3 transitive
dependencies, down to 13 with 1** (`internmap`). Four of the dropped ones —
`commander`, `iconv-lite`, `rw`, `safer-buffer` — arrived via `d3-dsv`, a CSV
parser that ships a command-line tool this app never calls.

**The PDF endpoint renders caller-supplied HTML, so it is locked down.**
`/api/export-pdf` takes an `html` string and renders it in headless Chrome, which
without guards is a rendering oracle: submitted HTML can `fetch()` an address
reachable from the function and write the response into the DOM, where it returns
inside the PDF. Three guards, all inert for a real export because the document we
generate is entirely static (inline `<style>`, base64 `@font-face` data URIs, a
serialised SVG, no `<script>`, no external URL — the Google Fonts fetch happens in
the browser *before* the POST):

- same-origin only (`Origin`, falling back to `Referer`, compared against `Host`);
- `page.setJavaScriptEnabled(false)`;
- request interception allowing only `data:`, `about:` and `blob:`.

`setContent` is implemented via page-context evaluation, so disabling scripts
could plausibly have broken the feature. Verified against real Chrome that it does
not: our export document renders to a **byte-identical** PDF with and without the
guards. A document carrying a script and an `<img>` at `169.254.169.254` hung
until the 30 s navigation timeout unguarded, and rendered promptly with the script
not run and the request blocked when guarded. One deployment caveat: the check
compares against the `Host` header, so a proxy that rewrites `Host` would reject
exports.

**Build-time metadata**: `next.config.ts` injects `NEXT_PUBLIC_GIT_HASH`, `NEXT_PUBLIC_GIT_TIMESTAMP`, and `NEXT_PUBLIC_GIT_REPO_URL` at build time, falling back to `git` shell-outs when the Vercel env vars aren't present.

**Standing review**: Open issues, design discussion, and a ranked improvement list live in `REVIEW.md` at the repo root.

## Tech Stack

- **Next.js 16** (App Router), **React 19** with React Compiler, **TypeScript 5** (strict)
- **D3 7** for all SVG rendering — imported as the three submodules actually used (`d3-selection`, `d3-scale`, `d3-color`) rather than the `d3` meta-package, plus a side-effect import of `d3-transition` (see below)
- **Tailwind CSS 4**
- **Puppeteer-core + @sparticuz/chromium** for server-side PDF

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
