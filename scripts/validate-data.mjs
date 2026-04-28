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
//   Array<{ code, name, nameEn?, dataFile, cosmeticsFile?, comment?, studyplan? }>
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
//
// <PROGRAM>-cosmetics.json:
//   Array<{ name, nameEn?, colorFamily, courses: Array<courseCode> }>
//   colorFamily ∈ { blue, green, turquoise, brick, yellow }
//
// academic-periods.json:
//   Array<{ id: "P1"..|"P4", start, end, lectureEnd,
//           examStart, examEnd, reExamStart, reExamEnd }>   (ISO date strings)

import { readFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dataDir = join(repoRoot, 'src', 'data');

const PERIOD_IDS = new Set(['P1', 'P2', 'P3', 'P4']);
const COLOR_FAMILIES = new Set(['blue', 'green', 'turquoise', 'brick', 'yellow']);
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

function validateProgramData(program, file) {
  const data = loadJson(file);
  if (!Array.isArray(data)) { if (data != null) err(file, 'expected an array'); return; }

  const courseCodes = new Set();
  const optionGroupNames = new Set();

  data.forEach((entry, i) => {
    const ctx = `[${i}]`;
    if (entry?.type === 'optionGroup') {
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

  validatePeriodList(c.exams, 'exams', c, ctx, file);
  validatePeriodList(c.reexams, 'reexams', c, ctx, file);
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

// ---------- main ----------

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
