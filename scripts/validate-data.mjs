#!/usr/bin/env node
// Validates the program data files in src/data/.
//
// Run:  npm run validate-data
//
// Exits non-zero on any error. Warnings print but do not fail.
//
// Schema (informal):
//
// programs.json:
//   Array<{ code, name, nameEn?, dataFile, cosmeticsFile?, verified?, comment?,
//           commentEn?, studyplan?,
//           specializations?: Array<{ code, name, nameEn?, group? }>,
//           specializationGroups?: Array<{ code, name, nameEn? }> }>
//
// <PROGRAM>.json:
//   Array<Course | OptionGroup>
//
//   Course:
//     code:      string (KTH course code, e.g. "SF1672")
//     name:      string (Swedish)
//     nameEn?:   string
//     briefName?, briefNameEn?: string
//     totalCredits: number (hp)
//     periodCredits: one of:
//        flat     -> { P1: number, P2: number, P3: number, P4: number }
//        by-year  -> { Year1: { P1.. }, Year2: {...}, ... }
//     year?: integer (only used with the flat shape; defaults to 1)
//     prerequisites?, prerequisitesCompleted?, prerequisitesParticipation?:
//        Array<courseCode>
//     exams?, reexams?: one of:
//        flat     -> Array<"P1"|"P2"|"P3"|"P4">
//        by-year  -> { Year1: ["P2"], Year2: [...] }
//     teacher?, webpage?, description?: string
//     category?: "mandatory" | "conditionallyElective"
//             | "electivePlaceholder" | "recommended"
//     gradingScale?: "A-F" | "P/F" | "VG/G/U"
//     specializations?: Array<specCode>   (must reference programs.json registry)
//     periodCreditsBySpecialization?: Record<specCode, { P1, P2, P3, P4 }>
//        Per-specialization period override. Flat-shape courses only. Each
//        spec code must already be in this course's `specializations`. Each
//        override's period sum must equal `totalCredits`.
//
//   OptionGroup:
//     type: "optionGroup"
//     name: string
//     nameEn?: string
//     year: integer
//     totalCredits: number
//     periodCredits: { P1, P2, P3, P4 }   (flat only)
//     options: Array<courseCode>          (must each exist in same file)
//     allowedNumberOfOptions: integer
//     exams?, reexams?: Array<periodId>
//     category?, gradingScale?, specializations?: same as Course
//
// <PROGRAM>-cosmetics.json:
//   Array<{ name, nameEn?, colorFamily, courses: Array<courseCode> }>
//   colorFamily ∈ { blue, green, turquoise, brick, yellow }
//
// academic-periods.json:
//   Array<{ id: "P1"..|"P4", start, end, lectureEnd,
//           examStart, examEnd, reExamStart, reExamEnd }>   (ISO date strings)

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dataDir = join(repoRoot, 'src', 'data');

const PERIOD_IDS = new Set(['P1', 'P2', 'P3', 'P4']);
const COLOR_FAMILIES = new Set(['blue', 'green', 'turquoise', 'brick', 'yellow']);
const COURSE_CATEGORIES = new Set(['mandatory', 'conditionallyElective', 'electivePlaceholder', 'recommended']);
const GRADING_SCALES = new Set(['A-F', 'P/F', 'VG/G/U']);
const COURSE_LEVELS = new Set(['G', 'A']);
// Confidence in a cohort year's provenance: 'exact' = the cohort's own published
// data; the rest describe a borrowed year, graded by whether a year the two
// cohorts share agrees ('high'), disagrees ('low'), or does not exist ('unknown').
const COHORT_CONFIDENCE = new Set(['exact', 'high', 'low', 'unknown']);
const CREDIT_TOLERANCE = 0.05; // hp; tolerates rounding (e.g. 3.7 + 3.8)

let errorCount = 0;
let warningCount = 0;

const rel = (p) => relative(repoRoot, p);
const err = (file, msg) => { errorCount++; console.error(`  ERROR  ${rel(file)}: ${msg}`); };
const warn = (file, msg) => { warningCount++; console.warn(`  WARN   ${rel(file)}: ${msg}`); };

function loadJson(path) {
  if (!existsSync(path)) { err(path, 'file not found'); return null; }
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { err(path, `failed to parse: ${e.message}`); return null; }
}

// ---------- programs.json ----------

function validateProgramsJson(programs, file) {
  if (!Array.isArray(programs)) { err(file, 'expected an array'); return; }
  const codes = new Set();
  programs.forEach((p, i) => {
    const ctx = `[${i}]`;
    if (!p.code || typeof p.code !== 'string') err(file, `${ctx}: missing or invalid 'code'`);
    if (!p.name || typeof p.name !== 'string') err(file, `${ctx}: missing or invalid 'name'`);
    if (!p.dataFile) err(file, `${ctx}: missing 'dataFile'`);
    if (codes.has(p.code)) err(file, `${ctx}: duplicate program code '${p.code}'`);
    codes.add(p.code);

    if (p.dataFile && !existsSync(join(dataDir, p.dataFile))) {
      err(file, `${ctx} ${p.code}: dataFile '${p.dataFile}' not found`);
    }
    if (p.cosmeticsFile && !existsSync(join(dataDir, p.cosmeticsFile))) {
      err(file, `${ctx} ${p.code}: cosmeticsFile '${p.cosmeticsFile}' not found`);
    }

    if (p.verified !== undefined && typeof p.verified !== 'boolean') {
      err(file, `${ctx} ${p.code}: 'verified' must be a boolean if present`);
    }
    // `disabled: true` withdraws a programme from the UI entirely. Its data is
    // still validated — the point is to stop showing it, not to stop checking it.
    if (p.disabled !== undefined && typeof p.disabled !== 'boolean') {
      err(file, `${ctx} ${p.code}: 'disabled' must be a boolean if present`);
    }

    // Specialization groups (optional). When present, every group must
    // have { code, name } and codes must be unique within the program.
    const groupCodes = new Set();
    if (p.specializationGroups !== undefined) {
      if (!Array.isArray(p.specializationGroups)) {
        err(file, `${ctx} ${p.code}: 'specializationGroups' must be an array`);
      } else {
        p.specializationGroups.forEach((g, j) => {
          const gctx = `${ctx}.specializationGroups[${j}]`;
          if (!g || typeof g !== 'object') { err(file, `${gctx}: not an object`); return; }
          if (!g.code || typeof g.code !== 'string') err(file, `${gctx}: missing or invalid 'code'`);
          if (!g.name || typeof g.name !== 'string') err(file, `${gctx}: missing or invalid 'name'`);
          if (g.code) {
            if (groupCodes.has(g.code)) err(file, `${gctx}: duplicate group code '${g.code}'`);
            groupCodes.add(g.code);
          }
        });
      }
    }

    // Specializations registry (optional). When present, every entry must
    // have { code, name } and codes must be unique within the program. If
    // a spec carries `group`, it must reference a known group code.
    if (p.specializations !== undefined) {
      if (!Array.isArray(p.specializations)) {
        err(file, `${ctx} ${p.code}: 'specializations' must be an array`);
      } else {
        const specCodes = new Set();
        p.specializations.forEach((s, j) => {
          const sctx = `${ctx}.specializations[${j}]`;
          if (!s || typeof s !== 'object') { err(file, `${sctx}: not an object`); return; }
          if (!s.code || typeof s.code !== 'string') err(file, `${sctx}: missing or invalid 'code'`);
          if (!s.name || typeof s.name !== 'string') err(file, `${sctx}: missing or invalid 'name'`);
          if (s.code) {
            if (specCodes.has(s.code)) err(file, `${sctx}: duplicate specialization code '${s.code}'`);
            specCodes.add(s.code);
          }
          if (s.group !== undefined) {
            if (typeof s.group !== 'string') err(file, `${sctx}: 'group' must be a string`);
            else if (groupCodes.size > 0 && !groupCodes.has(s.group)) {
              err(file, `${sctx}: unknown group '${s.group}' (allowed: ${[...groupCodes].join(', ')})`);
            }
            // If specializationGroups isn't declared at all, accept any
            // group string (the UI falls back to a single implicit group).
          }
        });
      }
    }
  });
}

