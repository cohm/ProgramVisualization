export interface Period {
  id: 'P1' | 'P2' | 'P3' | 'P4';
  start: Date;
  end: Date;
  lectureEnd: Date;
  examStart: Date;
  examEnd: Date;
  reExamStart: Date;
  reExamEnd: Date;
}

export interface CourseCredit {
  period: Period['id'];
  credits: number;
  year: number; // Academic year this credit belongs to (1, 2, 3, ...)
}

// KTH course categories per *Riktlinje om utbildningsplan* (V-2018-0608).
// When undefined, the course/group is treated as mandatory by the renderer
// (existing behaviour). Mark electives explicitly to opt in to category-aware
// rendering and filtering.
export type CourseCategory =
  | 'mandatory'             // obligatorisk
  | 'conditionallyElective' // villkorligt valbar
  | 'electivePlaceholder'   // valfri – plats för
  | 'recommended';          // rekommenderad

// KTH grading scales per *Riktlinje om kursplan* (V-2020-0650 §2). When
// undefined, no scale badge is shown in the UI. P/F is mandated for
// examensarbete on grundnivå and avancerad nivå.
export type GradingScale = 'A-F' | 'P/F' | 'VG/G/U';

export interface OptionGroup {
  type: 'optionGroup';
  name: string;
  nameEn?: string;
  year: number;
  totalCredits: number;
  periodCredits: Record<'P1' | 'P2' | 'P3' | 'P4', number>;
  options: string[]; // Array of course codes
  // Discriminator for the group's selection rule.
  //   'pickN'      — pick exactly N courses (the historical default; N comes
  //                  from `pickN` if set, otherwise from `allowedNumberOfOptions`)
  //   'minCredits' — pick any number of courses summing to at least
  //                  `minCredits` hp (e.g. "minst 30 hp ur följande grupp")
  // When omitted, the group is treated as 'pickN'. See src/lib/optionGroupKind.ts.
  kind?: 'pickN' | 'minCredits';
  pickN?: number;       // used when kind === 'pickN' (defaults to allowedNumberOfOptions)
  minCredits?: number;  // required when kind === 'minCredits'
  // Legacy field, kept for backward compatibility. New 'pickN' groups should
  // prefer `pickN`; new 'minCredits' groups can leave this at any value (1).
  allowedNumberOfOptions: number;
  exams: Period['id'][];
  reexams: Period['id'][];
  // Optional KTH metadata. category typically applies to the whole group;
  // gradingScale typically applies to all options in the group.
  category?: CourseCategory;
  gradingScale?: GradingScale;
  // Inriktning (specialization) codes this option group belongs to.
  // Undefined / empty = common to all specializations of the program.
  // Codes must reference the program's `specializations` registry in
  // programs.json. Currently scoped to the bachelor part of a civilingenjör
  // program; spår (master-program tracks) will be a separate field.
  specializations?: string[];
}

// What the bottom info panel shows when the user clicks a course or option.
// Lives here so the InfoPanel/OptionGroupModal components can type their props
// without depending on the parent TimelineVisualization module.
export interface SelectedInfo {
  course: Course;
  credit?: { period: string; credits: number; year: number };
}

export interface Course {
  code: string;
  name: string;
  nameEn?: string;
  briefName?: string;
  briefNameEn?: string;
  credits: CourseCredit[];
  year: number; // Primary year (min of credits.year). Kept for backwards compatibility.
  // Back-compat flat prerequisites (treated as completion unless detailed lists below are provided)
  prerequisites: string[]; // Course codes
  // Optional detailed prerequisite types
  prerequisitesCompleted?: string[]; // must be completed before
  prerequisitesParticipation?: string[]; // active participation required
  exams: Period['id'][];
  reexams: Period['id'][];
  // Optional year-specific exam mappings (preferred in new schema)
  examsByYear?: Record<number, Period['id'][]>;
  reexamsByYear?: Record<number, Period['id'][]>;
  // Optional metadata per course
  teacher: string;
  description: string;
  // Optional KTH metadata (Riktlinje om utbildningsplan, Riktlinje om kursplan)
  category?: CourseCategory;
  gradingScale?: GradingScale;
  // Cycle level: 'G' = grundnivå (first cycle), 'A' = avancerad nivå (second
  // cycle). When omitted, the level is inferred from the first digit after
  // the letters in `code` (1 → G, 2 → A); set explicitly only to override
  // the inference (rare). See src/lib/courseLevel.ts.
  courseLevel?: 'G' | 'A';
  // See OptionGroup.specializations.
  specializations?: string[];
  // Per-specialization period override. When the visualisation filters down
  // to a single inriktning whose code matches a key here, the entries in
  // `credits` are replaced by the override's flat {P1..P4} map (year is
  // taken from the course's primary `year`). Use this when one inriktning
  // takes the same KTH course in a different period than the others — the
  // course code stays unique, so the duplicate-code merge in
  // `useCourseModel.ts` still rejects accidental duplicates.
  // Restriction: flat (single-year) periodCredits only; multi-year courses
  // would need a richer override shape and aren't supported yet.
  periodCreditsBySpecialization?: Record<string, Record<'P1' | 'P2' | 'P3' | 'P4', number>>;
}

import rawPeriods from '@/data/academic-periods.json';

interface RawPeriod {
  id: string;
  start: string;
  end: string;
  lectureEnd: string;
  examStart: string;
  examEnd: string;
  reExamStart: string;
  reExamEnd: string;
}

// Convert JSON strings to Date objects
export const academicPeriods: Period[] = (rawPeriods as RawPeriod[]).map((p) => ({
  id: p.id as Period['id'],
  start: new Date(p.start),
  end: new Date(p.end),
  lectureEnd: new Date(p.lectureEnd),
  examStart: new Date(p.examStart),
  examEnd: new Date(p.examEnd),
  reExamStart: new Date(p.reExamStart),
  reExamEnd: new Date(p.reExamEnd)
}));