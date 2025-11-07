# Program Visualization

This project is a Next.js + TypeScript app that visualizes courses across academic years and periods. It draws horizontal course bars spanning study periods, stacks course credits vertically (15 ECTS = full year band), shows prerequisite arrows, marks exams (filled circles) and re-exams (open circles), and includes visual connectors for courses spanning consecutive periods. The app supports SVG and high-quality PDF export with proper font rendering.

## Quick start (development)

Prerequisites

- Node.js (>=18 recommended)
- npm (comes with Node)

Install and run locally:

```bash
# from the workspace folder containing this README
cd program-visualization
npm install
npm run dev
# open http://localhost:3000
```

Run the TypeScript checker:

```bash
cd program-visualization
npx tsc --noEmit
```

If the dev server appears suspended (e.g. you see `zsh: suspended npm run dev`), resume with `fg` in the same terminal or start fresh with `nohup npm run dev > /tmp/next-dev.log 2>&1 &` and check logs with `tail -f /tmp/next-dev.log`.

## Deploy

Recommended: Vercel (works well with Next.js). Create a GitHub repo and connect it to Vercel. Default build command `npm run build` and output directory are handled by Next.js.

**Important for Vercel deployment**: 
- The PDF export feature requires Puppeteer and a serverless-compatible Chrome binary. This is handled automatically by `@sparticuz/chromium-min`.
- The `vercel.json` file configures increased memory and timeout for the PDF generation endpoint.
- **Hobby Plan Limitation**: Vercel's Hobby (free) plan has a 1024MB default memory limit with a maximum of 2048MB for serverless functions. The configuration uses 1800MB to stay within this limit. If deployments silently fail from GitHub, check that the memory allocation in `vercel.json` is ≤2048MB.
- Pro plans support up to 3008MB which may improve performance for larger visualizations.

Other hosts: Netlify or static exports (with limitations). See Next.js docs for deployment options.

## What files matter

Top-level (inside this folder):

- `package.json` — project manifest and scripts (dev, build, start).
- `tsconfig.json` — TypeScript configuration.
- `next.config.ts` — Next.js configuration.

Key source files

- `src/app/page.tsx` — main page that mounts the visualization component.
- `src/app/HomeClient.tsx` — client-side wrapper for the visualization with program selector.
- `src/components/TimelineVisualization.tsx` — the D3 + React visualization (~2400 lines). This file draws the SVG, course bars with visual connectors for consecutive periods, prerequisite arrows, exam/re-exam markers, and handles SVG/PDF export.
- `src/app/api/export-pdf/route.ts` — API endpoint for server-side PDF generation using Puppeteer and `@sparticuz/chromium-min`.
- `src/types/course.ts` — TypeScript types (Course, Period, etc.) and the exported `academicPeriods` (loaded from JSON).
- `src/types/cosmetics.ts` — TypeScript types for program-specific visual customizations (colors, positions).

Data files (rendered at runtime)

- `src/data/programs.json` — list of available programs with their display names.
- `src/data/CTFYS.json`, `CTMAT.json`, `COPEN.json`, `CFATE.json` — program-specific course datasets. Each course includes fields such as `code`, `name`, `totalCredits`, `periodCredits` (P1–P4), `year`, `prerequisites`, and the generated `exams`/`reexams` arrays.
- `src/data/CTFYS-cosmetics.json`, etc. — program-specific visual customizations (colors, legend positions, course bar positions).
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
- **SVG Export**: Downloads the visualization as a vector SVG file with embedded fonts (Figtree from Google Fonts).
- **PDF Export**: Server-side PDF generation using Puppeteer with Chrome for perfect font rendering and vector graphics. Configured for Vercel deployment with `@sparticuz/chromium-min`.

**Tooltip Information**: Hover over courses to see total credits and per-period credit breakdown.

Troubleshooting

- Port 3000 already in use: find and kill the process `lsof -iTCP:3000 -sTCP:LISTEN -n -P` then `kill <PID>`.
- Suspended dev job (Ctrl+Z): resume with `fg` or start a background server with `nohup` as shown above.
- Type errors: run `npx tsc --noEmit` to see TypeScript diagnostics.
- PDF export not working on Vercel: Ensure `vercel.json` is deployed with the project and `@sparticuz/chromium-min` is in dependencies.

## Dependencies

Key production dependencies:
- `next` (16.x) — React framework
- `react` (19.x) — UI library
- `d3` (7.9.x) — Visualization and data manipulation
- `puppeteer-core` (23.x) — Headless browser control for PDF generation
- `@sparticuz/chromium-min` (141.x) — Serverless-compatible Chrome binary for Vercel

Development dependencies include TypeScript, ESLint, and Tailwind CSS.

## Configuration Files

- `vercel.json` — Vercel deployment configuration with increased memory (1800MB for Hobby plan, can be increased to 3008MB on Pro) and timeout (60s) for the PDF export API route.
- `tsconfig.json` — TypeScript configuration.
- `next.config.ts` — Next.js configuration.
- `package.json` — Project manifest and scripts (dev, build, start).

---

If anything in this README is out-of-date with the code, tell me and I'll update the file accordingly.
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.