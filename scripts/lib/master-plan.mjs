// A master programme's elective space, as ONE box per spår spanning both years.
//
// A civilingenjör programme states its choices per year, so the extractor builds
// them per year: villkorligt valfria courses grouped by period layout, and the
// remaining space filled with "Plats för valfri kurs" boxes. A master programme
// states them for the whole programme, and the per-year model misreads it:
//
//   TTFYM TFYA  "Under åk 1+2 ska studenten läsa 7,5 hp obligatoriska kurser samt
//                minst 32,5 hp villkorligt valfria kurser inom spåret."
//   TSCRM       "Välj minst 21 hp från listan av villkorligt valfria kurser."
//               (listed under both years, 18 of year 1's courses again in year 2)
//   TEFRM PHS   "Två av de villkorligt valfria kurserna ska väljas under år 1
//                eller år 2."
//
// Grouped by layout, TTFYM came out as 23 pick-one boxes, each a period's worth
// of a pool the student fills freely. So a master programme is built this way
// instead:
//
//   - the thesis stays a pick-one group (TTFYM's three, or two obligatoriska
//     alternatives such as TSCRM's DA236X/EA236X, which KOPPS lists as O);
//   - every other option group goes, and each spår gets one minCredits box over
//     its own shortfall per (year, period), in the by-year shape;
//   - its options are the spår's and the common villkorligt valfria courses,
//     then the rekommenderade and valfria ones, deduplicated;
//   - a course listed in both years becomes one entry with a round per year;
//   - the plan's rules become the box's `constraints`, and a rule not read is
//     reported.
//
// Pure: takes the extractor's entries and records, returns new entries plus the
// messages for the review file.

const PERIOD_IDS = ['P1', 'P2', 'P3', 'P4'];
const FULL_TIME_HP = 15;
const round = (n) => Math.round(n * 10) / 10;
const isGroup = (e) => e?.type === 'optionGroup';
const COURSE_CODE = /(?<![A-Z])[A-Z]{2}\d{4}[A-Z]?(?![A-Za-z0-9])/g;
const NUMBER_WORDS = { en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8 };
const numberOf = (w) => NUMBER_WORDS[String(w).toLowerCase()] ?? Number(String(w).replace(',', '.'));
// Word boundary for Swedish text: `\b` is ASCII-only (see CLAUDE.md).
const B = '(?<!\\p{L})';
const E = '(?!\\p{L})';
const NUM = `(\\d+(?:[.,]\\d+)?|en|ett|två|tre|fyra|fem|sex|sju|åtta)`;

const yearMaps = (e) => {
  const pc = e.periodCredits || {};
  if (Object.keys(pc).some((k) => /^Year\d+$/.test(k))) {
    return Object.fromEntries(Object.entries(pc).map(([k, v]) => [Number(k.slice(4)), v]));
  }
  return { [e.year ?? 1]: pc };
};
const firstPeriod = (pc) => PERIOD_IDS.find((p) => Number(pc?.[p] || 0) > 0) ?? 'P1';
const sameLayout = (a, b) => PERIOD_IDS.every((p) => round(Number(a?.[p] || 0)) === round(Number(b?.[p] || 0)));
const flatPeriods = (pc) => Object.fromEntries(PERIOD_IDS.map((p) => [p, round(Number(pc?.[p] || 0))]));

/**
 * @param {object} a
 * @param {object[]} a.entries        the extractor's entries and groups
 * @param {object[]} a.vvRecords      villkorligt valfria records ({ code, year, spec, periodCredits, credits, name })
 * @param {object[]} a.coreRecords    obligatoriska records, to tell a course
 *                                   obligatorisk in one spår from a choice in another
 * @param {object[]} a.electiveRecords valfria and rekommenderade records
 * @param {Map}      a.electivePeriods `${year}::${code}` -> { periodCredits, rounds }
 * @param {Map}      a.electiveNames   code -> English title
 * @param {object[]} a.ruleTexts      [{ year, spec, text }], the plan's own wording
 * @param {Map}      a.specNames      spec code -> name
 * @param {number}   a.years
 * @param {Function} a.roundIds       the extractor's id rule for alternative offerings
 */
