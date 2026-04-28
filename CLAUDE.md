# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Next.js dev server at http://localhost:3000
npm run build     # Production build
npm run lint      # ESLint
npx tsc --noEmit  # Type-check without emitting
```

There are no automated tests in this project.

## What This Is

A Next.js + D3.js visualization app that renders KTH engineering degree programs (CTFYS, CTMAT, CFATE, COPEN) as interactive SVG timeline charts. Courses are laid out across academic periods (P1–P4 per year), stacked by credit weight, with prerequisite arrows, exam markers, and optional course groups. Supports SVG, PNG, and server-side PDF export. Bilingual (Swedish/English) with URL-based state (`?program=CTFYS&l=sv`).

## Architecture

### Data Flow

1. User selects a program → `HomeClient.tsx` loads `src/data/<PROGRAM>.json` + `<PROGRAM>-cosmetics.json`
2. A merge step flattens year-specific credit data into a uniform `Course[]` (see `HomeClient.tsx` lines ~50–152)
3. Merged courses + cosmetics are passed to `TimelineVisualization`, which renders everything in D3
4. Export: SVG/PNG is client-side; PDF POSTs HTML to `/api/export-pdf` where Puppeteer renders it

### Key Components

- **`src/app/HomeClient.tsx`** — Main client component: program selector, language toggle, export menu, course merge logic, data loading orchestration
- **`src/components/TimelineVisualization.tsx`** — ~2400-line D3 component; renders SVG, handles focus mode, interactivity, and exports. This is where most feature work happens.
- **`src/components/OptionGroupModal.tsx`** — Modal for selecting from optional course groups (e.g., BSc thesis options)
- **`src/app/api/export-pdf/route.ts`** — Puppeteer-based PDF generation; uses `@sparticuz/chromium` on Vercel for serverless Chrome

### Data Files (`src/data/`)

- **`programs.json`** — Registry of 4 programs with metadata (data file, cosmetics file, study plan URL)
- **`<PROGRAM>.json`** — Course definitions: credits per period, prerequisites, exam dates (two formats: flat `exams: ["P2"]` or year-keyed `examsByYear: {1: ["P1"]}`)
- **`<PROGRAM>-cosmetics.json`** — Maps course codes to color family groups (blue/green/turquoise/brick/yellow)
- **`academic-periods.json`** — P1–P4 date ranges (lecture/exam/re-exam) for 2025–2026; converted to `Date` objects in `src/types/course.ts`
- **`kth-colors.json`** — KTH official color palette

### Types (`src/types/`)

- **`course.ts`** — `Course`, `Period`, `CourseCredit`, `OptionGroup` interfaces
- **`cosmetics.ts`** — `CourseGroup`, `ProgramCosmetics` interfaces

## Non-Obvious Details

**Course merge logic**: Course data can appear across multiple year entries with nested period credits. `HomeClient.tsx` deduplicates by course code, merges credits arrays, and attaches year metadata before passing to the visualization.

**Option groups**: `OptionGroup` is a special type for mutually exclusive course choices (e.g., thesis options). The cosmetics system treats them like courses for coloring; the modal lets the user pick which option to display.

**SVG export**: Embeds Figtree font CSS inline so the exported SVG renders correctly outside the browser.

**Vercel PDF export**: `vercel.json` sets 1800 MB RAM and 60s timeout for the PDF endpoint (Hobby plan limits). The `@sparticuz/chromium` binary must be bundled — configured via `serverExternalPackages` and `includeFiles` in `next.config.ts` and `vercel.json`.

**Build-time metadata**: `next.config.ts` injects `NEXT_PUBLIC_GIT_COMMIT_HASH`, `NEXT_PUBLIC_BUILD_TIMESTAMP`, and `NEXT_PUBLIC_REPO_URL` at build time.

## Tech Stack

- **Next.js 16** (App Router), **React 19** with React Compiler, **TypeScript 5** (strict)
- **D3.js 7** for all SVG rendering
- **Tailwind CSS 4**
- **Puppeteer-core + @sparticuz/chromium** for server-side PDF
