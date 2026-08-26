import type { Course, CourseCredit, CourseRound, OptionGroup, Period } from '@/types/course';

const PERIOD_IDS: Period['id'][] = ['P1', 'P2', 'P3', 'P4'];

/** True when the course is given more than once in an academic year. */
export const hasRounds = (course: Course): boolean =>
  Array.isArray(course.rounds) && course.rounds.length > 1;

/** The periods an option-group box occupies, in order. */
export const groupPeriods = (group: OptionGroup): Period['id'][] =>
  PERIOD_IDS.filter(p => (group.periodCredits?.[p] ?? 0) > 0);

/**
 * How well a round fits a box: the credits it places inside the box's own
 * periods. A course chosen from the "Valfri kurs, årskurs 3 P3" box should land
 * in P3, and that is exactly the round whose credits sit in P3.
 */
const overlap = (round: CourseRound, periods: Period['id'][]): number =>
  round.credits
    .filter(c => periods.includes(c.period))
    .reduce((sum, c) => sum + c.credits, 0);

/**
 * The round to draw for `course` when it was chosen from `group`.
 *
 * Order of preference:
 *   1. the round the user explicitly picked (`chosenRoundId`);
 *   2. the round overlapping the box's periods most — so the same course
 *      offered by both the P3 box and the P4 box lands in the box it was
 *      picked from, rather than always in whichever offering the study plan
 *      happened to name;
 *   3. the first round, which the extractor writes as the study plan's own.
 *
 * Ties break towards the earliest period, so the choice is deterministic and
 * a given URL always renders the same chart.
 *
 * Returns undefined for a single-round course, which is the overwhelming
 * majority: callers then use `course.credits` unchanged.
 */
export function pickRound(
  course: Course,
  group?: OptionGroup | null,
  chosenRoundId?: string | null,
): CourseRound | undefined {
  const rounds = course.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return undefined;

  if (chosenRoundId) {
    const exact = rounds.find(r => r.id === chosenRoundId);
    if (exact) return exact;
  }

  if (group) {
    const periods = groupPeriods(group);
    if (periods.length > 0) {
      let best: CourseRound | undefined;
      let bestScore = -1;
      // rounds are written in period order, so a plain scan already breaks
      // ties towards the earliest period.
      for (const r of rounds) {
        const score = overlap(r, periods);
        if (score > bestScore) { best = r; bestScore = score; }
      }
      if (best && bestScore > 0) return best;
    }
  }

  return rounds[0];
}

/**
 * The credits to draw for a course, given the round in force.
 *
 * A round's credits are stamped with the course's own `year` by the loader, but
 * a picked option is re-stamped to the year of the box it came from (see the
 * option-group placement rules), so the caller passes the year it wants.
 */
export const creditsForRound = (
  course: Course,
  round: CourseRound | undefined,
  year?: number,
): CourseCredit[] => {
  const base = round ? round.credits : course.credits;
  if (year === undefined) return base;
  return base.map(c => ({ ...c, year }));
};

/**
 * "(P3: 3 hp, P4: 4 hp)" — where a course lands, summed per period.
 *
 * Shared by the selection modal and the chart tooltip so the two can never
 * disagree about where an option will go. `creditsLabel` is passed in rather
 * than imported so this module stays free of the translation table.
 */
export const formatPeriods = (credits: CourseCredit[], creditsLabel: string): string => {
  const byPeriod = new Map<string, number>();
  credits.forEach(c => {
    if (!c.credits) return;
    byPeriod.set(c.period, (byPeriod.get(c.period) || 0) + c.credits);
  });
  const parts = PERIOD_IDS
    .filter(p => byPeriod.has(p))
    .map(p => {
      const n = byPeriod.get(p)!;
      return `${p}: ${Number.isInteger(n) ? n : n.toFixed(1)} ${creditsLabel}`;
    });
  return parts.length ? `(${parts.join(', ')})` : '';
};
