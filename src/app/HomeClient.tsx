'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import TimelineVisualization, { TimelineVisualizationHandle } from '@/components/TimelineVisualization';
import SpecializationFilter from '@/components/SpecializationFilter';
import Toast, { type ToastMessage } from '@/components/Toast';
import { Course, OptionGroup } from '@/types/course';
import type { CohortMeta } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import programsConfig from '@/data/programs.json';
import type { ProgramCosmetics } from '@/types/cosmetics';
import { loadCourses, loadCosmetics, loadCohortMeta, cohortDataFile } from '@/lib/useCourseModel';
import { composeTransition, mergeCosmetics, composedTitle } from '@/lib/transitions';
import type { TransitionPlan } from '@/types/transition';
import transitionsConfig from '@/data/transitions.json';
import cohortIndex from '@/data/cohorts/index.json';
import { tr, type Lang } from '@/lib/translations';

// Program configuration type
interface SpecializationDef {
  code: string;
  name: string;
  nameEn?: string;
  // Optional group code; references `specializationGroups[].code` below.
  // Programs whose inriktningar are organised as several pick-one buckets
  // (e.g. CINEK = pick one technical AND one business) tag each spec with
  // the bucket it belongs to. If omitted, all specs share an implicit
  // single group ("default").
  group?: string;
}

interface SpecializationGroupDef {
  code: string;
  name: string;
  nameEn?: string;
}

interface ProgramConfig {
  code: string;
  name: string;
  nameEn?: string;
  dataFile: string;
  cosmeticsFile?: string;
  // Whether the study plan has been verified by the program director or
  // admin personnel. Unverified plans are hidden from the program-selector
  // dropdown unless the user opts in via the "show unverified" checkbox.
  // Missing field is treated as `false`.
  verified?: boolean;
  // Withdrawn from the UI entirely — not in the dropdown, and not selectable via
  // `?program=`, even with "show unverified" on. `verified: false` only hides a
  // plan behind that checkbox, which is the right level for "extracted but not
  // signed off"; this is for a plan whose current rendering would mislead.
  // Master's programmes are the live case: their years 4-5 structure needs work
  // the bachelor-oriented renderer does not yet do.
  disabled?: boolean;
  comment?: string;
  // Optional English-language comment shown when the page language is `en`.
  // Falls back to `comment` if missing — keeps existing entries valid.
  commentEn?: string;
  studyplan?: string;
  // Optional inriktningar (specializations) for civilingenjör programs that
  // split their bachelor years by inriktning. When undefined / empty, the
  // SpecializationFilter is hidden.
  specializations?: SpecializationDef[];
  // Optional human-readable groups that organise the specs into multiple
  // pick-one rows (e.g. "Tekniskt val" + "Verksamhetsinriktning"). When
  // omitted, all specs are treated as one implicit group.
  specializationGroups?: SpecializationGroupDef[];
}

const programs: ProgramConfig[] = programsConfig as unknown as ProgramConfig[];