// ---------- academic-periods.json ----------

function validateAcademicPeriods(periods, file) {
  if (!Array.isArray(periods)) { err(file, 'expected an array'); return; }
  if (periods.length !== 4) err(file, `expected 4 periods, got ${periods.length}`);

  const seenIds = new Set();
  periods.forEach((p, i) => {
    const ctx = `[${i}]`;
    if (!PERIOD_IDS.has(p.id)) err(file, `${ctx}: invalid period id '${p.id}'`);
    if (seenIds.has(p.id)) err(file, `${ctx}: duplicate period id '${p.id}'`);
    seenIds.add(p.id);

    const dateFields = ['start', 'end', 'lectureEnd', 'examStart', 'examEnd', 'reExamStart', 'reExamEnd'];
    const dates = {};
    for (const f of dateFields) {
      if (!p[f]) { err(file, `${ctx} ${p.id}: missing '${f}'`); continue; }
      const d = new Date(p[f]);
      if (Number.isNaN(d.getTime())) {
        err(file, `${ctx} ${p.id}: invalid date for '${f}': ${p[f]}`);
        continue;
      }
      dates[f] = d;
    }

    const between = (label, a, b) => {
      if (dates[a] && dates[b] && dates[a] > dates[b]) {
        err(file, `${ctx} ${p.id}: ${a} > ${b}`);
      }
    };
    between('order', 'start', 'end');
    between('order', 'start', 'lectureEnd');
    between('order', 'lectureEnd', 'end');
    between('order', 'examStart', 'examEnd');
    between('order', 'reExamStart', 'reExamEnd');
  });
}

// ---------- program data file ----------

// Full-time study is 15 hp per period. A programme's courses should therefore
// add up to 15 in every (inriktning, year, period) cell, and a shortfall is a
// reliable signal that something is missing from the data rather than from the
// programme — most often the space for valfria kurser, which the study-plan page
// states in prose ("Utrymmet för valfria kurser är 7,5 hp per period hela
// läsåret") but does not list as courses.
//
// Counting rules that matter:
//   * An optionGroup counts once; its member courses do not, because the student
//     takes one of them. Counting both double-counts the whole group.
//   * A course tagged with `specializations` counts only for those inriktningar,
//     and `periodCreditsBySpecialization` overrides its layout for one of them.
//   * A by-year course contributes to each year it names.
//
// A shortfall is reported as a warning, not an error: a programme may legitimately
// leave a period light, and the curated files are the authority. An excess is
// reported too but reads differently — a small one is usually a genuinely optional
// extra course (CTFYS year 1 P1 is 16.5 because DD1301 is 1.5 hp and optional),
// while a large one means double counting or untagged inriktningar.
const FULL_TIME_HP = 15;
// PERIOD_IDS is a Set (used for membership tests elsewhere); the load check needs
// a stable order, so keep an ordered copy rather than relying on Set iteration.
const PERIODS_ORDERED = ['P1', 'P2', 'P3', 'P4'];
const LOAD_TOLERANCE = 0.01;
const LOAD_EXCESS_NOTEWORTHY = 3; // hp over full-time before it looks structural

function periodCreditMaps(entry) {
  const pc = entry.periodCredits || {};
  if (Object.keys(pc).some((k) => /^Year\d+$/i.test(k))) {
    const out = {};
    for (const [k, v] of Object.entries(pc)) out[Number(k.slice(4))] = v;
    return out;
  }
  return { [entry.year ?? 1]: pc };
}

function checkFullTimeLoad(program, data, file) {
  // Collected per lane first, then reported. Programmes with many inriktningar
  // often give every lane an identical load — CMAST has 17, and all 17 produced
  // the same year-2 and year-3 numbers, i.e. 34 identical warnings saying one
  // thing. Identical lanes are merged into a single line.
  const collected = [];
  const groups = data.filter((e) => e?.type === 'optionGroup');
  const optionMembers = new Set(groups.flatMap((g) => g.options || []));
  const specs = (program.specializations || []).map((x) => x?.code).filter(Boolean);
  // No inriktningar declared: one pass over everything.
  const lanes = specs.length > 0 ? specs : [null];

  for (const spec of lanes) {
    const totals = new Map(); // "year|period" -> hp
    for (const entry of data) {
      if (!entry || entry.type === 'cohortMeta') continue;
      const entrySpecs = entry.specializations;
      if (Array.isArray(entrySpecs) && entrySpecs.length > 0) {
        if (spec == null || !entrySpecs.includes(spec)) continue;
      }
      if (entry.type !== 'optionGroup' && optionMembers.has(entry.code)) continue;

      const override = spec != null
        ? (entry.periodCreditsBySpecialization || {})[spec]
        : null;
      for (const [year, map] of Object.entries(periodCreditMaps(entry))) {
        const use = override || map || {};
        for (const pid of PERIODS_ORDERED) {
          const v = Number(use[pid] || 0);
          if (v > 0) {
            const key = `${year}|${pid}`;
            totals.set(key, (totals.get(key) || 0) + v);
          }
        }
      }
    }
    if (totals.size === 0) continue;

    // One warning per (year, inriktning) rather than per period: a year that is
    // short is short as a unit, and four near-identical lines per year buried the
    // signal — six programmes across five cohort files produced over 400 of them.
    const years = [...new Set([...totals.keys()].map((k) => Number(k.split('|')[0])))].sort((a, b) => a - b);
    for (const year of years) {
      const load = PERIODS_ORDERED.map((pid) => round(totals.get(`${year}|${pid}`) || 0));
      const scheduled = load.filter((hp) => hp > 0);
      if (scheduled.length === 0) continue;
      const short = [];
      const over = [];
      PERIODS_ORDERED.forEach((pid, i) => {
        if (load[i] === 0) return; // a period with nothing scheduled is not a shortfall
        const diff = round(load[i] - FULL_TIME_HP);
        if (diff < -LOAD_TOLERANCE) short.push(`${pid} ${-diff}`);
        else if (diff >= LOAD_EXCESS_NOTEWORTHY) over.push(`${pid} +${diff}`);
      });
      if (short.length === 0 && over.length === 0) continue;
      let msg;
      if (short.length > 0 && over.length > 0) {
        msg = `load ${load.join('/')} hp — short in ${short.join(', ')} and over in ${over.join(', ')}; a mixed year usually means a "minst N hp ur grupp" pool the schema cannot express`;
      } else if (short.length > 0) {
        msg = `load ${load.join('/')} hp — short of full-time (${FULL_TIME_HP} hp) in ${short.join(', ')} hp; likely the missing space for valfria kurser`;
      } else {
        msg = `load ${load.join('/')} hp — over full-time in ${over.join(', ')} hp; check for double-counted option groups or courses not tagged with an inriktning`;
      }
      collected.push({ year, spec, msg });
    }
  }

  // Merge lanes that say exactly the same thing about the same year.
  const byMessage = new Map();
  for (const c of collected) {
    const k = `${c.year}|${c.msg}`;
    if (!byMessage.has(k)) byMessage.set(k, { ...c, specs: [] });
    if (c.spec) byMessage.get(k).specs.push(c.spec);
  }
  const laneCount = lanes.length;
  for (const item of byMessage.values()) {
    const all = item.specs.length > 0 && item.specs.length === laneCount;
    const label = item.specs.length === 0 ? ''
      : all ? ' [all inriktningar]'
        : ` [${item.specs.join(', ')}]`;
    warn(file, `year ${item.year}${label}: ${item.msg}`);
  }
}

