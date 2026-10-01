// Composing a COPEN transfer student's actual study plan.
//
// A COPEN student studies one year of COPEN and then two years of the programme
// they transfer into. That combination is published nowhere: COPEN's plan stops
// after year 1, and the target programme's plan assumes its own year 1. So the
// plan a transferring student follows has to be assembled from both, plus the
// differences recorded in `src/data/transitions.json`.
//
// The composition is intentionally a pure function of (source courses, target
// courses, plan). Nothing is baked into a data file, so re-extracting either
// programme keeps the composed view correct — which a hand-written combined
// course list would not.

import type { Course, OptionGroup, Period } from '@/types/course';
import type { TransitionCredit, TransitionOverlay, TransitionPlan } from '@/types/transition';
import { parseCourseEntries } from '@/lib/useCourseModel';
import { groupCredits, spansYears } from '@/lib/groupCredits';
import type { CourseGroup, ProgramCosmetics } from '@/types/cosmetics';
import type { FamilyName } from '@/lib/colors';

type Entry = Course | OptionGroup;

const isGroup = (e: Entry): e is OptionGroup =>
  (e as OptionGroup).type === 'optionGroup';

/** Study year of an entry — for a multi-year course, its first. */
const entryYear = (e: Entry): number => {
  if (isGroup(e)) return e.year;
  const years = e.credits.map(c => c.year);
  return years.length > 0 ? Math.min(...years) : e.year;
};

export interface ComposedPlan {
  entries: Entry[];
  /** Courses credited from the source programme, in the order the plan lists. */
  credited: TransitionCredit[];
  /** Target courses dropped, with the reason, for display. */
  exempted: { code: string; creditedBy?: string; note?: string; noteEn?: string }[];
  /** Target courses shifted to a later year, for display. */
  moved: { code: string; fromYear: number; toYear: number; note?: string; noteEn?: string }[];
  /** Anything the plan asserts that the data does not bear out. */
  warnings: string[];
  /** Composed years not at full-time in every period, for the notice. */
  loads: YearLoad[];
}

/**
 * A composed year's load per period, P1-P4, when a period is off full-time.
 * Data rather than text, so the page can phrase it in either language and say
 * whether the year is short, over, or full but unevenly spread.
 */
export interface YearLoad {
  year: number;
  load: number[];
}

/**
 * Build the combined plan.
 *
 * Year numbering needs no adjustment: the source contributes its year 1 and the
 * target its years 2-3, so the composed years already read 1, 2, 3 for the
 * student. A `moved` course is re-stamped to its new year but keeps its periods,
 * because it is the same course instance reached a year later — CTFYS's SF1922
 * runs in P4 either way.
 */
