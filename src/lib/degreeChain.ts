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
 * A group without some of its options, or null when none is left. A pick
 * count cannot exceed what is left, and a constraint loses the codes it
 * counted, or goes when it counted nothing else.
 */
function withoutOptions(g: OptionGroup, removed: (code: string) => boolean): OptionGroup | null {
  if (!g.options.some(removed)) return g;
  const options = g.options.filter(c => !removed(c));
  if (options.length === 0) return null;
  const constraints = g.constraints
    ?.map(c => (c.from ? { ...c, from: c.from.filter(x => options.includes(x)) } : c))
    .filter(c => !c.from || c.from.length > 0);
  return {
    ...g,
    options,
    allowedNumberOfOptions: Math.min(g.allowedNumberOfOptions, options.length),
    ...(g.pickN !== undefined ? { pickN: Math.min(g.pickN, options.length) } : {}),
    ...(g.constraints ? { constraints: constraints?.length ? constraints : undefined } : {}),
  };
}

const periodsKey = (credits: CourseCredit[]) =>
  credits.filter(c => c.credits > 0).map(c => `${c.period}:${c.credits}`).sort().join(',');

/**
 * `course`'s rounds followed by `other`'s, for one entry standing in for both.
 * A round of `other` in periods `course` already has is left out: a pick in a
 * one-year box is drawn in that box's year, so the two would draw the same.
 */
