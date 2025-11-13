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
  webpage: string;
  description: string;
}

import rawPeriods from '@/data/academic-periods.json';

// Convert JSON strings to Date objects
export const academicPeriods: Period[] = (rawPeriods as Array<any>).map((p) => ({
  id: p.id,
  start: new Date(p.start),
  end: new Date(p.end),
  lectureEnd: new Date(p.lectureEnd),
  examStart: new Date(p.examStart),
  examEnd: new Date(p.examEnd),
  reExamStart: new Date(p.reExamStart),
  reExamEnd: new Date(p.reExamEnd)
}));