export function composeTransition(
  sourceEntries: Entry[],
  targetEntries: Entry[],
  fullPlan: TransitionPlan,
  selectedSpecializations?: Set<string>,
): ComposedPlan {
  const plan = effectivePlan(fullPlan, selectedSpecializations);
  const warnings: string[] = [];
  const sourceYears = new Set(plan.sourceYears);
  const exemptCodes = new Set((plan.exempt ?? []).map(e => e.code));
  const movesByCode = new Map((plan.moved ?? []).map(m => [m.code, m]));
  const reschedByCode = new Map((plan.rescheduled ?? []).map(r => [r.code, r]));

  // --- the source programme's own years -----------------------------------
  const fromSource = sourceEntries.filter(e => sourceYears.has(entryYear(e)));

  // Every course the student actually took in the source years should appear in
  // `credited`; a mismatch means the plan predates a change to the programme.
  const sourceCodes = new Set(
    fromSource.filter((e): e is Course => !isGroup(e)).map(e => e.code),
  );
  const creditedSet = new Set(plan.credited.map(c => c.code));
  for (const code of sourceCodes) {
    if (!creditedSet.has(code)) {
      warnings.push(
        `${plan.from} year ${plan.sourceYears.join('/')} includes ${code}, which the ` +
        `transition plan does not list as credited — the plan may be out of date.`,
      );
    }
  }
  for (const { code } of plan.credited) {
    if (!sourceCodes.has(code)) {
      warnings.push(
        `The plan credits ${code}, but it is not in ${plan.from}'s year ` +
        `${plan.sourceYears.join('/')} data.`,
      );
    }
  }

  // --- the target programme's remaining years -----------------------------
  const fromTarget: Entry[] = [];
  for (const entry of targetEntries) {
    const year = entryYear(entry);
    const code = isGroup(entry) ? null : entry.code;

    if (code && exemptCodes.has(code)) continue;      // credited away
    // Already taken in the source years, as the same course. CBIOT teaches
    // SF1626 as a year-3 option, which a COPEN student read in year 1; kept, it
    // would be drawn twice.
    if (code && sourceCodes.has(code)) continue;

    const move = code ? movesByCode.get(code) : undefined;
    if (move) {
      if (year !== move.fromYear) {
        warnings.push(
          `The plan moves ${code} from year ${move.fromYear}, but ${plan.to} has it ` +
          `in year ${year} — check the plan against the programme data.`,
        );
      }
      // Re-stamp the year on the course and on each of its credits, leaving the
      // periods alone.
      const course = entry as Course;
      // A partial read (see TransitionMove.periodCredits) replaces the periods;
      // totalCredits stays the course's own, since that is still its size.
      const credits = move.periodCredits
        ? movedCredits(move.periodCredits, move.toYear)
        : course.credits.map(c => ({ ...c, year: move.toYear }));
      // New periods move the exam with them: kept where it still has a bar,
      // and put in the teaching period of a course now read in one (§1.1 of
      // the riktlinje, as for periodCreditsBySpecialization).
      const periods = [...new Set(credits.map(c => c.period))];
      const placeExams = (list: Period['id'][]): Period['id'][] => {
        if (!move.periodCredits || !list.length) return list;
        return periods.length === 1 ? [periods[0]] : list.filter(p => periods.includes(p));
      };
      fromTarget.push({
        ...course,
        year: move.toYear,
        credits,
        exams: placeExams(course.exams),
        reexams: placeExams(course.reexams),
        examsByYear: undefined,
        reexamsByYear: undefined,
      });
      continue;
    }

    if (sourceYears.has(year)) continue;              // replaced by the source year

    // Same year, different periods: the student takes the course's other
    // offering. Only the period map is replaced; everything else about the
    // course still comes from the target programme's own data.
    const resched = code ? reschedByCode.get(code) : undefined;
    if (resched) {
      const course = entry as Course;
      const credits = PERIODS
        .map(period => ({ year, period, credits: Number(resched.periodCredits[period] ?? 0) }))
        .filter(c => c.credits > 0);
      const sum = credits.reduce((a, c) => a + c.credits, 0);
      const was = course.credits.reduce((a, c) => a + c.credits, 0);
      const partial = (resched.creditedBy?.length ?? 0) > 0;
      if (!partial && Math.abs(sum - was) > LOAD_TOLERANCE) {
        warnings.push(
          `The plan reschedules ${code} to periods totalling ${sum} hp, but ${plan.to} lists it ` +
          `as ${was} hp — the offering should be the same course.`,
        );
      }
      if (partial) {
        // Part of the course is credited: keep only the markers in the periods
        // still read, since the credited part has no bar.
        const kept = new Set(credits.map(c => c.period));
        fromTarget.push({
          ...course, credits,
          exams: course.exams?.filter(p => kept.has(p)),
          reexams: course.reexams?.filter(p => kept.has(p)),
          examsByYear: undefined, reexamsByYear: undefined,
        });
        continue;
      }
      // The exam sits in the teaching period. An offering in one period takes
      // its exam there (CITEH's ME1003, P2 -> P3); markers that still have a
      // bar are kept (ML1505's P4). Only a marker left without one is a
      // question, since a multi-period exam placement is not derivable.
      const newPeriods = [...new Set(credits.map(c => c.period))];
      const place = (list: Period['id'][]): Period['id'][] =>
        !list.length ? list : newPeriods.length === 1 ? [newPeriods[0]] : list.filter(p => newPeriods.includes(p));
      const exams = place(course.exams);
      if (newPeriods.length > 1 && exams.length < course.exams.length) {
        warnings.push(
          `${code} is rescheduled, but it carries exam marker(s) in ${course.exams.join(', ')} ` +
          `from ${plan.to}'s own offering — check where the exam falls in the offering actually taken.`,
        );
      }
      fromTarget.push({
        ...course, credits, exams, reexams: place(course.reexams),
        examsByYear: undefined, reexamsByYear: undefined,
      });
      continue;
    }

    // A group cannot offer a course the student already took in the source
    // years, or was exempted from. CELTE's year-2 group lists SF1546, which a
    // COPEN student read in year 1; left in, the renderer treats it as an
    // unpicked option and hides the course everywhere, year 1 included.
    if (isGroup(entry)) {
      const options = entry.options.filter(c => !sourceCodes.has(c) && !exemptCodes.has(c));
      fromTarget.push(options.length === entry.options.length ? entry : { ...entry, options });
      continue;
    }

    fromTarget.push(entry);
  }

  for (const code of exemptCodes) {
    if (!targetEntries.some(e => !isGroup(e) && e.code === code)) {
      warnings.push(`The plan exempts ${code}, but ${plan.to} does not list it.`);
    }
  }
  for (const [code, move] of movesByCode) {
    if (!targetEntries.some(e => !isGroup(e) && e.code === code)) {
      warnings.push(`The plan moves ${code} to year ${move.toYear}, but ${plan.to} does not list it.`);
    }
  }
  for (const code of reschedByCode.keys()) {
    if (!targetEntries.some(e => !isGroup(e) && e.code === code)) {
      warnings.push(`The plan reschedules ${code}, but ${plan.to} does not list it.`);
    }
  }

  // Courses from neither published plan — see TransitionAddition. Parsed with
  // the data-file loader so the period/credit normalisation is the same code.
  const added = plan.added?.length
    ? (parseCourseEntries(plan.added as never[]) as Course[])
    : [];
  for (const a of plan.added ?? []) {
    if (a.substitutesFor && !targetEntries.some(e => !isGroup(e) && e.code === a.substitutesFor)) {
      warnings.push(
        `${a.code} is recorded as substituting for ${a.substitutesFor}, which ${plan.to} does not list.`,
      );
    }
    if (targetEntries.some(e => !isGroup(e) && e.code === a.code)) {
      warnings.push(
        `${a.code} is added by the plan but ${plan.to} already lists it — it would appear twice.`,
      );
    }
  }

  const onlySpec = selectedSpecializations?.size === 1 ? [...selectedSpecializations][0] : undefined;
  const regrouped = applyGroupChanges([...fromSource, ...fromTarget, ...added], plan, warnings, onlySpec);

  // --- redirect prerequisites onto the courses actually taken --------------
  const { entries: rewritten, warnings: rewriteWarnings } =
    redirectPrerequisites(regrouped, plan);
  const entries = rewritten;
  warnings.push(...rewriteWarnings);
  const loads = fullTimeLoads(entries, selectedSpecializations);

  return {
    entries,
    credited: plan.credited,
    exempted: plan.exempt ?? [],
    moved: plan.moved ?? [],
    warnings,
    loads,
  };
}