function validateProgramData(program, file) {
  const data = loadJson(file);
  if (!Array.isArray(data)) { if (data != null) err(file, 'expected an array'); return; }

  checkFullTimeLoad(program, data, file);

  const courseCodes = new Set();
  const optionGroupNames = new Set();

  // Specializations registry from programs.json (may be undefined). When
  // undefined or empty, no entry in this file is allowed to carry the
  // `specializations` field — catches typos before they confuse the UI.
  const specCodes = Array.isArray(program.specializations)
    ? new Set(program.specializations.map(s => s?.code).filter(Boolean))
    : new Set();
  const specsDeclared = specCodes.size > 0;

  data.forEach((entry, i) => {
    const ctx = `[${i}]`;
    if (entry?.type === 'cohortMeta') {
      validateCohortMeta(entry, program, ctx, file, i);
    } else if (entry?.type === 'optionGroup') {
      validateOptionGroup(entry, ctx, file);
      if (entry.name) {
        if (optionGroupNames.has(entry.name)) {
          err(file, `${ctx}: duplicate option group name '${entry.name}'`);
        }
        optionGroupNames.add(entry.name);
      }
    } else {
      validateCourse(entry, ctx, file);
      if (entry?.code) {
        if (courseCodes.has(entry.code)) {
          err(file, `${ctx}: duplicate course code '${entry.code}' (HomeClient.tsx merges them, summing credits silently)`);
        }
        courseCodes.add(entry.code);
      }
    }
  });

  // Cross-reference checks.
  data.forEach((entry, i) => {
    const ctx = `[${i}]`;

    // Specializations: every code on a course/option-group must reference
    // the program's registry. When the program declares none, no entry may
    // carry the field at all.
    if (entry && Array.isArray(entry.specializations)) {
      const ownerLabel = entry?.type === 'optionGroup'
        ? `optionGroup '${entry.name}'`
        : (entry.code || '<unknown>');
      if (!specsDeclared) {
        err(file, `${ctx} ${ownerLabel}: 'specializations' is set but program '${program.code}' has no specializations registered in programs.json`);
      } else {
        for (const sc of entry.specializations) {
          if (typeof sc !== 'string' || !specCodes.has(sc)) {
            err(file, `${ctx} ${ownerLabel}: unknown specialization code '${sc}' (allowed: ${[...specCodes].join(', ')})`);
          }
        }
      }
    }

    if (entry?.type === 'optionGroup') {
      (entry.options || []).forEach(opt => {
        if (!courseCodes.has(opt)) {
          err(file, `${ctx} optionGroup '${entry.name}': option '${opt}' is not a course in this file`);
        }
      });
    } else if (entry?.code) {
      const allPrereqs = [
        ...(entry.prerequisites || []),
        ...(entry.prerequisitesCompleted || []),
        ...(entry.prerequisitesParticipation || []),
      ];
      for (const pr of allPrereqs) {
        if (!courseCodes.has(pr)) {
          warn(file, `${ctx} ${entry.code}: prerequisite '${pr}' not found in file (will be silently skipped at render time)`);
        }
      }
      if (entry.prerequisites?.length && entry.prerequisitesCompleted?.length) {
        warn(file, `${ctx} ${entry.code}: both 'prerequisites' and 'prerequisitesCompleted' set; the merge logic in HomeClient.tsx silently drops 'prerequisites' in this case`);
      }
    }
  });

  // Cosmetics
  if (program.cosmeticsFile) {
    const cosmeticsPath = join(dataDir, program.cosmeticsFile);
    const cosmetics = loadJson(cosmeticsPath);
    if (cosmetics != null) validateCosmetics(cosmetics, cosmeticsPath, courseCodes);
  }
}

