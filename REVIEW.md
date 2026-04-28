# Program Visualization — Code Review

**Date:** 2026-04-28
**Reviewer:** Code review pass covering usability, data-model robustness,
performance, and alignment with KTH steering documents.
**Scope:** All files under `src/`, `next.config.ts`, `vercel.json`,
`.github/workflows/ci.yml`, the four program JSON datasets, and
`academic-periods.json`. KTH guidelines consulted:
- *Riktlinje om utbildningsplan för program på förberedande nivå, grundnivå och
  avancerad nivå* (V-2018-0608)
- *Riktlinje om kursplan, betygssystem och examination inom alla
  utbildningsnivåer* (V-2020-0650, senast ändrad HS-2026-0045)
- *Riktlinje om läsårets förläggning och planering* (V-2019-0109)

---

## Executive summary

The app is a focused, well-styled D3 visualization that already covers a lot of
ground (bilingual UI, four programs, three export formats, prerequisite
routing, focus mode, course groups, option groups). The biggest leverage points
for the next round of work are:

1. **Split `TimelineVisualization.tsx` (3 145 lines) into smaller modules.**
   It is the single largest source of friction for further changes; almost
   every issue below requires touching it.
2. **Tighten the data model** so that the four program JSON files describe
   what the KTH study plan actually requires (course category, course groups
   with credit thresholds, course level, language, grading scale, free
   electives, specializations) instead of just "course → period → credits".
3. **Stop full SVG redraws on UI-only state changes** (focus year, layer
   toggles). The infrastructure is partly there — finish migrating to
   post-render style updates.
4. **Add a JSON Schema + a build-time validator** that catches the silent
   merge / dangling-prerequisite / total-credit-mismatch bugs the data files
   are exposed to today.
5. **Decide what to do with re-exam semantics**, which currently look
   inconsistent with the *Riktlinje om läsårets förläggning* (see §4.3).

The rest of the document expands on each of these.

---

## 1. Usability

### 1.1 Discoverability

- **Hamburger icon for the export/language menu is misleading.** A three-line
  "menu" icon (`HomeClient.tsx:351-355`) usually means "main navigation". The
  menu actually contains only Export and Language. A more telling icon
  (e.g. ⤓ for download, or a labelled "Exportera ▾" button) and an explicit
  language switch in the header would be clearer.
- **Year labels and course bars are clickable but invisible as such.** There
  is no hover affordance on year labels (`TimelineVisualization.tsx:1693-1715`)
  — the cursor flips to `pointer`, but no underline, color shift, or tooltip
  hints that "click year for focus mode" exists. Same for the focus mode on
  individual course bars. A short hint line below the chart, or a `?` legend
  entry, would help.
