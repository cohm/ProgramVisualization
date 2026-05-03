// Loaders that turn the on-disk JSON shape into the in-memory `Course` /
// `OptionGroup` / `ProgramCosmetics` shapes consumed by the visualization.
//
// Despite the name, this module currently only exposes loader functions —
// no React hook. Calling code uses them inside `useEffect` (see HomeClient).
// The "useCourseModel" name is kept as a future affordance: a real
// `useCourseModel(programCode)` hook could wrap these and add SWR-style
// caching/retry without callers needing to change.

import type {
  Course,
  CourseCategory,
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
}

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
  const rawData = rawCourses.default as RawCourseEntry[];
  const optionGroups = rawData.filter(c => c.type === 'optionGroup');
  const regularCourses = rawData.filter(c => c.type !== 'optionGroup');

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
      // Backward compatibility: if detailed arrays are empty but flat
      // prerequisites exist, treat the flat list as completion prereqs.
      prerequisitesCompleted: (entry.prerequisitesCompleted && entry.prerequisitesCompleted.length ? entry.prerequisitesCompleted : (entry.prerequisites || [])),
      prerequisitesParticipation: entry.prerequisitesParticipation || [],
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
    } as Course;
  });

  return [...courses, ...optionGroups as unknown as OptionGroup[]];
};

// Load a program's cosmetics (course-group → colour-family map). Returns null
// if no file is configured or the import fails (gracefully degrading to the
// default colour for every course).
export const loadCosmetics = async (cosmeticsFile: string | undefined): Promise<ProgramCosmetics | null> => {
  if (!cosmeticsFile) return null;
  try {
    const rawGroups = await import(`@/data/${cosmeticsFile}`);
    const groups: CourseGroup[] = rawGroups.default as CourseGroup[];
    const courseToGroup = new Map<string, CourseGroup>();
    groups.forEach(group => {
      group.courses.forEach(code => courseToGroup.set(code, group));
    });
    return { groups, courseToGroup };
  } catch (e) {
    console.warn('Failed to load cosmetics:', e);
    return null;
  }
};
