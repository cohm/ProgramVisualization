# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start Next.js dev server at http://localhost:3000
npm run build          # Production build
npm run lint           # ESLint
npm run validate-data  # Validate src/data/*.json (also runs in CI)
npx tsc --noEmit       # Type-check without emitting
```

There are no automated tests in this project, but `validate-data` enforces the data-file schema and cross-reference invariants.

## What This Is

A Next.js + D3.js visualization app that renders KTH engineering degree programs (CTFYS, CTMAT, CFATE, COPEN) as interactive SVG timeline charts. Courses are laid out across academic periods (P1–P4 per year), stacked by credit weight, with prerequisite arrows, exam markers, and optional course groups. Supports SVG, PNG, and server-side PDF export. Bilingual (Swedish/English) with URL-based state (`?program=CTFYS&l=sv`).

## Architecture

### Data Flow

1. User selects a program → `HomeClient.tsx` loads `src/data/<PROGRAM>.json` + `<PROGRAM>-cosmetics.json`
2. A merge step normalises both `periodCredits` shapes into a uniform `Course[]` (see `HomeClient.tsx` lines ~80–228)
3. Merged courses + cosmetics are passed to `TimelineVisualization`, which renders everything in D3
4. Export: SVG/PNG is client-side; PDF POSTs HTML to `/api/export-pdf` where Puppeteer renders it

### Key Components

- **`src/app/HomeClient.tsx`** — Main client component: program selector, language toggle, export menu, course merge logic, data loading orchestration.
- **`src/components/TimelineVisualization.tsx`** — ~3100-line D3 component; renders SVG, handles focus mode, interactivity, exports, and (inlined at the bottom of the file) the option-group selection modal. This is where most feature work happens.
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

### Types (`src/types/`)

- **`course.ts`** — `Course`, `Period`, `CourseCredit`, `OptionGroup` interfaces
- **`cosmetics.ts`** — `CourseGroup`, `ProgramCosmetics` interfaces

## Non-Obvious Details

**Course merge logic**: A single course code can appear across multiple JSON entries or carry the by-year `periodCredits` shape. `HomeClient.tsx` (~lines 80–228) normalises both to a uniform per-year credits map. Two foot-guns the validator catches: duplicate `code` entries are silently summed, and a flat `prerequisites` array is silently dropped if `prerequisitesCompleted` is also non-empty.

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