- **Empty info-panel state is literally empty** (`:2902-2906`), so first-time
  users see a blank box and don't know what produces content there. A
  one-line placeholder ("Klicka på en kurs för detaljer / Click a course for
  details") would be cheap and effective.
- **The legend doubles as a layer-toggle, but does not say so.** Hovering an
  item should explain "click to hide layer".
- **Option groups: the small numbered circle on the bar** (`:1543-1574`) is
  a nice cue that "this is a choice", but only after you've discovered the
  pattern. A short tooltip on the circle ("välj 1 av N alternativ") would
  remove guesswork.

### 1.2 Sharing & state persistence

The URL only carries `program` and `l` (`HomeClient.tsx:270-307`). Things
that are not in the URL but that the user would obviously want to share or
preserve:

- The currently chosen option per option-group
  (`selectedOptionPerGroup`, `:170-172`).
- The set of disabled layers (`layers`, `:665-681`).
- The focused course / focused year.

Persisting these to query params would let teachers/students bookmark or
e-mail "the CTFYS year-3 view with KEX = SA114X and arrows hidden". A
single base64-encoded `view=` parameter is enough; no need for one param per
toggle.

### 1.3 Responsive layout & mobile

- The chart container has `min-height: 600px` and no max-width
  (`:2728`). On a 320 px phone the chart compresses to the point where labels
  and arrows overlap badly; on a 4 K monitor it stretches.
- The legend is positioned absolutely with fixed pixel offsets
  (`STYLE.legend.offsetX = 85`, `:41`). On phones it overlaps the chart area.
- The tooltip is positioned with `event.pageX + 50, event.pageY + 50`
  (e.g. `:933`); near the right/bottom edge of the screen the tooltip flows
  off-screen with no clamping.
- Touch devices have no `mouseover`/`mouseout`; the tap-to-tooltip pattern is
  not implemented.

### 1.4 Accessibility

- The SVG is the entire chart and has no role/labelling. Screen readers will
  read it as a generic graphic. At minimum, set `role="img"` and a
  human-readable `<title>` / `<desc>` describing program + year count.
- All clickable course bars are `<rect>` with `cursor: pointer`, no
  `tabindex`, no `aria-label`, no keyboard event handlers. They cannot be
  used with keyboard or assistive tech.
- Layer toggles in the HTML legend are `<div onClick>` with no
  `role="button"`, no `tabIndex`, no keyboard handlers (`:2734-2790`).
- Color-only encoding for course groups creates problems for color-blind
  users. The pattern fill used for option groups (`:752-769`) is a good
  pattern — a similar distinct *shape* cue (e.g. corner badge) per group
  would help users who cannot rely on hue.
- The 🇸🇪/🇺🇸 flags as language switch (`:382-383`) are awkward: emoji flags
  do not render on Windows, an "🇺🇸" flag is a strange choice for English at a
  Swedish university (📕 EN / 🇬🇧 / "EN" textual switch would be more neutral).

### 1.5 Smaller UX nits

- **Hard-coded Swedish/English in the option-group modal.** "Show group" /
  "Hide group" tooltip strings (`:2811`), "Totalt poäng:" / "Total credits:"
  (`:2982`), "Choose" / "Välj" (`:3040`), "Cancel" / "Avbryt" (`:3070`) all
  use ad-hoc inline ternaries instead of going through `tr[language]`. Move
  them into the `tr` tables for consistency.
- **`alert('PDF export failed: ' + errorText)`** (`:596`, `:611`) — the
  server response on a 5 MB SVG can be large; alerts are a poor UI surface
  and the raw error leaks to the user. Replace with an inline toast or a
  small dialog.
- **No "reset to defaults" affordance** for layers/option choices/focus.
- **No undo** when an option-group selection accidentally replaces the
  group.
- **Comment `programComment`** is duplicated at the bottom of the page and
  again on the export — fine, but if the JSON doesn't supply a comment, the
  exported SVG also has no audit/version footer at all. Consider always
  printing the program code, KTH commit hash, and date in the export footer.
- **Tooltip uses HTML strings built by string concat** (e.g. `:1212-1215`,
  `:1393-1396`). Course/group names from JSON go straight into `.html(...)`
  with no escaping. A `<` in a future course name would break the tooltip
  (and is a latent XSS vector — see §3.4).
- **`console.warn` in production** (`HomeClient.tsx:75`,
  `TimelineVisualization.tsx:508`, `:595`, `:610`). Mostly fine, but the
  cosmetics-load failure surfaces only to the console; the user sees no
  group colors and no warning.
- **Stale `CLAUDE.md`.** `OptionGroupModal.tsx` no longer exists — the
  modal logic was inlined into `TimelineVisualization.tsx` (~`:2916-3140`).
  Update the doc.

---

## 2. Robustness — data model for programs

The JSON files are the spec for what the tool can show; gaps in the model
limit what real KTH study plans you can express.

### 2.1 Missing course categories

KTH's *Riktlinje om utbildningsplan* (V-2018-0608) requires a study plan to
classify each course as one of:

- **Obligatorisk** (mandatory)
- **Villkorligt valbar** (conditionally elective, with a credit threshold per
  group)
- **Valfri** (free elective)
- **Rekommenderad** (recommended)

The `Course` type (`src/types/course.ts:31-52`) has no `category`/`type`
field. Today the visualization treats every course identically and only knows
"in option group" or "not". This means:

- `XY123Z`, `XY456Z` (`CTFYS.json:591-627`) are real, free-elective
  *placeholders* with name "Plats för valfri kurs", but the data model has no
  way to mark them as such. They are currently shown as opaque yellow
  bars with prerequisites — visually indistinguishable from a real
  obligatoriska kurs.
- The `(valfri)` suffix in `DD1301`'s name (`CTFYS.json:193`) is the
  workaround. This belongs in a structured field.
- Courses can't be color-coded or filtered by category, even though that's
  often what students want to see ("just show me the obligatory ones").

**Recommendation.** Add an enum:

```ts
type CourseCategory =
  | 'mandatory'           // obligatorisk
  | 'conditionallyElective' // villkorligt valbar
  | 'electivePlaceholder' // valfri – plats för
  | 'recommended';        // rekommenderad
```

Default to `mandatory` for backwards compatibility. Use it to drive a
filter/legend toggle and a visual variation (e.g. dashed border for
recommended, hatched fill for placeholder).

### 2.2 Option groups are too narrow

`OptionGroup` (`src/types/course.ts:18-29`) hard-wires `allowedNumberOfOptions`
and uses one set of credits for the *group* — i.e. only "pick exactly 1 course
from this list, all options have the same period layout". This works for
*Kandidatexamensarbete* (`CTFYS.json:540-555`, all options are 15 hp split
P3+P4). It cannot express the more general KTH "kursgrupp" pattern:

> "Välj kurser om minst 30 hp ur följande grupp" — pick courses for *at
> least* 30 hp from this group, periods/credits per option vary.

**Recommendation.** Replace `allowedNumberOfOptions` with a richer
description:

```ts
interface CourseGroup {
  kind: 'pickN' | 'minCredits' | 'minCoursesAndCredits';
  pickN?: number;          // välj N kurser
  minCredits?: number;     // minst X hp
  ...
}
```

and let the visualization render either as today (when one option must be
picked and all options share a layout) or as a placeholder block sized to the
required credit total (when multiple options can be combined).

### 2.3 Re-exam semantics are confusing

`Course.reexams: Period['id'][]` (`src/types/course.ts:45`) and the JSON
field `"reexams": ["P1"]` mean *"this course's re-exam is in the P1 re-exam
slot"*, not *"the re-exam happens during P1"*. The actual date of that slot is
`academicPeriods[0].reExamStart` = **2025-12-15** — i.e. between P1 and P2.

This naming contradicts the *Riktlinje om läsårets förläggning*, §1.1
("Omprov finns inte i period 1") — there is no re-exam period inside P1
at all. New readers consistently misread this.

**Recommendation.** Either:

- Rename the field to `reexamSlot` / `reexamFor`, or
- Better: store re-exam scheduling implicitly (drop the field, let the
  application compute it from `exams` plus the academic-periods rules), since
  the *Riktlinje* already prescribes the slot per exam period.

### 2.4 Multiple, undocumented data shapes for `periodCredits`/`exams`

`HomeClient.tsx:80-228` quietly accepts two shapes:

- *Flat:* `"periodCredits": { "P1": 3, "P2": 3, ... }` plus a top-level
  `"year": 1` (used in `CTFYS.json`, `CFATE.json`, most of `CTMAT.json`).
- *Year-keyed:* `"periodCredits": { "Year1": { "P1": ... }, "Year2": ... }`
  plus an optional `"exams": { "Year1": ["P2"], "Year2": ["P4"] }`
  (used by `SA1006` in `CTMAT.json:172-220`).

There is no schema, no documentation, and no validator. The merge logic
(`HomeClient.tsx:88-191`) is ~140 lines of `if`/`else` that future
contributors will not enjoy. Concrete consequences:

- If a course is listed twice with the same code (e.g. by accident in
  copy-paste), credits are *summed silently* (`HomeClient.tsx:150`). A
  duplicate `SF1672` row with `P2: 7.5` would render as `P2: 15` with no
  warning.
- A flat `"prerequisites": [...]` is silently dropped if
  `prerequisitesCompleted` is also non-empty (`:215`). In a hand-edited
  JSON file that is easy to do without realising.
- A year-keyed `exams` object is recognised by *not* being an array
  (`:130-134`); a JSON typo (`"exam"` vs `"exams"`) goes through unnoticed.

**Recommendation.**

- Pick one shape (the year-keyed nested form is strictly more expressive)
  and migrate the flat files. Keep a small one-time script to do the
  conversion.
- Add a JSON Schema (e.g. `src/data/program.schema.json`) and a `npm run
  validate-data` script (`ajv-cli`) that runs in CI. This is the
  cheapest single change that improves robustness.
- In the validator, catch:
  - Duplicate `code` within a file.
  - `Σ periodCredits ≠ totalCredits` per (course, year).
  - Prerequisites that reference a code not present in the file.
  - Option-group `options[]` referencing missing course codes.
  - Option-group `Σ periodCredits = totalCredits`.
  - Exam/re-exam period IDs not in the academic-periods set.
  - At least one exam slot per `läsår` (KTH: minst två tentamenstillfällen
    — see §4.3).

### 2.5 No specialization (inriktning) support

The *Riktlinje om utbildningsplan* explicitly requires a "kurslista för
årskurser och eventuella inriktningar" (course list per year *and per
specialization*). A `Course` has no `inriktning?: string[]` field, so the
tool can't render only "Astrofysik"-track courses for CTFYS, only
"Beräkningsmatematik"-track courses for CTMAT, etc. For the master years
(Y4–Y5), inriktningar are the *primary* organising principle.

