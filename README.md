# Program Visualization

This project is a small Next.js + TypeScript app that visualizes courses across academic years and periods. It draws horizontal course bars spanning study periods, stacks course credits vertically (15 ECTS = full year band), shows prerequisite arrows, and marks exams (filled circles) and re-exams (open circles).

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

Other hosts: Netlify or static exports (with limitations). See Next.js docs for deployment options.

## What files matter

Top-level (inside this folder):

- `package.json` — project manifest and scripts (dev, build, start).
- `tsconfig.json` — TypeScript configuration.
- `next.config.ts` — Next.js configuration.

Key source files

- `src/app/page.tsx` — main page that mounts the visualization component.
- `src/components/TimelineVisualization.tsx` — the D3 + React visualization. This file draws the SVG, course bars, arrows, and exam/re-exam markers.
- `src/types/course.ts` — TypeScript types (Course, Period, etc.) and the exported `academicPeriods` (loaded from JSON).

Data files (rendered at runtime)

- `src/data/courses.json` — primary course dataset. Each course includes fields such as `code`, `name`, `totalCredits`, `periodCredits` (P1–P4), `year`, `prerequisites`, and the generated `exams`/`reexams` arrays.
- `src/data/kth-colors.json` — KTH color palette used for fills/strokes in the visualization.
- `src/data/academic-periods.json` — academic period definitions (P1–P4) with `start`, `end`, `examStart`, `examEnd`, `reExamStart`, `reExamEnd` as ISO date strings. These are converted to Date objects in `src/types/course.ts`.

How data is consumed

- The app loads `courses.json` in the page layer and maps `periodCredits` into the internal `credits` arrays used by the visualization.
- `academic-periods.json` provides the timeline boundaries and exam/re-exam ranges. The visualization reads `academicPeriods` exported from `src/types/course.ts`.

Exam/re-exam markers

- By default each course has `exams` and `reexams` fields (arrays of period ids like `"P2"`) set to the exam period following the course's last study period.
- The visualization draws a filled circle (KTH brick color) for an exam and an open circle (stroke only) for a re-exam. Markers are positioned horizontally at the midpoint of the exam/re-exam period and vertically slightly above the course bar.

Troubleshooting

- Port 3000 already in use: find and kill the process `lsof -iTCP:3000 -sTCP:LISTEN -n -P` then `kill <PID>`.
- Suspended dev job (Ctrl+Z): resume with `fg` or start a background server with `nohup` as shown above.
- Type errors: run `npx tsc --noEmit` to see TypeScript diagnostics.

Next steps / enhancements

- Add interactive tooltips or a modal for course details (click behavior is planned but can be improved).
- Add a legend describing colors and marker semantics.
- Make the data loader dynamic (allow uploading JSON or selecting different academic years).

If you'd like I can add a small legend and tooltips for exam markers, or wire the visualization to fetch data from an external URL instead of the local JSON files.

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