function validateCourse(c, ctx, file) {
  if (!c || typeof c !== 'object') { err(file, `${ctx}: not an object`); return; }
  if (!c.code || typeof c.code !== 'string') err(file, `${ctx}: missing or invalid 'code'`);
  if (!c.name || typeof c.name !== 'string') err(file, `${ctx} ${c.code || ''}: missing or invalid 'name'`);

  if (typeof c.totalCredits !== 'number') {
    err(file, `${ctx} ${c.code}: missing or invalid 'totalCredits'`);
  }

  if (!c.periodCredits || typeof c.periodCredits !== 'object') {
    err(file, `${ctx} ${c.code}: missing or invalid 'periodCredits'`);
    return;
  }

  const keys = Object.keys(c.periodCredits);
  const yearKeys = keys.filter(k => /^Year\d+$/.test(k));
  const periodKeys = keys.filter(k => PERIOD_IDS.has(k));
  const otherKeys = keys.filter(k => !yearKeys.includes(k) && !periodKeys.includes(k));

  for (const k of otherKeys) {
    err(file, `${ctx} ${c.code}: unknown periodCredits key '${k}' (expected 'P1'..'P4' or 'Year<n>')`);
  }
  if (yearKeys.length > 0 && periodKeys.length > 0) {
    err(file, `${ctx} ${c.code}: 'periodCredits' mixes flat (P1..P4) and year-keyed (Year<n>) shapes`);
    return;
  }

  const sumPerYear = {};
  if (yearKeys.length > 0) {
    for (const yk of yearKeys) {
      const yearNum = Number(yk.slice(4));
      const periods = c.periodCredits[yk];
      if (!periods || typeof periods !== 'object') {
        err(file, `${ctx} ${c.code}.${yk}: not an object`);
        continue;
      }
      let sum = 0;
      for (const [pid, val] of Object.entries(periods)) {
        if (!PERIOD_IDS.has(pid)) {
          err(file, `${ctx} ${c.code}.${yk}: invalid period '${pid}'`);
          continue;
        }
        if (typeof val !== 'number' || Number.isNaN(val)) {
          err(file, `${ctx} ${c.code}.${yk}.${pid}: not a number`);
        } else if (val < 0) {
          err(file, `${ctx} ${c.code}.${yk}.${pid}: credits must be ≥ 0`);
        } else {
          sum += val;
        }
      }
      sumPerYear[yearNum] = (sumPerYear[yearNum] || 0) + sum;
    }
  } else {
    let sum = 0;
    for (const [pid, val] of Object.entries(c.periodCredits)) {
      if (!PERIOD_IDS.has(pid)) continue; // already reported above
      if (typeof val !== 'number' || Number.isNaN(val)) {
        err(file, `${ctx} ${c.code}.${pid}: not a number`);
      } else if (val < 0) {
        err(file, `${ctx} ${c.code}.${pid}: credits must be ≥ 0`);
      } else {
        sum += val;
      }
    }
    const year = c.year || 1;
    sumPerYear[year] = sum;
    if (c.year != null && (typeof c.year !== 'number' || c.year < 1 || !Number.isInteger(c.year))) {
      err(file, `${ctx} ${c.code}: 'year' must be a positive integer`);
    }
  }

  // Sum across all years should match totalCredits.
  if (typeof c.totalCredits === 'number') {
    const totalSum = Object.values(sumPerYear).reduce((a, b) => a + b, 0);
    if (Math.abs(totalSum - c.totalCredits) > CREDIT_TOLERANCE) {
      err(file, `${ctx} ${c.code}: Σ periodCredits = ${round(totalSum)} ≠ totalCredits = ${c.totalCredits}`);
    }
  }

  // Per-specialization period override. The renderer applies the override
  // when the user picks an inriktning whose code matches a key here. Flat
  // shape only; multi-year overrides aren't modelled yet.
  if (c.periodCreditsBySpecialization !== undefined) {
    if (!c.periodCreditsBySpecialization || typeof c.periodCreditsBySpecialization !== 'object') {
      err(file, `${ctx} ${c.code}: 'periodCreditsBySpecialization' must be an object`);
    } else if (yearKeys.length > 0) {
      err(file, `${ctx} ${c.code}: 'periodCreditsBySpecialization' is not supported on courses that use the by-year periodCredits shape`);
    } else if (!Array.isArray(c.specializations) || c.specializations.length === 0) {
      err(file, `${ctx} ${c.code}: 'periodCreditsBySpecialization' requires a non-empty 'specializations' array on the course`);
    } else {
      const ownSpecs = new Set(c.specializations);
      for (const [specCode, periods] of Object.entries(c.periodCreditsBySpecialization)) {
        const sctx = `${ctx} ${c.code}.periodCreditsBySpecialization.${specCode}`;
        if (!ownSpecs.has(specCode)) {
          err(file, `${sctx}: '${specCode}' is not in this course's specializations (${[...ownSpecs].join(', ')})`);
          continue;
        }
        if (!periods || typeof periods !== 'object') {
          err(file, `${sctx}: must be an object`);
          continue;
        }
        let sum = 0;
        for (const [pid, val] of Object.entries(periods)) {
          if (!PERIOD_IDS.has(pid)) {
            err(file, `${sctx}: unknown period '${pid}' (expected P1..P4)`);
            continue;
          }
          if (typeof val !== 'number' || Number.isNaN(val) || val < 0) {
            err(file, `${sctx}.${pid}: credits must be a non-negative number`);
          } else {
            sum += val;
          }
        }
        if (typeof c.totalCredits === 'number' && Math.abs(sum - c.totalCredits) > CREDIT_TOLERANCE) {
          err(file, `${sctx}: Σ = ${round(sum)} ≠ totalCredits = ${c.totalCredits}`);
        }
      }
    }
  }

  // ----- rounds (alternative offerings in one academic year) -----
  //
  // The invariant that matters: every round is the WHOLE course, so each one's
  // periods must sum to totalCredits. That is precisely what the old union
  // violated — DD1380's four 1.5 hp offerings were merged into a 6 hp bar — so
  // this check is what stops the same mistake reaching a data file again.
  if (c.rounds !== undefined) {
    if (!Array.isArray(c.rounds) || c.rounds.length === 0) {
      err(file, `${ctx} ${c.code}: 'rounds' must be a non-empty array when present`);
    } else {
      const seenIds = new Set();
      c.rounds.forEach((r, i) => {
        const rctx = `${ctx} ${c.code}.rounds[${i}]`;
        if (!r || typeof r !== 'object') { err(file, `${rctx}: must be an object`); return; }
        // `P3`, or `P1-3` when two offerings start in the same period and are
        // told apart by the credits there (CTMAT's SE1010: P1+P2 as 3+9 and
        // 6+6). The base before the dash is the round's first teaching period.
        const idBase = typeof r.id === 'string' ? r.id.split('-')[0] : null;
        if (!idBase || !PERIOD_IDS.has(idBase)) {
          err(file, `${rctx}: 'id' must be P1..P4, optionally suffixed '-<hp>' (got ${JSON.stringify(r.id)})`);
        } else if (seenIds.has(r.id)) {
          err(file, `${rctx}: duplicate round id '${r.id}' — ids address a round in the URL, so they must be unique`);
        } else {
          seenIds.add(r.id);
        }
        if (!r.periodCredits || typeof r.periodCredits !== 'object') {
          err(file, `${rctx}: missing 'periodCredits'`);
          return;
        }
        let sum = 0;
        for (const [pid, val] of Object.entries(r.periodCredits)) {
          if (!PERIOD_IDS.has(pid)) {
            err(file, `${rctx}: unknown period '${pid}' (expected P1..P4)`);
          } else if (typeof val !== 'number' || Number.isNaN(val) || val < 0) {
            err(file, `${rctx}.${pid}: credits must be a non-negative number`);
          } else {
            sum += val;
          }
        }
        if (typeof c.totalCredits === 'number' && Math.abs(sum - c.totalCredits) > CREDIT_TOLERANCE) {
          err(file, `${rctx}: Σ periodCredits = ${round(sum)} ≠ totalCredits = ${c.totalCredits} — ` +
            `a round is one whole offering of the course, not a share of it`);
        }
        if (idBase && r.periodCredits && (r.periodCredits[idBase] || 0) <= 0) {
          err(file, `${rctx}: id '${r.id}' but no credits in ${idBase} — the id must start with the round's first teaching period`);
        }
        validatePeriodList(r.exams, `rounds[${i}].exams`, c, ctx, file);
        validatePeriodList(r.reexams, `rounds[${i}].reexams`, c, ctx, file);
      });
      // The flat `periodCredits` must mirror one of the rounds, so a consumer
      // that ignores `rounds` still draws a real offering rather than a shape
      // that exists nowhere in KTH's catalogue.
      const flatShape = c.periodCredits
        && !Object.keys(c.periodCredits).some((k) => /^Year\d+$/i.test(k));
      if (flatShape) {
        const key = (pc) => [...PERIOD_IDS].sort().map((p) => round(pc?.[p] || 0)).join('/');
        const flat = key(c.periodCredits);
        if (!c.rounds.some((r) => key(r.periodCredits) === flat)) {
          err(file, `${ctx} ${c.code}: 'periodCredits' matches no entry in 'rounds' — ` +
            `it must be a copy of the default offering`);
        }
      }
    }
  }

  validatePeriodList(c.exams, 'exams', c, ctx, file);
  validatePeriodList(c.reexams, 'reexams', c, ctx, file);
  validateOptionalEnum(c.category, 'category', COURSE_CATEGORIES, c.code, ctx, file);
  validateOptionalEnum(c.gradingScale, 'gradingScale', GRADING_SCALES, c.code, ctx, file);
  validateOptionalEnum(c.courseLevel, 'courseLevel', COURSE_LEVELS, c.code, ctx, file);
  validateReexamConsistency(c, ctx, file);
}

