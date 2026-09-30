#!/usr/bin/env node
// Which master programmes each five-year civilingenjör programme leads into,
// per admission cohort, read from KTH's study-plan pages.
//
//   node scripts/extract-master-mapping.mjs            # all programmes
//   node scripts/extract-master-mapping.mjs CTFYS CTMAT
//
// Writes src/data/master-mapping.json and master-mapping-review.md.
//
// There is no one place KTH states this, and the places differ by programme.
// Measured over the 18 programmes' year-4 pages for kull HT2023-HT2025:
//
//   - a list in the year-4 page's own text, with codes: "Teknisk fysik (TTFYM)
//     | Matematik (TMAKM) | … Marina system (TMRSM) (ej spår Management)"
//     (CTFYS, CTKEM, CITEH);
//   - the same kind of list without codes, as names only, in the year-4 text or
//     in `studyProgramme.arskursinformationAr3`: "Flyg- och rymdteknik
//     Fordonsteknik Hållbar energiteknik …" (CFATE, CMEDT, CMATD, CDEPR, CSAMH,
//     CBIOT, CTMAT);
//   - year-3 curricula named after a destination, "Master, industriell
//     ekonomi" (the ITM programmes);
//   - nothing at all on the programme's own pages (CDATE, CELTE, CINTE, CMETE).
//     For those the MASTER programme's plan says it instead: 13 EECS masters
//     list, under "platsgaranti (mappning)", the civilingenjör programmes whose
//     students they take, with the courses each must have read.
//
// The lists change between cohorts: CTMAT's HT2024 page names TBDVM and its
// HT2023 and HT2025 pages do not, and CTFYS added a note on TTMAM's CSSE track
// for HT2025. So the mapping is kept per cohort.
//
// Names are resolved against KTH's catalogue of CURRENT master programmes, from
// the programme index page. Retired programmes stay in that index under a
// separate list, and several share a name with a current one (TMTHM and TMAKM
// are both "matematik"), so they are left out. A name two current programmes
// share (TINEM and TIEMM, "industriell ekonomi") is resolved by a code the same
// programme's texts give; otherwise it is reported as ambiguous.
//
// Everything here is read from free text, so the review file lists every
// judgement for a programme director to confirm.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeStateBlob, fetchStudyPlanState, getText } from './lib/kth-pages.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const programs = JSON.parse(readFileSync(join(repoRoot, 'src/data/programs.json'), 'utf8'));
const cohortIndex = JSON.parse(readFileSync(join(repoRoot, 'src/data/cohorts/index.json'), 'utf8'));
const OUT_JSON = join(repoRoot, 'src/data/master-mapping.json');
const OUT_REVIEW = join(repoRoot, 'master-mapping-review.md');

const MASTER_CODE = /^T[A-Z]{3}M$/;
// What a note on a listed master says: a track, or a restriction on one.
const QUALIFIER = /sp[åa]r|\bej\b|endast|inklusive|utom|tid\./iu;
// A cohort label from cohorts/index.json, "HT2025", as the term code 20252.
// Checked here too, so a malformed index names the bad label rather than
// failing later as a malformed term.
const termFor = (cohort) => {
  if (!/^HT\d{4}$/.test(cohort)) throw new Error(`not a cohort label: ${JSON.stringify(cohort)}`);
  return `${cohort.slice(2)}2`;
};
const DESTINATIONS = 'årskurs 3, inriktning mot master';

