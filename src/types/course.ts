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
}

export interface Course {
  code: string;
  name: string;
  briefName?: string;
  credits: CourseCredit[];
  year: number; // Academic year (1, 2, 3, etc.)
  prerequisites: string[]; // Course codes
  exams: Period['id'][];
  reexams: Period['id'][];
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