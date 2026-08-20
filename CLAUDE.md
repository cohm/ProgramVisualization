# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start Next.js dev server at http://localhost:3000
npm run build          # Production build
npm run lint           # ESLint
npm run validate-data  # Validate src/data/*.json (also runs in CI)
npx tsc --noEmit       # Type-check without emitting

npm run extract-plan CTFYS            # Build extracted/CTFYS.kopps.json from KTH
npm run extract-plan CTFYS -- --help  # Options (--years, --lasar, --specializations)
node scripts/validate-data.mjs --include CTFYS=extracted/CTFYS.kopps.json
```

There are no automated tests in this project, but `validate-data` enforces the data-file schema and cross-reference invariants.

## What This Is

A Next.js + D3.js visualization app that renders KTH engineering degree programs (CTFYS, CTMAT, CFATE, COPEN) as interactive SVG timeline charts. Courses are laid out across academic periods (P1–P4 per year), stacked by credit weight, with prerequisite arrows, exam markers, and optional course groups. Supports SVG, PNG, and server-side PDF export. Bilingual (Swedish/English) with URL-based state (`?program=CTFYS&l=sv`).

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
- **`academic-periods.json`** — P1–P4 date ranges (lecture/exam/re-exam) for one läsår at a time (currently 2025/2026); converted to `Date` objects in `src/types/course.ts`. Note: the file's `reExamStart`/`reExamEnd` for period `P1` actually fall in December — i.e. between P1 and P2, per *Riktlinje om läsårets förläggning* §1.1. A course's `"reexams": ["P1"]` therefore means "uses the P1 re-exam slot (December)", not "re-exam during P1".

  The `reexams` field on a course is **optional**: when omitted, the loader defaults it to a copy of `exams`, which matches the riktlinje's rule that the re-exam slot is fixed by the ordinary exam period. Set it explicitly only to add EXTRA tillfällen (e.g. an additional re-exam for a critical first-year math course). Known limitation: extra slots in periods where the course has no credits aren't visualised yet — the renderer anchors markers to the course's bar in the same period (`TimelineVisualization.tsx:1659–1691`).
- **`kth-colors.json`** — KTH official color palette.

### Study-Plan Extraction (`scripts/extract-from-kopps.mjs`)

Builds a candidate `extracted/<PROGRAM>.kopps.json` from KTH's public study-plan
pages, for human diff-and-merge. Verified files are never touched, and candidates
are gitignored. Pure Node, no extra dependencies. Run `--help` for options.

**Candidates must stay out of `src/data/`.** `useCourseModel.ts` loads data with
``await import(`@/data/${dataFile}`)`` — a dynamic import with a template
literal, so the bundler builds a context module over the whole directory and
*every* JSON file in it enters the client bundle, referenced or not. Measured:
six candidate files in `src/data/` took the brotlied client JS from 201.33 kB to
212.87 kB and shipped unverified course data to browsers. This is also why
PR #37's `src/data/<PROG>.ladok.json` convention should not be revived.

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

**`electiveCondition` mapping.** `O`→`mandatory`; `VV`→an `optionGroup`
(`pickN: 1`); `V`→**reported but not written**, because the curated files
deliberately abstract electives into `Plats för valfri kurs` placeholders.
`--electives` overrides.

**Accuracy, measured against the six curated files** (231 overlapping courses):
`totalCredits` 231/231, `periodCredits` 228/231, `nameEn` 225/227, `exams` 48/58.
The `periodCredits` misses are all in TIEMM, whose curated file is an unverified
2024-cohort extraction; the live source agrees with the extractor and the 2024
plan is no longer online. Two `nameEn` misses are KOPPS typos the curated files
fixed by hand.

**Exams are two-tier.** Single-period courses are certain (the exam sits in the
teaching period, per *Riktlinje om läsårets förläggning* §1.1) — 13/13 on CTFYS.
Multi-period courses are **not derivable**: SE1055 puts its single exam in the
last period while SI1121 puts its in the credit-majority period, which rules out
every simple rule. Those get a convention (one exam per exam-bearing module, in
the last N periods; 5/7 on CTFYS) and are all flagged for review. Replacing this
with facts means joining Ladok's aktivitetstillfällen — which the sibling
`academic-performance-portal` already imports into its `exam_occasions` table.

**Not extractable:** `teacher`, `description`, cosmetics files, and the case where
inriktningar take one course in *different study years* (CINEK's DD1320) — the
schema has no shape for it, so the extractor emits the widest-audience year and
flags the rest.

### Types (`src/types/`)

- **`course.ts`** — `Course`, `Period`, `CourseCredit`, `OptionGroup` interfaces
- **`cosmetics.ts`** — `CourseGroup`, `ProgramCosmetics` interfaces

## Non-Obvious Details

**Course merge logic**: A single course code can appear across multiple JSON entries or carry the by-year `periodCredits` shape. `src/lib/useCourseModel.ts` normalises both to a uniform per-year credits map (`HomeClient.tsx` no longer does this). Two foot-guns the validator catches: duplicate `code` entries are silently summed, and a flat `prerequisites` array is silently dropped if `prerequisitesCompleted` is also non-empty.

**Option groups**: `OptionGroup` is a special data-file entry (`type: "optionGroup"`) for course choices like thesis options. The current implementation only supports `allowedNumberOfOptions = 1` ("pick exactly one course from this list, all options share the same period layout"); it can't yet express "minst N hp ur grupp". The selection modal is rendered inline at the bottom of `TimelineVisualization.tsx` (~lines 2916–3140), not in a separate component.

**SVG export**: Embeds Figtree font CSS inline so the exported SVG renders correctly outside the browser. The font is fetched fresh from Google Fonts on every export.

**Vercel PDF export**: `vercel.json` sets 1800 MB RAM and 60s timeout for the PDF endpoint (Hobby plan limit is 2048 MB). The `@sparticuz/chromium` binary must be bundled — configured via `serverExternalPackages` + `outputFileTracingIncludes` in `next.config.ts` and the matching `includeFiles` in `vercel.json` (the duplication is intentional but fragile).

**Build-time metadata**: `next.config.ts` injects `NEXT_PUBLIC_GIT_HASH`, `NEXT_PUBLIC_GIT_TIMESTAMP`, and `NEXT_PUBLIC_GIT_REPO_URL` at build time, falling back to `git` shell-outs when the Vercel env vars aren't present.

**Standing review**: Open issues, design discussion, and a ranked improvement list live in `REVIEW.md` at the repo root.

## Tech Stack

- **Next.js 16** (App Router), **React 19** with React Compiler, **TypeScript 5** (strict)
- **D3.js 7** for all SVG rendering
- **Tailwind CSS 4**
- **Puppeteer-core + @sparticuz/chromium** for server-side PDF