// Per *Riktlinje om läsårets förläggning* (V-2019-0109) §1.1, the re-exam slot
// is fixed by the ordinary exam period. The loader therefore defaults `reexams`
// to `exams` when the field is omitted; authors only need to set `reexams` to
// add EXTRA tillfällen beyond the default.
//
// This check warns when the JSON contains a `reexams` value that is either
// redundant (matches `exams` exactly) or insufficient (a strict subset of
// `exams`). Supersets — i.e. extra slots — pass without complaint.
function validateReexamConsistency(c, ctx, file) {
  if (c.reexams === undefined || c.reexams === null) return; // using default

  const examPairs = collectPeriodPairs(c.exams, c.year);
  const reexamPairs = collectPeriodPairs(c.reexams, c.year);
  if (examPairs == null || reexamPairs == null) return; // structural error already reported

  const sameSet = examPairs.size === reexamPairs.size && [...examPairs].every(p => reexamPairs.has(p));
  if (sameSet) {
    warn(file, `${ctx} ${c.code}: 'reexams' duplicates 'exams' — omit it to use the default per Riktlinje om läsårets förläggning §1.1`);
    return;
  }
  const missing = [...examPairs].filter(p => !reexamPairs.has(p));
  if (missing.length > 0) {
    warn(file, `${ctx} ${c.code}: 'reexams' is missing slot(s) [${missing.join(', ')}] that exist in 'exams' — per Riktlinje om läsårets förläggning §2.1 every written exam should have ≥2 tillfällen per läsår`);
  }
}

// Collect (year, period) pairs from an exams/reexams field. Accepts a flat
// array (uses the course's top-level year) or a Year<n>-keyed object.
// Returns null on shapes the structural validator would already have flagged.
function collectPeriodPairs(value, fallbackYear) {
  const out = new Set();
  if (Array.isArray(value)) {
    const y = fallbackYear || 1;
    for (const p of value) {
      if (typeof p === 'string') out.add(`Year${y}.${p}`);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [yk, arr] of Object.entries(value)) {
      if (!Array.isArray(arr)) return null;
      const y = Number(String(yk).replace(/\D/g, '')) || 1;
      for (const p of arr) {
        if (typeof p === 'string') out.add(`Year${y}.${p}`);
      }
    }
    return out;
  }
  return null;
}

function validateOptionalEnum(value, fieldName, allowed, codeOrName, ctx, file) {
  if (value == null) return;
  if (!allowed.has(value)) {
    err(file, `${ctx} ${codeOrName}: invalid '${fieldName}' '${value}' (allowed: ${[...allowed].join(', ')})`);
  }
}

function validatePeriodList(value, fieldName, c, ctx, file) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (!PERIOD_IDS.has(v)) err(file, `${ctx} ${c.code}.${fieldName}: invalid period '${v}'`);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [yk, arr] of Object.entries(value)) {
      if (!/^Year\d+$/.test(yk)) {
        err(file, `${ctx} ${c.code}.${fieldName}: invalid year key '${yk}'`);
        continue;
      }
      if (!Array.isArray(arr)) {
        err(file, `${ctx} ${c.code}.${fieldName}.${yk}: expected array of period ids`);
        continue;
      }
      for (const v of arr) {
        if (!PERIOD_IDS.has(v)) err(file, `${ctx} ${c.code}.${fieldName}.${yk}: invalid period '${v}'`);
      }
    }
    return;
  }
  err(file, `${ctx} ${c.code}: '${fieldName}' must be an array or year-keyed object`);
}

// Provenance header written by scripts/extract-from-kopps.mjs into each
// src/data/cohorts/<PROG>-HT<year>.json. It records, per study year, which
// cohort the data actually came from — KTH deletes past läsår and leaves future
// ones unscheduled, so a cohort's own plan is usually stitched from neighbours.
// The UI needs this to tell a student which years are really theirs.
function validateCohortMeta(m, program, ctx, file, index) {
  if (index !== 0) {
    err(file, `${ctx}: 'cohortMeta' must be the first entry (loaders read it before the courses)`);
  }
  if (m.program !== program.code) {
    err(file, `${ctx} cohortMeta: 'program' is '${m.program}' but this file is validated against '${program.code}'`);
  }
  if (!/^HT\d{4}$/.test(m.cohort || '')) {
    err(file, `${ctx} cohortMeta: 'cohort' must look like 'HT2023', got '${m.cohort}'`);
  }
  if (!Array.isArray(m.years) || m.years.length === 0) {
    err(file, `${ctx} cohortMeta: 'years' must be a non-empty array`);
    return;
  }
  const seen = new Set();
  m.years.forEach((y, j) => {
    const yctx = `${ctx}.years[${j}]`;
    if (!Number.isInteger(y?.year) || y.year < 1) {
      err(file, `${yctx}: 'year' must be a positive integer`);
    } else if (seen.has(y.year)) {
      err(file, `${yctx}: duplicate entry for year ${y.year}`);
    } else {
      seen.add(y.year);
    }
    if (typeof y?.approximated !== 'boolean') {
      err(file, `${yctx}: 'approximated' must be a boolean`);
    }
    // sourceCohort may be null, meaning no cohort published that year at all.
    if (y?.sourceCohort != null && !/^HT\d{4}$/.test(y.sourceCohort)) {
      err(file, `${yctx}: 'sourceCohort' must be 'HT<year>' or null, got '${y.sourceCohort}'`);
    }
    // The two must agree, or the UI would mark the wrong years.
    if (y?.sourceCohort != null && (y.sourceCohort === m.cohort) !== (y.approximated === false)) {
      err(file, `${yctx}: 'approximated' (${y.approximated}) contradicts sourceCohort '${y.sourceCohort}' vs cohort '${m.cohort}'`);
    }
    if (y?.confidence != null && !COHORT_CONFIDENCE.has(y.confidence)) {
      err(file, `${yctx}: 'confidence' must be one of ${[...COHORT_CONFIDENCE].join(', ')}`);
    }
    if (y?.approximated && y.confidence === 'low') {
      warn(file, `${yctx}: year ${y.year} borrowed from ${y.sourceCohort} and corroboration DISAGREED — verify against the study plan`);
    }
  });
}