/**
 * Credits for a moved course's `periodCredits`: flat for `toYear`, or keyed by
 * study year for a course read over several (CMETE's DM1578).
 */
function movedCredits(
  pc: Record<string, number> | Record<string, Record<string, number>>,
  toYear: number,
): Course['credits'] {
  const byYear = Object.keys(pc).filter(k => /^Year\d+$/.test(k));
  const rows: [number, Record<string, number>][] = byYear.length
    ? byYear.map(k => [Number(k.slice(4)), (pc as Record<string, Record<string, number>>)[k]])
    : [[toYear, pc as Record<string, number>]];
  return rows.flatMap(([year, map]) => PERIODS
    .map(period => ({ year, period, credits: Number(map[period] ?? 0) }))
    .filter(c => c.credits > 0));
}

/**
 * Extend the target's option groups as the plan says; see TransitionGroupChange.
 *
 * Runs on the composed entries, after `moved`, so a course moved into the
 * group's year (CSAMH's AG1314) is already there to become an option. Once it
 * is an option, the group bar stands for it: the renderer draws it only when
 * picked, and the load check counts the group rather than the course.
 */
function applyGroupChanges(entries: Entry[], plan: TransitionPlan, warnings: string[], spec?: string): Entry[] {
  if (!plan.groupChanges?.length) return entries;
  const out = [...entries];
  const courses = new Map(
    entries.filter((e): e is Course => !isGroup(e)).map(e => [e.code, e]),
  );
  for (const change of plan.groupChanges) {
    // With an inriktning selected, only a group it can see: CLGYM's four
    // year-3 boxes, one per inriktning, all offer DD1351.
    const at = out.findIndex(e => isGroup(e) && e.year === change.year && e.options.includes(change.offering)
      && (!spec || !e.specializations?.length || e.specializations.includes(spec)));
    if (at < 0) {
      warnings.push(
        `The plan changes the year-${change.year} group offering ${change.offering}, but the ` +
        `composed plan has no such group.`,
      );
      continue;
    }
    const group = out[at] as OptionGroup;
    if (change.satisfiedBy?.length) {
      // The student's credited course fills the choice; the options they did
      // not take leave the plan with the group, unless another group still
      // offers them.
      out.splice(at, 1);
      const stillOffered = new Set(out.filter(isGroup).flatMap(g => g.options));
      for (const code of group.options) {
        if (stillOffered.has(code)) continue;
        const i = out.findIndex(e => !isGroup(e) && e.code === code && entryYear(e) === change.year);
        if (i >= 0) out.splice(i, 1);
      }
      continue;
    }
    const options = [...group.options];
    for (const code of change.addOptions ?? []) {
      const course = courses.get(code);
      if (!course) {
        warnings.push(`The plan adds ${code} to the group offering ${change.offering}, but ${code} is not in the composed plan.`);
        continue;
      }
      if (entryYear(course) !== change.year) {
        warnings.push(
          `The plan adds ${code} to a year-${change.year} group, but the composed plan has it in ` +
          `year ${entryYear(course)}.`,
        );
      }
      if (!options.includes(code)) options.push(code);
    }
    // A smaller credit pool: the plan moves courses into part of its space.
    // Only for a group in one year: `change.periodCredits` is a flat map, and
    // applied to a spanning group it would leave its other years untouched.
    if (change.minCredits != null && spansYears(group)) {
      warnings.push(`The plan resizes the group offering ${change.offering}, which spans study years; a resize supports one-year groups only.`);
    }
    const resized = change.minCredits != null && change.periodCredits && !spansYears(group)
      ? {
        minCredits: change.minCredits,
        totalCredits: change.minCredits,
        periodCredits: Object.fromEntries(PERIODS.map(p => [p, Number(change.periodCredits![p] ?? 0)])) as OptionGroup['periodCredits'],
      }
      : {};
    out[at] = {
      ...group,
      ...resized,
      options,
      qualifiesFor: change.qualifiesFor ? { ...group.qualifiesFor, ...change.qualifiesFor } : group.qualifiesFor,
      comment: change.comment ?? group.comment,
      commentEn: change.commentEn ?? group.commentEn,
    };
  }
  return out;
}

