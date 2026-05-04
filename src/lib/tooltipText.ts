// Tooltip HTML builders for TimelineVisualization. Centralised here so the
// HTML strings are written in one place (also closes the latent XSS in §3.4
// of REVIEW.md by escaping every JSON-derived value before interpolation).

import { Course, OptionGroup } from '@/types/course';
import { tr, type Lang } from '@/lib/translations';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildStudyPeriodTooltip(language: Lang, periodId: string): string {
  return `<strong>${escapeHtml(tr[language].period)} ${escapeHtml(periodId)}</strong>`;
}

export function buildExamPeriodTooltip(language: Lang, periodId: string): string {
  return `<strong>${escapeHtml(tr[language].examPeriodLabel)} ${escapeHtml(periodId)}</strong><br/>`;
}

export function buildReexamPeriodTooltip(language: Lang, periodId: string): string {
  return `<strong>${escapeHtml(tr[language].reexamPeriodLabel)} ${escapeHtml(periodId)}</strong><br/>`;
}

export function buildExamDotTooltip(language: Lang, courseCode: string): string {
  return `<strong>${escapeHtml(courseCode)}</strong><br/>${escapeHtml(tr[language].exam)}`;
}

export function buildReexamDotTooltip(language: Lang, courseCode: string): string {
  return `<strong>${escapeHtml(courseCode)}</strong><br/>${escapeHtml(tr[language].reexam)}`;
}

interface CourseTooltipDeps {
  // List of individual courses currently visible — used to compute the
  // "required for" reverse-prerequisite list.
  individualCourses: Course[];
}

export function buildCourseTooltip(course: Course, language: Lang, deps: CourseTooltipDeps): string {
  const allCompleted = course.prerequisitesCompleted || course.prerequisites || [];
  const allParticipation = course.prerequisitesParticipation || [];
  const completedStr = allCompleted.length ? allCompleted.map(escapeHtml).join(', ') : '—';
  const participationStr = allParticipation.length ? allParticipation.map(escapeHtml).join(', ') : '—';
  const dependents = deps.individualCourses.filter(c => {
    const comp = c.prerequisitesCompleted || c.prerequisites || [];
    const part = c.prerequisitesParticipation || [];
    return comp.includes(course.code) || part.includes(course.code);
  }).map(c => c.code);
  const dependentCodes = dependents.length ? dependents.map(escapeHtml).join(', ') : '—';

  const totalCredits = course.credits.reduce((sum, c) => sum + c.credits, 0);
  const periodCreditsStr = course.credits
    .map(c => `${escapeHtml(c.period)}: ${c.credits} ${escapeHtml(tr[language].credits)}`)
    .join(', ');

  const courseName = language === 'en' ? (course.nameEn || course.name) : course.name;

  return `<strong>${escapeHtml(course.code)}, ${totalCredits} ${escapeHtml(tr[language].credits)}</strong><br/>${escapeHtml(courseName)}<br/>${periodCreditsStr}
    <br/><em>${escapeHtml(tr[language].legend.prerequisitesCompleted)}:</em> ${completedStr}
    <br/><em>${escapeHtml(tr[language].legend.prerequisitesParticipation)}:</em> ${participationStr}
    <br/><em>${escapeHtml(tr[language].requiredFor)}:</em> ${dependentCodes}`;
}

interface OptionGroupTooltipDeps {
  // Lookup from course code to the Course in the current data set, used to
  // print a "code: name" line per option in the tooltip.
  courseByCode: Map<string, Course>;
}

export function buildOptionGroupTooltip(og: OptionGroup, language: Lang, deps: OptionGroupTooltipDeps): string {
  const ogName = language === 'en' ? (og.nameEn || og.name) : og.name;
  const optionsList = og.options
    .map(optionCode => {
      const optionCourse = deps.courseByCode.get(optionCode);
      if (!optionCourse) return null;
      const optName = language === 'en' ? (optionCourse.nameEn || optionCourse.name) : optionCourse.name;
      return `${escapeHtml(optionCode)}: ${escapeHtml(optName)}`;
    })
    .filter((opt): opt is string => opt !== null)
    .join('<br/>');

  // Hint line, e.g. "pick 1 of 3 options" — substitutes {N}.
  const hint = tr[language].optionGroupHint.replace('{N}', String(og.options.length));

  return `<strong>${escapeHtml(ogName)}</strong><br/><em>${escapeHtml(hint)}</em><br/>${escapeHtml(tr[language].totalCredits)}: ${og.totalCredits} ${escapeHtml(tr[language].credits)}<br/><strong>${escapeHtml(tr[language].options)}:</strong><br/>${optionsList}`;
}
