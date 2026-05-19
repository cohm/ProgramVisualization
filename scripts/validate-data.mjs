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

import { readFileSync, existsSync } from 'fs';
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

function validateProgramData(program, file) {
  const data = loadJson(file);
  if (!Array.isArray(data)) { if (data != null) err(file, 'expected an array'); return; }

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

// ---------- main ----------

// Parse --include flags. Format: --include <programCode>=<path>
// Validates <path> using the program entry for <programCode> from
// programs.json (so specialization cross-refs etc. still work). Used to
// check candidate JSON produced by scripts/extract-from-ladok.py.
const includes = []; // [{ programCode, path }]
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--include') {
    const next = process.argv[++i];
    if (!next || !next.includes('=')) {
      console.error(`error: --include expects <programCode>=<path>, got '${next ?? ''}'`);
      process.exit(2);
    }
    const [programCode, ...rest] = next.split('=');
    includes.push({ programCode, path: rest.join('=') });
  }
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
  }
}

// Validate any --include candidate files against their programme entry.
for (const inc of includes) {
  const programEntry = Array.isArray(programs)
    ? programs.find(p => p?.code === inc.programCode)
    : null;
  if (!programEntry) {
    err(programsFile, `--include ${inc.programCode}=${inc.path}: no such program in programs.json`);
    continue;
  }
  const candidatePath = join(repoRoot, inc.path);
  if (!existsSync(candidatePath)) {
    err(candidatePath, `--include candidate file not found`);
    continue;
  }
  console.log(`• ${inc.programCode} (candidate ${rel(candidatePath)})`);
  validateProgramData(programEntry, candidatePath);
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