const OVERLAY_KEYS: (keyof TransitionOverlay)[] = ['exempt', 'moved', 'rescheduled', 'added', 'groupChanges'];

/**
 * The plan as it applies to one inriktning: the common changes plus that
 * inriktning's own (`bySpecialization`), lists concatenated. With no single
 * inriktning selected, only the common part applies. See
 * TransitionPlan.bySpecialization; COPEN -> CLGYM is the case.
 */
export function effectivePlan(plan: TransitionPlan, selected?: Set<string> | string): TransitionPlan {
  const spec = typeof selected === 'string'
    ? selected
    : selected?.size === 1 ? [...selected][0] : undefined;
  const overlay = spec ? plan.bySpecialization?.[spec] : undefined;
  if (!overlay) return plan;
  const merged: TransitionPlan = { ...plan };
  for (const key of OVERLAY_KEYS) {
    const extra = overlay[key];
    if (!extra?.length) continue;
    (merged as unknown as Record<string, unknown[]>)[key] = [...(plan[key] ?? []), ...extra];
  }
  return merged;
}

/**
 * Point prerequisite arrows at the course the student actually took.
 *
 * A target course in years 2-3 states its prerequisites in the target's own
 * terms: CTFYS's SF1683 and SI1146 both require SF1674. A COPEN transfer student
 * never took SF1674 — they took SF1626, the same subject — so an arrow drawn to
 * the letter would start from a course that is not in their plan and simply
 * vanish, leaving those courses looking like they have no prerequisites at all.
 *
 * So every equivalence recorded in the plan becomes a rewrite: any reference to a
 * replaced target course is redirected to the source course that credits it. This
 * is a general rule over the plan's own data, not a list of special cases — the
 * five CTFYS references (DD1331, SF1672, SF1674, SG1112, SK1104) all resolve
 * through it, and a plan for another programme needs only its own `replaces`
 * entries.
 *
 * A reference that survives the rewrite but names a course outside the composed
 * plan is reported: it means an equivalence is missing, and the symptom would
 * otherwise be a silently absent arrow.
 */