**Recommendation.** Add an optional `tracks?: string[]` per course and a
`tracks: { code, name, nameEn }[]` registry per program. The UI gains a
track filter / multi-select; rendering filters out non-track courses.

### 2.6 Master years (Y4–Y5) effectively unsupported

The civilingenjör programs are 5-year, 300 hp. All four data files stop at
year 3 (the "kandidat" portion ending with KEX). The code computes
`numYears` dynamically (`TimelineVisualization.tsx:784-791`), so adding
year 4–5 is mechanically possible — but:

- Y4–Y5 are organised around *masterprogram* (TKEMM, TIMBM, etc.), not the
  civilingenjör code; you'd need another linkage layer.
- Y4–Y5 contain mostly conditionally elective courses — see §2.1, §2.2.
- The `programs.json` registry lists only one `studyplan` URL per program;
  a 5-year program has separate study plans for the bachelor's and each
  master's option.

This is a real limitation if the goal is "the full program".

### 2.7 Other missing course-syllabus fields (per *Riktlinje om kursplan*)

The kursplan riktlinje (V-2020-0650 §1.1.1) requires fields the tool does
not model:

| KTH kursplan field | Modelled? |
|---|---|
| Kurskod | yes (`code`) |
| Benämning sv/en | yes (`name`/`nameEn`) |
| Omfattning (hp) | yes (`totalCredits`) |
| Kursnivå (grundnivå/avancerad nivå) | **no** |
| Mål | **no** |
| Krav på särskild behörighet | partial (only as course codes) |
| Examination | partial (only period) |
| Betygssystem (A–F / P–F / VG-G-U) | **no** |
| Kursinnehåll | **no** (`description` is free text, optional) |
| Huvudområde | **no** |
| Undervisningsspråk | **no** |
| Kursomgång (kurs-PM) | **no** |

