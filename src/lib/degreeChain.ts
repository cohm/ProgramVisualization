/**
 * A five-year degree: a bachelor's years 1-3 (possibly composed from COPEN
 * year 1 and a transition plan) followed by a master programme's two years.
 *
 * The master's data is its own years 1-2, so it is shifted to follow the
 * bachelor: TTFYM's year 1 becomes year 4 of CTFYS + TTFYM. Nothing else about
 * a master's entries changes, which is why this is an append rather than a
 * transition plan: no course is credited or exempted between the two
 * programmes, the student simply goes on.
 *
 * One rule carries over from the transition composition: nobody reads the same
 * course twice. A course the bachelor already has is left out of the master's
 * part; if it is an option of a master box, the box keeps offering it, and the
 * bachelor's entry serves as the option (picking it in the master box moves it
 * to the box's year, as any pick does).
 */

import type { Course, CourseCredit, CourseRound, OptionGroup, Period } from '@/types/course';

type Entry = Course | OptionGroup;
const isGroup = (e: Entry): e is OptionGroup => 'type' in e && e.type === 'optionGroup';

const shiftKeys = <T,>(m: Record<number, T> | undefined, by: number): Record<number, T> | undefined =>
  m ? Object.fromEntries(Object.entries(m).map(([y, v]) => [Number(y) + by, v])) as Record<number, T> : undefined;

const shiftCredits = (credits: CourseCredit[], by: number): CourseCredit[] =>
  credits.map(c => ({ ...c, year: c.year + by }));

/** An entry moved `by` study years, every year-bearing field included. */
export function shiftEntryYears(e: Entry, by: number): Entry {
  if (by === 0) return e;
  if (isGroup(e)) {
    return {
      ...e,
      year: e.year + by,
      periodCreditsByYear: shiftKeys(e.periodCreditsByYear, by) as OptionGroup['periodCreditsByYear'],
    };
  }
  return {
    ...e,
    year: e.year + by,
    credits: shiftCredits(e.credits, by),
    examsByYear: shiftKeys(e.examsByYear, by) as Record<number, Period['id'][]> | undefined,
    reexamsByYear: shiftKeys(e.reexamsByYear, by) as Record<number, Period['id'][]> | undefined,
    rounds: e.rounds?.map((r): CourseRound => ({ ...r, credits: shiftCredits(r.credits, by) })),
    yearBySpecialization: e.yearBySpecialization
      ? Object.fromEntries(Object.entries(e.yearBySpecialization).map(([s, y]) => [s, y + by]))
      : undefined,
  };
}

/** The last study year the entries use. */
export function lastYear(entries: Entry[]): number {
  let max = 0;
  for (const e of entries) {
    if (isGroup(e)) {
      const years = e.periodCreditsByYear ? Object.keys(e.periodCreditsByYear).map(Number) : [e.year];
      max = Math.max(max, ...years);
    } else {
      max = Math.max(max, e.year, ...e.credits.map(c => c.year));
    }
  }
  return max;
}

/**
 * The bachelor's entries followed by the master's, shifted to start the year
 * after the bachelor's last.
 *
 * A code both programmes carry is kept once, by what it is on each side:
 *
 *   - obligatorisk in the bachelor: it stays there, and is taken out of the
 *     master's boxes, since an option nobody picked is hidden and would hide
 *     the bachelor's course with it;
 *   - only an option in the bachelor but obligatorisk in the master: the
 *     master's entry wins, and it leaves the bachelor's boxes. CTMAT
 *     offers SF2940 among its year-3 electives, and TTMAM requires it.
 *     Keeping the bachelor's copy dropped 7.5 hp from TTMAM's year 1;
 *   - an option on both sides: the bachelor's entry serves both boxes.
 */
export function appendMaster(
  bachelor: Entry[],
  master: Entry[],
  masterCode: string,
): { entries: Entry[]; warnings: string[]; offset: number } {
  const offset = lastYear(bachelor);
  const warnings: string[] = [];
  const optionsOf = (list: Entry[]) => new Set(list.filter(isGroup).flatMap(g => g.options));
  const bachelorOptions = optionsOf(bachelor);
  const masterOptions = optionsOf(master);
  const bachelorCourses = new Map(bachelor.filter((e): e is Course => !isGroup(e)).map(e => [e.code, e]));
  const bachelorMandatory = new Set([...bachelorCourses.keys()].filter(c => !bachelorOptions.has(c)));

  const replaced = new Set<string>();
  const appended: Entry[] = [];
  for (const e of master) {
    if (isGroup(e)) {
      const options = e.options.filter(c => !bachelorMandatory.has(c));
      if (options.length === 0) continue;
      const constraints = e.constraints
        ?.map(c => (c.from ? { ...c, from: c.from.filter(x => options.includes(x)) } : c))
        .filter(c => !c.from || c.from.length > 0);
      appended.push(shiftEntryYears({
        ...e,
        options,
        allowedNumberOfOptions: Math.min(e.allowedNumberOfOptions, options.length),
        ...(constraints ? { constraints: constraints.length ? constraints : undefined } : {}),
      }, offset));
      continue;
    }
    if (!bachelorCourses.has(e.code)) { appended.push(shiftEntryYears(e, offset)); continue; }
    if (bachelorMandatory.has(e.code)) {
      if (!masterOptions.has(e.code)) {
        warnings.push(`${e.code} is obligatorisk in both the bachelor programme and ${masterCode}; it is shown once, in the bachelor years.`);
      }
      continue;
    }
    // An option in the bachelor. The master's entry wins when the master
    // requires it; otherwise the bachelor's serves both boxes.
    if (!masterOptions.has(e.code)) {
      replaced.add(e.code);
      appended.push(shiftEntryYears(e, offset));
    }
  }
  // A course the master requires is not an elective in the bachelor years any
  // more: left in a bachelor box, it would be an option nobody picked, and the
  // chart hides those, taking the master's obligatorisk course with it.
  const kept = bachelor.flatMap((e): Entry[] => {
    if (!isGroup(e)) return replaced.has(e.code) ? [] : [e];
    if (!e.options.some(c => replaced.has(c))) return [e];
    const options = e.options.filter(c => !replaced.has(c));
    if (options.length === 0) return [];
    return [{ ...e, options, allowedNumberOfOptions: Math.min(e.allowedNumberOfOptions, options.length) }];
  });
  if (replaced.size) {
    warnings.push(`${[...replaced].sort().join(', ')}: obligatorisk in ${masterCode}, so no longer offered as a bachelor elective.`);
  }
  return { entries: [...kept, ...appended], warnings, offset };
}