function redirectPrerequisites(
  entries: Entry[],
  plan: TransitionPlan,
): { entries: Entry[]; warnings: string[] } {
  const warnings: string[] = [];

  // target code -> source code that stands in for it
  const replacedBy = new Map<string, string>();
  for (const credit of plan.credited) {
    for (const target of credit.replaces ?? []) {
      const existing = replacedBy.get(target);
      if (existing && existing !== credit.code) {
        warnings.push(
          `${target} is recorded as replaced by both ${existing} and ${credit.code}; ` +
          `using ${existing}.`,
        );
        continue;
      }
      replacedBy.set(target, credit.code);
    }
  }
  // `exempt.creditedBy` says the same thing in the other direction.
  for (const ex of plan.exempt ?? []) {
    if (ex.creditedBy && !replacedBy.has(ex.code)) replacedBy.set(ex.code, ex.creditedBy);
  }
  // An `added` course standing in for a target course inherits its arrows too.
  for (const add of plan.added ?? []) {
    if (add.substitutesFor && !replacedBy.has(add.substitutesFor)) {
      replacedBy.set(add.substitutesFor, add.code);
    }
  }

  const present = new Set(
    entries.filter((e): e is Course => !isGroup(e)).map(e => e.code),
  );

  const remap = (codes: string[] | undefined, owner: string): string[] | undefined => {
    if (!codes?.length) return codes;
    const out: string[] = [];
    for (const code of codes) {
      const mapped = replacedBy.get(code) ?? code;
      if (!present.has(mapped)) {
        // Not in the composed plan and no equivalence covers it — the arrow
        // would disappear without explanation.
        warnings.push(
          `${owner} requires ${code}${mapped !== code ? ` (mapped to ${mapped})` : ''}, ` +
          `which is not in the composed plan — add an equivalence for it, or the ` +
          `prerequisite arrow will be missing.`,
        );
        continue;
      }
      if (mapped !== owner && !out.includes(mapped)) out.push(mapped);
    }
    return out;
  };

  const mapped = entries.map((entry) => {
    if (isGroup(entry)) return entry;
    const course = entry;
    const completed = remap(course.prerequisitesCompleted, course.code);
    const participation = remap(course.prerequisitesParticipation, course.code);
    const flat = remap(course.prerequisites, course.code);
    if (completed === course.prerequisitesCompleted
      && participation === course.prerequisitesParticipation
      && flat === course.prerequisites) return course;
    return {
      ...course,
      prerequisites: flat ?? [],
      prerequisitesCompleted: completed,
      prerequisitesParticipation: participation,
    };
  });

  return { entries: mapped, warnings };
}

const PERIODS: Period['id'][] = ['P1', 'P2', 'P3', 'P4'];
const FULL_TIME_HP = 15;
const LOAD_TOLERANCE = 0.05;

/**
 * Check the composed years against full-time study.
 *
 * The same signal `validate-data` uses on the programme files, applied to the
 * composition — because a swap can balance over a year while leaving individual
 * periods lopsided, and that is invisible in the year total. COPEN -> CTFYS is
 * exactly that case: dropping SF1544 (P2 1 hp, P3 5 hp) and picking up SF1922
 * (P4 6 hp) keeps year 2 at 60 hp while making it 15/14/10/21.
 *
 * Reported rather than corrected. Where the plan puts a course is the program
 * director's call, and the arithmetic is what they need in order to make it.
 */
