// KTH course-level inference. Per the standard course-code convention,
// the first digit after the letters indicates the cycle:
//   1xxx → grundnivå       (G, first cycle)
//   2xxx → avancerad nivå  (A, second cycle)
//   3xxx → forskarnivå     (research level — does not appear in study plans)
// Anything else returns undefined and the caller renders no badge.

export type CourseLevel = 'G' | 'A';

export function inferCourseLevel(code: string): CourseLevel | undefined {
  const m = /^[A-Za-z]+(\d)/.exec(code);
  if (!m) return undefined;
  if (m[1] === '1') return 'G';
  if (m[1] === '2') return 'A';
  return undefined;
}

export function getCourseLevel(course: { code: string; courseLevel?: CourseLevel }): CourseLevel | undefined {
  return course.courseLevel ?? inferCourseLevel(course.code);
}