function validateOptionGroup(og, ctx, file) {
  if (og.type !== 'optionGroup') err(file, `${ctx}: type must be 'optionGroup'`);
  if (!og.name || typeof og.name !== 'string') err(file, `${ctx}: missing or invalid 'name'`);
  if (typeof og.year !== 'number' || og.year < 1) {
    err(file, `${ctx} optionGroup '${og.name}': missing or invalid 'year'`);
  }
  if (typeof og.totalCredits !== 'number') {
    err(file, `${ctx} optionGroup '${og.name}': missing or invalid 'totalCredits'`);
  }
  if (typeof og.allowedNumberOfOptions !== 'number' || og.allowedNumberOfOptions < 1) {
    err(file, `${ctx} optionGroup '${og.name}': 'allowedNumberOfOptions' must be a positive number`);
  }
  if (!Array.isArray(og.options) || og.options.length === 0) {
    err(file, `${ctx} optionGroup '${og.name}': 'options' must be a non-empty array of course codes`);
  } else if (og.allowedNumberOfOptions > og.options.length) {
    err(file, `${ctx} optionGroup '${og.name}': allowedNumberOfOptions (${og.allowedNumberOfOptions}) > options.length (${og.options.length})`);
  }

  // 'kind' discriminator (introduced for minCredits-style groups). When
  // omitted, the group is treated as 'pickN' with N = allowedNumberOfOptions.
  if (og.kind != null) {
    if (og.kind !== 'pickN' && og.kind !== 'minCredits') {
      err(file, `${ctx} optionGroup '${og.name}': 'kind' must be 'pickN' or 'minCredits'`);
    } else if (og.kind === 'pickN') {
      if (og.pickN != null && (typeof og.pickN !== 'number' || og.pickN < 1)) {
        err(file, `${ctx} optionGroup '${og.name}': 'pickN' must be a positive integer`);
      }
      if (og.minCredits != null) {
        warn(file, `${ctx} optionGroup '${og.name}': 'minCredits' is ignored when kind === 'pickN'`);
      }
    } else if (og.kind === 'minCredits') {
      if (typeof og.minCredits !== 'number' || og.minCredits < 1) {
        err(file, `${ctx} optionGroup '${og.name}': 'minCredits' is required (≥ 1) when kind === 'minCredits'`);
      } else if (typeof og.totalCredits === 'number' && og.totalCredits < og.minCredits) {
        err(file, `${ctx} optionGroup '${og.name}': totalCredits (${og.totalCredits}) < minCredits (${og.minCredits}); the placeholder cannot fit the requirement`);
      }
      if (og.pickN != null) {
        warn(file, `${ctx} optionGroup '${og.name}': 'pickN' is ignored when kind === 'minCredits'`);
      }
    }
  } else if (og.pickN != null || og.minCredits != null) {
    warn(file, `${ctx} optionGroup '${og.name}': 'pickN' / 'minCredits' set without an explicit 'kind' — set kind: 'pickN' or 'minCredits' to use them`);
  }

  // A group's free-text note. Optional, but must be a non-empty string when set —
  // an empty one renders as a blank italic line in the modal.
  for (const field of ['comment', 'commentEn']) {
    if (og[field] != null && (typeof og[field] !== 'string' || og[field].trim() === '')) {
      err(file, `${ctx} optionGroup '${og.name}': '${field}' must be a non-empty string when set`);
    }
  }

  // `qualifiesFor` maps an option to the master programmes requiring it, read
  // from the study plan. A code that is not one of this group's options would
  // render nowhere, so it is an error rather than a warning.
  if (og.qualifiesFor != null) {
    if (typeof og.qualifiesFor !== 'object' || Array.isArray(og.qualifiesFor)) {
      err(file, `${ctx} optionGroup '${og.name}': 'qualifiesFor' must be an object keyed by course code`);
    } else {
      for (const [code, masters] of Object.entries(og.qualifiesFor)) {
        if (Array.isArray(og.options) && !og.options.includes(code)) {
          err(file, `${ctx} optionGroup '${og.name}': qualifiesFor names '${code}', which is not one of its options`);
        }
        if (!Array.isArray(masters) || masters.length === 0) {
          err(file, `${ctx} optionGroup '${og.name}': qualifiesFor['${code}'] must be a non-empty array`);
          continue;
        }
        for (const m of masters) {
          if (!m || typeof m.code !== 'string' || !/^[A-Z]{4,6}$/.test(m.code)) {
            err(file, `${ctx} optionGroup '${og.name}': qualifiesFor['${code}'] entry needs a programme 'code' of 4-6 capitals`);
          }
          if (!m || typeof m.name !== 'string' || !m.name) {
            err(file, `${ctx} optionGroup '${og.name}': qualifiesFor['${code}'] entry needs a 'name'`);
          }
          if (m?.track != null && m?.tracks != null) {
            warn(file, `${ctx} optionGroup '${og.name}': qualifiesFor['${code}'] sets both 'track' and 'tracks' — use one`);
          }
        }
      }
      // The count a student must take is implied by the per-master requirements
      // when the plan states no rule of its own; flag a group whose pickN cannot
      // satisfy the master needing the most, since such a plan is unfollowable.
      const perMaster = new Map();
      for (const [, masters] of Object.entries(og.qualifiesFor)) {
        for (const m of Array.isArray(masters) ? masters : []) {
          const key = `${m?.code}::${m?.track ?? ''}`;
          perMaster.set(key, (perMaster.get(key) ?? 0) + 1);
        }
      }
      const most = Math.max(0, ...perMaster.values());
      const allowed = og.kind === 'minCredits' ? Infinity : (og.pickN ?? og.allowedNumberOfOptions ?? 1);
      if (most > allowed) {
        warn(file, `${ctx} optionGroup '${og.name}': a master programme requires ${most} of these options but the group allows ${allowed} — a student heading there cannot follow this plan`);
      }
    }
  }

  if (og.periodCredits && typeof og.periodCredits === 'object') {
    let sum = 0;
    for (const [pid, val] of Object.entries(og.periodCredits)) {
      if (!PERIOD_IDS.has(pid)) {
        err(file, `${ctx} optionGroup '${og.name}': invalid period '${pid}'`);
        continue;
      }
      if (typeof val !== 'number' || Number.isNaN(val)) {
        err(file, `${ctx} optionGroup '${og.name}'.${pid}: not a number`);
      } else if (val < 0) {
        err(file, `${ctx} optionGroup '${og.name}'.${pid}: credits must be ≥ 0`);
      } else {
        sum += val;
      }
    }
    if (typeof og.totalCredits === 'number' && Math.abs(sum - og.totalCredits) > CREDIT_TOLERANCE) {
      err(file, `${ctx} optionGroup '${og.name}': Σ periodCredits = ${round(sum)} ≠ totalCredits = ${og.totalCredits}`);
    }
  } else {
    err(file, `${ctx} optionGroup '${og.name}': missing or invalid 'periodCredits'`);
  }

  validatePeriodList(og.exams, 'exams', { code: `optionGroup '${og.name}'` }, ctx, file);
  validatePeriodList(og.reexams, 'reexams', { code: `optionGroup '${og.name}'` }, ctx, file);
  validateOptionalEnum(og.category, 'category', COURSE_CATEGORIES, `optionGroup '${og.name}'`, ctx, file);
  validateOptionalEnum(og.gradingScale, 'gradingScale', GRADING_SCALES, `optionGroup '${og.name}'`, ctx, file);
}

function validateCosmetics(cosmetics, file, courseCodes) {
  if (!Array.isArray(cosmetics)) { err(file, 'expected an array'); return; }
  const seenNames = new Set();
  const seenCodes = new Map(); // code -> first group it appeared in
  cosmetics.forEach((g, i) => {
    const ctx = `[${i}]`;
    if (!g.name || typeof g.name !== 'string') err(file, `${ctx}: missing or invalid 'name'`);
    if (!g.colorFamily) err(file, `${ctx} group '${g.name}': missing 'colorFamily'`);
    else if (!COLOR_FAMILIES.has(g.colorFamily)) {
      err(file, `${ctx} group '${g.name}': invalid colorFamily '${g.colorFamily}' (allowed: ${[...COLOR_FAMILIES].join(', ')})`);
    }
    if (g.name) {
      if (seenNames.has(g.name)) err(file, `${ctx}: duplicate group name '${g.name}'`);
      seenNames.add(g.name);
    }

    if (!Array.isArray(g.courses)) {
      err(file, `${ctx} group '${g.name}': 'courses' must be an array`);
      return;
    }
    for (const code of g.courses) {
      if (!courseCodes.has(code)) {
        warn(file, `${ctx} group '${g.name}': course '${code}' not found in program data file`);
      }
      if (seenCodes.has(code)) {
        warn(file, `${ctx} group '${g.name}': course '${code}' is also in group '${seenCodes.get(code)}' (the last one wins)`);
      } else {
        seenCodes.set(code, g.name);
      }
    }
  });
}

function round(x) { return Math.round(x * 100) / 100; }


