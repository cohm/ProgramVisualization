// Loaders that turn the on-disk JSON shape into the in-memory `Course` /
// `OptionGroup` / `ProgramCosmetics` shapes consumed by the visualization.
//
// Despite the name, this module currently only exposes loader functions —
// no React hook. Calling code uses them inside `useEffect` (see HomeClient).
// The "useCourseModel" name is kept as a future affordance: a real
// `useCourseModel(programCode)` hook could wrap these and add SWR-style
// caching/retry without callers needing to change.

import type {
  CohortMeta,
  Course,
  CourseCategory,
  CourseCredit,
  CourseRound,
  GradingScale,
  OptionGroup,
  Period,
} from '@/types/course';
import type { CourseGroup, ProgramCosmetics } from '@/types/cosmetics';

// ----- raw JSON shapes -----

interface RawCourseEntry {
  code: string;
  name: string;
  nameEn?: string;
  briefName?: string;
  briefNameEn?: string;
  type?: string;
  year?: number;
  periodCredits?: Record<string, unknown>;
  prerequisites?: string[];
  prerequisitesCompleted?: string[];
  prerequisitesParticipation?: string[];
  exams?: unknown;
  reexams?: unknown;
  teacher?: string;
  webpage?: string;
  description?: string;
  category?: CourseCategory;
  gradingScale?: GradingScale;
  [key: string]: unknown;
}

interface RawEntry {
  code: string;
  name: string;
  nameEn?: string;
  briefName?: string;
  briefNameEn?: string;
  perYear: Record<string, Record<string, number>>;
  prerequisites: string[];
  prerequisitesCompleted: string[];
  prerequisitesParticipation: string[];
  exams: string[];
  reexams: string[];
  examByYear?: Record<number, string[]>;
  reexamByYear?: Record<number, string[]>;
  teacher: string;
  webpage: string;
  description: string;
  category?: CourseCategory;
  gradingScale?: GradingScale;
  specializations?: string[];
  periodCreditsBySpecialization?: Record<string, Record<'P1' | 'P2' | 'P3' | 'P4', number>>;
  rounds?: CourseRound[];
}

/** Raw JSON shape of one alternative offering. See CourseRound. */
interface RawRound {
  id?: string;
  periodCredits?: Record<string, unknown>;
  exams?: unknown;
  reexams?: unknown;
  applicationCode?: string;
}

/**
 * Normalise `rounds` into CourseRound[], stamping each round's credits with the
 * course's own year.
 *
 * A round is a whole-year alternative, so it uses the flat {P1..P4} shape only —
 * a course that both spans study years and runs several times a year would need
 * the by-year shape here too, and no such course exists in the data. Returning
 * undefined for that case keeps the course on its flat `credits` rather than
 * inventing a layout.
 */
const parseRounds = (raw: unknown, year: number): CourseRound[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: CourseRound[] = [];
  for (const r of raw as RawRound[]) {
    const pc = r?.periodCredits;
    if (!pc || typeof pc !== 'object') continue;
    const credits: CourseCredit[] = [];
    Object.entries(pc as Record<string, unknown>).forEach(([p, val]) => {
      const num = Number(val) || 0;
      if (num > 0) credits.push({ period: p as Period['id'], credits: num, year });
    });
    if (credits.length === 0) continue;
    // Default the id to the round's first teaching period, which is what the
    // extractor writes and what the URL round-selector expects.
    const id = (r.id as Period['id'])
      ?? (['P1', 'P2', 'P3', 'P4'] as const).find(p => credits.some(c => c.period === p))
      ?? 'P1';
    const exams = parsePeriodList(r.exams).flat as Period['id'][];
    const reexams = r.reexams !== undefined && r.reexams !== null
      ? parsePeriodList(r.reexams).flat as Period['id'][]
      : exams;
    out.push({ id, credits, exams, reexams, applicationCode: r.applicationCode });
  }
  return out.length > 0 ? out : undefined;
};