function fullTimeLoads(
  entries: Entry[],
  selectedSpecializations?: Set<string>,
): YearLoad[] {
  // A course tagged with inriktningar is taken only by students on one of them,
  // so counting every tag at once overstates the year. CMAST is the case: its
  // three language tracks are 37.5 hp together and a student takes at most one,
  // which made the composed year 2 read 90 hp against a true 61.5. When the view
  // has a selection, count a tagged course only if it matches; with no selection
  // (no registry, or nothing picked yet) keep the old behaviour of counting it,
  // since dropping every tagged course would understate the year instead.
  const matchesSpec = (e: Entry): boolean => {
    const specs = e.specializations;
    if (!specs?.length) return true;
    if (!selectedSpecializations?.size) return true;
    return specs.some(c => selectedSpecializations.has(c));
  };
  // Option groups are filtered the same way, and membership is taken from the
  // visible groups only, as the renderer and validate-data do. Counting every
  // inriktning's groups put COPEN -> CSAMH's year 3 at 45 hp in STP's P4, and a
  // course obligatorisk for one inriktning but an option for another would
  // otherwise drop out of the first one's load.
  const groups = entries.filter(isGroup).filter(matchesSpec);
  const inGroup = new Set(groups.flatMap(g => g.options));
  const byYear = new Map<number, Record<string, number>>();

  const add = (year: number, period: string, hp: number) => {
    const row = byYear.get(year) ?? Object.fromEntries(PERIODS.map(p => [p, 0]));
    row[period] = (row[period] ?? 0) + hp;
    byYear.set(year, row);
  };

  for (const entry of groups) {
    // A group counts once; the student takes one of its options, so the
    // member courses must not be counted as well.
    for (const c of groupCredits(entry)) add(c.year, c.period, c.credits);
  }
  for (const entry of entries) {
    if (isGroup(entry)) continue;
    if (inGroup.has(entry.code)) continue;
    if (!matchesSpec(entry)) continue;
    // The inriktning's own layout, as the renderer draws it: CLGYM's LT1037 is
    // P3+P4 but P1+P4 for TEMI, and CINEK's DD1320 sits in year 3 for PPUI.
    const spec = selectedSpecializations?.size === 1 ? [...selectedSpecializations][0] : undefined;
    const layout = spec ? entry.periodCreditsBySpecialization?.[spec] : undefined;
    const yearOverride = spec ? entry.yearBySpecialization?.[spec] : undefined;
    if (layout) {
      const y = yearOverride ?? entryYear(entry);
      for (const p of PERIODS) add(y, p, layout[p] ?? 0);
      continue;
    }
    for (const c of entry.credits) add(yearOverride ?? c.year, c.period, c.credits);
  }

  const out: YearLoad[] = [];
  for (const year of [...byYear.keys()].sort()) {
    const row = byYear.get(year)!;
    const load = PERIODS.map(p => Math.round((row[p] ?? 0) * 10) / 10);
    const off = load.some(hp => hp > 0 && Math.abs(hp - FULL_TIME_HP) > LOAD_TOLERANCE);
    if (off) out.push({ year, load });
  }
  return out;
}

// The five colour families, in the order a spare one is handed out. Kept in the
// same order as the palette so the first spare is visually distinct from the
// four a typical programme already uses.
const FAMILY_ORDER: FamilyName[] = ['blue', 'green', 'brick', 'yellow', 'turquoise'];

// A course's department, its two-letter code prefix: SF1625 -> SF.
const prefixOf = (code: string) => code.slice(0, 2);

// Departments by subject, for a course whose own department the target has no
// course of. Read off the cosmetics files that use the common group names (the
// eight masters, CTFYS, CFATE and COPEN): every prefix they file, under the
// group that holds most of its courses. SK is "Fysik" in 37 of 39 cases, SG
// "Ingenjörsämnen" in 16 of 20, SA "Övrigt" in 4 of 7. TTFYM's SH and SI
// courses then find CFATE's physics in "Fysik & Mekanik", which holds SK1112
// but no SH or SI course.
const SUBJECTS: string[][] = [
  ['SF'],
  ['CB', 'EF', 'SH', 'SI', 'SK'],
  ['DD', 'DH', 'DT', 'ID'],
  ['AG', 'AH', 'BB', 'CM', 'DM', 'ED', 'EG', 'EH', 'EI', 'EK', 'EL', 'EP', 'EQ', 'HL',
    'IK', 'IL', 'KD', 'MF', 'MJ', 'SD', 'SE', 'SG', 'SM'],
  ['AK', 'DA', 'EA', 'LS', 'ME', 'MH', 'SA'],
];
const subjectOf = new Map(SUBJECTS.flatMap((prefixes, i) => prefixes.map(p => [p, i] as const)));

/**
 * The group of `groups` a course belongs with: the one listing its code, else
 * the one listing the most courses of its department, else of its subject.
 * The earlier group wins a tie. Null when no group has either.
 */
function homeFor(code: string, groups: CourseGroup[]): CourseGroup | null {
  const exact = groups.find(g => g.courses.includes(code));
  if (exact) return exact;
  const mostOf = (same: (c: string) => boolean): CourseGroup | null => {
    let best: CourseGroup | null = null;
    let bestCount = 0;
    for (const g of groups) {
      const n = g.courses.filter(same).length;
      if (n > bestCount) { best = g; bestCount = n; }
    }
    return best;
  };
  const subject = subjectOf.get(prefixOf(code));
  return mostOf(c => prefixOf(c) === prefixOf(code))
    ?? (subject === undefined ? null : mostOf(c => subjectOf.get(prefixOf(c)) === subject));
}

