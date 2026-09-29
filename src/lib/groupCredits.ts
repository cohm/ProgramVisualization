import type { CourseCredit, OptionGroup, Period } from '@/types/course';

const PERIOD_IDS: Period['id'][] = ['P1', 'P2', 'P3', 'P4'];

/**
 * Every (year, period, credits) an option group's box occupies.
 *
 * A group normally sits in one study year, `year` with `periodCredits`. A group
 * spanning years carries `periodCreditsByYear` instead (see OptionGroup), and
 * reading `periodCredits` alone would lose all but its first year. Everything
 * that draws, counts or sizes a group reads it through this.
 */
export function groupCredits(og: OptionGroup): CourseCredit[] {
  const byYear = og.periodCreditsByYear ?? { [og.year]: og.periodCredits };
  const out: CourseCredit[] = [];
  Object.keys(byYear)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach(year => {
      PERIOD_IDS.forEach(period => {
        const credits = Number(byYear[year]?.[period] ?? 0);
        if (credits > 0) out.push({ year, period, credits });
      });
    });
  return out;
}

/** The study years a group occupies, ascending. */
export const groupYears = (og: OptionGroup): number[] =>
  [...new Set(groupCredits(og).map(c => c.year))];

/** True for a group whose box spans more than one study year. */
export const spansYears = (og: OptionGroup): boolean => groupYears(og).length > 1;

/**
 * The group with its periods replaced, in either shape. A single year stays
 * in the flat shape, so a normal group round-trips unchanged.
 */
export function withGroupCredits(og: OptionGroup, credits: CourseCredit[]): OptionGroup {
  const byYear: Record<number, Record<Period['id'], number>> = {};
  credits.forEach(c => {
    if (!(c.credits > 0)) return;
    byYear[c.year] = byYear[c.year] ?? { P1: 0, P2: 0, P3: 0, P4: 0 };
    byYear[c.year][c.period] += c.credits;
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const total = Math.round(credits.reduce((a, c) => a + c.credits, 0) * 10) / 10;
  if (years.length <= 1) {
    const year = years[0] ?? og.year;
    return { ...og, year, periodCredits: byYear[year] ?? { P1: 0, P2: 0, P3: 0, P4: 0 }, periodCreditsByYear: undefined, totalCredits: total };
  }
  return { ...og, year: years[0], periodCredits: byYear[years[0]], periodCreditsByYear: byYear, totalCredits: total };
}