You don't need to render all of these, but the data model should at least
*hold* them so the JSON can act as a single source of truth and the UI can
opt into showing them later. A concrete near-term win: showing the course
level (G/A) as a small `G`/`A` badge would matter for the masters years.

### 2.8 Prerequisites are tied to specific course codes only

`prerequisites` / `prerequisitesCompleted` / `prerequisitesParticipation` are
all `string[]` of *course codes* in the same program file
(`HomeClient.tsx:1867`, `:1890` resolves them by code). KTH's "särskild
behörighet" can also be:

- A general competency ("Matematik 4 från gymnasiet"),
- "Minst N hp inom huvudområde X",
- Cross-program prerequisites (a course not in this file),
- Boolean expressions ("(SF1672 OR SF1681) AND DD1331").

For now everything resolves to "AND of these courses by code". When a
prerequisite code isn't found, `find(...)` quietly returns `undefined` and
the arrow is skipped silently (`:1867-1874`). Add a build-time warning at
minimum, and ideally a structured prerequisite type.

### 2.9 `getFamilyVariants` is a no-op-with-extra-steps

`TimelineVisualization.tsx:64-89` returns *exactly one* variant per family
(an array of length 1). The variant-selection arithmetic at `:194-202`
(`baseIndex % variants.length`, hash-on-code fallback) therefore always
selects element 0. Either:

- Restore the multi-variant palette so that courses inside a group get
  shaded by index (the original intent), or
- Drop the function and inline `getColorForFamily`.

