/**
 * Transition plans: COPEN year 1 followed by two years of a target programme.
 *
 * COPEN (Öppen ingång) students take one common year and then transfer into a
 * five-year civilingenjör programme. The target programme credits most of what
 * they already took, exempts them from a course or two, and sometimes has them
 * pick up a course the target's own students took in year 1. That combination is
 * what a student actually studies, and it matches no single published plan — so
 * it is composed here from both programmes plus the plan below.
 *
 * The shape is deliberately declarative rather than a list of courses: the
 * composed plan has to stay correct when either programme's data is
 * re-extracted, and a hand-written course list would silently go stale. What is
 * recorded is the *difference* from the target programme's published plan.
 */

import type { MasterEligibility } from '@/types/course';

/** A target course the transferring student does not take. */
export interface TransitionExemption {
  /** Course code in the TARGET programme that is dropped. */
  code: string;
  /** The source-programme course that credits it, when there is a single one. */
  creditedBy?: string;
  note?: string;
  noteEn?: string;
}

/**
 * A target course that moves to a different study year.
 *
 * CTFYS's SF1922 is the motivating case: its own students take it in year 1 P4,
 * which a COPEN transfer student was never present for, so they take the same P4
 * offering during their year 2. The period is deliberately NOT changed — it is
 * the same course instance, just reached a year later.
 */
export interface TransitionMove {
  code: string;
  fromYear: number;
  toYear: number;
  /**
   * The part of the course still read, when the rest is credited. CENMI's
   * CK1020 is 6 hp in P4; 3 hp are credited from COPEN's KD1000 and the
   * student reads the other 3 with CENMI year 1. Omitted, the course keeps
   * all its periods. Must not sum to more than the course's own credits; equal
   * means the whole course in other periods (CTKEM's BB1050, read with BB1150).
   *
   * May be keyed by study year, `{ Year2: {…}, Year3: {…} }`, for a course
   * that spans years. CMETE's DM1578 runs over years 1-3; the transfer student
   * reads 5 hp of it in year 2 (3 of them CMETE's year-1 part) and 2 in year 3.
   * `toYear` is then the first of those years.
   */
  periodCredits?: Record<string, number> | Record<string, Record<string, number>>;
  note?: string;
  noteEn?: string;
}

/**
 * A target course the student takes in its other offering of the same year.
 *
 * `moved` changes the study year and keeps the periods; this is the mirror
 * image — same year, different periods — for a course KTH gives more than once
 * a year where the transition makes the non-default offering the better choice.
 *
 * CINEK's DD1320 is the case. Its study plan says the course "kan läsas under
 * höstterminen istället för under våren", and for a student arriving from COPEN
 * the autumn offering is markedly better: their year 2 is back-loaded, because
 * three of CINEK's year-1 business courses are read during it. Measured over the
 * composed year, P1/P2/P3/P4 goes from 10/18.5/20/20.5 to 15/19.5/16/18.5 — the
 * same 69 hp, distributed far closer to full time.
 *
 * Only the periods are recorded, not a copy of the course, so the composition
 * stays a pure function of the target programme's current data: everything else
 * — name, credits, prerequisites, grading — still comes from there.
 */
export interface TransitionReschedule {
  code: string;
  /** The offering's periods, replacing the ones the target programme lists. */
  periodCredits: Record<string, number>;
  /**
   * Source courses that are credited for the rest, when the periods cover
   * only part of the course. CMEDT's year-3 elective placeholder is 9 hp in P1
   * and 6.5 hp in P2; the plan counts COPEN's SF1546 and KD1000 (9 hp) as
   * electives, so the transfer student's space is the 6.5 hp in P2. Without
   * it the periods must add up to the whole course.
   */
  creditedBy?: string[];
  note?: string;
  noteEn?: string;
}