/**
 * Merge two programmes' cosmetics for a composed plan.
 *
 * Needed because the two files share no course codes: CTFYS's cosmetics say
 * nothing about SF1625 or DD1310, so a composed COPEN+CTFYS chart rendered from
 * the target's file alone would draw all nine COPEN courses in the default
 * colour.
 *
 * Merging is by group NAME first, so "Matematik" from both programmes becomes
 * one legend row. The target's colour wins where the two disagree, because most
 * of the years come from it: CTFYS has Ingenjörsämnen = brick while COPEN has
 * it turquoise, and the composed chart follows CTFYS.
 *
 * A source group with no namesake is split by course: each course joins the
 * target group listing its code, else the one listing the most courses of its
 * department, its two-letter code prefix (SF maths; SK, SH, SI physics; DD
 * computing), which is what the cosmetics files group by, else of its subject
 * (`SUBJECTS`: SH and SK are both physics). That colours it
 * the way the target programme colours its own courses of that department:
 * COPEN's "Programmering" is DD1310 and SF1546, and in CTFYS they go to
 * "Datateknik" and to "Matematik", where CTFYS files its own SF1544.
 *
 * The names are the programme's own and rarely match. The masters use five
 * ("Matematik", "Fysik", "Datateknik", "Ingenjörsämnen", "Övrigt"), while CFATE
 * says "Fysik & Mekanik", CTMAT "Fysik & Ingenjörsvetenskap" and CDATE
 * "Datalogi och programmering". Merged by name alone, each such group needed a
 * colour of its own, and most programmes already use all five. Measured over
 * every composition the app offers, 19 of the 36 bachelor + master pairs and
 * all 18 COPEN transitions had a group left in the default colour: all 54 of
 * TTFYM's physics courses after CFATE, 80 TCSCM courses after CDATE, and COPEN's
 * own physics and programming courses in 16 of the transition views.
 *
 * Courses with no such home keep a legend row of their own, under the source
 * group's name, in a colour family not yet in use. It does not keep its own
 * colour, which would collide (COPEN's Programmering is brick, which CTFYS
 * spends on Ingenjörsämnen). With no family left they join the target's
 * "Övrigt": CDATE has no physics course, so COPEN's SK1115 and SG1133 have no
 * department to join. Without an "Övrigt" either, they keep the default
 * colour, with a warning; the five-family cap is hard.
 *
 * "Övrigt" itself is kept whole. It holds the programme-wide courses (AK, SA,
 * ME) and the elective placeholders, and yellow is elective space (the palette
 * convention in CLAUDE.md), so it goes to its namesake, then to yellow, and
 * only then is split like the others.
 */
export function mergeCosmetics(
  target: ProgramCosmetics | null,
  source: ProgramCosmetics | null,
  plan?: TransitionPlan,
): { cosmetics: ProgramCosmetics | null; warnings: string[] } {
  if (!target && !source) return { cosmetics: null, warnings: [] };
  if (!target) return withAdditions(source!, plan);
  if (!source) return withAdditions(target, plan);

  const warnings: string[] = [];
  const groups: CourseGroup[] = target.groups.map(g => ({ ...g, courses: [...g.courses] }));
  const byName = new Map(groups.map(g => [g.name, g]));
  const usedFamilies = new Set(groups.map(g => g.colorFamily));

  const add = (into: CourseGroup, codes: string[]) => {
    for (const code of codes) {
      if (!into.courses.includes(code)) into.courses.push(code);
    }
  };
  // A course's home is looked for among the target's own groups only: they
  // are what the chart's other years are coloured by.
  const targetGroups = [...groups];
  const newRow = (sourceGroup: CourseGroup, codes: string[], order: FamilyName[]): boolean => {
    const spare = order.find(f => !usedFamilies.has(f));
    if (!spare) return false;
    usedFamilies.add(spare);
    const row: CourseGroup = { ...sourceGroup, colorFamily: spare, courses: [...codes] };
    groups.push(row);
    byName.set(row.name, row);
    return true;
  };
  const NON_YELLOW = FAMILY_ORDER.filter(f => f !== 'yellow');

  for (const sourceGroup of source.groups) {
    const existing = byName.get(sourceGroup.name);
    if (existing) { add(existing, sourceGroup.courses); continue; }
    // Yellow means elective space, so only an "Övrigt" group may take it, and
    // it takes it first. COPEN's "Fysik" merged into CTMAT used to come out
    // yellow, the elective boxes' colour.
    if (sourceGroup.name === 'Övrigt' && newRow(sourceGroup, sourceGroup.courses, ['yellow'])) continue;

    const homeless: string[] = [];
    for (const code of sourceGroup.courses) {
      const home = homeFor(code, targetGroups);
      if (home) add(home, [code]);
      else homeless.push(code);
    }
    if (homeless.length === 0) continue;
    if (newRow(sourceGroup, homeless, NON_YELLOW)) continue;
    const other = byName.get('Övrigt');
    if (other) { add(other, homeless); continue; }
    warnings.push(
      `Cosmetics group '${sourceGroup.name}': ${homeless.join(', ')} share no department with ` +
      `any group and no colour family is left — they render in the default colour.`,
    );
  }

  const merged = withAdditions({ groups, courseToGroup: new Map() }, plan);
  return { cosmetics: merged.cosmetics, warnings: [...warnings, ...merged.warnings] };
}