Today the function adds complexity and zero behaviour.

### 2.10 Cosmetics: only 5 color families

`CourseGroup.colorFamily` is a literal union of five values
(`src/types/cosmetics.ts:4`). CTMAT already uses 3 of them; CFATE uses 5
(every available color). A 5th and 6th group cannot be added without
extending `kth-colors.json` and the family enum. Either prepare to add new
families now, or document the limit.

---

## 3. Performance

### 3.1 Full SVG rebuild on every state change in the main effect

The main `useEffect` (`TimelineVisualization.tsx:702-2442`) clears the SVG
(`svg.selectAll('*').remove()`, `:732`) and rebuilds ~2 000 D3 calls every
time any of these change:

```
[courses, layers, language, selectedOptionPerGroup, focusYear,
 cosmetics, programCode, programName, studyplanUrl, getCourseColors]
```

Several of those should *not* trigger a rebuild:

- `layers` only affects which elements are visible — `display`/`opacity`
  toggling is already done in a *second* effect (`:2447-2517`), which runs
  *after* the rebuild. So layer changes pay for a full rebuild *and* a style
  pass. Drop `layers` from the main effect's deps.
- `focusYear` is also handled by a separate post-render effect
  (`:2649-2719`); the main effect uses it only to bold the year label
  (`:1712-1714`). That can be done in the same post-render pass. Drop it
  from the main deps.
- `programName` / `studyplanUrl` rarely change without `programCode`
  changing too; if they did, a redraw would trigger anyway because of
  `cosmetics`. They can be removed from deps.
- `getCourseColors` is recreated whenever `cosmetics` changes
  (`:194-202`), which is the only thing that should drive its identity.
  Already wrapped in `useCallback`, so this is fine — listing both
  `cosmetics` and `getCourseColors` is redundant.

Rough impact: today, toggling a single legend layer triggers ~4 000 D3
operations and a full DOM re-paint of every course bar. Removing the deps
above brings that down to a few hundred style mutations.

### 3.2 Per-element D3 listeners

Every course bar gets its own `mouseover`/`mousemove`/`mouseout`/`click`
handler (`:1363-1456`), and again on each connector polygon (`:1242-1267`).
For ~50 courses + connectors that is hundreds of listeners; for a 5-year
program with ~100 courses it doubles. Plus, the tooltip HTML is rebuilt
inside each `mouseover` from the same template as elsewhere
(`:1366-1416` is a near-duplicate of `:1184-1233`).

**Recommendation.** Use event delegation: a single listener on the SVG
root that reads `data-course` from `event.target` and looks up the
metadata. Build the tooltip text once per `(course, period)` and cache it
in a `Map`. This both shrinks the per-render work and removes a chunk of
duplicated code.

### 3.3 O(n²) lookups in arrow routing

In `:1857-1910` each arrow does
`individualCourses.find(c => c.code === prCode)`. With ~50 courses and ~80
arrows this is fine, but build a `Map<code, Course>` once outside the loop
to make the cost linear in arrow count. Same for the dependents lookup at
`:1192-1196`, `:1373-1378`, `:2603-2609`, `:2883-2887`.

### 3.4 Tooltip HTML uses string interpolation with raw data

`:1212`:

```js
tooltipText = `<strong>${course.code}, ${totalCredits} ${tr[language].credits}</strong><br/>${courseName}<br/>...`;
```

`courseName` is a JSON value. Today no course has `<` or `&` in it, but
nothing prevents that; XSS via tooltip is a real possibility if data ever
comes from less-trusted sources (e.g. fetched from a course-catalog API).
Use `textContent` for the dynamic parts or escape before interpolation.

### 3.5 Export pipeline

- **Font fetch on every PNG/SVG/PDF export** (`:235-281`). The Google Fonts
  CSS + each woff2 file is fetched fresh. Cache the data-URLs in a
  module-level `Map<fontFamily, string>` keyed by family + weight set;
  export becomes near-instant on subsequent runs.
- **`getComputedTextLength()` truncation loop** (`:1604-1612`) is O(label
  length) per label and synchronously triggers layout on each iteration.
  For long names this can be ~50 layout reflows per label × ~50 labels =
  2 500 reflows on first render. Use `d3.scaleLinear` over the label width
  / character ratio and binary-search instead.