/**
 * A course the transferring student takes that neither published plan lists.
 *
 * COPEN -> CTFYS needs one: a COPEN student has no probability course, while
 * CTFYS teaches SF1922 in its year 1, which the transfer student was not present
 * for. Rather than wait for CTFYS's next P4 offering, they take SF1920 in P3 of
 * year 2 alongside CELTE's second year — the same subject, earlier, and it lands
 * in the period the exemption emptied.
 *
 * CELTE is not a programme this app models, so the course is embedded here in the
 * same raw shape a data file uses and parsed with the same loader
 * (`parseCourseEntries`). `fromProgram` and `substitutesFor` record where it came
 * from and why, since neither is derivable from the course itself.
 */
export interface TransitionAddition {
  code: string;
  name: string;
  nameEn?: string;
  totalCredits: number;
  year: number;
  /**
   * Flat `{P1..P4}`, or the data files' by-year shape `{Year2: {P1..P4}, …}`
   * for a course spanning study years. Parsed by `parseCourseEntries`, which
   * already normalises both, so nothing downstream needs to know which was used.
   *
   * CELTE's EN1001 is why the second shape is allowed here: it runs 3 hp in
   * year 2 and 3 hp in year 3, and exists specifically for students arriving
   * from Öppen ingång — its own eligibility text says so.
   */
  periodCredits: Record<string, number> | Record<string, Record<string, number>>;
  exams?: string[];
  reexams?: string[];
  prerequisites?: string[];
  prerequisitesCompleted?: string[];
  prerequisitesParticipation?: string[];
  gradingScale?: string;
  courseLevel?: string;
  category?: string;
  /** Target-programme course this stands in for, when there is one. */
  substitutesFor?: string;
  /** Programme whose plan this course is taken from, for provenance. */
  fromProgram?: string;
  /**
   * Cosmetics group this course belongs to in the composed view, by name.
   *
   * Needed because the course is in neither programme's cosmetics file, so it
   * would otherwise render in the default colour — visibly out of place next to
   * the light-tone palette. SF1920 is a maths course and says so here.
   */
  cosmeticsGroup?: string;
  note?: string;
  noteEn?: string;
}

/**
 * A change to one of the target programme's option groups.
 *
 * COPEN -> CSAMH is the case. CSAMH's own year-2 P4 group is "two of AF1002,
 * AH1030 and SF1676". A transfer student also reads AG1314 there, which CSAMH's
 * own students took in year 1, so for them the same slot is two of FOUR. Which
 * two depends on the inriktning they are heading for, and the plan states that
 * per inriktning: STP must take AH1030, GIT AG1314, and so on.
 *
 * Moving AG1314 into year 2 as a course would draw it on top of the group and
 * put P4 at 22.5 hp. Making it an option of the group is what the plan says.
 *
 * The group is identified by a course it already offers, not by its name,
 * because the names of extracted groups are generated ("Villkorligt valfri
 * grupp 1") and would not survive a re-extraction.
 */
export interface TransitionGroupChange {
  /** Study year of the group, after any `moved` re-stamping. */
  year: number;
  /** A course the target's group already offers. */
  offering: string;
  /**
   * Courses added as options. Each must be in the composed plan (a target
   * course, typically one the plan `moved`, or an `added` one), so the option
   * has course data behind it.
   */
  addOptions?: string[];
  /**
   * Per option, which inriktningar require or recommend it. The same shape as
   * the master-programme eligibility on extracted groups, and rendered the same
   * way: "krävs för STP", "rek. för MHI".
   */
  qualifiesFor?: Record<string, MasterEligibility[]>;
  /**
   * A credited source course that already fills the group's choice. The group
   * and its remaining options are then left out of the composed plan. Several
   * courses may fill a credit pool together: CINTE's 36 hp year-2 box is filled
   * by six COPEN courses (39 hp).
   *
   * CBIOT's year-3 P4 choice is KD1270 or SF1626, and a COPEN student took
   * SF1626 in year 1. Without this the group would stay, offering KD1270 alone,
   * and P4 would read 22.5 hp. It is stated per plan rather than inferred from
   * "an option was already taken", because plans read that differently: COPEN
   * -> CELTE says "välj minst 1 (ej SF1546 … SG1130)" of a pick-three group.
   */
  satisfiedBy?: string | string[];
  /**
   * A smaller size for a `minCredits` group, when part of its space is taken
   * by courses the plan moves in. CITEH's year-3 box is 24 hp over P1-P4; the
   * transfer student reads ML1504 in its P3, and the plan leaves "Valfri/VV
   * 18 hp" in P1, P2 and P4. Both fields together, and the periods must sum to
   * `minCredits`.
   */
  minCredits?: number;
  periodCredits?: Record<string, number>;
  /**
   * A different count for a `pickN` group. CELTE's own students read "Tre
   * villkorligt valfria kurser … i årskurs 2 eller 3", a pick-three box in
   * year 2; COPEN -> CELTE says "Välj minst 1 (ej SF1546, SF1547, eller
   * SG1130)". The bar keeps its size: a group whose options differ in shape is
   * drawn as their per-period envelope, which one option fills as well as three.
   * What changes is how many the modal accepts and what the tooltip says.
   */
  pickN?: number;
  /** Replaces the group's own note. */
  comment?: string;
  commentEn?: string;
}

