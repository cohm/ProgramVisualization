# Program Visualization

This project is a Next.js + TypeScript app that visualizes courses across academic years and periods. It draws horizontal course bars spanning study periods, stacks course credits vertically (15 ECTS = full year band), shows prerequisite arrows, marks exams (filled circles) and re-exams (open circles), and includes visual connectors for courses spanning consecutive periods. The app supports SVG and high-quality PDF export with proper font rendering.

## Quick start (development)

Prerequisites

- Node.js (>=20 recommended; CI runs on Node 20)
- npm (comes with Node)

Install and run locally:

```bash
# from the workspace folder containing this README
cd program-visualization
npm install
npm run dev
# open http://localhost:3000
```

Other useful commands (all of these also run in CI):

```bash
npm run lint            # ESLint (max-warnings 0)
npm run validate-data   # Schema + cross-reference checks for src/data/*.json
npx tsc --noEmit        # TypeScript diagnostics without emitting
npm run build           # Production build
```

If the dev server appears suspended (e.g. you see `zsh: suspended npm run dev`), resume with `fg` in the same terminal or start fresh with `nohup npm run dev > /tmp/next-dev.log 2>&1 &` and check logs with `tail -f /tmp/next-dev.log`.

## Deploy

Recommended: Vercel (works well with Next.js). Create a GitHub repo and connect it to Vercel. Default build command `npm run build` and output directory are handled by Next.js.

**Important for Vercel deployment**: 
- The PDF export feature requires Puppeteer and a serverless-compatible Chrome binary. This is handled automatically by `@sparticuz/chromium`.
- The `vercel.json` file configures increased memory and timeout for the PDF generation endpoint.
- **Hobby Plan Limitation**: Vercel's Hobby (free) plan has a 1024MB default memory limit with a maximum of 2048MB for serverless functions. The configuration uses 1800MB to stay within this limit. If deployments silently fail from GitHub, check that the memory allocation in `vercel.json` is ≤2048MB.
- Pro plans support up to 3008MB which may improve performance for larger visualizations.

Other hosts: Netlify or static exports (with limitations). See Next.js docs for deployment options.

## What files matter

Top-level (inside this folder):

- `package.json` — project manifest and scripts (dev, build, start, lint, validate-data, extract-plan, size).
- `tsconfig.json` — TypeScript configuration.
- `next.config.ts` — Next.js configuration.
- `STUDY-PLAN-CONVENTIONS.md` — observations on how study plans differ between KTH schools, gathered while building the extractor.

Scripts

- `scripts/extract-from-kopps.mjs` — builds a cohort's study plan from KTH's published data. Pure Node, no extra dependencies. See `CLAUDE.md` for the full picture and `--help` for options. It also writes `prerequisite-review/<PROGRAM>.md`: a worklist for the program director covering every cohort, where each judgement links the course page and the exact kursplan PDF it was read from, so it can be signed off by clicking rather than by reading data files.
- `scripts/validate-data.mjs` — schema and cross-reference checks for everything in `src/data`, including the per-period full-time load check. Runs in CI.

Key source files

- `src/app/page.tsx` — main page that mounts the visualization component.
- `src/app/HomeClient.tsx` — client-side wrapper for the visualization with program selector.
- `src/components/TimelineVisualization.tsx` — the D3 + React visualization (the largest file in the project). Draws the SVG, course bars with visual connectors for consecutive periods, prerequisite arrows, exam/re-exam markers, focus-mode interactions, and handles SVG/PNG/PDF export. The option-group selection modal is inlined at the bottom of this file.
- `src/components/Legend.tsx`, `InfoPanel.tsx`, `OptionGroupModal.tsx`, `SpecializationFilter.tsx`, `Toast.tsx` — supporting UI pieces.
- `src/app/api/export-pdf/route.ts` — API endpoint for server-side PDF generation using Puppeteer and `@sparticuz/chromium`.
- `src/types/course.ts` — TypeScript types (Course, Period, etc.) and the exported `academicPeriods` (loaded from JSON).
- `src/types/cosmetics.ts` — TypeScript types for program-specific visual customizations (colors, positions).
- `REVIEW.md` — open issues, design discussion, and the ranked improvement backlog. Worth skimming before larger changes.

Data files (rendered at runtime)

- `src/data/programs.json` — list of available programs with their display names, optional inriktningar (specializations), and a study-plan URL. Two flags control visibility: `verified: false` hides a plan behind the "show unverified" checkbox, while `disabled: true` withdraws it from the UI entirely (not in the dropdown, not reachable via `?program=`).
- `src/data/<PROGRAM>.json` — program-specific course datasets (CTFYS, CTMAT, CFATE, COPEN, CINEK; CMAST and CMATD load a cohort file directly). Each course includes fields such as `code`, `name`, `totalCredits`, `periodCredits` (P1–P4, either flat per-year or by-year for multi-year courses), `year`, `prerequisitesCompleted` / `prerequisitesParticipation`, and the `exams`/`reexams` arrays. Programs may also include `optionGroup` entries for course-choice slots and `electivePlaceholder` entries for the space reserved for valfria kurser.
- `src/data/cohorts/<PROGRAM>-HT<year>.json` — per-admission-cohort study plans, one file per cohort (**HT2022–HT2026**), each opening with a `cohortMeta` entry that records where every study year's data came from. Selected in the UI via `?cohort=HT2023`. `cohorts/index.json` lists what is available per program and is regenerated from disk by the extractor. The archive is committed on purpose: KTH deletes each läsår as it passes, so HT2022 is already gone from the source entirely and every one of its years is reconstructed from a later cohort.
- `src/data/<PROGRAM>-cosmetics.json` — per-course color-family assignments (capped at 5 families).
- `src/data/kth-colors.json` — KTH color palette used for fills/strokes in the visualization.
- `src/data/academic-periods.json` — academic period definitions (P1–P4) with `start`, `end`, `examStart`, `examEnd`, `reExamStart`, `reExamEnd` as ISO date strings. These are converted to Date objects in `src/types/course.ts`.