- **The cloned SVG retains the full DOM, including invisible/hidden
  elements** (`:216`). For PDF export the cloned SVG is then serialised and
  POSTed to `/api/export-pdf`; consider pruning hidden layers and any
  `<g>` whose `display: none` is set, and dropping `data-*` attributes
  before serialising. This shrinks the payload (helps the 10 MB cap in the
  API) and reduces the PDF rendering time.
- **PDF API uses `waitUntil: 'networkidle0'`** (`route.ts:75`). Since the
  HTML you POST is fully self-contained except for the Google Fonts
  `@import url(...)` (`route.ts:555` is on the *client* side; the server
  HTML at `:550` also has an `@import`), `networkidle0` will wait for the
  fonts. That's fine, but in serverless-cold-start conditions the entire
  request can be dominated by font-fetch latency. Pre-embed the font as
  base64 in the HTML you POST (you already fetch+embed for SVG export at
  `:243-274`, just reuse that), and use `waitUntil: 'load'`.
- **Browser is launched per request** (`route.ts:63-69`). On Vercel the
  cold-start of `@sparticuz/chromium` is ~2–4 s. Consider caching the
  `Browser` instance across invocations using a module-level `let
  cachedBrowser`. It is safe within one warm Lambda; the
  `finally { browser?.close(); }` would just become a no-op until the
  Lambda dies. (Watch: only one inflight request per Lambda may safely
  reuse one Browser; concurrency settings need to match.)
- **Memory: 1800 MB** is a lot of headroom; if the optimisations above
  bring per-request RAM down, you can drop to 1024 MB on the Hobby plan
  and avoid the cap entirely.

### 3.6 Webpack dynamic imports bundle every program's JSON

`await import(`@/data/${dataFile}`)` (`HomeClient.tsx:67`, `:82`) — Webpack
sees a non-static import path and bundles *all* JSON files matching the
pattern. That's how the chunk reaches the user without a network round
trip on switch, but it also means every visitor downloads CTFYS + CTMAT +
CFATE + COPEN data even if they only ever look at one. For the current
~50 KB total this is fine; if data files grow (Y4–Y5, more programs),
reconsider.

### 3.7 React Compiler and stable inputs

`reactCompiler: true` (`next.config.ts:49`) means React Compiler will memo
many things automatically. But it can only memo things whose inputs are
referentially stable. `STYLE`, `tr`, `defaultColor` etc. are all
module-level — good. `getCourseColors` is `useCallback`-wrapped — good.
`courses`, `cosmetics` come from state, so they get new identities on
every fetch — fine, but be aware that React Compiler is doing real work
here; don't add inline object literals to props (`HomeClient.tsx:391-401`
already keeps these clean).

### 3.8 Smaller perf nits

- `containerRef.current.querySelector('.pv-tooltip')` is removed and
  re-added on every redraw (`:708-719`). A single `useRef` for the tooltip
  div would do.
- Several `Object.entries(slotsByYearPeriod)` iterations
  (`:1037-1041`, `:1059`, `:1292`) over the same data. Build the result
  once and pass through.
- Re-parsing `Date` from the period objects in inner loops
  (`new Date(periodObj.lectureEnd)` at `:1077`, `:1333`); the
  `academicPeriods` already store `Date` objects.

---

## 4. Alignment with KTH steering documents

Things that the regelverk says, that affect this tool.

### 4.1 *Riktlinje om utbildningsplan* (V-2018-0608)

Required content of an utbildningsplan:

- Programmet's name in **both Swedish and English** — already supported.
- The cohort the plan applies to (which year admitted) — not modelled.
- Goals (kunskap, färdigheter, värderingsförmåga) — not modelled.
- Scope and content — partial (course list).
- Eligibility and selection — not modelled.
- Implementation: structure, courses, **grading system**, conditions for
  participation, thesis, exam — partial.
- **Course lists per year and per inriktning** — only per year today
  (see §2.5).
- **Description of inriktningar** — not modelled.

The riktlinje also says: *"Utbildningsplan ska inte innehålla länk eller
hänvisa till styrdokument/webbsida"*. The visualization is **not** the
study plan, so it's fine that the app links out to e.g.
`kth.se/student/kurser/...` from the title (`:898-906`) and from the info
panel (`:2836-2844`). But: if someone in the future wants to use this tool
*to render a formal utbildningsplan*, those links would need to be hidden
in that mode. Worth keeping in mind.