// ---------- transition plans ----------
//
// A COPEN student takes one year of COPEN and then two years of the programme
// they transfer into. src/data/transitions.json records the *difference* from
// the target's published plan rather than a combined course list, so these
// checks exist to catch the plan drifting out of step with either programme's
// data — which is exactly what a hand-written combined list would hide.
function validateTransitions(plans, file, programs, coursesByProgram) {
  if (!Array.isArray(plans)) { err(file, 'expected an array of transition plans'); return; }
  const seen = new Set();

  plans.forEach((plan, i) => {
    const ctx = `[${i}]`;
    if (!plan || typeof plan !== 'object') { err(file, `${ctx} not an object`); return; }
    const label = `${plan.from} -> ${plan.to}`;

    for (const field of ['from', 'to']) {
      if (typeof plan[field] !== 'string' || !plan[field]) {
        err(file, `${ctx} '${field}' must be a non-empty string`);
        return;
      }
      if (!programs.some((p) => p?.code === plan[field])) {
        err(file, `${ctx} ${label}: '${plan[field]}' is not a program in programs.json`);
      }
    }
    if (plan.from === plan.to) err(file, `${ctx} ${label}: 'from' and 'to' are the same program`);

    const key = `${plan.from}->${plan.to}`;
    if (seen.has(key)) err(file, `${ctx} duplicate plan for ${label}`);
    seen.add(key);

    if (!Array.isArray(plan.sourceYears) || plan.sourceYears.length === 0
        || plan.sourceYears.some((y) => !Number.isInteger(y) || y < 1)) {
      err(file, `${ctx} ${label}: 'sourceYears' must be a non-empty array of positive integers`);
      return;
    }
    if (!Array.isArray(plan.credited) || plan.credited.some((c) => !c || typeof c.code !== 'string')) {
      err(file, `${ctx} ${label}: 'credited' must be an array of { code, replaces? } objects`);
      return;
    }

    const src = coursesByProgram.get(plan.from);
    const tgt = coursesByProgram.get(plan.to);
    if (!src || !tgt) {
      warn(file, `${ctx} ${label}: could not load course data for both programs — skipped the cross-checks`);
      return;
    }

    // `credited` must match what the source programme actually teaches in those
    // years, in both directions. A course added to COPEN that nobody added here
    // would otherwise be silently dropped from the composed plan.
    const inSourceYears = new Set(
      [...src.values()].filter((c) => plan.sourceYears.includes(c.year)).map((c) => c.code));
    const creditedCodes = plan.credited.map((c) => c.code);
    for (const code of creditedCodes) {
      if (!inSourceYears.has(code)) {
        err(file, `${ctx} ${label}: credits '${code}', which is not in ${plan.from} year ${plan.sourceYears.join('/')}`);
      }
    }
    for (const code of inSourceYears) {
      if (!creditedCodes.includes(code)) {
        warn(file, `${ctx} ${label}: ${plan.from} year ${plan.sourceYears.join('/')} teaches '${code}' but the plan does not credit it — plan may be out of date`);
      }
    }

    // `replaces` drives the prerequisite rewrite, so a wrong code here shows up
    // as a silently missing arrow rather than an error. Check both ends.
    const replacedBy = new Map();
    for (const credit of plan.credited) {
      for (const target of credit.replaces ?? []) {
        if (!tgt.has(target)) {
          err(file, `${ctx} ${label}: '${credit.code}' replaces '${target}', which ${plan.to} does not list`);
          continue;
        }
        if (!plan.sourceYears.includes(tgt.get(target).year)) {
          warn(file, `${ctx} ${label}: '${credit.code}' replaces '${target}', which ${plan.to} teaches in year ${tgt.get(target).year} — outside the years the source replaces`);
        }
        if (replacedBy.has(target)) {
          err(file, `${ctx} ${label}: '${target}' is replaced by both '${replacedBy.get(target)}' and '${credit.code}'`);
        }
        replacedBy.set(target, credit.code);
      }
    }

    // Every target-programme prerequisite pointing into the years the source
    // replaces must have an equivalence, or its arrow vanishes from the chart.
    const targetProgram = programs.find((p) => p?.code === plan.to);
    const targetData = targetProgram?.dataFile ? loadJson(join(dataDir, targetProgram.dataFile)) : null;
    if (Array.isArray(targetData)) {
      const exemptCodes = new Set((plan.exempt ?? []).map((e) => e.code));
      for (const e of targetData) {
        if (!e?.code || e.type === 'optionGroup' || e.type === 'cohortMeta') continue;
        const year = tgt.get(e.code)?.year;
        if (year == null || plan.sourceYears.includes(year)) continue;   // not in the student's plan
        if (exemptCodes.has(e.code)) continue;
        const pres = [...(e.prerequisitesCompleted ?? []), ...(e.prerequisitesParticipation ?? []), ...(e.prerequisites ?? [])];
        for (const pre of new Set(pres)) {
          const preYear = tgt.get(pre)?.year;
          if (preYear == null || !plan.sourceYears.includes(preYear)) continue;
          if (!replacedBy.has(pre)) {
            warn(file, `${ctx} ${label}: '${e.code}' requires '${pre}' from ${plan.to} year ${preYear}, which no credited course replaces — its prerequisite arrow will be missing`);
          }
        }
      }
    }

    for (const ex of plan.exempt ?? []) {
      if (!ex || typeof ex.code !== 'string') { err(file, `${ctx} ${label}: 'exempt' entry needs a 'code'`); continue; }
      if (!tgt.has(ex.code)) {
        err(file, `${ctx} ${label}: exempts '${ex.code}', which ${plan.to} does not list`);
      }
      if (ex.creditedBy && !src.has(ex.creditedBy)) {
        err(file, `${ctx} ${label}: '${ex.code}' is credited by '${ex.creditedBy}', which ${plan.from} does not list`);
      }
    }

    for (const mv of plan.moved ?? []) {
      if (!mv || typeof mv.code !== 'string') { err(file, `${ctx} ${label}: 'moved' entry needs a 'code'`); continue; }
      const course = tgt.get(mv.code);
      if (!course) {
        err(file, `${ctx} ${label}: moves '${mv.code}', which ${plan.to} does not list`);
        continue;
      }
      if (course.year !== mv.fromYear) {
        err(file, `${ctx} ${label}: moves '${mv.code}' from year ${mv.fromYear}, but ${plan.to} has it in year ${course.year}`);
      }
      if (plan.sourceYears.includes(mv.toYear)) {
        err(file, `${ctx} ${label}: moves '${mv.code}' into year ${mv.toYear}, which is taken in ${plan.from}`);
      }
      if (mv.toYear <= mv.fromYear) {
        warn(file, `${ctx} ${label}: moves '${mv.code}' from year ${mv.fromYear} to ${mv.toYear} — not a later year, check this is intended`);
      }
    }

    // `added` courses come from a programme this app does not model (SF1920 is
    // taken from CELTE), so there is no third data file to cross-check against.
    // What can be checked is that the embedded course is internally coherent and
    // does not collide with the target's own plan.
    for (const ad of plan.added ?? []) {
      if (!ad || typeof ad.code !== 'string') { err(file, `${ctx} ${label}: 'added' entry needs a 'code'`); continue; }
      if (tgt.has(ad.code)) {
        err(file, `${ctx} ${label}: adds '${ad.code}', which ${plan.to} already lists — it would appear twice`);
      }
      if (src.has(ad.code)) {
        err(file, `${ctx} ${label}: adds '${ad.code}', which the student already took in ${plan.from}`);
      }
      if (typeof ad.totalCredits !== 'number' || ad.totalCredits <= 0) {
        err(file, `${ctx} ${label}: '${ad.code}' needs a positive 'totalCredits'`);
      }
      if (!Number.isInteger(ad.year) || plan.sourceYears.includes(ad.year)) {
        err(file, `${ctx} ${label}: '${ad.code}' has year ${ad.year}, which is not one of the target's own years`);
      }
      const sum = PERIODS_ORDERED.reduce((a, p) => a + (Number(ad.periodCredits?.[p]) || 0), 0);
      if (Math.abs(sum - ad.totalCredits) > CREDIT_TOLERANCE) {
        err(file, `${ctx} ${label}: '${ad.code}' periodCredits sum to ${sum} hp but totalCredits is ${ad.totalCredits}`);
      }
      if (ad.substitutesFor && !tgt.has(ad.substitutesFor)) {
        err(file, `${ctx} ${label}: '${ad.code}' substitutes for '${ad.substitutesFor}', which ${plan.to} does not list`);
      }
      for (const pre of [...(ad.prerequisitesCompleted ?? []), ...(ad.prerequisitesParticipation ?? [])]) {
        if (!src.has(pre) && !tgt.has(pre) && !(plan.added ?? []).some((o) => o.code === pre)) {
          warn(file, `${ctx} ${label}: '${ad.code}' requires '${pre}', which is in neither programme — the arrow will not be drawn`);
        }
      }
    }

    if (plan.verified !== true) {
      warn(file, `${ctx} ${label}: not yet verified — confirm against the program director's transition plan`);
    }
  });
}

