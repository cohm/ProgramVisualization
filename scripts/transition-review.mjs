#!/usr/bin/env node
/**
 * Write a sign-off worklist for each COPEN transition plan.
 *
 * A transition plan records the DIFFERENCE between what a COPEN student already
 * took and what the target programme publishes, so nothing about it can be
 * checked by reading one document. The program director who signs it needs the
 * equivalences laid side by side, every judgement we made called out as a
 * judgement, and a link to each course — which is what this file is.
 *
 * The factual half (equivalences, per-period load, links) is computed from
 * `transitions.json` plus both programmes' data, so it cannot drift. The
 * questions are hand-written per plan below, because they are readings of a PDF
 * that only a human has seen.
 *
 * Usage: node scripts/transition-review.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'src', 'data');
const outDir = join(root, 'transition-review');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const programs = readJson(join(dataDir, 'programs.json'));
const plans = readJson(join(dataDir, 'transitions.json'));

const courseUrl = (c) => `https://www.kth.se/student/kurser/kurs/${c}`;
const link = (c) => `[${c}](${courseUrl(c)})`;
const hp = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

function entriesFor(code) {
  const prog = programs.find((p) => p.code === code);
  if (!prog) return [];
  const d = readJson(join(dataDir, prog.dataFile));
  return Array.isArray(d) ? d.filter((e) => e && e.type !== 'cohortMeta') : [];
}
const nameOf = (entries, code) =>
  entries.find((e) => e.code === code)?.name ?? '—';
const creditsOf = (entries, code) =>
  entries.find((e) => e.code === code)?.totalCredits ?? null;

/**
 * Per-period load of the composed plan, computed the same way the app does:
 * source years from the source programme, the rest from the target, minus
 * exemptions, plus moves and additions.
 *
 * Courses tagged with an inriktning are counted ONLY when a single inriktning is
 * assumed, because a student takes one — counting every tag at once is what
 * makes CMAST's year 2 read 90 hp instead of 61,5.
 */
const YEAR_KEY = /^Year(\d+)$/;

/**
 * Flatten one raw entry into `{ year, periodCredits }` rows.
 *
 * A course spanning study years carries `periodCredits` keyed `Year1`/`Year2`/…
 * and no top-level `year` (CTMAT's SA1006 runs across years 1-3). Reading
 * `e.year` on those yields `undefined`, which produced a phantom "year
 * undefined" row in the table and, worse, let them slip past the source-year
 * filter. The study year of such a course is its FIRST, matching `entryYear` in
 * src/lib/transitions.ts.
 */
function yearRows(e) {
  const pc = e.periodCredits;
  if (!pc) return [];
  const years = Object.keys(pc).filter((k) => YEAR_KEY.test(k));
  if (years.length === 0) return [{ year: e.year, periodCredits: pc }];
  return years.map((k) => ({ year: Number(k.match(YEAR_KEY)[1]), periodCredits: pc[k] }));
}
const firstYear = (e) => {
  const rows = yearRows(e);
  return rows.length ? Math.min(...rows.map((r) => r.year)) : e.year;
};

function composedLoad(plan, spec) {
  const src = entriesFor(plan.from);
  const tgt = entriesFor(plan.to);
  const exempt = new Set((plan.exempt ?? []).map((e) => e.code));
  const moves = new Map((plan.moved ?? []).map((m) => [m.code, m]));
  const out = [];
  for (const e of src) if (plan.sourceYears.includes(firstYear(e))) out.push({ ...e });
  const resched = new Map((plan.rescheduled ?? []).map((r) => [r.code, r]));
  for (const e of tgt) {
    if (e.code && exempt.has(e.code)) continue;
    const mv = e.code ? moves.get(e.code) : null;
    if (mv) { out.push({ ...e, year: mv.toYear, periodCredits: yearRows(e)[0]?.periodCredits ?? e.periodCredits }); continue; }
    if (plan.sourceYears.includes(firstYear(e))) continue;
    const rs = e.code ? resched.get(e.code) : null;
    out.push(rs ? { ...e, periodCredits: rs.periodCredits } : { ...e });
  }
  for (const a of plan.added ?? []) out.push({ ...a });

  // Same counting rule the app uses (`fullTimeWarnings` in src/lib/transitions.ts):
  // an option group counts ONCE and its member courses do not, because the
  // student takes one of them. Counting both is what made year 3 read 207 hp.
  const inGroup = new Set(out.filter((e) => e.type === 'optionGroup').flatMap((g) => g.options ?? []));
  const byYear = new Map();
  for (const e of out) {
    if (!e.periodCredits) continue;
    if (e.type !== 'optionGroup' && inGroup.has(e.code)) continue;
    // A course tagged with inriktningar is taken only by students on one of
    // them. With `spec` given, count it only when it matches; without, leave
    // every tagged course out and report the common part alone — counting all
    // of them at once would sum several mutually exclusive tracks.
    const tags = e.specializations;
    if (tags?.length && (!spec || !tags.includes(spec))) continue;
    for (const { year: y, periodCredits: pc } of yearRows(e)) {
      if (y == null) continue;
      if (!byYear.has(y)) byYear.set(y, { P1: 0, P2: 0, P3: 0, P4: 0 });
      const row = byYear.get(y);
      for (const p of ['P1', 'P2', 'P3', 'P4']) row[p] += Number(pc[p] || 0);
    }
  }
  const r1 = (n) => Math.round(n * 10) / 10;
  return [...byYear.entries()].sort((a, b) => a[0] - b[0])
    .map(([y, row]) => [y, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, r1(v)]))]);
}

