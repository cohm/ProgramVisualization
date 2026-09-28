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

function composedLoad(fullPlan, spec) {
  const plan = effective(fullPlan, spec);
  const src = entriesFor(plan.from);
  const tgt = entriesFor(plan.to);
  const exempt = new Set((plan.exempt ?? []).map((e) => e.code));
  const moves = new Map((plan.moved ?? []).map((m) => [m.code, m]));
  const out = [];
  for (const e of src) if (plan.sourceYears.includes(firstYear(e))) out.push({ ...e });
  const taken = new Set(out.map((e) => e.code).filter(Boolean));
  const resched = new Map((plan.rescheduled ?? []).map((r) => [r.code, r]));
  for (const e of tgt) {
    if (e.code && exempt.has(e.code)) continue;
    if (e.type !== 'optionGroup' && e.code && taken.has(e.code)) continue;  // same course, already read
    const mv = e.code ? moves.get(e.code) : null;
    if (mv) { out.push({ ...e, year: mv.toYear, periodCredits: mv.periodCredits ?? yearRows(e)[0]?.periodCredits ?? e.periodCredits }); continue; }
    if (plan.sourceYears.includes(firstYear(e))) continue;
    const rs = e.code ? resched.get(e.code) : null;
    // A group cannot offer what the student already took or was exempted from
    // (CELTE's SF1546); same rule as composeTransition.
    if (e.type === 'optionGroup') { out.push({ ...e, options: (e.options ?? []).filter((c) => !taken.has(c) && !exempt.has(c)) }); continue; }
    out.push(rs ? { ...e, periodCredits: rs.periodCredits } : { ...e });
  }
  for (const a of plan.added ?? []) out.push({ ...a });
  // Options a plan adds to a target group are counted through the group, like
  // the group's own options (COPEN -> CSAMH's AG1314 in year 2 P4).
  for (const gc of plan.groupChanges ?? []) {
    const g = out.find((e) => e.type === 'optionGroup' && e.year === gc.year && (e.options ?? []).includes(gc.offering) && (!spec || !e.specializations?.length || e.specializations.includes(spec)));
    if (!g) continue;
    if (gc.minCredits != null && gc.periodCredits) {
      g.minCredits = gc.minCredits;
      g.periodCredits = { P1: 0, P2: 0, P3: 0, P4: 0, ...gc.periodCredits };
    }
    if ([gc.satisfiedBy ?? []].flat().length) {
      // Filled by credited courses: the group and its options leave the plan.
      const drop = new Set(g.options ?? []);
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i] === g || (out[i].type !== 'optionGroup' && drop.has(out[i].code) && firstYear(out[i]) === gc.year)) out.splice(i, 1);
      }
      continue;
    }
    g.options = [...new Set([...(g.options ?? []), ...(gc.addOptions ?? [])])];
  }

  // Same counting rule the app uses (`fullTimeWarnings` in src/lib/transitions.ts):
  // an option group counts ONCE and its member courses do not, because the
  // student takes one of them. Counting both is what made year 3 read 207 hp.
  //
  // Membership comes from the groups this inriktning sees, as in the renderer.
  // CMAST's MF1016 and MJ1112 are options only in the INT profiles' groups and
  // obligatoriska otherwise; a global set dropped them from the common row.
  const visible = (e) => !e.specializations?.length || (spec && e.specializations.includes(spec));
  const inGroup = new Set(out.filter((e) => e.type === 'optionGroup' && visible(e)).flatMap((g) => g.options ?? []));
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
    // Per-inriktning overrides: the same course can sit in a different study
    // year and a different offering depending on the inriktning selected
    // (CINEK's DD1320 for PPUI). Both must be applied or the row is wrong.
    const yOv = spec ? e.yearBySpecialization?.[spec] : undefined;
    const pOv = spec ? e.periodCreditsBySpecialization?.[spec] : undefined;
    for (const src of yearRows(e)) {
      const y = yOv ?? src.year;
      const pc = pOv ?? src.periodCredits;
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
// The plan for one inriktning: common changes plus its overlay, as in
// `effectivePlan` (src/lib/transitions.ts).
const OVERLAY_KEYS = ['exempt', 'moved', 'rescheduled', 'added', 'groupChanges'];
function effective(plan, spec) {
  const overlay = spec ? plan.bySpecialization?.[spec] : null;
  if (!overlay) return plan;
  const merged = { ...plan };
  for (const k of OVERLAY_KEYS) if (overlay[k]?.length) merged[k] = [...(plan[k] ?? []), ...overlay[k]];
  return merged;
}

const QUESTIONS = readJson(join(root, 'scripts', 'transition-questions.json'));

/**
 * The sections describing a plan's changes: exemptions, moves, reschedules,
 * additions and group changes. Rendered once for the common part and once per
 * inriktning overlay (`bySpecialization`), with `h` the heading level.
 */
function renderChanges(plan, L, tgt, h, spec) {
  if (plan.exempt?.length) {
    L.push(h + ' Kurser som utgår');
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
    L.push(h + ' Kurser som flyttas till en senare årskurs');
    L.push('');
    L.push('Kursen läses i samma läsperioder som vanligt, men ett år senare.');
    L.push('');
    for (const m of plan.moved) {
      // New periods, flat or keyed by study year; "varav" only for a partial read.
      let part = '';
      if (m.periodCredits) {
        const yearKeys = Object.keys(m.periodCredits).filter((k) => /^Year\d+$/.test(k));
        const rows = yearKeys.length ? yearKeys.map((k) => [`åk ${k.slice(4)} `, m.periodCredits[k]]) : [['', m.periodCredits]];
        const text = rows.map(([lead, map]) => lead + ['P1', 'P2', 'P3', 'P4'].filter((q) => map[q]).map((q) => `${q}: ${hp(map[q])} hp`).join(', ')).join('; ');
        const sum = rows.reduce((a, [, map]) => a + ['P1', 'P2', 'P3', 'P4'].reduce((b, q) => b + Number(map[q] || 0), 0), 0);
        part = sum < (creditsOf(tgt, m.code) ?? 0) - 0.05 ? `, varav **${text}** läses` : `, i **${text}**`;
      }
      L.push(`- **${link(m.code)} ${nameOf(tgt, m.code)}** (${hp(creditsOf(tgt, m.code) ?? 0)} hp${part}): årskurs ${m.fromYear} → ${m.toYear}`);
      if (m.note) L.push(`  ${m.note}`);
    }
    L.push('');
  }

  if (plan.rescheduled?.length) {
    L.push(h + ' Kurser som läses i andra perioder');
    L.push('');
    L.push('Samma kurs och samma årskurs, men i andra läsperioder: en annan av KTH:s omgångar under året, eller bara den del som inte tillgodoräknas.');
    L.push('');
    for (const rs of plan.rescheduled) {
      const from = ['P1', 'P2', 'P3', 'P4'].filter((q) => tgt.find((e) => e.code === rs.code)?.periodCredits?.[q])
        .map((q) => `${q}: ${hp(tgt.find((e) => e.code === rs.code).periodCredits[q])} hp`).join(', ');
      const to = ['P1', 'P2', 'P3', 'P4'].filter((q) => rs.periodCredits?.[q])
        .map((q) => `${q}: ${hp(rs.periodCredits[q])} hp`).join(', ');
      const rest = rs.creditedBy?.length ? `; resten tillgodoräknas genom ${rs.creditedBy.map(link).join(' och ')}` : '';
      L.push(`- **${link(rs.code)} ${nameOf(tgt, rs.code)}** (${hp(creditsOf(tgt, rs.code) ?? 0)} hp): ${from} → **${to}**${rest}`);
      if (rs.note) L.push(`  ${rs.note}`);
    }
    L.push('');
  }

  if (plan.added?.length) {
    L.push(h + ' Kurser som tillkommer');
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

  if (plan.groupChanges?.length) {
    L.push(h + ' Valgrupper som ändras');
    L.push('');
    L.push(`Valgrupper i ${plan.to} som ser annorlunda ut för den transfererande studenten.`);
    L.push('');
    const who = (list, required) => (list ?? []).filter((m) => (m.required !== false) === required).map((m) => m.code).join(', ');
    for (const gc of plan.groupChanges) {
      const g = tgt.find((e) => e.type === 'optionGroup' && e.year === gc.year && (e.options ?? []).includes(gc.offering) && (!spec || !e.specializations?.length || e.specializations.includes(spec)));
      if (!g) continue;
      const by = [gc.satisfiedBy ?? []].flat();
      if (by.length) {
        const what = g.kind === 'minCredits' ? `valblocket *${g.name}* (${hp(g.minCredits)} hp)` : `valet mellan ${(g.options ?? []).map(link).join(' och ')}`;
        L.push(`**Årskurs ${gc.year}, ${what}** utgår: det fylls redan av ${by.map(link).join(', ')} från ${plan.from}.`);
        L.push('');
        if (gc.comment) { L.push(gc.comment); L.push(''); }
        continue;
      }
      if (gc.minCredits != null && gc.periodCredits) {
        const per = ['P1', 'P2', 'P3', 'P4'].filter((q) => gc.periodCredits[q]).map((q) => `${q}: ${hp(gc.periodCredits[q])} hp`).join(', ');
        L.push(`**Årskurs ${gc.year}, valblocket *${g.name}*** minskar från ${hp(g.minCredits)} till **${hp(gc.minCredits)} hp** (${per}).`);
        L.push('');
        if (gc.comment) { L.push(gc.comment); L.push(''); }
        if (!gc.addOptions?.length && !gc.qualifiesFor) continue;
      }
      const rule = g.kind === 'minCredits' ? `minst ${hp(g.minCredits)} hp` : `välj ${g.pickN ?? g.allowedNumberOfOptions ?? 1}`;
      L.push(`**Årskurs ${gc.year}, ${rule}** av:`);
      L.push('');
      L.push('| Kurs | hp | Obligatorisk för | Rekommenderad för |');
      L.push('|---|---|---|---|');
      const options = [...new Set([...(g.options ?? []), ...(gc.addOptions ?? [])])];
      for (const code of options) {
        const added = (gc.addOptions ?? []).includes(code) && !(g.options ?? []).includes(code);
        const q = gc.qualifiesFor?.[code] ?? g.qualifiesFor?.[code];
        L.push(`| ${link(code)} ${nameOf(tgt, code)}${added ? ' _(tillkommer)_' : ''} | ${hp(creditsOf(tgt, code) ?? 0)} | ${who(q, true) || '—'} | ${who(q, false) || '—'} |`);
      }
      L.push('');
      if (gc.comment) { L.push(gc.comment); L.push(''); }
    }
  }

}

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

  renderChanges(plan, L, tgt, '##', undefined);

  // Per-inriktning overlays, one section each, in the order of the registry.
  const targetSpecs = programs.find((p) => p.code === plan.to)?.specializations ?? [];
  for (const sp of targetSpecs) {
    const overlay = plan.bySpecialization?.[sp.code];
    if (!overlay) continue;
    L.push(`## Inriktning ${sp.code} ${sp.name}`);
    L.push('');
    L.push(`Utöver ändringarna ovan gäller följande för en student som läser ${sp.code}.`);
    L.push('');
    renderChanges({ ...overlay, from: plan.from, to: plan.to }, L, tgt, '###', sp.code);
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
    // Every year any inriktning has, not just the years with common courses:
    // all of CSAMH's year-3 courses belong to an inriktning, and iterating the
    // common rows alone left year 3 out of the table.
    const common = new Map(composedLoad(plan));
    const bySpec = new Map(specs.map((sp) => [sp.code, new Map(composedLoad(plan, sp.code))]));
    const years = [...new Set([...common.keys(), ...[...bySpec.values()].flatMap((m) => [...m.keys()])])].sort((a, b) => a - b);
    const empty = { P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const year of years) {
      const row = common.get(year) ?? empty;
      L.push(rowFor(year, row, '_gemensamma_'));
      for (const sp of specs) {
        const r = bySpec.get(sp.code).get(year);
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