/**
 * File the plan's `added` courses into the group each one names, then rebuild the
 * code → group index. Without this an added course renders in the default
 * colour, which next to the light-tone palette reads as a mistake rather than as
 * "this came from elsewhere".
 */
function withAdditions(
  cosmetics: ProgramCosmetics,
  plan?: TransitionPlan,
): { cosmetics: ProgramCosmetics; warnings: string[] } {
  const warnings: string[] = [];
  const groups = cosmetics.groups.map(g => ({ ...g, courses: [...g.courses] }));
  for (const add of plan?.added ?? []) {
    if (!add.cosmeticsGroup) continue;
    const group = groups.find(g => g.name === add.cosmeticsGroup);
    if (!group) {
      warnings.push(
        `${add.code} names cosmetics group '${add.cosmeticsGroup}', which the composed ` +
        `view has no group for — it renders in the default colour.`,
      );
      continue;
    }
    if (!group.courses.includes(add.code)) group.courses.push(add.code);
  }
  const courseToGroup = new Map<string, CourseGroup>();
  for (const g of groups) for (const code of g.courses) courseToGroup.set(code, g);
  return { cosmetics: { groups, courseToGroup }, warnings };
}

// ---------------------------------------------------------------------------
// Titling a composed view
// ---------------------------------------------------------------------------

// KTH programme names all begin with the qualification, which is the same for
// both halves of a transition and so pure noise the second time:
// "Civilingenjörsutbildning Öppen ingång → Civilingenjörsutbildning i Teknisk
// fysik" says "Civilingenjörsutbildning" twice and buries the part that differs.
//
// Stripping a *fixed* set of openers is deliberate. Taking the longest common
// word prefix instead looks more general but is wrong on the English names:
// "Degree Program in Engineering - Open Entrance" and "Degree Program in
// Engineering Physics" share "Degree Program in Engineering", which would reduce
// CTFYS to "Physics". The set below is short, and an unrecognised name falls
// through unchanged rather than being mangled.
const PROGRAM_NAME_PREFIXES = [
  /^Civilingenjörsutbildning(?:\s+i)?\s+/i,
  /^Högskoleingenjörsutbildning(?:\s+i)?\s+/i,
  /^Masterprogram,\s+/i,
  /^Degree Program(?:me)?(?:\s+in)?\s+/i,
  /^Master's Programme,\s+/i,
];

/**
 * The distinguishing part of a programme name, for use after an arrow.
 *
 * "Civilingenjörsutbildning i Teknisk fysik" -> "Teknisk fysik". The first letter
 * is capitalised because several names lower-case the subject
 * ("…i maskinteknik"), which reads wrong once it starts a phrase.
 */
export function shortProgramName(name: string): string {
  for (const prefix of PROGRAM_NAME_PREFIXES) {
    const stripped = name.replace(prefix, '');
    if (stripped !== name && stripped.length > 0) {
      return stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }
  }
  return name;
}

/** Name and code for a composed view: "A → B" / "COPEN → CTFYS". */
export function composedTitle(
  sourceName: string,
  targetName: string,
  from: string,
  to: string,
): { name: string; code: string } {
  return {
    name: `${sourceName} → ${shortProgramName(targetName)}`,
    code: `${from} → ${to}`,
  };
}