// The cohort nearest to `i` that satisfies `ok`, the earlier one on a tie; the
// same search the cohort extractor uses to borrow a year (resolveYear).
function nearest(list, i, ok) {
  for (let d = 1; d < list.length; d++) {
    if (i - d >= 0 && ok(list[i - d])) return i - d;
    if (i + d < list.length && ok(list[i + d])) return i + d;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// HTML to plain text, keeping list and paragraph breaks as ' | ' so a name at
// the end of one line is not read together with the start of the next.
const plain = (html) => String(html ?? '')
  .replace(/<br\s*\/?>/gi, ' | ')
  .replace(/<\/(p|li|h\d)>/gi, ' | ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/[ \t\r\n]+/g, ' ')
  .trim();

// For matching only: lower case, and hyphens and dashes as spaces, so
// "Flyg- och rymdteknik" and "Flyg och rymdteknik" (CDEPR writes both) match
// the same catalogue name. Length-preserving, so positions map back to `plain`.
const fold = (s) => s.toLowerCase().replace(/[-–]/g, ' ');

// A catalogue name as a pattern: words separated by any run of spaces, and
// bounded by non-letters. `\b` is ASCII-only in JavaScript and fails next to
// å/ä/ö (see CLAUDE.md), hence the lookarounds with the `u` flag.
const namePattern = (name) =>
  new RegExp(`(?<!\\p{L})${fold(name).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}(?!\\p{L})`, 'gu');

// ---------------------------------------------------------------------------
// The catalogue of current master programmes
// ---------------------------------------------------------------------------

async function masterCatalogue() {
  const html = await getText('https://www.kth.se/student/kurser/kurser-inom-program');
  const state = decodeStateBlob(html, 'programme index');
  // `programmes` holds pairs of [heading, { first, second }]: `first` the
  // programmes admitting students, `second` the retired ones.
  const current = [];
  const walk = (o, path) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, path)); return; }
    if (!o || typeof o !== 'object') return;
    if (o.programmeCode) {
      if (path.endsWith('.first') && MASTER_CODE.test(o.programmeCode)) current.push(o);
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(state, '');
  if (current.length < 30) {
    throw new Error(`the programme index listed only ${current.length} current master programmes — its page structure has changed`);
  }
  return current.map((p) => ({
    code: p.programmeCode,
    name: String(p.title).replace(/^Masterprogram,\s*/i, '').trim(),
    nameEn: String(p.titleOtherLanguage ?? '').replace(/^Master's Programme,\s*/i, '').trim(),
  }));
}

// ---------------------------------------------------------------------------
// Reading one text
// ---------------------------------------------------------------------------

/**
 * The master programmes a text names, with what it says about each.
 *
 * Returns [{ code | candidates, name, note, how }]. `how` is 'code' when the
 * text wrote the code, 'name' when only the name was matched.
 */
function readText(text, catalogue) {
  const byCode = new Map(catalogue.map((m) => [m.code, m]));
  const f = fold(text);
  const found = [];

  // Every catalogue name, longest first, so "Industriell produktutveckling"
  // is not also read as a shorter name inside it.
  const names = [...new Map(catalogue.map((m) => [fold(m.name), m.name])).values()]
    .sort((a, b) => b.length - a.length);
  const taken = new Array(f.length).fill(false);
  for (const name of names) {
    for (const hit of f.matchAll(namePattern(name))) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (taken.slice(start, end).some(Boolean)) continue;
      for (let i = start; i < end; i++) taken[i] = true;
      found.push({ start, end, name });
    }
  }
  // Codes written out, where no name was matched right before them.
  for (const hit of text.matchAll(/(?<![A-Z])T[A-Z]{3}M(?![A-Z])/g)) {
    if (!byCode.has(hit[0])) continue;
    if (taken[hit.index]) continue;
    found.push({ start: hit.index, end: hit.index + 5, code: hit[0] });
  }
  found.sort((a, b) => a.start - b.start);

  // Depth of parentheses at each position. A name inside them qualifies the
  // entry before it: CTFYS's "Tillämpad matematik … (TTMAM) (Inklusive spåret
  // CSSE Datorsimuleringar inom teknik och naturvetenskap …)" names a track of
  // TTMAM, not the master TDTNM.
  const depth = [];
  for (let i = 0, d = 0; i < text.length; i++) {
    if (text[i] === '(') d++;
    depth.push(d);
    if (text[i] === ')') d = Math.max(0, d - 1);
  }

  const out = [];
  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    if (depth[m.start] > 0 && !m.code) continue;
    const before = f.slice(Math.max(0, m.start - 40), m.start);
    // "civilingenjörsexamen i Teknisk fysik" names the degree, not a master.
    if (/(examen|programmet|utbildningsprogram(met)?)\s+i\s*$/.test(before)) continue;
    // "Spår, Mekatronik" under Industriell produktutveckling (CDEPR) is a
    // track of the master before it, even when a master of that name exists.
    if (/sp[åa]r(et)?\s*,?\s*(mot\s+)?$/.test(before) && out.length) {
      const prev = out[out.length - 1];
      prev.notes.push(`spår ${text.slice(m.start, m.end)}`);
      continue;
    }

    // What follows, up to the next match: "(TTFYM)", "(ej spår Management)",
    // ", spår mot biomedicinsk fysik", "| Spår, teknisk design".
    const nextStart = found[i + 1]?.start ?? text.length;
    const tail = text.slice(m.end, nextStart);
    const notes = [];
    let code = m.code;
    // Only parentheses that follow the name directly, one after another:
    // "Marina system (TMRSM) (ej spår Management)". A later one belongs to
    // other text ("Behörighetsgivande kurser (måste vara avslutade)"), and only
    // a qualifier of the programme is kept as a note.
    for (const p of tail.match(/^(\s*\([^()]*\))+/)?.[0].matchAll(/\(([^()]*)\)/g) ?? []) {
      const inner = p[1].trim();
      if (MASTER_CODE.test(inner) && byCode.has(inner)) { code ??= inner; continue; }
      if (QUALIFIER.test(inner) && inner.length < 160) notes.push(inner);
    }
    const dash = tail.match(/^\s*[–-]\s*(T[A-Z]{3}M)\b/);
    if (dash && byCode.has(dash[1])) code ??= dash[1];
    const comma = tail.match(/^\s*,\s*(sp[åa]r[^|(),.]*)/i);
    if (comma) notes.push(comma[1].trim());
    for (const s of tail.matchAll(/\|\s*(Sp[åa]r,\s*[^|(\s][^|(]*)/g)) notes.push(s[1].replace(/\s+$/, '').trim());

    // A name that runs on, in the same list item, into the code of a programme
    // with another name is part of that programme's name, not a master of its
    // own. CITEH HT2022 writes TTMAM's name wrong, "Tillämpad matematik och
    // beräkningsteknik, spår optimeringslära och systemteknik (TTMAM)": no
    // catalogue name matches it whole, and "matematik" inside it matched TMAKM,
    // "Masterprogram, matematik". A list item ends at a line break (' | ' from
    // `plain`) or a semicolon. The code's own name is the usual case,
    // "Teknisk fysik (TTFYM)", and is left alone: the code is matched on its
    // own, starting inside the parentheses, so `code` above does not see it.
    const next = found[i + 1];
    if (!code && next?.code && fold(byCode.get(next.code).name) !== fold(m.name)
      && !/[|;]/.test(tail) && tail.length < 160) {
      const byName = catalogue.filter((c) => fold(c.name) === fold(m.name)).map((c) => c.code);
      const end = text[next.end] === ')' ? next.end + 1 : next.end;
      out.push({ candidates: [], how: 'partial', written: text.slice(m.start, m.end), notes, within: text.slice(m.start, end), byName });
      continue;
    }

    const candidates = code ? [code] : catalogue.filter((c) => fold(c.name) === fold(m.name)).map((c) => c.code);
    out.push({ candidates, how: m.code || code ? 'code' : 'name', written: text.slice(m.start, m.end), notes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One programme, one cohort
// ---------------------------------------------------------------------------

async function bachelorSide(prog, cohort, catalogue) {
  const term = termFor(cohort);
  const [y4, y3] = await Promise.all([
    fetchStudyPlanState(prog, term, 4).catch(() => null),
    fetchStudyPlanState(prog, term, 3).catch(() => null),
  ]);
  const texts = [];
  const push = (where, html) => { const t = plain(html); if (t && !texts.some((x) => x.text === t)) texts.push({ where, text: t }); };
  for (const ci of y4?.curriculumInfos ?? []) {
    push('årskurs 4', ci.supplementaryInformation);
    push('årskurs 4', ci.conditionallyElectiveCoursesInformation);
  }
  const sp = y4?.studyProgramme ?? y3?.studyProgramme ?? {};
  push('årskursinformation år 4', sp.arskursinformationAr4);
  push('årskursinformation år 3', sp.arskursinformationAr3);
  // Year-3 curricula named after a destination ("Master, industriell ekonomi").
  const destinations = (y3?.curriculumInfos ?? [])
    .filter((ci) => !ci.isCommon && /^\s*master\s*,/i.test(ci.specializationName ?? ''))
    .map((ci) => ci.specializationName.replace(/^\s*master\s*,\s*/i, ''));
  if (destinations.length) push(DESTINATIONS, destinations.join(' | '));

  const hits = [];
  for (const { where, text } of texts) {
    for (const h of readText(text, catalogue)) hits.push({ ...h, where });
  }
  return { hits, pages: { y4: !!y4, y3: !!y3 } };
}

// The masters' own "platsgaranti (mappning)" lists: master -> civilingenjör programmes.
async function masterSide(catalogue, bachelors) {
  const out = new Map(); // bachelor -> [{ code }]
  const jobs = catalogue.map(async (m) => {
    const state = await fetchStudyPlanState(m.code, '20252', 1).catch(() => null);
    const t = plain(state?.studyProgramme?.behorighetOchUrval);
    if (!/platsgaranti|mappning/i.test(t)) return;
    for (const hit of new Set(t.match(/(?<![A-Z])C[A-Z]{4}(?![A-Z])/g) ?? [])) {
      if (!bachelors.includes(hit)) continue;
      if (!out.has(hit)) out.set(hit, []);
      out.get(hit).push(m.code);
    }
  });
  await Promise.all(jobs);
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const bachelors = programs
  .filter((p) => /^C[A-Z]{4}$/.test(p.code) && p.code !== 'COPEN' && p.level !== 'master')
  .map((p) => p.code)
  .filter((c) => only.length === 0 || only.includes(c));

const catalogue = await masterCatalogue();
const byCode = new Map(catalogue.map((m) => [m.code, m]));
console.log(`${catalogue.length} current master programmes in KTH's catalogue.`);
const fromMasters = await masterSide(catalogue, bachelors);

// Every programme's pages first: a shared name is resolved with evidence from
// all of them (see below).
const allSides = new Map();
await Promise.all(bachelors.map(async (prog) => {
  const cohorts = [...(cohortIndex[prog] ?? [])].sort();
  allSides.set(prog, { cohorts, sides: await Promise.all(cohorts.map((c) => bachelorSide(prog, c, catalogue))) });
}));
// How often each code is written out, per programme.
const writtenBy = new Map(); // code -> Set(prog)
for (const [prog, { sides }] of allSides) {
  for (const h of sides.flatMap((s) => s.hits)) {
    if (h.how !== 'code') continue;
    if (!writtenBy.has(h.candidates[0])) writtenBy.set(h.candidates[0], new Set());
    writtenBy.get(h.candidates[0]).add(prog);
  }
}

const result = {};
const review = [];
for (const prog of bachelors) {
  const { cohorts, sides } = allSides.get(prog);
  const perCohort = {};
  const notesFor = [];
  // KTH publishes a cohort's pages only for the läsår being taught and the next,
  // so part of what a cohort states can be missing. Borrowed from the nearest
  // cohort that has it, and marked so:
  //   - the year-3 destination curricula, not yet published for a cohort whose
  //     year 3 lies ahead (CMAST HT2025: its only master left was TINEM, from the
  //     year-4 text);
  //   - everything, for a cohort whose pages name no master at all (CMEDT
  //     HT2022-HT2024).
  const hasDest = (s) => s.hits.some((h) => h.where === DESTINATIONS);
  const borrowed = sides.map((side, i) => {
    let hits = side.hits;
    if (hits.length === 0) {
      const j = nearest(sides, i, (s) => s.hits.length > 0);
      if (j >= 0) hits = sides[j].hits.map((h) => ({ ...h, where: `${h.where} (från kull ${cohorts[j]})` }));
    } else if (!hasDest(side) && sides.some(hasDest)) {
      const j = nearest(sides, i, hasDest);
      hits = [...hits, ...sides[j].hits.filter((h) => h.where === DESTINATIONS)
        .map((h) => ({ ...h, where: `${h.where} (från kull ${cohorts[j]})` }))];
    }
    return { ...side, hits };
  });
  // A name two current programmes share ("industriell ekonomi": TINEM and
  // TIEMM) is resolved by the code this programme writes for it, in any cohort;
  // failing that, by the code the most OTHER programmes write. CMAST, CDEPR and
  // CITEH write TINEM and only CINEK writes TIEMM, so CFATE's uncoded
  // "Industriell ekonomi" is read as TINEM. The second case is reported.
  const writtenCodes = new Set(sides.flatMap((s) => s.hits.filter((h) => h.how === 'code').map((h) => h.candidates[0])));
  const resolve = (cands) => {
    const own = cands.filter((c) => writtenCodes.has(c));
    if (own.length === 1) return { code: own[0] };
    const score = (c) => [...(writtenBy.get(c) ?? [])].filter((p) => p !== prog).length;
    const ranked = [...cands].sort((a, b) => score(b) - score(a));
    if (ranked.length > 1 && score(ranked[0]) > score(ranked[1])) {
      return { code: ranked[0], inferred: `${ranked.map((c) => `${c} written by ${score(c)}`).join(', ')} other programme(s)` };
    }
    return null;
  };
  cohorts.forEach((cohort, i) => {
    const entries = new Map();
    for (const h of borrowed[i].hits) {
      if (h.how === 'partial') {
        const msg = `${cohort}: "…${h.within}" (${h.where}): "${h.written}" is read as part of that `
          + `programme's name, not as ${h.byName.join(' or ')}`;
        if (!notesFor.includes(msg)) notesFor.push(msg);
        continue;
      }
      let cands = h.candidates;
      if (cands.length > 1) {
        const r = resolve(cands);
        if (r) {
          cands = [r.code];
          if (r.inferred) {
            const msg = `"${h.written}" is shared by ${h.candidates.join(' and ')}; read as ${r.code} (${r.inferred})`;
            if (!notesFor.includes(msg)) notesFor.push(msg);
          }
        }
      }
      if (cands.length !== 1) {
        notesFor.push(`${cohort}: "${h.written}" (${h.where}) matches ${cands.join(' and ')}, which share the name — left out`);
        continue;
      }
      const code = cands[0];
      const e = entries.get(code) ?? { code, notes: [], sources: [] };
      for (const n of h.notes) if (!e.notes.includes(n)) e.notes.push(n);
      if (!e.sources.includes(h.where)) e.sources.push(h.where);
      entries.set(code, e);
    }
    for (const code of fromMasters.get(prog) ?? []) {
      const e = entries.get(code) ?? { code, notes: [], sources: [] };
      e.sources.push(`${code}:s platsgaranti`);
      entries.set(code, e);
    }
    perCohort[cohort] = [...entries.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((e) => ({ code: e.code, ...(e.notes.length ? { note: e.notes.join('; ') } : {}), sources: e.sources }));
  });
  result[prog] = perCohort;
  review.push({ prog, perCohort, notesFor, pages: sides.map((s, i) => [cohorts[i], s.pages]) });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Merge into the committed file, so a run for one programme keeps the others.
let existing = {};
try { existing = JSON.parse(readFileSync(OUT_JSON, 'utf8')); } catch { /* first run */ }
const merged = { ...existing, ...result };
const ordered = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
writeFileSync(OUT_JSON, `${JSON.stringify(ordered, null, 2)}\n`);

const link = (code) => `[${code}](https://www.kth.se/student/kurser/program/${code})`;
const L = [];
L.push('# Master programmes per civilingenjör programme — to verify');
L.push('');
L.push('Generated by `scripts/extract-master-mapping.mjs` from KTH\'s study-plan pages; the data is in `src/data/master-mapping.json`.');
L.push('Each master is listed with where it was read. "platsgaranti" means the master\'s own plan names the programme; everything else is the programme\'s own year-3 or year-4 text.');
L.push('Codes are resolved against KTH\'s catalogue of current master programmes.');
L.push('');
for (const { prog, perCohort, notesFor, pages } of review) {
  L.push(`## ${prog}`);
  L.push('');
  const cohorts = Object.keys(perCohort);
  const all = [...new Set(cohorts.flatMap((c) => perCohort[c].map((e) => e.code)))].sort();
  if (all.length === 0) {
    L.push('**No master programme found** on the programme\'s own pages or in any master\'s platsgaranti list.');
    L.push('');
  } else {
    L.push(`| master | ${cohorts.join(' | ')} | read from | note |`);
    L.push(`|---|${cohorts.map(() => '---').join('|')}|---|---|`);
    for (const code of all) {
      const cells = cohorts.map((c) => (perCohort[c].some((e) => e.code === code) ? '✓' : '—'));
      const es = cohorts.flatMap((c) => perCohort[c].filter((e) => e.code === code));
      const sources = [...new Set(es.flatMap((e) => e.sources))].join('; ');
      const notes = [...new Set(es.map((e) => e.note).filter(Boolean))].join(' / ');
      L.push(`| ${link(code)} ${byCode.get(code)?.name ?? ''} | ${cells.join(' | ')} | ${sources} | ${notes} |`);
    }
    L.push('');
  }
  const missing = pages.filter(([, p]) => !p.y4 && !p.y3).map(([c]) => c);
  if (missing.length) L.push(`Pages not published for: ${missing.join(', ')}.`, '');
  if (notesFor.length) { L.push('**To resolve:**', ''); for (const n of notesFor) L.push(`- ${n}`); L.push(''); }
}
// A run for some programmes replaces only their sections, like the JSON above;
// the others are kept from the committed file, in programs.json order.
const sectionsOf = (text) => {
  const out = new Map();
  for (const part of text.split(/^(?=## [A-Z]{5}$)/m).slice(1)) out.set(part.slice(3, 8), part.replace(/\n+$/, '\n\n'));
  return out;
};
const fresh = sectionsOf(`${L.join('\n')}\n`);
let previous = new Map();
try { previous = sectionsOf(readFileSync(OUT_REVIEW, 'utf8')); } catch { /* first run */ }
const header = L.slice(0, L.findIndex((l) => l.startsWith('## '))).join('\n');
const order = programs.map((p) => p.code).filter((c) => fresh.has(c) || previous.has(c));
writeFileSync(OUT_REVIEW, `${header}\n${order.map((c) => fresh.get(c) ?? previous.get(c)).join('').replace(/\n+$/, '')}\n`);
console.log(`Wrote ${OUT_JSON.replace(`${repoRoot}/`, '')} and ${OUT_REVIEW.replace(`${repoRoot}/`, '')}.`);