### 4.2 *Riktlinje om kursplan, betygssystem och examination* (V-2020-0650)

- An obligatorisk kurs *bör omfatta minst sex högskolepoäng*. The data has
  several < 6 hp courses, e.g. `DD1310` (6 — at the limit), `DD1301`
  (1.5 — but this is `valfri`), `KD1000` (3), `SK1105` (4), `SI1146` (4),
  `SI1200` (4). The validator could flag mandatory courses below 6 hp as a
  warning, once category is in the model (§2.1).
- The kursplan must specify **betygssystem (A–F / P–F / VG-G-U)**. Showing
  this in the info-panel (e.g. a small `A–F` badge) would be a small,
  high-value addition.
- Two-grade scale (P/F) is mandatory for examensarbete on grundnivå
  och avancerad nivå. The KEX option groups in the data are unmarked; if
  you add a `gradingScale` field, the KEX courses are the canonical place
  to start.
- *"Antalet tentamenstillfällen (skriftlig tentamen) ska vara minst två
  per kurs och läsår"*. Today this is enforced only by convention (each
  course has matching `exams` and `reexams`). The validator could check
  that every course with `exams.length > 0` also has a `reexams` slot —
  but see §2.3 about what `reexams: ["P1"]` actually means.
- *"Fler än två ordinarie skriftliga tentamina bör därför undvikas i
  tentamensperioderna"*. The tool already shows when many exams stack on
  the same period (filled circles cluster vertically). It could explicitly
  highlight periods where the obligatory-course count exceeds 2 — useful
  feedback for programmes designing a new study year.

### 4.3 *Riktlinje om läsårets förläggning* (V-2019-0109)

This is the one with the most direct visual impact on the tool.

- The riktlinje fixes the *structure* of a läsår (40 weeks, 2 terms × 20
  weeks, 4 periods, 7–8 weeks teaching + 3–4 days self-study/omprov + 6–7
  days examination). The exact dates are decided each year by Rektor and
  *bör not change after publication*.
- `academic-periods.json` is hard-coded for one year (2025-08-25 →
  2026-08-21). The data structure has no notion of "läsår 2024/2025 vs
  2025/2026", and the tool has no way to switch year. This is fine for the
  current "render the next läsår" use case, but it's a foot-gun: the file
  needs to be manually updated each year and there is no UI hint as to
  which läsår is being shown. Consider:
  - Showing the läsår (e.g. "Läsår 2025/2026") in the chart title.
  - Storing per-läsår period definitions and selecting via URL `?lä=2025`.
- **Re-exam slot rules (key quote):**
  > "Omprov för kurs med ordinarie examinationstillfälle i period 1 äger
  > rum strax innan jul. För kurser i period 2 ges omprov innan
  > examinationsperiod i period 3 eller mitt i period 4 i samband med
  > påskhelgen. Omprov för period 3-kurser äger rum direkt efter
  > vårterminens slut. Omprov för period 4-kurser äger rum direkt före
  > läsårets början. *Omprov finns inte i period 1.*"

  `academic-periods.json` reflects this correctly *date-wise*:
  `P1.reExam = 2025-12-15`, `P2.reExam = 2026-04-07`, `P3.reExam =
  2026-06-02`, `P4.reExam = 2026-08-10`. The encoding of the slot via the
  field `reexams: ["P1"]` is what's misleading — see §2.3.
- The riktlinje says "*Omprov finns inte i period 1*". Today the
  `Period['id']` union (`src/types/course.ts:2`) covers P1–P4 and
  `reExamStart`/`reExamEnd` are present for *every* period including P1.
  That is fine for the *date* of the December re-exam slot, but it
  contradicts the rule unless the field is renamed/clarified.
- The riktlinje also says that a fall semester begins "en måndag mellan
  23 augusti och 3 september" and the spring semester 20 weeks later on a
  Tuesday. This is outside the model — fine, but worth noting that
  swapping in next year's dates is not just changing four ISO strings; the
  exam-period day-counts (6–7 days) and the lecture-end positions
  (`lectureEnd` field) need to be recomputed too. A small Node script
  taking the four "first Mondays" and emitting `academic-periods.json`
  would be safer than hand-editing.