// Parse an exams/reexams JSON value into the canonical { flat, byYear } shape.
// Accepts an array (flat) or a Year<n>-keyed object. Returns empty flat +
// undefined byYear if absent/invalid.
const parsePeriodList = (raw: unknown): { flat: string[]; byYear: Record<number, string[]> | undefined } => {
  if (Array.isArray(raw)) return { flat: [...raw as string[]], byYear: undefined };
  if (raw && typeof raw === 'object') {
    const byYear = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([yk, arr]) => [
        Number(String(yk).replace(/\D/g, '')) || 1,
        Array.isArray(arr) ? (arr as string[]) : [],
      ])
    ) as Record<number, string[]>;
    return { flat: [], byYear };
  }
  return { flat: [], byYear: undefined };
};

// Load and merge the array of courses + option groups for a single program.
// Multi-year courses can appear either as one entry with the by-year shape
// (e.g. SA1006 in CTMAT.json) or as multiple rows with the same `code` —
// both are normalised to a uniform `Course[]`.
export const loadCourses = async (dataFile: string): Promise<(Course | OptionGroup)[]> => {
  const rawCourses = await import(`@/data/${dataFile}`);
  return parseCourseEntries(rawCourses.default as RawCourseEntry[]);
};

/**
 * Turn the raw JSON shape into `Course` / `OptionGroup`.
 *
 * Split out of `loadCourses` so a caller holding raw entries from somewhere
 * other than a data file can use the same parsing — the transition plans embed
 * a course from a programme this app does not otherwise model (see
 * `src/lib/transitions.ts`), and re-implementing the period/credit
 * normalisation for it would be a second parser to keep in step with this one.
 */