const ui = {
  sv: {
    title: 'Visualisering av utbildningsprogram',
    programLabel: 'Program:',
    export: 'Exportera',
    savePng: 'Spara PNG',
    saveSvg: 'Spara SVG',
    savePdf: 'Spara PDF',
    includeLegend: 'Inkludera förklaringsruta',
    language: 'Språk',
    swedish: 'Svenska',
    english: 'Engelska',
    menu: 'Meny för export och språk',
    showUnverified: 'Visa icke-verifierade utbildningsplaner',
    resetSelections: 'Återställ val',
    resetSelectionsHint: 'Ta bort alla egna val i valfria block och visa den publicerade planen',
    unverifiedSuffix: '(inte verifierad)',
    cohortLabel: 'Antagningsår',
    cohortNone: 'Utan antagningsår',
    continuationLabel: 'Fortsättningsprogram',
    continuationNone: 'Utan fortsättningsprogram',
    transitionLoadFailed: 'Kunde inte sätta samman övergångsplanen',
    // The composed view is not a published plan, so say so plainly.
    transitionNotice: (from: string, to: string) =>
      `Visar ${from} årskurs 1 följt av årskurs 2–3 i ${to}, enligt övergångsplanen.`,
    transitionCredited: (n: number) => `${n} kurser tillgodoräknas`,
    transitionExempt: 'Utgår',
    transitionMoved: 'Flyttad',
    transitionToYear: (y: number) => `årskurs ${y}`,
    transitionAdded: 'Tillkommer',
    transitionInsteadOf: 'i stället för',
    transitionUnverified: 'Övergångsplanen är inte verifierad — kontrollera mot programansvarigs plan.',
    // "År 3 är uppskattat" / "År 1 och 2 är uppskattade" / "År 1, 2 och 3 ..."
    // Neuter singular: it agrees with "år", which is an ett-word.
    approxSummary: (years: number[]) => {
      const list = years.length <= 1
        ? String(years[0] ?? '')
        : `${years.slice(0, -1).join(', ')} och ${years[years.length - 1]}`;
      return `År ${list} ${years.length === 1 ? 'är uppskattat' : 'är uppskattade'}`;
    },
    approxInfoLabel: 'Mer information om uppskattade årskurser',
    approxYear: (y: number, src: string) => `Årskurs ${y}: hämtad från ${src}`,
    approxWhy: 'KTH publicerar bara det pågående och nästa läsår, så år som saknas för din kull hämtas från närmaste kull som har dem.',
    approxSource: 'Utbildningsplanen på KTH:s webb gäller alltid före det som visas här →',
    approxLowConfidence: 'osäker',
    approxUnknown: 'ej kontrollerbar',
  },
  en: {
    title: 'Education program visualization',
    programLabel: 'Program:',
    export: 'Export',
    savePng: 'Save PNG',
    saveSvg: 'Save SVG',
    savePdf: 'Save PDF',
    includeLegend: 'Include legend',
    language: 'Language',
    swedish: 'Swedish',
    english: 'English',
    menu: 'Export and language menu',
    showUnverified: 'Show unverified study plans',
    resetSelections: 'Reset choices',
    resetSelectionsHint: 'Clear every choice made in the elective boxes and show the published plan',
    unverifiedSuffix: '(unverified)',
    cohortLabel: 'Admission year',
    cohortNone: 'No admission year',
    continuationLabel: 'Continuation program',
    continuationNone: 'No continuation program',
    transitionLoadFailed: 'Could not compose the transition plan',
    transitionNotice: (from: string, to: string) =>
      `Showing ${from} year 1 followed by years 2–3 of ${to}, per the transition plan.`,
    transitionCredited: (n: number) => `${n} courses credited`,
    transitionExempt: 'Dropped',
    transitionMoved: 'Moved',
    transitionToYear: (y: number) => `year ${y}`,
    transitionAdded: 'Added',
    transitionInsteadOf: 'instead of',
    transitionUnverified: 'The transition plan is unverified — check it against the program director\u2019s plan.',
    approxSummary: (years: number[]) => {
      const list = years.length <= 1
        ? String(years[0] ?? '')
        : `${years.slice(0, -1).join(', ')} and ${years[years.length - 1]}`;
      return `Year${years.length === 1 ? '' : 's'} ${list} ${years.length === 1 ? 'is' : 'are'} approximated`;
    },
    approxInfoLabel: 'More information about approximated years',
    approxYear: (y: number, src: string) => `Year ${y}: taken from ${src}`,
    approxWhy: 'KTH publishes only the current and next academic year, so years missing for your cohort are taken from the nearest cohort that has them.',
    approxSource: "The study plan on KTH's website always takes precedence over what is shown here →",
    approxLowConfidence: 'uncertain',
    approxUnknown: 'unverifiable',
  }
} as const;

// ---- `og` encoding -------------------------------------------------------
//
// Structural characters are escaped with `~` rather than left to percent-
// encoding, because `URLSearchParams.get()` decodes percent-escapes BEFORE we
// get to split the value. The old scheme wrote `encodeURIComponent(name)`, so
// "Valfri kurs, årskurs 3 P4" went out as `Valfri%20kurs%2C%20...`; the router
// then normalises the address bar down one level of encoding, and reading that
// back gave a literal comma, which `split(',')` cut the group name in half on.
// The result was a group named " årskurs 3 P4" that matches nothing, so every
// shared or bookmarked link silently lost its selection — measured on
// origin/main, not just here. Every extracted elective box has a comma in its
// name, so this hit exactly the boxes this feature is about.
//
// `!`, `*` and `.` survive one round of form-decoding unchanged. `+` and `,`
// deliberately do not appear: `+` decodes to a space in
// application/x-www-form-urlencoded, and `,` is what the old format tripped on.
const OG_ESCAPES: Record<string, string> = { '~': '~~', '!': '~e', '*': '~s', '.': '~d', '@': '~a' };
const escOg = (v: string) => v.replace(/[~!*.@]/g, (c) => OG_ESCAPES[c]);
const unescOg = (v: string) => v.replace(/~(.)/g, (m, c) =>
  c === '~' ? '~' : c === 'e' ? '!' : c === 's' ? '*'
    : c === 'd' ? '.' : c === 'a' ? '@' : m);