// Hand-written, per plan: the readings a human made of the PDF and the questions
// only the programme can settle. Keyed `FROM->TO`.
const QUESTIONS = readJson(join(root, 'scripts', 'transition-questions.json'));

function write(plan) {
  const key = `${plan.from}->${plan.to}`;
  const q = QUESTIONS[key] ?? {};
  const src = entriesFor(plan.from);
  const tgt = entriesFor(plan.to);
  const L = [];

  L.push(`# Övergångsplan ${plan.from} → ${plan.to} — underlag för signering`);
  L.push('');
  L.push(q.intro ?? '');
  L.push('');
  if (plan.source) { L.push(`**Källa:** ${plan.source}`); L.push(''); }
  L.push(`**Status:** ${plan.verified ? 'verifierad' : '**inte verifierad** — detta dokument är det som ska signeras.'}`);
  L.push('');
  L.push('Varje kurskod nedan länkar till KTH:s kurssida.');
  L.push(plan.verified
    ? 'Planen är godkänd; avsnitten nedan är kvar som dokumentation av vad som granskades.'
    : 'Kontrollera raderna i tur och ordning; de som är markerade **Fråga** kräver ett aktivt beslut.');
  L.push('');

  L.push('## Tillgodoräknade kurser');
  L.push('');
  L.push(`De ${plan.credited.length} kurserna i ${plan.from} årskurs ${plan.sourceYears.join('/')} och vad de ersätter i ${plan.to}.`);
  L.push('');
  L.push(`| ${plan.from}-kurs | hp | Ersätter i ${plan.to} | hp | Kommentar |`);
  L.push('|---|---|---|---|---|');
  for (const c of plan.credited) {
    const reps = (c.replaces ?? []);
    // Without `replaces` the course still carries a note explaining what it
    // credits — SA1007 and KD1000 jointly cover SI1121 and SK1105 — so "replaces
    // nothing" would understate it. The note is in the next column.
    const repTxt = reps.length
      ? reps.map((r) => `${link(r)} ${nameOf(tgt, r)}`).join('<br>')
      : '_(ingen enskild motsvarighet — se kommentar)_';
    const repHp = reps.length ? reps.map((r) => hp(creditsOf(tgt, r) ?? 0)).join('<br>') : '—';
    L.push(`| ${link(c.code)} ${nameOf(src, c.code)} | ${hp(creditsOf(src, c.code) ?? 0)} | ${repTxt} | ${repHp} | ${c.note ?? ''} |`);
  }
  L.push('');

  if (plan.exempt?.length) {
    L.push('## Kurser som utgår');
    L.push('');
    L.push(`Kurser i ${plan.to} som den transfererande studenten inte läser.`);
    L.push('');
    for (const e of plan.exempt) {
      L.push(`- **${link(e.code)} ${nameOf(tgt, e.code)}** (${hp(creditsOf(tgt, e.code) ?? 0)} hp)` +
        (e.creditedBy ? ` — tillgodoräknad genom ${link(e.creditedBy)}` : ''));
      if (e.note) L.push(`  ${e.note}`);
    }
    L.push('');
  }

  if (plan.moved?.length) {
    L.push('## Kurser som flyttas till en senare årskurs');
    L.push('');
    L.push('Kursen läses i samma läsperioder som vanligt, men ett år senare.');
    L.push('');
    for (const m of plan.moved) {
      L.push(`- **${link(m.code)} ${nameOf(tgt, m.code)}** (${hp(creditsOf(tgt, m.code) ?? 0)} hp): årskurs ${m.fromYear} → ${m.toYear}`);
      if (m.note) L.push(`  ${m.note}`);
    }
    L.push('');
  }

  if (plan.rescheduled?.length) {
    L.push('## Kurser som läses i en annan kursomgång');
    L.push('');
    L.push('Samma kurs och samma årskurs, men den andra av KTH:s omgångar under året.');
    L.push('');
    for (const rs of plan.rescheduled) {
      const from = ['P1', 'P2', 'P3', 'P4'].filter((q) => tgt.find((e) => e.code === rs.code)?.periodCredits?.[q])
        .map((q) => `${q}: ${hp(tgt.find((e) => e.code === rs.code).periodCredits[q])} hp`).join(', ');
      const to = ['P1', 'P2', 'P3', 'P4'].filter((q) => rs.periodCredits?.[q])
        .map((q) => `${q}: ${hp(rs.periodCredits[q])} hp`).join(', ');
      L.push(`- **${link(rs.code)} ${nameOf(tgt, rs.code)}** (${hp(creditsOf(tgt, rs.code) ?? 0)} hp): ${from} → **${to}**`);
      if (rs.note) L.push(`  ${rs.note}`);
    }
    L.push('');
  }

  if (plan.added?.length) {
    L.push('## Kurser som tillkommer');
    L.push('');
    L.push('Kurser som inte finns i någon av de två publicerade studieplanerna.');
    L.push('');
    for (const a of plan.added) {
      const per = ['P1', 'P2', 'P3', 'P4'].filter((p) => a.periodCredits?.[p])
        .map((p) => `${p}: ${hp(a.periodCredits[p])} hp`).join(', ');
      L.push(`- **${link(a.code)} ${a.name}** (${hp(a.totalCredits)} hp, årskurs ${a.year}, ${per})` +
        (a.substitutesFor ? ` — i stället för ${link(a.substitutesFor)}` : ''));
      if (a.note) L.push(`  ${a.note}`);
    }
    L.push('');
  }

  L.push('## Läsårsbelastning i den sammansatta planen');
  L.push('');
  L.push('Heltid är **15 hp per läsperiod**. Avvikelser är inte nödvändigtvis fel —');
  L.push('en övergångsplan innehåller ofta upphämtningskurser — men de bör stämma med');
  L.push('övergångsplanens egna summor.');
  L.push('');
  const targetProg = programs.find((p) => p.code === plan.to);
  const specs = targetProg?.specializations ?? [];
  const rowFor = (year, row, label) => {
    const tot = row.P1 + row.P2 + row.P3 + row.P4;
    const lead = label == null ? `| ${year} |` : `| ${year} | ${label} |`;
    return `${lead} ${hp(row.P1)} | ${hp(row.P2)} | ${hp(row.P3)} | ${hp(row.P4)} | ${hp(tot)} |`;
  };
  if (specs.length === 0) {
    L.push('| Årskurs | P1 | P2 | P3 | P4 | Totalt |');
    L.push('|---|---|---|---|---|---|');
    for (const [year, row] of composedLoad(plan)) L.push(rowFor(year, row, null));
  } else {
    // One row per inriktning, because a student takes exactly one of them and
    // the years differ between them. The "gemensamma" row is the part every
    // student reads, which is what the inriktning rows are added to.
    L.push('| Årskurs | Inriktning | P1 | P2 | P3 | P4 | Totalt |');
    L.push('|---|---|---|---|---|---|---|');
    const common = new Map(composedLoad(plan));
    for (const [year, row] of common) {
      L.push(rowFor(year, row, '_gemensamma_'));
      for (const sp of specs) {
        const r = new Map(composedLoad(plan, sp.code)).get(year);
        if (!r) continue;
        const differs = ['P1', 'P2', 'P3', 'P4'].some((q) => r[q] !== row[q]);
        if (differs) L.push(rowFor(year, r, `${sp.code} ${sp.name}`));
      }
    }
  }
  L.push('');
  if (q.loadNote) { L.push(q.loadNote); L.push(''); }

  if (q.items?.length) {
    L.push('## Frågor som behöver besvaras');
    L.push('');
    q.items.forEach((it, i) => {
      L.push(`### ${i + 1}. ${it.title}`);
      L.push('');
      L.push(it.body);
      L.push('');
    });
  }

  L.push('---');
  L.push('');
  L.push('När planen är godkänd sätts `verified: true` på posten i');
  L.push('`src/data/transitions.json`, och programmet visas då utan reservation.');
  L.push('');

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${plan.from}-${plan.to}.md`);
  writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}

for (const plan of plans) console.log('Wrote', write(plan).replace(root + '/', ''));