export const parseCourseEntries = (rawData: RawCourseEntry[]): (Course | OptionGroup)[] => {
  const optionGroups = rawData.filter(c => c.type === 'optionGroup');
  // `cohortMeta` is the provenance header in a cohort file, not a course — it
  // would otherwise fall through to the course branch and parse as a nameless
  // entry with no credits. See loadCohortMeta.
  const regularCourses = rawData.filter(
    c => c.type !== 'optionGroup' && c.type !== 'cohortMeta');

  const byCode = new Map<string, RawEntry>();
  regularCourses.forEach((c) => {
    // Normalize periodCredits to nested per-year map { Year1: {P1:..}, ... }.
    let nested: Record<string, Record<string, number>> = {};
    const pc = c.periodCredits || {};
    const hasYearBuckets = Object.keys(pc).some(k => /^Year\d+$/i.test(k));
    if (hasYearBuckets) {
      nested = {};
      Object.entries(pc as Record<string, Record<string, unknown>>).forEach(([yk, periods]) => {
        nested[yk] = {};
        Object.entries(periods || {}).forEach(([p, val]) => {
          const num = Number(val) || 0;
          if (num > 0) nested[yk][p] = num;
        });
      });
    } else {
      const yearNum = c.year || 1;
      const yk = `Year${yearNum}`;
      nested[yk] = {};
      Object.entries(pc as Record<string, unknown>).forEach(([p, val]) => {
        const num = Number(val) || 0;
        if (num > 0) nested[yk][p] = num;
      });
    }

    // Re-exam scheduling defaults to follow the ordinary exams: per
    // *Riktlinje om läsårets förläggning* §1.1 each exam period has a fixed
    // re-exam slot. Authors only need to set `reexams` to add EXTRA slots.
    const examShape = parsePeriodList(c.exams);
    const reexamShape = c.reexams !== undefined && c.reexams !== null
      ? parsePeriodList(c.reexams)
      : examShape;

    const code: string = c.code;
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, {
        code,
        name: c.name,
        nameEn: c.nameEn || undefined,
        briefName: c.briefName || undefined,
        briefNameEn: c.briefNameEn || undefined,
        perYear: nested,
        prerequisites: Array.isArray(c.prerequisites) ? [...c.prerequisites] : [],
        prerequisitesCompleted: Array.isArray(c.prerequisitesCompleted) ? [...c.prerequisitesCompleted] : [],
        prerequisitesParticipation: Array.isArray(c.prerequisitesParticipation) ? [...c.prerequisitesParticipation] : [],
        exams: examShape.flat,
        reexams: reexamShape.flat,
        examByYear: examShape.byYear,
        reexamByYear: reexamShape.byYear,
        teacher: c.teacher || '',
        webpage: c.webpage || '',
        description: c.description || '',
        category: c.category,
        gradingScale: c.gradingScale,
        specializations: Array.isArray(c.specializations) ? [...c.specializations as string[]] : undefined,
        periodCreditsBySpecialization: (c as RawCourseEntry & { periodCreditsBySpecialization?: Record<string, Record<'P1' | 'P2' | 'P3' | 'P4', number>> }).periodCreditsBySpecialization,
        rounds: parseRounds(c.rounds, c.year || 1),
      });
    } else {
      // Merge nested perYear (sums credits if duplicates exist).
      Object.entries(nested).forEach(([yk, periods]) => {
        existing.perYear[yk] = existing.perYear[yk] || {};
        Object.entries(periods).forEach(([p, val]) => {
          existing.perYear[yk][p] = (existing.perYear[yk][p] || 0) + (val as number);
        });
      });
      const unique = <T,>(arr: T[]) => Array.from(new Set(arr));
      existing.prerequisites = unique([...(existing.prerequisites || []), ...(c.prerequisites || [])]);
      existing.prerequisitesCompleted = unique([...(existing.prerequisitesCompleted || []), ...(c.prerequisitesCompleted || [])]);
      existing.prerequisitesParticipation = unique([...(existing.prerequisitesParticipation || []), ...(c.prerequisitesParticipation || [])]);
      existing.exams = unique([...(existing.exams || []), ...examShape.flat]);
      existing.reexams = unique([...(existing.reexams || []), ...reexamShape.flat]);
      const mergeYearMap = (dst: Record<number, string[]>, src: Record<number, string[]> | undefined) => {
        if (!src) return dst;
        Object.entries(src).forEach(([yStr, arr]) => {
          const y = Number(yStr);
          const cur = dst[y] || [];
          dst[y] = Array.from(new Set([...cur, ...arr]));
        });
        return dst;
      };
      existing.examByYear = mergeYearMap(existing.examByYear || {}, examShape.byYear);
      existing.reexamByYear = mergeYearMap(existing.reexamByYear || {}, reexamShape.byYear);
      // Prefer the existing scalar fields unless missing.
      if (!existing.name && c.name) existing.name = c.name;
      if (!existing.nameEn && c.nameEn) existing.nameEn = c.nameEn;
      if (!existing.briefName && c.briefName) existing.briefName = c.briefName;
      if (!existing.briefNameEn && c.briefNameEn) existing.briefNameEn = c.briefNameEn;
      if (!existing.teacher && c.teacher) existing.teacher = c.teacher;
      if (!existing.webpage && c.webpage) existing.webpage = c.webpage;
      if (!existing.description && c.description) existing.description = c.description;
      if (!existing.category && c.category) existing.category = c.category;
      if (!existing.gradingScale && c.gradingScale) existing.gradingScale = c.gradingScale;
      if (Array.isArray(c.specializations)) {
        existing.specializations = Array.from(new Set([...(existing.specializations || []), ...(c.specializations as string[])]));
      }
    }
  });

  // Map RawEntry -> Course with flattened credits including year.
  const courses: Course[] = Array.from(byCode.values()).map((entry) => {
    const credits: Course['credits'] = [];
    Object.entries(entry.perYear as Record<string, Record<string, number>>).forEach(([yk, periods]) => {
      const year = Number(String(yk).replace(/\D/g, '')) || 1;
      Object.entries(periods).forEach(([p, val]) => {
        const num = Number(val) || 0;
        if (num > 0) credits.push({ period: p as Period['id'], credits: num, year });
      });
    });
    const primaryYear = credits.length ? Math.min(...credits.map(c => c.year)) : 1;
    return {
      code: entry.code,
      name: entry.name,
      nameEn: entry.nameEn,
      briefName: entry.briefName,
      briefNameEn: entry.briefNameEn,
      credits,
      year: primaryYear,
      prerequisites: entry.prerequisites || [],
      // Completion prereqs: the flat `prerequisites` field is back-compat
      // for the same concept (must-be-completed), so we UNION the two
      // instead of dropping the legacy field when the new one is also set.
      // Then we dedupe across participation: completion subsumes
      // participation, so any code in both is removed from participation.
      prerequisitesCompleted: (() => {
        const merged = Array.from(new Set([
          ...(entry.prerequisitesCompleted || []),
          ...(entry.prerequisites || []),
        ]));
        return merged;
      })(),
      prerequisitesParticipation: (() => {
        const completedSet = new Set([
          ...(entry.prerequisitesCompleted || []),
          ...(entry.prerequisites || []),
        ]);
        return (entry.prerequisitesParticipation || []).filter(c => !completedSet.has(c));
      })(),
      exams: entry.exams || [],
      reexams: entry.reexams || [],
      examsByYear: entry.examByYear,
      reexamsByYear: entry.reexamByYear,
      teacher: entry.teacher || '',
      webpage: entry.webpage || '',
      description: entry.description || '',
      category: entry.category,
      gradingScale: entry.gradingScale,
      specializations: entry.specializations,
      periodCreditsBySpecialization: entry.periodCreditsBySpecialization,
      rounds: entry.rounds,
    } as Course;
  });

  // Return entries in FILE ORDER, interleaving courses and option groups.
  //
  // This used to be `[...courses, ...optionGroups]`, which put every course
  // before every group regardless of where they sat in the file. The renderer
  // stacks each period's bars in the order of this list, so that concatenation
  // quietly overruled the ordering that `alignEntries()` exists to choose — and
  // it only became visible once something was picked, because an unpicked group
  // and its (hidden) options cannot disagree.
  //
  // The symptom was CTFYS year 3: picking any elective made the picked course a
  // regular course, which then sorted above the Kandidatexamensarbete group in
  // that one period while the other period still had the group on top. The
  // thesis spans P3+P4, so its two bars sat at different heights and the
  // connector between them was drawn as a diagonal.
  //
  // A merged course appears at the position of its FIRST raw entry, which is
  // what the by-year shape (one code, several entries) should mean for layout.
  const byCodeCourse = new Map<string, Course>();
  courses.forEach(c => byCodeCourse.set(c.code, c));
  const groupsByIndex = new Map<number, OptionGroup>();
  optionGroups.forEach((g, i) => groupsByIndex.set(i, g as unknown as OptionGroup));

  const ordered: (Course | OptionGroup)[] = [];
  const emitted = new Set<string>();
  let groupIdx = 0;
  for (const raw of rawData) {
    if (raw.type === 'cohortMeta') continue;
    if (raw.type === 'optionGroup') {
      const g = groupsByIndex.get(groupIdx++);
      if (g) ordered.push(g);
      continue;
    }
    const code: string = raw.code;
    if (!code || emitted.has(code)) continue;
    const c = byCodeCourse.get(code);
    if (c) { ordered.push(c); emitted.add(code); }
  }
  return ordered;
};