export default function HomeClient() {
  const [courses, setCourses] = useState<(Course | OptionGroup)[]>([]);
  const [cosmetics, setCosmetics] = useState<ProgramCosmetics | null>(null);
  const [cohortMeta, setCohortMeta] = useState<CohortMeta | null>(null);
  // Populated when a composed transition view disagrees with the programme data.
  const [transitionWarnings, setTransitionWarnings] = useState<string[]>([]);
  const [approxInfoOpen, setApproxInfoOpen] = useState(false);
  // Page-level toast for non-blocking failures (PDF export errors,
  // cosmetics-load failures). Children emit via the `onToast` callback.
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const vizRef = useRef<TimelineVisualizationHandle | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportSubOpen, setExportSubOpen] = useState(false);
  const [includeLegend, setIncludeLegend] = useState(true);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  const selectedProgram = useMemo(() => {
    // Disabled programmes are excluded here too, so a stale `?program=TIEMM`
    // bookmark falls back to the default rather than rendering a withdrawn plan.
    const offered = programs.filter(p => p.disabled !== true);
    const param = (searchParams.get('program') || '').trim();
    const match = param
      ? offered.find(p => p.code.toLowerCase() === param.toLowerCase())
      : null;
    return match ?? offered[0];
  }, [searchParams]);

  // Cohorts with an archived plan for this program, newest first. Empty when the
  // program has none, in which case the selector is hidden and the curated
  // program-wide file is used exactly as before.
  const availableCohorts = useMemo<string[]>(
    () => (cohortIndex as Record<string, string[]>)[selectedProgram.code] ?? [],
    [selectedProgram],
  );

  // `?cohort=HT2023`. Falls back to the curated file when absent or unknown, so
  // an old bookmark keeps working after a cohort file is removed.
  const selectedCohort = useMemo<string | null>(() => {
    const param = (searchParams.get('cohort') || '').trim().toUpperCase();
    return availableCohorts.includes(param) ? param : null;
  }, [searchParams, availableCohorts]);

  // Programmes this one can continue into. COPEN (Öppen ingång) is the case:
  // its plan stops after year 1, so a student's real plan is COPEN year 1 plus
  // two years of wherever they transferred. Empty for every other programme, in
  // which case the selector is hidden.
  const transitionPlans = transitionsConfig as TransitionPlan[];
  const availableContinuations = useMemo<TransitionPlan[]>(
    () => transitionPlans.filter(t => t.from === selectedProgram.code),
    [transitionPlans, selectedProgram],
  );

  // `?continuation=CTFYS`. Ignored when the programme has no plan for it, so a
  // stale bookmark falls back to the plain programme view.
  const selectedContinuation = useMemo<TransitionPlan | null>(() => {
    const param = (searchParams.get('continuation') || '').trim().toUpperCase();
    return availableContinuations.find(t => t.to === param) ?? null;
  }, [searchParams, availableContinuations]);

  // Years in the current view that did not come from the selected cohort.
  const approximatedYears = useMemo(
    () => (cohortMeta?.years ?? []).filter(y => y.approximated),
    [cohortMeta],
  );

  const language = useMemo<Lang>(() => {
    const langParam = searchParams.get('l');
    return (langParam === 'en' || langParam === 'sv') ? langParam : 'sv';
  }, [searchParams]);

  // A composed view is two programmes, so the chart is titled for both:
  // "Civilingenjörsutbildning Öppen ingång → Teknisk fysik (COPEN → CTFYS)".
  // The target's name is shortened because the qualification is identical on both
  // sides and pure noise the second time — see shortProgramName.
  const chartTitle = useMemo(() => {
    const name = language === 'en'
      ? (selectedProgram.nameEn || selectedProgram.name)
      : selectedProgram.name;
    if (!selectedContinuation) return { name, code: selectedProgram.code };
    const target = (programsConfig as ProgramConfig[]).find(p => p.code === selectedContinuation.to);
    if (!target) return { name, code: selectedProgram.code };
    const targetName = language === 'en' ? (target.nameEn || target.name) : target.name;
    return composedTitle(name, targetName, selectedProgram.code, target.code);
  }, [language, selectedProgram, selectedContinuation]);

  // Whether unverified study plans are shown in the program dropdown.
  // Off by default; flipped via the checkbox next to the selector.
  // Persisted in the URL as `unverified=1` so bookmarks survive reloads.
  const showUnverified = useMemo<boolean>(() => searchParams.get('unverified') === '1', [searchParams]);

  const setLanguage = (lang: Lang) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('l', lang);
    router.replace(`/?${params.toString()}`);
  };

  const setShowUnverified = (next: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('unverified', '1');
    else params.delete('unverified');
    router.replace(`/?${params.toString()}`);
  };

  // Always include the currently-selected program even if it's unverified
  // and the toggle is off — otherwise a bookmarked `?program=CTMAT` would
  // hide its own entry from the dropdown and silently look broken.
  const visiblePrograms = useMemo<ProgramConfig[]>(() => {
    const offered = programs.filter(p => p.disabled !== true);
    if (showUnverified) return offered;
    return offered.filter(p => p.verified === true || p.code === selectedProgram.code);
  }, [showUnverified, selectedProgram]);

  // ----- View state derived from URL params -----
  // og=Group1:Code1,Group2:Code2 — user's pick per option group
  // hide=layer1,layer2          — top-level layers that are off
  // hideGroups=Name1,Name2      — cosmetics course-groups that are off
  // All three are absent by default; absence = "default visibility / no choice".
  // Selections persist across program switches (an `og` entry that doesn't match
  // the new program is simply ignored).

  // Codes after the colon are joined with '+' — multi-select for groups
  // with kind: 'pickN' (pickN > 1) or kind: 'minCredits'. Single-string
  // form is still accepted for back-compat with bookmarks from the
  // pre-multiselect days.
  // A code may carry a chosen offering as `CODE@ROUND` (e.g. `DD1380@P4`) for
  // the few courses KTH gives several times a läsår. The suffix is stripped
  // here so every existing consumer keeps seeing plain course codes; the round
  // is exposed separately as `selectedRoundPerCourse`. A link without a suffix
  // means "whichever offering matches the box".
  const ogEntries = useMemo<{ name: string; codes: string[]; rounds: Record<string, string> }[]>(() => {
    const og = searchParams.get('og');
    if (!og) return [];
    const out: { name: string; codes: string[]; rounds: Record<string, string> }[] = [];

    // Escaped delimiters never appear bare, so a plain split is unambiguous.
    // A value with no '*' is a pre-existing bookmark in the old
    // name:CODE+CODE,name:CODE format; keep reading those.
    const legacy = !og.includes('*');
    const entries = legacy ? og.split(',') : og.split('!');
    for (const pair of entries) {
      const sepIndex = legacy ? pair.indexOf(':') : pair.indexOf('*');
      if (sepIndex <= 0) continue;
      const rawName = pair.slice(0, sepIndex);
      const name = legacy ? decodeURIComponent(rawName) : unescOg(rawName);
      const codesRaw = pair.slice(sepIndex + 1);
      if (!name || !codesRaw) continue;
      const codes: string[] = [];
      const rounds: Record<string, string> = {};
      for (const raw of codesRaw.split(legacy ? '+' : '.')) {
        const token = legacy ? decodeURIComponent(raw) : unescOg(raw);
        if (!token) continue;
        const at = token.indexOf('@');
        if (at > 0) {
          const code = token.slice(0, at);
          const round = token.slice(at + 1);
          codes.push(code);
          if (round) rounds[code] = round;
        } else {
          codes.push(token);
        }
      }
      if (codes.length > 0) out.push({ name, codes, rounds });
    }
    return out;
  }, [searchParams]);

  const selectedOptionPerGroup = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const e of ogEntries) out[e.name] = e.codes;
    return out;
  }, [ogEntries]);

  const selectedRoundPerCourse = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const e of ogEntries) Object.assign(out, e.rounds);
    return out;
  }, [ogEntries]);

  const hiddenLayers = useMemo<Set<string>>(() => {
    const v = searchParams.get('hide');
    if (!v) return new Set();
    return new Set(v.split(',').map(s => s.trim()).filter(Boolean));
  }, [searchParams]);

  const hiddenGroups = useMemo<Set<string>>(() => {
    const v = searchParams.get('hideGroups');
    if (!v) return new Set();
    return new Set(v.split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean));
  }, [searchParams]);

  // Map spec code → group code, derived from the program's registry. The
  // filter pre-pass uses this to enforce AND-across-groups semantics.
  const specGroupMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const s of selectedProgram.specializations || []) {
      m.set(s.code, s.group || '__default__');
    }
    return m;
  }, [selectedProgram]);

  // ?spec=A,B = the user's pick per spec group. When the program has a
  // specs registry, the visualisation defaults to the first option in each
  // group so the chart isn't ambiguous on first load.
  const selectedSpecializations = useMemo<Set<string>>(() => {
    const v = searchParams.get('spec');
    if (v) return new Set(v.split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean));
    // Default: first spec per group.
    const specs = selectedProgram.specializations;
    if (!specs || specs.length === 0) return new Set();
    const seenGroups = new Set<string>();
    const defaults = new Set<string>();
    for (const s of specs) {
      const g = s.group || '__default__';
      if (seenGroups.has(g)) continue;
      seenGroups.add(g);
      defaults.add(s.code);
    }
    return defaults;
  }, [searchParams, selectedProgram]);

  const replaceParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`/?${params.toString()}`);
  }, [searchParams, router]);

  // Serialising needs both halves, since a round rides along with its code.
  // `rounds` is only written for a code that actually has a chosen offering,
  // so a plan with no multi-round course produces exactly the old URL.
  // Serialising needs both halves, since a round rides along with its code.
  // `rounds` is only written for a code that actually has a chosen offering,
  // so a plan with no multi-round course produces a URL as short as before.
  const writeOg = useCallback((
    groups: Record<string, string[]>,
    rounds: Record<string, string>,
  ) => {
    replaceParams((p) => {
      const entries = Object.entries(groups)
        .filter(([, codes]) => Array.isArray(codes) && codes.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) p.delete('og');
      else p.set('og', entries
        .map(([k, codes]) => `${escOg(k)}*${codes
          // Escape each PART, then join with '@' — escaping the assembled
          // token would escape the separator we just added.
          .map(c => (rounds[c] ? `${escOg(c)}@${escOg(rounds[c])}` : escOg(c)))
          .join('.')}`)
        .join('!'));
    });
  }, [replaceParams]);

  const setSelection = useCallback((
    groups: Record<string, string[]>,
    rounds: Record<string, string>,
  ) => writeOg(groups, rounds), [writeOg]);

  const setHiddenLayers = useCallback((next: Set<string>) => {
    replaceParams((p) => {
      if (next.size === 0) p.delete('hide');
      else p.set('hide', [...next].sort().join(','));
    });
  }, [replaceParams]);

  const setHiddenGroups = useCallback((next: Set<string>) => {
    replaceParams((p) => {
      if (next.size === 0) p.delete('hideGroups');
      else p.set('hideGroups', [...next].sort().map(encodeURIComponent).join(','));
    });
  }, [replaceParams]);

  const setSelectedSpecializations = useCallback((next: Set<string>) => {
    replaceParams((p) => {
      if (next.size === 0) p.delete('spec');
      else p.set('spec', [...next].sort().map(encodeURIComponent).join(','));
    });
  }, [replaceParams]);

  // Load courses and cosmetics when the program, cohort or continuation changes
  useEffect(() => {
    const dataFile = selectedCohort
      ? cohortDataFile(selectedProgram.code, selectedCohort)
      : selectedProgram.dataFile;

    // With a continuation selected, the view is composed from two programmes:
    // this one's own early years plus the target's remaining ones, with the
    // transition plan applied. See src/lib/transitions.ts.
    if (selectedContinuation) {
      const target = (programsConfig as ProgramConfig[]).find(p => p.code === selectedContinuation.to);
      if (target) {
        const targetFile = selectedCohort && (cohortIndex as Record<string, string[]>)[target.code]?.includes(selectedCohort)
          ? cohortDataFile(target.code, selectedCohort)
          : target.dataFile;
        Promise.all([loadCourses(dataFile), loadCourses(targetFile)])
          .then(([sourceEntries, targetEntries]) => {
            const composed = composeTransition(sourceEntries, targetEntries, selectedContinuation);
            setCourses(composed.entries);
            setTransitionWarnings(composed.warnings);
          })
          .catch((e) => {
            console.warn('Failed to compose the transition plan:', e);
            setToast({ title: ui[language].transitionLoadFailed, detail: String(e).slice(0, 200) });
          });
        // Neither programme's cosmetics covers the other's courses, so merge them.
        Promise.all([loadCosmetics(target.cosmeticsFile), loadCosmetics(selectedProgram.cosmeticsFile)])
          .then(([targetCos, sourceCos]) => {
            const { cosmetics: merged, warnings } = mergeCosmetics(targetCos, sourceCos, selectedContinuation);
            setCosmetics(merged);
            if (warnings.length > 0) console.warn(warnings.join('\n'));
          })
          .catch((e) => {
            console.warn('Failed to load cosmetics:', e);
            setCosmetics(null);
          });
        setCohortMeta(null);
        return;
      }
    }

    setTransitionWarnings([]);
    loadCourses(dataFile).then(setCourses);
    if (selectedCohort) {
      loadCohortMeta(dataFile).then(setCohortMeta).catch(() => setCohortMeta(null));
    } else {
      setCohortMeta(null);
    }
    loadCosmetics(selectedProgram.cosmeticsFile)
      .then(setCosmetics)
      .catch((e) => {
        console.warn('Failed to load cosmetics:', e);
        setCosmetics(null);
        setToast({ title: tr[language].cosmeticsLoadFailed, detail: String(e).slice(0, 200) });
      });
    // Disabling exhaustive-deps because `language` is intentionally not a
    // dep — switching language shouldn't re-fetch the cosmetics file. The
    // toast text uses whatever `language` was at the moment the failure
    // fires, which is acceptable for a transient banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProgram, selectedCohort, selectedContinuation]);

  // Initialize missing URL params
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    let changed = false;
    if (!params.get('program')) {
      params.set('program', selectedProgram.code);
      changed = true;
    }
    if (!params.get('l')) {
      params.set('l', language);
      changed = true;
    }
    if (changed) {
      router.replace(`/?${params.toString()}`);
    }
  }, [searchParams, router, selectedProgram, language]);

  // Close main menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const btn = exportBtnRef.current;
      const menu = exportMenuRef.current;
      if (menu && menu.contains(e.target as Node)) return;
      if (btn && btn.contains(e.target as Node)) return;
      setMenuOpen(false);
      setExportSubOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* `flex-wrap` is load-bearing on phones, not cosmetic. Without it this
            row is a nowrap flex line whose items cannot shrink below their
            content (flex items default to `min-width: auto`), so it set the
            page's scroll width — measured 864 px on a 390 px viewport, which
            scrolled the WHOLE page sideways and put the menu button off-screen.
            The chart's own horizontal scroll (issue #2) was working correctly;
            this row was the thing overflowing past it. */}
        <div className="relative pr-14 flex flex-wrap justify-between items-center gap-x-6 gap-y-3 mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold" style={{ color: kthColors.KthHeaven?.HEX }}>{ui[language].title}</h1>
          {/* Column so the provenance line can sit directly under the selectors
              that produced it, rather than becoming a third flex item beside
              them. */}
          <div className="items-start sm:items-end" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>{ui[language].programLabel}</label>
            <select
            value={selectedProgram.code}
            onChange={(e) => {
              const program = programs.find(p => p.code === e.target.value);
              if (program) {
                const params = new URLSearchParams(searchParams.toString());
                params.set('program', program.code);
                // Selections belong to the programme they were made in. `og` and
                // `spec` are keyed by group name and inriktning code, and several
                // programmes share both — "Kandidatexamensarbete" exists in CTFYS,
                // CTMAT and CFATE. Carrying them across meant a thesis chosen in
                // one programme silently replaced the thesis box in every other
                // one, which reads as the box having disappeared.
                params.delete('og');
                params.delete('spec');
                router.replace(`/?${params.toString()}`);
              }
            }}
            style={{ color: kthColors.KthBlue?.HEX }}
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm"
          >
            {visiblePrograms.map(program => (
              <option key={program.code} value={program.code}>
                {program.verified === true ? program.code : `${program.code} ${ui[language].unverifiedSuffix}`}
              </option>
            ))}
          </select>
            {availableCohorts.length > 0 && (
              <select
                value={selectedCohort ?? ''}
                onChange={(e) => {
                  const params = new URLSearchParams(searchParams.toString());
                  if (e.target.value) params.set('cohort', e.target.value);
                  else params.delete('cohort');
                  // A cohort's option groups need not be the same ones, so a
                  // selection made against another cohort's groups is not
                  // meaningful here either.
                  params.delete('og');
                  router.replace(`/?${params.toString()}`);
                }}
                aria-label={ui[language].cohortLabel}
                title={ui[language].cohortLabel}
                style={{ color: kthColors.KthBlue?.HEX }}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm"
              >
                <option value="">{ui[language].cohortNone}</option>
                {availableCohorts.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
            {availableContinuations.length > 0 && (
              <select
                value={selectedContinuation?.to ?? ''}
                onChange={(e) => {
                  const params = new URLSearchParams(searchParams.toString());
                  if (e.target.value) params.set('continuation', e.target.value);
                  else params.delete('continuation');
                  router.replace(`/?${params.toString()}`);
                }}
                aria-label={ui[language].continuationLabel}
                title={ui[language].continuationLabel}
                style={{ color: kthColors.KthBlue?.HEX }}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm"
              >
                <option value="">{ui[language].continuationNone}</option>
                {availableContinuations.map(t => (
                  <option key={t.to} value={t.to}>
                    {t.verified === true ? t.to : `${t.to} ${ui[language].unverifiedSuffix}`}
                  </option>
                ))}
              </select>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: kthColors.KthBlue?.HEX, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={showUnverified}
                onChange={(e) => setShowUnverified(e.target.checked)}
              />
              {ui[language].showUnverified}
            </label>

            {/*
              Reset. Only shown once a choice exists, so it never advertises a
              state the user is already in.

              Once options are picked, a chosen course is drawn exactly like an
              obligatorisk one, so there is no way to tell which bars are the
              published plan and which are your own choices — and no way back
              to the plan short of editing the URL. This clears `og` (both the
              picks and any offering choices, which live in the same parameter)
              and leaves everything else — programme, cohort, language, layer
              visibility — untouched.
            */}
            {Object.keys(selectedOptionPerGroup).length > 0 && (
              <button
                onClick={() => replaceParams((p) => p.delete('og'))}
                className="px-3 py-2 border border-gray-300 rounded-md shadow-sm"
                style={{ color: kthColors.KthBlue?.HEX, fontSize: 13 }}
                title={ui[language].resetSelectionsHint}
              >
                {ui[language].resetSelections}
              </button>
            )}

            {/*
              Pinned to the header's top-right rather than sitting in the
              selector row. As a flex item it wrapped with the selectors, so on
              a narrow window it slid down and sideways with them — the menu is
              a fixed piece of chrome and should stay where the user last saw
              it. Absolute against the header (which carries `relative pr-14`
              to reserve the space), so it also cannot collide with a long
              programme name.
            */}
            <div className="absolute top-0 right-0">
              <button ref={exportBtnRef} onClick={() => setMenuOpen(v => !v)} className="px-2 py-2 border border-gray-300 rounded-md shadow-sm bg-white" aria-label={ui[language].menu} aria-expanded={menuOpen} aria-haspopup="menu">
                <svg width="20" height="16" viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="3" width="16" height="2" rx="1" fill={kthColors.KthBlue?.HEX || '#004791'} />
                  <rect x="2" y="7" width="16" height="2" rx="1" fill={kthColors.KthBlue?.HEX || '#004791'} />
                  <rect x="2" y="11" width="16" height="2" rx="1" fill={kthColors.KthBlue?.HEX || '#004791'} />
                </svg>
              </button>
              {menuOpen && (
                <div ref={exportMenuRef} style={{ position: 'absolute', right: 0, marginTop: 6, background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', zIndex: 50, padding: 12, width: 260, color: kthColors.KthBlue?.HEX }}>
                  {/* Export submenu header */}
                  <button onClick={() => setExportSubOpen(v => !v)} className="w-full text-left px-3 py-2 border border-gray-200 rounded-md hover:bg-gray-50" style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>
                    {ui[language].export}
                  </button>
                  {exportSubOpen && (
                    <div style={{ padding: '10px 6px 0 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <input id="includeLegend" type="checkbox" checked={includeLegend} onChange={(e) => setIncludeLegend(e.target.checked)} />
                        <label htmlFor="includeLegend" style={{ fontSize: 14, color: kthColors.KthBlue?.HEX }}>{ui[language].includeLegend}</label>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <button onClick={() => { vizRef.current?.exportChart('png', { includeLegend }); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-left" style={{ color: kthColors.KthBlue?.HEX }}>{ui[language].savePng}</button>
                        <button onClick={() => { vizRef.current?.exportChart('svg', { includeLegend }); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-left" style={{ color: kthColors.KthBlue?.HEX }}>{ui[language].saveSvg}</button>
                        {process.env.NEXT_PUBLIC_DISABLE_PDF !== '1' && (
                          <button onClick={() => { vizRef.current?.exportChart('pdf', { includeLegend }); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-left" style={{ color: kthColors.KthBlue?.HEX }}>{ui[language].savePdf}</button>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Divider */}
                  <div style={{ height: 1, background: '#e5e7eb', margin: '12px 0' }} />
                  {/* Language flags */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    {/* <div style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>{ui[language].language}</div> */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setLanguage('sv'); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-1 border border-gray-300 rounded-md shadow-sm font-semibold" aria-label="Svenska" title="Svenska" style={{ color: kthColors.KthBlue?.HEX, fontSize: 13, outline: language==='sv' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>SV</button>
                      <button onClick={() => { setLanguage('en'); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-1 border border-gray-300 rounded-md shadow-sm font-semibold" aria-label="English" title="English" style={{ color: kthColors.KthBlue?.HEX, fontSize: 13, outline: language==='en' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>EN</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/*
            Provenance line. Deliberately here, under the selectors that caused
            it, rather than inside the chart card: it is a property of the
            selection, and a full box inside the chart pushed the plan down and
            read as part of the visualisation. The detail lives in a hover/focus
            tooltip that names KTH's published plan as the authority, because
            that is what a student should check against.
          */}
          {/*
            A composed transition view is not a plan KTH publishes anywhere — it
            is this programme's early years stitched to another's later ones. Say
            so, and summarise what the plan changed, so a student can see why
            their chart differs from the target programme's own page.
          */}
          {selectedContinuation && (
            <div style={{ marginTop: 10, fontSize: 13, color: kthColors.KthBlue?.HEX }}>
              <div>{ui[language].transitionNotice(selectedContinuation.from, selectedContinuation.to)}</div>
              <div style={{ marginTop: 2, opacity: 0.85 }}>
                {ui[language].transitionCredited(selectedContinuation.credited.length)}
                {(selectedContinuation.exempt ?? []).map(e => (
                  <span key={e.code}>{` · ${ui[language].transitionExempt}: ${e.code}`}</span>
                ))}
                {(selectedContinuation.moved ?? []).map(m => (
                  <span key={m.code}>{` · ${ui[language].transitionMoved}: ${m.code} → ${ui[language].transitionToYear(m.toYear)}`}</span>
                ))}
                {(selectedContinuation.added ?? []).map(a => (
                  <span key={a.code}>
                    {` · ${ui[language].transitionAdded}: ${a.code}`}
                    {a.fromProgram ? ` (${a.fromProgram})` : ''}
                    {a.substitutesFor ? ` ${ui[language].transitionInsteadOf} ${a.substitutesFor}` : ''}
                  </span>
                ))}
              </div>
              {selectedContinuation.verified !== true && (
                <div style={{ marginTop: 2, fontStyle: 'italic' }}>{ui[language].transitionUnverified}</div>
              )}
              {transitionWarnings.length > 0 && (
                <ul style={{ marginTop: 4, paddingLeft: 18, color: '#78001A' }}>
                  {transitionWarnings.map(w => <li key={w}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
          {approximatedYears.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, color: kthColors.KthBlue?.HEX }}>
              <span>{ui[language].approxSummary(approximatedYears.map(y => y.year))}</span>
              <span
                tabIndex={0}
                role="button"
                aria-label={ui[language].approxInfoLabel}
                onMouseEnter={() => setApproxInfoOpen(true)}
                onMouseLeave={() => setApproxInfoOpen(false)}
                onFocus={() => setApproxInfoOpen(true)}
                onBlur={() => setApproxInfoOpen(false)}
                style={{
                  position: 'relative', display: 'inline-flex', alignItems: 'center',
                  justifyContent: 'center', width: 16, height: 16, marginLeft: 6,
                  borderRadius: '50%', border: `1px solid ${kthColors.KthBlue?.HEX}`,
                  fontSize: 11, fontWeight: 700, cursor: 'help', verticalAlign: 'text-bottom',
                }}
              >
                i
                {approxInfoOpen && (
                  <span
                    role="tooltip"
                    style={{
                      position: 'absolute', top: 22, right: -8, zIndex: 60, width: 340,
                      background: 'white', border: '1px solid #e5e7eb', borderRadius: 6,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.10)', padding: '10px 12px',
                      fontSize: 12, fontWeight: 400, lineHeight: 1.45, cursor: 'auto',
                      textAlign: 'left', color: kthColors.KthBlue?.HEX,
                    }}
                  >
                    {approximatedYears.map(y => (
                      <span key={y.year} style={{ display: 'block' }}>
                        {ui[language].approxYear(y.year, y.sourceCohort ?? '—')}
                        {y.confidence === 'low' && ` — ${ui[language].approxLowConfidence}`}
                        {y.confidence === 'unknown' && ` — ${ui[language].approxUnknown}`}
                      </span>
                    ))}
                    <span style={{ display: 'block', marginTop: 8 }}>{ui[language].approxWhy}</span>
                    {selectedProgram.studyplan && (
                      <a
                        href={selectedProgram.studyplan}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'block', marginTop: 8, textDecoration: 'underline' }}
                      >
                        {ui[language].approxSource}
                      </a>
                    )}
                  </span>
                )}
              </span>
            </div>
          )}
          </div>
        </div>
        {/* Tighter padding on phones: `p-6` spent 48 of a 390 px viewport on
            whitespace either side of a chart that is already scrolled. */}
        <div className="bg-white rounded-lg shadow-lg p-3 sm:p-6 min-h-[600px]">
          {selectedProgram.specializations && selectedProgram.specializations.length > 0 && (
            <SpecializationFilter
              language={language}
              specializations={selectedProgram.specializations}
              groups={selectedProgram.specializationGroups}
              selected={selectedSpecializations}
              onChange={setSelectedSpecializations}
            />
          )}
          <TimelineVisualization
            ref={vizRef}
            courses={courses}
            language={language}
            programName={chartTitle.name}
            programCode={chartTitle.code}
            studyplanUrl={selectedProgram.studyplan}
            programComment={language === 'en' ? (selectedProgram.commentEn || selectedProgram.comment) : selectedProgram.comment}
            cosmetics={cosmetics}
            selectedOptionPerGroup={selectedOptionPerGroup}
            onSelectionChange={setSelection}
            selectedRoundPerCourse={selectedRoundPerCourse}
            hiddenLayers={hiddenLayers}
            onHiddenLayersChange={setHiddenLayers}
            hiddenGroups={hiddenGroups}
            onHiddenGroupsChange={setHiddenGroups}
            selectedSpecializations={selectedSpecializations}
            specGroupMap={specGroupMap}
            onToast={setToast}
          />
        </div>
        <Toast language={language} toast={toast} onClose={() => setToast(null)} />
        
        {/* Git version info in bottom right */}
        <div style={{ 
          position: 'fixed', 
          bottom: 8, 
          right: 8, 
          fontSize: 11, 
          color: '#6b7280',
          background: 'rgba(255, 255, 255, 0.9)',
          padding: '4px 8px',
          borderRadius: 4,
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
        }}>
          <a 
            href='https://github.com/cohm/ProgramVisualization'
            target="_blank"
            rel="noopener noreferrer"
            style={{ 
              color: kthColors.KthBlue?.HEX || '#004791',
              textDecoration: 'none',
              fontFamily: 'monospace'
            }}>github</a>{' - '}
          {process.env.NEXT_PUBLIC_GIT_HASH && (
            <>
              {process.env.NEXT_PUBLIC_GIT_REPO_URL ? (
                <a 
                  href={`${process.env.NEXT_PUBLIC_GIT_REPO_URL}/commit/${process.env.NEXT_PUBLIC_GIT_HASH}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ 
                    color: kthColors.KthBlue?.HEX || '#004791',
                    textDecoration: 'none',
                    fontFamily: 'monospace'
                  }}
                >
                  {process.env.NEXT_PUBLIC_GIT_HASH}
                </a>
              ) : (
                <span style={{ fontFamily: 'monospace' }}>
                  {process.env.NEXT_PUBLIC_GIT_HASH}
                </span>
              )}
              {process.env.NEXT_PUBLIC_GIT_TIMESTAMP && (
                <span style={{ marginLeft: 8 }}>
                  {new Date(process.env.NEXT_PUBLIC_GIT_TIMESTAMP).toISOString().replace('T', ' ').substring(0, 19)}
                </span>
              )}
            </>
          )}
        </div>

      </main>
    </div>
  );
}
