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
  periodCredits: Record<string, number>;
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
  added?: TransitionAddition[];
  /** False until a program director has confirmed it, like `programs.json`. */
  verified?: boolean;
  source?: string;
  sourceEn?: string;
}