### 4.4 Bilingual rule

The riktlinje mandates SV + EN for the study plan. The tool already does
this via the `language` query param — good. Two leftovers:

- Some UI text not in `tr`: see §1.5.
- The `programs.json` `comment` field is Swedish-only; an
  English-speaking student switching languages still sees Swedish in the
  footer. Add `commentEn`.

### 4.5 What the tool could helpfully add

Things the steering documents care about, that a visualization is well
placed to surface:

- A "credit budget" indicator per year ("63.5 / 60 hp" with a warning
  color when over/under 60 ± a tolerance).
- A "kurs-PM ej publicerad" flag once the Course-PM URL is part of the
  data model (Riktlinje om kursplan §4 requires Kurs-PM at course start).
- Highlight periods with > 2 obligatoriska tentor in the same exam window
  (Riktlinje §2.1, läsårets förläggning).
- A toggle to switch to the corresponding *previous* läsår's plan, once
  multi-year data is supported.

---

## 5. Concrete suggestions, ranked

Roughly in cost-vs-value order:

1. **Add a JSON Schema + a `npm run validate-data` script run in CI.**
   Catches §2.4 (silent merges, dropped prereqs, total/period mismatches,
   dangling option codes) and gives a place to hang future rules.
2. **Update `CLAUDE.md`** to remove the dead `OptionGroupModal.tsx`
   reference and to mention the dual `periodCredits` shapes
   (flat vs `Year1`-keyed).
3. **Drop `layers` and `focusYear` from the main `useEffect` deps**
   (`TimelineVisualization.tsx:2442`). Move the work they do (label
   weight, layer visibility) into the existing post-render effects. This
   is the single biggest UI-perf win.
4. **Add `category` and `gradingScale` fields** to the Course model
   (§2.1, §4.2) — non-breaking, optional, default values keep current
   files working.
5. **Encode option choices and disabled layers in the URL.** Lets users
   share configurations.
6. **Rename `reexams` field** (or compute it implicitly from `exams`
   plus the läsårsregler), §2.3 / §4.3.
7. **Refactor `TimelineVisualization.tsx` into smaller files**, e.g.
   - `ChartLayout.ts` (numYears, year heights, time scale)
   - `ArrowRouter.ts` (segments, lanes, polylines)
   - `BarRenderer.tsx`, `OptionGroupModal.tsx`, `Legend.tsx`,
     `InfoPanel.tsx`, `Export.ts`
   - `useCourseModel.ts` for the merge logic from `HomeClient.tsx`.
8. **Switch the per-bar event handlers to delegated handlers** with a
   cached tooltip text map (§3.2).
9. **Cache embedded fonts and the Puppeteer browser instance** (§3.5).
10. **Accessibility pass:** keyboard focus on bars, `role="img"` + title
    on the SVG, `aria-label`s on icon buttons (§1.4).
11. **Add inriktning support and a track filter** when Y4–Y5 data is
    added (§2.5, §2.6).
12. **Drop or restore `getFamilyVariants`** (§2.9).

---

## 6. Out of scope (worth noting)

- The `eslint` script (`package.json:9`) is just `eslint` with no path; on
  Next 16 it relies on `eslint-config-next` discovering files. CI's
  `npm run lint` (`.github/workflows/ci.yml:29`) doesn't fail on warnings.
  Consider `eslint .` and `--max-warnings 0`.
- `tsconfig.json` doesn't include `tsc --noEmit` in CI — only lint and
  build. Adding a separate `npx tsc --noEmit` step would catch type
  regressions earlier than build.
- `next.config.ts:8` shells out to `git rev-parse` at build time; on
  Vercel this works because the repo is checked out. Anywhere else the
  fallback is `'unknown'`. If you ever build from a tarball, set
  `NEXT_PUBLIC_GIT_HASH` explicitly.
- `vercel.json:6` and `next.config.ts:51-56` double-declare the
  Chromium include. This is intentional (Vercel needs the explicit hint),
  but the duplication is fragile if either changes.
- `.DS_Store` files are committed in `src/` and at the repo root; add to
  `.gitignore` and remove from history.