// Load a program's cosmetics (course-group → colour-family map). Returns
// null when the program has no `cosmeticsFile` configured (silent degrade
// to the default colour for every course). When a file IS configured but
// the import fails, the promise REJECTS so the caller can surface the
// failure to the user rather than silently degrading.
/** Relative path, inside src/data, of one cohort's plan. */
export const cohortDataFile = (programCode: string, cohort: string): string =>
  `cohorts/${programCode}-${cohort}.json`;

/**
 * Read the provenance header from a cohort file. Returns null for a file that
 * has none — the curated per-program files don't, and shouldn't be treated as
 * though every year were the cohort's own.
 */
export const loadCohortMeta = async (dataFile: string): Promise<CohortMeta | null> => {
  const mod = await import(`@/data/${dataFile}`);
  const raw = mod.default as { type?: string }[];
  const meta = raw.find(e => e?.type === 'cohortMeta');
  return (meta as CohortMeta | undefined) ?? null;
};

export const loadCosmetics = async (cosmeticsFile: string | undefined): Promise<ProgramCosmetics | null> => {
  if (!cosmeticsFile) return null;
  const rawGroups = await import(`@/data/${cosmeticsFile}`);
  const groups: CourseGroup[] = rawGroups.default as CourseGroup[];
  const courseToGroup = new Map<string, CourseGroup>();
  groups.forEach(group => {
    group.courses.forEach(code => courseToGroup.set(code, group));
  });
  return { groups, courseToGroup };
};