How data is consumed

- The app loads program-specific JSON files based on user selection and maps `periodCredits` into the internal `credits` arrays used by the visualization.
- `academic-periods.json` provides the timeline boundaries and exam/re-exam ranges. The visualization reads `academicPeriods` exported from `src/types/course.ts`.
- Cosmetics files provide program-specific visual customizations (colors, positions) that override defaults.

Exam/re-exam markers

- By default each course has `exams` and `reexams` fields (arrays of period ids like `"P2"`) set to the exam period following the course's last study period.
- The visualization draws a filled circle (KTH brick color) for an exam and an open circle (stroke only) for a re-exam. Markers are positioned horizontally at the midpoint of the exam/re-exam period and vertically slightly above the course bar.

## Key Features

**Visual Connectors**: Courses spanning consecutive periods in the same year show visual connector fills between their bars, creating a unified appearance. Only the first bar in a sequence displays the course label.

**Interactive Focus Mode**: Click any course to highlight it and show detailed information in an expanding info box at the bottom. Focus mode dims other courses and shows only the selected course's prerequisite arrows and connectors.

**Layer Visibility Toggle**: The legend allows toggling visibility of different visual layers (course bars, borders, connectors, arrows, exam markers, etc.).

**Export Functionality**:
- **SVG Export**: Downloads the visualization as a vector SVG file with embedded Figtree font CSS so the file renders correctly outside the browser.
- **PNG Export**: Rasterises the on-screen SVG to a high-DPI PNG entirely in the browser.
- **PDF Export**: Server-side PDF generation using Puppeteer with Chrome for perfect font rendering and vector graphics. Configured for Vercel deployment with `@sparticuz/chromium`.

**Tooltip Information**: Hover over courses to see total credits and per-period credit breakdown.

**Bilingual UI** (Swedish/English): Toggle from the export menu. The choice is reflected in the URL (`?l=sv` or `?l=en`).

**Shareable URL state**: The selected program, admission cohort, language, hidden layers, specialization filter, and option-group picks are mirrored into the query string so a particular view can be linked or bookmarked — e.g. `?program=CTFYS&cohort=HT2023&l=sv`.

**Cohort view**: A student picks their admission year (HT2022–HT2026) and sees the plan as they will study it, rather than one calendar läsår sliced across three cohorts. Because KTH publishes only the läsår currently being taught and the next one, years missing for a cohort are borrowed from the nearest cohort that has them; a line under the selectors says which years are approximated, with per-year detail and a link to KTH's published plan behind an info affordance. The oldest cohorts lean on this most: HT2022 has been removed from KTH's pages altogether, so all of its years are borrowed and reported with `unknown` confidence.

**Elective space**: Where a period falls short of full-time (15 hp), the plan shows a "Plats för valfri kurs" placeholder sized to the shortfall, in yellow.

**Specializations (inriktningar) and option groups**: Programs that split their bachelor years by inriktning (e.g. CINEK) get a SpecializationFilter UI that AND-filters courses across spec groups. Course-choice slots (e.g. thesis-track options) are modelled as `optionGroup` entries and rendered with a striped pattern; clicking opens a selection modal.

Troubleshooting

- Port 3000 already in use: check what is listening with `lsof -iTCP:3000 -sTCP:LISTEN -n -P`, or just start on another port with `npm run dev -- --port 3100`. Note that on macOS a second server can bind `*:3000` while an existing one holds `[::1]:3000` — both appear to start, but `localhost:3000` reaches the first one.
- Suspended dev job (Ctrl+Z): resume with `fg` or start a background server with `nohup` as shown above.
- Type errors: run `npx tsc --noEmit` to see TypeScript diagnostics.
- PDF export not working on Vercel: Ensure `vercel.json` is deployed with the project and `@sparticuz/chromium` is in dependencies.

## Dependencies

Key production dependencies:
- `next` (16.x) — React framework
- `react` (19.x) — UI library
- `d3` (7.9.x) — Visualization and data manipulation
- `puppeteer-core` (25.x) — Headless browser control for PDF generation
- `@sparticuz/chromium` (141.x) — Serverless-compatible Chrome binary for Vercel

The study-plan extractor deliberately adds no dependencies — it runs on plain Node
with `fetch`, so it works in a checkout with no `node_modules` at all.

Development dependencies include TypeScript, ESLint, and Tailwind CSS.

## Configuration Files

- `vercel.json` — Vercel deployment configuration with increased memory (1800MB for Hobby plan, can be increased to 3008MB on Pro) and timeout (60s) for the PDF export API route.
- `tsconfig.json` — TypeScript configuration.
- `next.config.ts` — Next.js configuration.
- `package.json` — Project manifest and scripts (dev, build, start, lint, validate-data, extract-plan, size). The `size-limit` budget covers every static chunk, which includes the committed cohort archive — see the note in `.github/workflows/ci.yml` before assuming a failure means the app grew.

## License & data attribution

The source code in this repository is released under the MIT License — see [LICENSE.md](LICENSE.md). You're welcome to use, fork, and adapt it; please keep the copyright notice intact.

The course data in `src/data/` was compiled from KTH's publicly available study plans (utbildningsplaner) and is included here for visualisation purposes only. The underlying programme content belongs to KTH and is not covered by this repository's license. If you reuse the app for another institution or programme, please replace the data files with your own source.