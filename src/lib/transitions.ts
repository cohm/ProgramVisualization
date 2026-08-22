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
import type { TransitionCredit, TransitionPlan } from '@/types/transition';
import { parseCourseEntries } from '@/lib/useCourseModel';
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
  plan: TransitionPlan,
): ComposedPlan {
  const warnings: string[] = [];
  const sourceYears = new Set(plan.sourceYears);
  const exemptCodes = new Set((plan.exempt ?? []).map(e => e.code));
  const movesByCode = new Map((plan.moved ?? []).map(m => [m.code, m]));

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
      fromTarget.push({
        ...course,
        year: move.toYear,
        credits: course.credits.map(c => ({ ...c, year: move.toYear })),
        examsByYear: undefined,
        reexamsByYear: undefined,
      });
      continue;
    }

    if (sourceYears.has(year)) continue;              // replaced by the source year
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

  // --- redirect prerequisites onto the courses actually taken --------------
  const { entries: rewritten, warnings: rewriteWarnings } =
    redirectPrerequisites([...fromSource, ...fromTarget, ...added], plan);
  const entries = rewritten;
  warnings.push(...rewriteWarnings);
  warnings.push(...fullTimeWarnings(entries, plan));

  return {
    entries,
    credited: plan.credited,
    exempted: plan.exempt ?? [],
    moved: plan.moved ?? [],
    warnings,
  };
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
function fullTimeWarnings(entries: Entry[], plan: TransitionPlan): string[] {
  const groups = entries.filter(isGroup);
  const inGroup = new Set(groups.flatMap(g => g.options));
  const byYear = new Map<number, Record<string, number>>();

  const add = (year: number, period: string, hp: number) => {
    const row = byYear.get(year) ?? Object.fromEntries(PERIODS.map(p => [p, 0]));
    row[period] = (row[period] ?? 0) + hp;
    byYear.set(year, row);
  };

  for (const entry of entries) {
    if (isGroup(entry)) {
      // A group counts once; the student takes one of its options, so the
      // member courses must not be counted as well.
      for (const p of PERIODS) add(entry.year, p, entry.periodCredits[p] ?? 0);
      continue;
    }
    if (inGroup.has(entry.code)) continue;
    for (const c of entry.credits) add(c.year, c.period, c.credits);
  }

  const out: string[] = [];
  for (const year of [...byYear.keys()].sort()) {
    const row = byYear.get(year)!;
    const load = PERIODS.map(p => Math.round((row[p] ?? 0) * 10) / 10);
    const short = PERIODS.filter((p, i) => load[i] > 0 && load[i] < FULL_TIME_HP - LOAD_TOLERANCE);
    const over = PERIODS.filter((p, i) => load[i] > FULL_TIME_HP + LOAD_TOLERANCE);
    if (short.length === 0 && over.length === 0) continue;
    const parts = [
      short.length ? `short in ${short.map(p => `${p} ${Math.round((FULL_TIME_HP - row[p]) * 10) / 10}`).join(', ')}` : '',
      over.length ? `over in ${over.map(p => `${p} +${Math.round((row[p] - FULL_TIME_HP) * 10) / 10}`).join(', ')}` : '',
    ].filter(Boolean);
    out.push(
      `${plan.from}+${plan.to} year ${year}: load ${load.join('/')} hp — ${parts.join(' and ')}. ` +
      `The year totals ${Math.round(load.reduce((a, b) => a + b, 0) * 10) / 10} hp, so this is a ` +
      `distribution question rather than a missing course: confirm with the program director.`,
    );
  }
  return out;
}

// The five colour families, in the order a spare one is handed out. Kept in the
// same order as the palette so the first spare is visually distinct from the
// four a typical programme already uses.
const FAMILY_ORDER: FamilyName[] = ['blue', 'green', 'brick', 'yellow', 'turquoise'];

/**
 * Merge two programmes' cosmetics for a composed plan.
 *
 * Needed because the two files share no course codes: CTFYS's cosmetics say
 * nothing about SF1625 or DD1310, so a composed COPEN+CTFYS chart rendered from
 * the target's file alone would draw all nine COPEN courses in the default
 * colour.
 *
 * Merging is by group NAME, so "Matematik" from both programmes becomes one
 * legend row. The target's colour wins where the two disagree, because two of
 * the three years come from it: CTFYS has Ingenjörsämnen = brick while COPEN has
 * it turquoise, and the composed chart follows CTFYS. A group only the source
 * has — COPEN's "Programmering" — takes the first family not already in use,
 * rather than its own colour, which would collide (COPEN's Programmering is
 * brick, which CTFYS already spends on Ingenjörsämnen).
 *
 * The five-family cap is hard, so an overflow is reported rather than papered
 * over: the extra group keeps its courses and falls back to the default colour.
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

  for (const sourceGroup of source.groups) {
    const existing = byName.get(sourceGroup.name);
    if (existing) {
      for (const code of sourceGroup.courses) {
        if (!existing.courses.includes(code)) existing.courses.push(code);
      }
      continue;
    }
    const spare = FAMILY_ORDER.find(f => !usedFamilies.has(f));
    if (!spare) {
      warnings.push(
        `Cosmetics group '${sourceGroup.name}' has no colour family left — the ` +
        `five-family cap is reached, so its courses render in the default colour.`,
      );
      continue;
    }
    usedFamilies.add(spare);
    const merged: CourseGroup = { ...sourceGroup, colorFamily: spare, courses: [...sourceGroup.courses] };
    groups.push(merged);
    byName.set(merged.name, merged);
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