export function buildMasterPlan(input) {
  const flags = [];
  const out = [];
  const a = keepOwnSpecs(input, flags);
  const byCode = new Map(a.entries.filter((e) => e.code).map((e) => [e.code, e]));
  const isThesis = (code) => /X$/.test(code) && Number(byCode.get(code)?.totalCredits || 0) >= 15;

  // --- the thesis ------------------------------------------------------------
  const theses = [];
  for (const e of a.entries) {
    if (!isGroup(e)) { out.push(e); continue; }
    if (e.options.length > 0 && e.options.every(isThesis)) {
      theses.push(e);
      out.push(e);
    }
    // any other group is replaced by the spår box below
  }
  // Two or more obligatoriska theses in the same place are alternatives: a
  // student writes one. TSCRM lists DA236X and EA236X as O, and says "Choose
  // DA236X or EA236X" in a free text.
  const alternatives = new Map();
  for (const e of out) {
    if (isGroup(e) || !isThesis(e.code) || (e.category && e.category !== 'mandatory')) continue;
    const key = `${e.year}|${(e.specializations || []).join(',')}|${JSON.stringify(flatPeriods(e.periodCredits))}`;
    if (!alternatives.has(key)) alternatives.set(key, []);
    alternatives.get(key).push(e);
  }
  for (const members of alternatives.values()) {
    if (members.length < 2) continue;
    const first = members[0];
    const group = {
      type: 'optionGroup',
      name: `Examensarbete${first.specializations?.length ? ` (${first.specializations.join(', ')})` : ''}`,
      nameEn: `Degree project${first.specializations?.length ? ` (${first.specializations.join(', ')})` : ''}`,
      year: first.year,
      totalCredits: round(Number(first.totalCredits)),
      periodCredits: flatPeriods(first.periodCredits),
      options: members.map((m) => m.code),
      allowedNumberOfOptions: 1,
      kind: 'pickN',
      pickN: 1,
      exams: [],
      category: 'conditionallyElective',
      ...(first.specializations?.length ? { specializations: [...first.specializations] } : {}),
    };
    for (const m of members) m.category = 'conditionallyElective';
    out.push(group);
    theses.push(group);
    flags.push(`year ${first.year}: ${members.map((m) => m.code).join(' and ')} are all listed as ` +
      `obligatoriska theses in the same periods — grouped as pick one, since a student writes one.`);
  }
  // Thesis groups get a readable name, unique per file.
  const thesisNames = new Set();
  for (const g of theses) {
    if (/^(Kandidatexamensarbete|Villkorligt valfri grupp)/.test(g.name)) {
      g.name = 'Examensarbete';
      g.nameEn = 'Degree project';
    }
    let name = g.name;
    for (let i = 2; thesisNames.has(name); i++) name = `${g.name} ${i}`;
    g.name = name;
    thesisNames.add(name);
  }

  // --- lanes -----------------------------------------------------------------
  const specs = [...new Set(out.flatMap((e) => e.specializations || []))].sort();
  const lanes = specs.length ? specs : [null];
  const visible = (e, lane) => !e.specializations?.length || (lane != null && e.specializations.includes(lane));

  // Offerings per code over both years, from what the plan lists.
  const offerings = new Map(); // code -> Map(year -> periodCredits)
  const addOffering = (code, year, pc) => {
    if (!pc || !PERIOD_IDS.some((p) => Number(pc[p] || 0) > 0)) return;
    if (!offerings.has(code)) offerings.set(code, new Map());
    if (!offerings.get(code).has(year)) offerings.get(code).set(year, flatPeriods(pc));
  };
  for (const r of a.vvRecords) addOffering(r.code, r.year, r.periodCredits);
  for (const r of a.electiveRecords) addOffering(r.code, r.year, a.electivePeriods.get(`${r.year}::${r.code}`)?.periodCredits);

  // --- option courses for valfria / rekommenderade ---------------------------
  const emitted = new Set(out.filter((e) => e.code).map((e) => e.code));
  for (const r of a.electiveRecords) {
    if (emitted.has(r.code) || isThesis(r.code)) continue;
    const got = a.electivePeriods.get(`${r.year}::${r.code}`);
    if (!got?.periodCredits) continue; // no round found; reported below if it was an option
    const pc = flatPeriods(got.periodCredits);
    const ids = a.roundIds(got.rounds ?? []);
    const entry = {
      code: r.code,
      name: r.name || r.code,
      ...(a.electiveNames.get(r.code) ? { nameEn: a.electiveNames.get(r.code) } : {}),
      totalCredits: round(PERIOD_IDS.reduce((s, p) => s + pc[p], 0)),
      periodCredits: pc,
      ...((got.rounds ?? []).length > 1
        ? { rounds: got.rounds.map((x, i) => ({ id: ids[i], periodCredits: flatPeriods(x.periodCredits), ...(x.applicationCode ? { applicationCode: String(x.applicationCode) } : {}) })) }
        : {}),
      year: r.year,
      prerequisites: [],
      exams: [],
      teacher: '',
      description: '',
      category: 'recommended',
      ...(r.spec ? { specializations: [r.spec] } : {}),
    };
    out.push(entry);
    byCode.set(r.code, entry);
    emitted.add(r.code);
  }
  // A valfri course named by more than one spår carries all of them.
  for (const r of a.electiveRecords) {
    const e = byCode.get(r.code);
    if (!e || e.category !== 'recommended') continue;
    if (!r.spec) { delete e.specializations; continue; }
    if (e.specializations) e.specializations = [...new Set([...e.specializations, r.spec])].sort();
  }

  // --- one round per study year -----------------------------------------------
  for (const [code, perYear] of offerings) {
    if (perYear.size < 2) continue;
    const e = byCode.get(code);
    if (!e || isGroup(e)) continue;
    if (e.yearBySpecialization || e.rounds?.length || Object.keys(e.periodCredits || {}).some((k) => k.startsWith('Year'))) {
      flags.push(`${code}: listed in years ${[...perYear.keys()].join(' and ')}, but already carries ` +
        `rounds or a per-inriktning year — not given a round per year. Verify by hand.`);
      continue;
    }
    const total = Number(e.totalCredits || 0);
    const years = [...perYear.keys()].sort((x, y) => x - y);
    const rounds = years.map((y) => {
      const pc = perYear.get(y);
      const base = firstPeriod(pc);
      return { id: y === e.year ? base : `${base}-y${y}`, ...(y === e.year ? {} : { year: y }), periodCredits: pc };
    });
    if (!rounds.some((r) => (r.year ?? e.year) === e.year)) {
      rounds.unshift({ id: firstPeriod(e.periodCredits), periodCredits: flatPeriods(e.periodCredits) });
    }
    if (rounds.some((r) => Math.abs(PERIOD_IDS.reduce((s, p) => s + r.periodCredits[p], 0) - total) > 0.05)) {
      flags.push(`${code}: listed in years ${years.join(' and ')} with periods that do not add up to ` +
        `its ${total} hp in each — not given a round per year. Verify by hand.`);
      continue;
    }
    // The default must mirror the entry's own year and periods.
    const own = rounds.find((r) => (r.year ?? e.year) === e.year);
    if (!sameLayout(own.periodCredits, e.periodCredits)) own.periodCredits = flatPeriods(e.periodCredits);
    e.rounds = rounds;
    flags.push(`${code}: listed in years ${years.join(' and ')} — one entry with a round per year ` +
      `(default year ${e.year}); a student reads it once.`);
  }

  // --- the spår boxes --------------------------------------------------------
  const texts = a.ruleTexts.filter((t) => t.text && t.text.trim());
  // Obligatorisk for this lane: listed as O for it, or for every student.
  // TTMAM's SF2524 is O for CSSE and a common villkorligt valfri course, so it
  // is CSSE's course and an option in every other spår's box.
  const mandatoryIn = (code, lane) => (a.coreRecords ?? []).some((r) => r.code === code && (!r.spec || r.spec === lane));
  const namedLists = readNamedLists(texts.map((t) => t.text).join('\n'));
  const laneOptions = new Map();
  for (const lane of lanes) {
    const laneVv = [...new Set(a.vvRecords.filter((r) => !r.spec || r.spec === lane).map((r) => r.code))]
      .filter((c) => byCode.has(c) && !isThesis(c));
    const ownVv = [...new Set(a.vvRecords.filter((r) => lane != null && r.spec === lane).map((r) => r.code))]
      .filter((c) => laneVv.includes(c));
    const laneElective = [...new Set(a.electiveRecords.filter((r) => !r.spec || r.spec === lane).map((r) => r.code))];
    const missing = laneElective.filter((c) => !byCode.has(c));
    const options = [...new Set([...laneVv, ...laneElective.filter((c) => byCode.has(c) && !isThesis(c))])]
      // A course obligatorisk for this lane is not an option in it.
      .filter((c) => !mandatoryIn(c, lane));
    const optionSet = new Set(options);
    laneOptions.set(lane, optionSet);

    // What the lane already reads, per (year, period).
    const load = new Map();
    const add = (y, p, v) => { if (v > 0) load.set(`${y}|${p}`, (load.get(`${y}|${p}`) || 0) + v); };
    for (const e of out) {
      if (!visible(e, lane)) continue;
      if (isGroup(e)) {
        if (!theses.includes(e)) continue;
        for (const [y, m] of Object.entries(yearMaps(e))) for (const p of PERIOD_IDS) add(y, p, Number(m?.[p] || 0));
        continue;
      }
      if (optionSet.has(e.code)) continue;
      if (theses.some((g) => g.options.includes(e.code))) continue;
      if (e.category && e.category !== 'mandatory') continue;
      if (e.code && (a.coreRecords ?? []).length && !mandatoryIn(e.code, lane)) continue;
      const yOver = lane != null ? e.yearBySpecialization?.[lane] : undefined;
      const pOver = lane != null ? e.periodCreditsBySpecialization?.[lane] : undefined;
      for (const [y, m] of Object.entries(yearMaps(e))) {
        const use = pOver || m;
        for (const p of PERIOD_IDS) add(yOver ?? y, p, Number(use?.[p] || 0));
      }
    }
    const byYear = {};
    for (let y = 1; y <= a.years; y++) {
      const row = {};
      for (const p of PERIOD_IDS) {
        const used = round(load.get(`${y}|${p}`) || 0);
        if (used > FULL_TIME_HP + 0.05) {
          flags.push(`${lane ?? 'common'} year ${y} ${p}: ${used} hp before any elective — over full-time. Verify.`);
        }
        row[p] = round(Math.max(0, FULL_TIME_HP - used));
      }
      if (PERIOD_IDS.some((p) => row[p] > 0)) byYear[y] = row;
    }
    const years = Object.keys(byYear).map(Number);
    if (years.length === 0 || options.length === 0) {
      if (years.length > 0) flags.push(`${lane ?? 'common'}: ${years.join(', ')} not full-time, but no course is listed to fill it.`);
      continue;
    }
    const total = round(years.reduce((s, y) => s + PERIOD_IDS.reduce((t, p) => t + byYear[y][p], 0), 0));
    const periodCredits = years.length === 1
      ? byYear[years[0]]
      : Object.fromEntries(years.map((y) => [`Year${y}`, byYear[y]]));

    // --- constraints ---------------------------------------------------------
    const constraints = [];
    const unread = [];
    const laneTexts = texts.filter((t) => t.spec == null || t.spec === lane);
    const seenSentences = new Set();
    for (const t of laneTexts) {
      // Sentences, then clauses: one sentence may state two rules, "minst en av
      // SF2832, SF2863 och SF2812, samt minst en av SF2527 och SF2524" (TTMAM).
      const clauses = t.text.split(/(?<=[.!?])\s+|\n+/)
        .flatMap((x) => x.split(/(?:,\s*(?:samt\s+|och\s+)?|\s+(?:samt|och)\s+)(?=minst\s)/iu));
      for (const raw of clauses) {
        const sentence = raw.replace(/\s+/g, ' ').trim();
        if (!sentence || seenSentences.has(sentence)) continue;
        seenSentences.add(sentence);
        const got = readRule(sentence, { lane, own: t.spec != null, laneVv, ownVv, options, vvRecords: a.vvRecords, namedLists, years: a.years, mandatory: (c) => mandatoryIn(c, lane) });
        if (got) {
          for (const c of got) {
            const key = `${c.kind}|${c.value}|${(c.from || []).join(',')}`;
            if (!constraints.some((x) => `${x.kind}|${x.value}|${(x.from || []).join(',')}` === key)) constraints.push(c);
          }
        } else if (RULE_WORDS.test(sentence) && /villkorligt|kurs/i.test(sentence)
          && new RegExp(`${B}${NUM}${E}`, 'iu').test(sentence)) {
          unread.push(sentence);
        }
      }
    }
    const laneName = lane ? (a.specNames.get(lane) || lane) : null;
    out.push({
      type: 'optionGroup',
      name: `Villkorligt valfria och valfria kurser${lane ? ` (${lane})` : ''}`,
      nameEn: `Conditionally elective and elective courses${lane ? ` (${lane})` : ''}`,
      year: years[0],
      totalCredits: total,
      periodCredits,
      options,
      allowedNumberOfOptions: options.length,
      kind: 'minCredits',
      minCredits: total,
      ...(constraints.length ? { constraints } : {}),
      exams: [],
      category: 'conditionallyElective',
      ...(lane ? { specializations: [lane] } : {}),
      comment: `${laneName ? `${laneName}: ` : ''}villkorligt valfria kurser${laneName ? ' för spåret' : ''} och exempel på valfria kurser. Även andra kan väljas; se utbildningsplanen.`,
      commentEn: 'Conditionally elective courses and examples of elective ones; others may also be chosen — see the study plan.',
    });
    flags.push(`${lane ?? 'common'}: one box over years ${years.join('+')} (${years.map((y) => PERIOD_IDS.map((p) => byYear[y][p]).join('/')).join(' | ')} hp, ${total} hp), ` +
      `${options.length} options (${laneVv.length} villkorligt valfria), ${constraints.length} rule(s) read` +
      (constraints.length ? `: ${constraints.map((c) => `${c.kind} ${c.value}${c.from ? ` of ${c.from.length}` : ''}`).join('; ')}` : '') + '.');
    for (const sentence of unread) flags.push(`${lane ?? 'common'}: rule not machine-read — "${sentence.slice(0, 220)}"`);
    if (missing.length) flags.push(`${lane ?? 'common'}: ${missing.length} listed elective(s) have no offering to place and are left out: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
  }

  // A course a spår box offers must be visible in that spår, and a course
  // obligatorisk for a spår in it; the filter is per inriktning. So each option
  // course is tagged with exactly those spår, or with none when that is all.
  if (lanes[0] != null) {
    for (const e of out) {
      if (isGroup(e) || !e.code) continue;
      const seen = lanes.filter((l) => laneOptions.get(l)?.has(e.code) || mandatoryIn(e.code, l));
      if (!lanes.some((l) => laneOptions.get(l)?.has(e.code))) continue;
      if (seen.length === lanes.length) delete e.specializations;
      else e.specializations = seen;
    }
  }

  // Option courses no box offers any more (a dropped layout group's) stay as
  // courses of their own only if they are obligatoriska somewhere.
  const offered = new Set(out.filter(isGroup).flatMap((g) => g.options));
  const kept = out.filter((e) => isGroup(e) || offered.has(e.code) || !e.category || e.category === 'mandatory');
  const dropped = out.filter((e) => !kept.includes(e)).map((e) => e.code);
  if (dropped.length) flags.push(`dropped ${dropped.length} course(s) no box offers: ${dropped.join(', ')}`);
  return { entries: kept, flags };
}

const RULE_WORDS = /(?<!\p{L})(minst|ska\s+(läsas|väljas)|måste|välj)(?!\p{L})/iu;

/**
 * Constraints stated in one sentence, or null when it states none this reads.
 *
 * Phrasings, from the TTFYM, TTMAM, TSCRM and TEFRM plans:
 *   "minst 32,5 hp villkorligt valfria kurser inom spåret"      credits, own list
 *   "Välj minst 21 hp från listan av villkorligt valfria kurser" credits
 *   "Minst två av … kurserna SK2533, SK2534 och SK2535"         count of a list
 *   "måste en av kurserna SF2930 eller SF2943 läsas"            count of a list
 *   "Minst 4 villkorligt valfria spårkurser ska läsas"          count
 *   "Av de villkorligt valfria kurserna i åk 1 ska 3 kurser väljas" count, one year
 */
function readRule(sentence, ctx) {
  const out = [];
  const label = sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
  // One study year named: the rule counts only that year's listing.
  const yearMatch = sentence.match(new RegExp(`${B}(?:åk|årskurs|år)\\s*(\\d)${E}`, 'iu'));
  const onlyYear = yearMatch && !/\d\s*(\+|och|eller)\s*\d/.test(sentence) ? Number(yearMatch[1]) : null;
  const vvPool = (() => {
    let pool = ctx.own && ctx.ownVv.length ? ctx.ownVv : ctx.laneVv;
    if (onlyYear) {
      const inYear = new Set(ctx.vvRecords.filter((r) => r.year === onlyYear && (!r.spec || r.spec === ctx.lane)).map((r) => r.code));
      pool = pool.filter((c) => inYear.has(c));
    }
    // Only what the box offers: a course obligatorisk for the lane is not an
    // option (TTMAM CSSE lists AK2030 and SF2524 among its year-2 VV courses).
    return pool.filter((c) => ctx.options.includes(c));
  })();

  // A list of codes in the sentence, restricted to the box's options.
  const listed = [...new Set(sentence.match(COURSE_CODE) || [])];
  const listedOptions = listed.filter((c) => ctx.options.includes(c));

  // A count of named courses. One sentence may state it beside a credit
  // minimum: TFYF's "minst 40 hp villkorligt valfria kurser … varav minst en
  // av … SK2303 eller SK2758 … måste ingå". "Dock gäller att en av SF2930
  // eller SF2943 … ska läsas" (TTMAM FMIA) has no "minst".
  const countOfList = sentence.match(new RegExp(`${B}(?:minst|måste|ska|varav|att)\\s+(?:minst\\s+)?${NUM}\\s+av${E}`, 'iu'));
  if (countOfList && listed.length >= 2) {
    const n = numberOf(countOfList[1]);
    // Already met when the lane reads one of them as obligatorisk: TTMAM asks
    // for "minst en av SF2527 och SF2524", and SF2524 is O for CSSE.
    if (listed.filter((c) => ctx.mandatory(c)).length >= n) return [];
    if (!(listedOptions.length >= n && n > 0)) return null;
    out.push({ kind: 'minCount', value: n, from: listedOptions, label });
  }

  // A count from a list the plan names in prose: TMAIM's "Teori" and
  // "Tillämpningsområden" (see readNamedLists). "minst 6 kurser från
  // Tillämpningsområdet och Teori", "minst 2 av de 6 kurserna är från Teori".
  const fromNamed = [...sentence.matchAll(new RegExp(`${B}från\\s+(\\p{L}+)(?:\\s*(?:och|\\+|samt)\\s*(\\p{L}+))?`, 'giu'))]
    .flatMap((m) => [m[1], m[2]].filter(Boolean))
    .map((w) => ctx.namedLists.find((l) => l.stem.length >= 5 && w.toLowerCase().startsWith(l.stem)))
    .filter(Boolean);
  const namedCount = sentence.match(new RegExp(`${B}minst\\s+${NUM}\\s+(?:av\\s+de\\s+\\d+\\s+)?kurs`, 'iu'));
  if (!countOfList?.[0] || listed.length < 2) {
    if (fromNamed.length && namedCount) {
      const pool = [...new Set(fromNamed.flatMap((l) => l.codes))].filter((c) => ctx.options.includes(c));
      const n = numberOf(namedCount[1]);
      if (pool.length >= n && n > 0) out.push({ kind: 'minCount', value: n, from: pool, label });
      return out.length ? out : null;
    }
  }

  // "Minst en villkorligt valfri kurs i varje årskurs" (TTMAM FMIA): one rule
  // per year, each counting that year's listing.
  if (new RegExp(`${B}i\\s+varje\\s+(?:årskurs|år)${E}`, 'iu').test(sentence)) {
    const m = sentence.match(new RegExp(`${B}minst\\s+${NUM}\\s+villkorligt\\s+valfri`, 'iu'));
    if (!m) return null;
    const n = numberOf(m[1]);
    for (let y = 1; y <= ctx.years; y++) {
      const inYear = new Set(ctx.vvRecords.filter((r) => r.year === y && (!r.spec || r.spec === ctx.lane)).map((r) => r.code));
      const pool = (ctx.own && ctx.ownVv.length ? ctx.ownVv : ctx.laneVv).filter((c) => inYear.has(c) && ctx.options.includes(c));
      if (pool.length >= n) out.push({ kind: 'minCount', value: n, from: pool, label: `${label} (år ${y})` });
    }
    return out.length ? out : null;
  }

  // A credit minimum of the villkorligt valfria courses, the pool named before
  // or after it: "minst 32,5 hp villkorligt valfria kurser inom spåret", "Av de
  // villkorligt valfria kurserna i åk 2 ska minst 30 hp väljas" (TTMAM CSSE).
  const credits = /villkorligt\s+valfri/iu.test(sentence)
    ? sentence.match(new RegExp(`${B}minst\\s+(\\d+(?:[.,]\\d+)?)\\s*hp${E}`, 'iu'))
    : null;
  if (credits && vvPool.length) {
    out.push({ kind: 'minCredits', value: numberOf(credits[1]), from: vvPool, label });
  }
  const count = sentence.match(new RegExp(`${B}(?:minst|ska)\\s+${NUM}\\s+(?:villkorligt\\s+valfria\\s+)?(?:spår)?kurser${E}`, 'iu'))
    ?? sentence.match(new RegExp(`${B}ska\\s+${NUM}\\s+kurser\\s+väljas${E}`, 'iu'))
    ?? sentence.match(new RegExp(`${B}minst\\s+${NUM}\\s+villkorligt\\s+valfria\\s+kurser${E}`, 'iu'))
    ?? sentence.match(new RegExp(`^${NUM}\\s+av\\s+de\\s+villkorligt\\s+valfria${E}`, 'iu'));
  if (!credits && !countOfList && count && vvPool.length && /villkorligt|spårkurs/iu.test(sentence)) {
    const n = numberOf(count[1]);
    if (n > 0 && n <= vvPool.length) out.push({ kind: 'minCount', value: n, from: vvPool, label });
  }
  return out.length ? out : null;
}

/**
 * Course lists the plan names in prose, as TMAIM does:
 *
 *   Teori Maskininlärning: EL2805, EL2810, DD2437, …
 *   Tillämpningsområde Datorseende: EQ2425, DD2423, DD2424.
 *
 * Lines are grouped by their first word ("Teori", "Tillämpningsområde"), which
 * is what the rules refer to. The stem is the word minus a final t/n, so
 * "Tillämpningsområdet" and "Tillämpningsområden" both find it.
 */
function readNamedLists(text) {
  const lists = new Map();
  for (const line of text.split(/\n+/)) {
    const m = line.match(/^\s*(\p{L}+)[\p{L}\s&;/.,-]*:\s*(.*)$/u);
    if (!m) continue;
    const codes = [...new Set(m[2].match(COURSE_CODE) || [])];
    if (codes.length === 0) continue;
    const stem = m[1].toLowerCase().replace(/(et|en|t|n)$/u, '');
    if (!lists.has(stem)) lists.set(stem, new Set());
    for (const c of codes) lists.get(stem).add(c);
  }
  return [...lists].map(([stem, codes]) => ({ stem, codes: [...codes] }));
}

/**
 * Only the spår the cohort itself had (`ownSpecs`, from its own pages). A year
 * borrowed from another cohort brings that cohort's spår: without this, TTFYM
 * HT2026 had boxes for both TFYF (from year 2, borrowed from HT2025) and TFYH
 * (its own year 1), and TTMAM HT2023 a CSSE box with no thesis, since CSSE
 * starts with HT2025. A course only for a dropped spår is dropped with it.
 */
function keepOwnSpecs(a, flags) {
  const own = a.ownSpecs;
  if (!own || own.size === 0) return a;
  const all = new Set([...a.entries, ...a.vvRecords, ...(a.coreRecords ?? []), ...a.electiveRecords]
    .flatMap((x) => x.specializations ?? (x.spec ? [x.spec] : [])));
  const dropped = [...all].filter((s) => !own.has(s)).sort();
  if (dropped.length === 0) return a;
  const keepRecord = (r) => !r.spec || own.has(r.spec);
  const entries = [];
  const gone = [];
  for (const e of a.entries) {
    if (!e.specializations?.length) { entries.push(e); continue; }
    const specs = e.specializations.filter((s) => own.has(s));
    if (specs.length === 0) { gone.push(e.code ?? e.name); continue; }
    const kept = { ...e, specializations: specs };
    for (const k of ['yearBySpecialization', 'periodCreditsBySpecialization']) {
      if (!e[k]) continue;
      const m = Object.fromEntries(Object.entries(e[k]).filter(([s]) => own.has(s)));
      if (Object.keys(m).length) kept[k] = m; else delete kept[k];
    }
    entries.push(kept);
  }
  flags.push(`spår ${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not on this cohort's own pages` +
    `${a.ownSpecsFrom ? ` (none left; spår read from kull ${a.ownSpecsFrom})` : ''} — they come from a borrowed ` +
    `year, so they are left out${gone.length ? `, with ${gone.length} entr${gone.length === 1 ? "y" : "ies"} only they had: ${gone.join(', ')}` : ''}.`);
  return {
    ...a,
    entries,
    vvRecords: a.vvRecords.filter(keepRecord),
    coreRecords: (a.coreRecords ?? []).filter(keepRecord),
    electiveRecords: a.electiveRecords.filter(keepRecord),
  };
}