/**
 * A source-programme course credited into the target degree.
 *
 * `replaces` is what makes prerequisite arrows come out right. A target course
 * in years 2-3 states its prerequisites in terms of the target's own year 1 —
 * CTFYS's SF1683 requires SF1674 — but a transfer student never took that
 * course; they took the source's equivalent. Recording the equivalence lets the
 * composition rewrite those references, so the arrow starts from SF1626 where the
 * student actually earned the knowledge.
 *
 * Omit it for a course that credits general degree progress without standing in
 * for a specific target course (SA1007, KD1000).
 */
export interface TransitionCredit {
  /** Course code in the SOURCE programme. */
  code: string;
  /** Target-programme course codes this stands in for. */
  replaces?: string[];
  note?: string;
  noteEn?: string;
}

/** The parts of a plan an inriktning may add to; see TransitionPlan.bySpecialization. */
export type TransitionOverlay = Pick<TransitionPlan, 'exempt' | 'moved' | 'rescheduled' | 'added' | 'groupChanges'>;

export interface TransitionPlan {
  /** Programme the student starts in (COPEN today). */
  from: string;
  /** Programme they transfer into. */
  to: string;
  /** Study years taken in the source programme, normally just [1]. */
  sourceYears: number[];
  /**
   * Source-programme courses credited into the target degree. Listed explicitly
   * rather than inferred as "everything in year 1" so the validator can flag a
   * plan that has drifted out of step with the programme data.
   */
  credited: TransitionCredit[];
  exempt?: TransitionExemption[];
  moved?: TransitionMove[];
  rescheduled?: TransitionReschedule[];
  added?: TransitionAddition[];
  groupChanges?: TransitionGroupChange[];
  /**
   * Changes that apply only when one inriktning is selected, merged over the
   * common ones (lists are concatenated).
   *
   * COPEN -> CLGYM is why. Its plan gives year 2 and year 3 as a separate table
   * per inriktning, and the same course lands in different years depending on
   * it: SF1633 is year 2 for TEMI and MAKE but year 3 for TEDA, and LT1038 is
   * year 2 for TEMI only. A per-inriktning overlay mirrors the plan as written,
   * one block per table, so each block can be checked against its table.
   */
  bySpecialization?: Record<string, TransitionOverlay>;
  /**
   * The source programme's admission cohorts the plan applies to. A plan
   * stands until it is revised, so `from` has no end: `{ from: "HT2025" }`
   * covers HT2025 and every later kull. Omitted when the plan does not say.
   * Nothing goes back before HT2025: no plan is known to hold for the older
   * cohorts, CTFYS's included.
   *
   * The chart composes a plan with whichever cohort is selected, so for a kull
   * before `from` it shows another cohort's plan. It says so rather than
   * hiding the view: an approximation is still what that student has.
   */
  cohorts?: { from: string };
  /** False until a program director has confirmed it, like `programs.json`. */
  verified?: boolean;
  source?: string;
  sourceEn?: string;
}