// ---------- main ----------

// `--include <PROGRAM>=<path>` validates a data file that is NOT registered in
// programs.json, against that program's registry entry. This is how a candidate
// produced by scripts/extract-from-kopps.mjs gets schema-checked before anyone
// merges it, without first having to point programs.json at unverified data.
// Repeatable. Everything registered in programs.json is still validated too.
const includes = [];
// `--cohorts` validates every src/data/cohorts/<PROG>-HT<year>.json against its
// program's registry entry. The archive is committed data, so CI should check it
// like anything else in src/data.
const validateCohorts = process.argv.includes('--cohorts');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--include') continue;
  const spec = process.argv[++i];
  const eq = spec == null ? -1 : spec.indexOf('=');
  if (eq <= 0) {
    console.error(`  ERROR  --include expects <PROGRAM>=<path>, got '${spec ?? ''}'`);
    process.exit(2);
  }
  includes.push({ code: spec.slice(0, eq).toUpperCase(), path: join(repoRoot, spec.slice(eq + 1)) });
}

console.log('Validating program data files...\n');

const programsFile = join(dataDir, 'programs.json');
const programs = loadJson(programsFile);
if (programs != null) {
  validateProgramsJson(programs, programsFile);
  if (Array.isArray(programs)) {
    for (const p of programs) {
      if (!p?.dataFile) continue;
      const dataPath = join(dataDir, p.dataFile);
      if (!existsSync(dataPath)) continue; // already reported
      console.log(`• ${p.code}`);
      validateProgramData(p, dataPath);
    }

    if (validateCohorts) {
      const dir = join(dataDir, 'cohorts');
      // index.json is the generated list of available cohorts, not a cohort.
      const files = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()
        : [];
      if (files.length === 0) {
        console.log('• cohorts (none found)');
      }
      const indexPath = join(dir, 'index.json');
      if (existsSync(indexPath)) {
        const idx = loadJson(indexPath);
        if (idx && typeof idx === 'object' && !Array.isArray(idx)) {
          for (const [code, list] of Object.entries(idx)) {
            if (!programs.some((p) => p?.code === code)) {
              err(indexPath, `'${code}' is not a program in programs.json`);
            }
            if (!Array.isArray(list)) { err(indexPath, `'${code}' must map to an array`); continue; }
            for (const c of list) {
              if (!files.includes(`${code}-${c}.json`)) {
                err(indexPath, `'${code}' lists ${c} but ${code}-${c}.json is missing — the UI would offer a cohort it cannot load`);
              }
            }
          }
          // And the reverse: a file present but unlisted is invisible to the UI.
          for (const f of files) {
            const m = /^([A-Z0-9]+)-(HT\d{4})\.json$/.exec(f);
            if (m && !(idx[m[1]] || []).includes(m[2])) {
              warn(indexPath, `${f} exists but is not listed — re-run the extractor to refresh the index`);
            }
          }
        } else if (idx != null) {
          err(indexPath, 'expected an object mapping program code to cohort list');
        }
      }

      for (const f of files) {
        // <PROG>-HT<year>.json
        const m = /^([A-Z0-9]+)-HT(\d{4})\.json$/.exec(f);
        if (!m) { err(join(dir, f), 'cohort file name must be <PROGRAM>-HT<year>.json'); continue; }
        const program = programs.find((p) => p?.code === m[1]);
        if (!program) { err(join(dir, f), `no program '${m[1]}' in programs.json`); continue; }
        console.log(`• ${m[1]} HT${m[2]} (cohort archive)`);
        validateProgramData(program, join(dir, f));
      }
    }

    for (const inc of includes) {
      const program = programs.find((p) => p?.code === inc.code);
      if (!program) {
        err(programsFile, `--include ${inc.code}: no program with that code in programs.json`);
        continue;
      }
      if (!existsSync(inc.path)) { err(inc.path, 'file not found (--include)'); continue; }
      console.log(`• ${inc.code} (--include ${rel(inc.path)})`);
      validateProgramData(program, inc.path);
    }
  }
}

// Transition plans need both programmes' course data, so this runs after the
// per-program validation above has already loaded and checked them.
const transitionsFile = join(dataDir, 'transitions.json');
if (existsSync(transitionsFile)) {
  const plans = loadJson(transitionsFile);
  if (plans != null) {
    console.log('• transitions');
    const byProgram = new Map();
    for (const plan of Array.isArray(plans) ? plans : []) {
      for (const code of [plan?.from, plan?.to]) {
        if (!code || byProgram.has(code)) continue;
        const program = programs.find((p) => p?.code === code);
        if (!program?.dataFile) continue;
        const data = loadJson(join(dataDir, program.dataFile));
        if (!Array.isArray(data)) continue;
        const map = new Map();
        for (const e of data) {
          if (e?.code && e.type !== 'optionGroup' && e.type !== 'cohortMeta') {
            // A year-spanning course has no top-level `year`; use its first.
            const spanned = Object.keys(e.periodCredits ?? {})
              .map((k) => /^Year(\d+)$/.exec(k)?.[1])
              .filter(Boolean)
              .map(Number)
              .sort((a, b) => a - b);
            map.set(e.code, { code: e.code, year: e.year ?? spanned[0] ?? null });
          }
        }
        byProgram.set(code, map);
      }
    }
    validateTransitions(plans, transitionsFile, programs, byProgram);
  }
}

const periodsFile = join(dataDir, 'academic-periods.json');
const periods = loadJson(periodsFile);
if (periods != null) {
  console.log('• academic-periods');
  validateAcademicPeriods(periods, periodsFile);
}

console.log();
if (errorCount > 0) {
  console.error(`✗ ${errorCount} error(s), ${warningCount} warning(s).`);
  process.exit(1);
}
if (warningCount > 0) {
  console.log(`✓ Validated with ${warningCount} warning(s).`);
} else {
  console.log('✓ All data files valid.');
}