function withRoundsOf(course: Course, other: Course): CourseRound[] | undefined {
  const asRounds = (c: Course): CourseRound[] =>
    c.rounds?.length ? c.rounds : [{
      id: c.credits.find(x => x.credits > 0)?.period ?? 'P1',
      credits: c.credits,
      exams: c.exams,
      reexams: c.reexams ?? c.exams,
    }];
  const mine = asRounds(course);
  const seen = new Set(mine.map(r => periodsKey(r.credits)));
  const ids = new Set<string>(mine.map(r => r.id));
  const added = asRounds(other).filter(r => !seen.has(periodsKey(r.credits)));
  if (added.length === 0) return course.rounds;
  return [
    ...mine,
    ...added.map(r => {
      // Same first period, other shape: tell them apart by the year, as the
      // extractor does for an offering in another study year.
      const id = ids.has(r.id) ? `${r.id}-y${r.credits[0]?.year ?? other.year}` : r.id;
      ids.add(id);
      return { ...r, id } as CourseRound;
    }),
  ];
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
 *
 * "Obligatorisk in the master" is decided per spår, because it often holds for
 * some spår only. TCSCM's DD2421 is obligatorisk for CSCS and CSDA and an
 * option in the CSSC and CSST boxes. TEFRM's SH2404 is obligatorisk for SPA
 * and not offered to the other spår at all. Deciding it for the master as a
 * whole got both wrong. DD2421 is offered by some box, so it was read as an
 * option. The master's entry was dropped, and the bachelor's copy, an option
 * nobody had picked, was hidden: CTMAT + TCSCM's year 4 was 7.5 hp short
 * for CSCS. SH2404 was read as obligatorisk, so it left CTFYS's year-3
 * elective box for every spår, although only SPA reads it in the master.
 *
 * When only some spår require the course, the master's entry is kept for all
 * spår. Each bachelor box that offers it is split in two, one per side, told
 * apart by the master's spår codes (the filter ANDs across spec groups):
 *   - the spår that require it see the box without the course, so their
 *     year 4 draws it as obligatorisk;
 *   - the others see the box with the course, where it stays an option, drawn
 *     only once picked, and in the box's own year.
 * Both halves keep the box's name, so the chart reads as one box. A pick of
 * the course made in the second half, then a switch to a spår that requires
 * it, leaves a pick the first half does not offer; the chart ignores it
 * (`shownPicks` in TimelineVisualization) and restores it on switching back.
 */
export function appendMaster(
  bachelor: Entry[],
  master: Entry[],
  masterCode: string,
): { entries: Entry[]; warnings: string[]; offset: number } {
  const offset = lastYear(bachelor);
  const warnings: string[] = [];
  const bachelorOptions = new Set(bachelor.filter(isGroup).flatMap(g => g.options));
  const bachelorCourses = new Map(bachelor.filter((e): e is Course => !isGroup(e)).map(e => [e.code, e]));
  const bachelorMandatory = new Set([...bachelorCourses.keys()].filter(c => !bachelorOptions.has(c)));

  // The master's spår are the codes its entries carry. A master without spår
  // (TMAIM) is treated as one, so the per-spår test below still applies.
  const spar = [...new Set(master.flatMap(e => e.specializations ?? []))].sort();
  const sparOrWhole = spar.length ? spar : [''];
  const sees = (e: Entry, s: string) => !e.specializations?.length || e.specializations.includes(s);
  const masterGroups = master.filter(isGroup);
  // The spår that see the course and have no box offering it.
  const requiredBy = (e: Course): string[] =>
    sparOrWhole.filter(s => sees(e, s) && !masterGroups.some(g => sees(g, s) && g.options.includes(e.code)));

  const replaced = new Set<string>();
  // Code -> the spår that require it, for a code only some spår require.
  const partly = new Map<string, string[]>();
  const appended: Entry[] = [];
  for (const e of master) {
    if (isGroup(e)) {
      const g = withoutOptions(e, c => bachelorMandatory.has(c));
      if (g) appended.push(shiftEntryYears(g, offset));
      continue;
    }
    if (!bachelorCourses.has(e.code)) { appended.push(shiftEntryYears(e, offset)); continue; }
    if (bachelorMandatory.has(e.code)) {
      if (!masterGroups.some(g => g.options.includes(e.code))) {
        warnings.push(`${e.code} is obligatorisk in both the bachelor programme and ${masterCode}; it is shown once, in the bachelor years.`);
      }
      continue;
    }
    // An option in the bachelor. The master's entry wins where the master
    // requires it; elsewhere the bachelor's serves both boxes.
    const required = requiredBy(e);
    if (required.length === 0) continue;
    if (required.length === sparOrWhole.length) {
      replaced.add(e.code);
      appended.push(shiftEntryYears(e, offset));
      continue;
    }
    partly.set(e.code, required);
    // Visible to every spår: an option where a visible box offers it, and
    // obligatorisk where none does. It also stands in for the bachelor's
    // entry, so it carries the bachelor's offering as a round: CTMAT reads
    // DD2421 in P1 and TCSCM in P3, and a pick in CTMAT's P1 box must land
    // in P1. The master's offering stays first, as the default.
    const own = shiftEntryYears({ ...e, specializations: undefined }, offset) as Course;
    appended.push({ ...own, rounds: withRoundsOf(own, bachelorCourses.get(e.code)!) });
  }

  // A course the master requires is not an elective in the bachelor years any
  // more: left in a bachelor box, it would be an option nobody picked, and the
  // chart hides those, taking the master's obligatorisk course with it.
  const kept = bachelor.flatMap((e): Entry[] => {
    if (!isGroup(e)) return replaced.has(e.code) || partly.has(e.code) ? [] : [e];
    const base = withoutOptions(e, c => replaced.has(c));
    if (!base) return [];
    const codes = base.options.filter(c => partly.has(c));
    if (codes.length === 0) return [base];
    // One half per set of spår that drops the same codes. Two codes with
    // different spår give more than two halves; none of today's pairs does.
    const halves = new Map<string, { spar: string[]; drop: Set<string> }>();
    for (const s of spar) {
      const drop = codes.filter(c => partly.get(c)!.includes(s));
      const key = drop.join(',');
      const h = halves.get(key) ?? { spar: [], drop: new Set(drop) };
      h.spar.push(s);
      halves.set(key, h);
    }
    return [...halves.values()].flatMap(h => {
      const g = withoutOptions(base, c => h.drop.has(c));
      return g ? [{ ...g, specializations: [...(g.specializations ?? []), ...h.spar] }] : [];
    });
  });
  if (replaced.size) {
    warnings.push(`${[...replaced].sort().join(', ')}: obligatorisk in ${masterCode}, so no longer offered as a bachelor elective.`);
  }
  for (const [code, required] of [...partly].sort(([a], [b]) => a.localeCompare(b))) {
    warnings.push(`${code}: obligatorisk in ${masterCode} for ${required.join(', ')}, so not offered as a bachelor elective with ${required.length > 1 ? 'those spår' : 'that spår'}.`);
  }
  return { entries: [...kept, ...appended], warnings, offset };
}
