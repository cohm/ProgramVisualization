

import React, { useEffect, useMemo, useRef, forwardRef, useImperativeHandle, useState, useCallback } from 'react';
// Import the three d3 modules actually used rather than the `d3` meta-package.
// Identical bundle (the wildcard import was already tree-shaken) but a much
// smaller install tree: 38 packages -> 13, and 7 non-d3 transitive deps -> 1.
// The dropped ones arrived via d3-dsv, a CSV parser with a CLI this app never
// calls (commander, iconv-lite, rw, safer-buffer) and via d3-delaunay
// (delaunator, robust-predicates).
//
// `d3-transition` is imported for its SIDE EFFECT: it is what puts
// `.transition()` and `.interrupt()` on the selection prototype. Without it the
// 17 `.interrupt()` calls below throw at runtime, and neither tsc nor eslint
// catches that, because @types/d3 declares the augmentation regardless of which
// module provides it. Verified empirically: selection.prototype.interrupt is
// undefined before the import and a function after.
import { select } from 'd3-selection';
import { scaleTime } from 'd3-scale';
// Aliased: a local `const color` at ~:479 would otherwise shadow it.
import { color as d3color } from 'd3-color';
import 'd3-transition';
import { Course, CourseCredit, OptionGroup, Period, SelectedInfo, academicPeriods } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import type { ProgramCosmetics } from '@/types/cosmetics';
import { STYLE, defaultColor, getColorForFamily, getCosmeticsColor } from '@/lib/colors';
import { tr, type Lang } from '@/lib/translations';
import Legend, { type ToggleableLayerKey } from '@/components/Legend';
import InfoPanel from '@/components/InfoPanel';
import OptionGroupModal from '@/components/OptionGroupModal';
import { type ToastMessage } from '@/components/Toast';
import {
  buildStudyPeriodTooltip,
  buildExamPeriodTooltip,
  buildReexamPeriodTooltip,
  buildExamDotTooltip,
  buildReexamDotTooltip,
  buildCourseTooltip,
  buildOptionGroupTooltip,
} from '@/lib/tooltipText';
import { getEmbeddedFontFaces } from '@/lib/fonts';
import { pickRound } from '@/lib/courseRounds';

type CourseOrOptionGroup = Course | OptionGroup;

// Plot margins. Shared by the D3 render and by `legendLeftIn()` below, which
// has to reproduce the same time→x mapping outside the render to place the
// legend. Two copies of these numbers would drift silently: nothing in the
// types connects a legend offset to a plot margin.
const CHART_MARGIN = { top: 100, right: 40, bottom: 40, left: 100 } as const;

/**
 * x, in container pixels, where the legend should sit for a given container
 * width: horizontally centred in the summer gap between the P3 re-exams
 * (early June) and the P4 re-exams (mid August).
 *
 * The legend used to be pinned at `right: STYLE.legend.offsetX`, i.e. 85 px in
 * from the container's right edge. That looks width-independent but is not
 * *gap*-independent: the plot's right edge is `CHART_MARGIN.right` (40 px) in
 * from the same edge and the August re-exam band ends exactly there, so the
 * legend's right edge always landed 45 px from the domain end — which is 5 px
 * clear of the band's left edge at EVERY width, the band being ~3 % of the
 * plot. Measured at 1200/1440/1680/1920/2200/2560/3000/3440 px: the clearance
 * was 5 px at each one (13 px below 1500, where the page's max-width has not
 * yet kicked in). So the box never technically overlapped, but it was welded
 * to the August markers with the whole gap empty to its left.
 *
 * Centring in the gap is what "in the gap" actually means, and it holds at any
 * width because the gap is a fixed fraction of the plot: Jun 5 → Aug 10 is
 * 66/361 of the domain, i.e. 18.3 %, which is 194 px at the narrowest layout
 * and 241 px once the page's max-width caps the chart — both wider than the
 * 170 px legend.
 */
function legendLeftIn(containerWidth: number): number {
  const inner = containerWidth - CHART_MARGIN.left - CHART_MARGIN.right;
  const domainStart = +academicPeriods[0].start;
  const span = +academicPeriods[3].reExamEnd - domainStart;
  // Same linear mapping d3's scaleTime applies over [domainStart, domainEnd].
  const xOf = (d: Date) => CHART_MARGIN.left + ((+d - domainStart) / span) * inner;

  const gapStart = xOf(academicPeriods[2].reExamEnd);   // June re-exams end
  const gapEnd = xOf(academicPeriods[3].reExamStart);   // August re-exams begin
  const centred = gapStart + (gapEnd - gapStart - STYLE.legend.width) / 2;

  // Clamp to the plot area so a legend wider than the gap (a future translation
  // or an extra cosmetics family) degrades to "inside the chart" rather than
  // hanging off the edge.
  const min = CHART_MARGIN.left;
  const max = containerWidth - CHART_MARGIN.right - STYLE.legend.width;
  return Math.max(min, Math.min(max, centred));
}

// Top-level layer keys that can be hidden via the legend / URL `hide=` param.
type TopLayerKey = ToggleableLayerKey;

interface TimelineVisualizationProps {
  courses: CourseOrOptionGroup[];
  language?: Lang;
  programName?: string;
  programCode?: string;
  studyplanUrl?: string;
  programComment?: string;
  cosmetics?: ProgramCosmetics | null;
  // URL-derived view state (controlled by the parent so it can be persisted to
  // query params and survive page reloads / sharing).
  // Per-group user selection: for kind: 'pickN' (the default), the array is
  // capped at pickN entries; for kind: 'minCredits' it has no cap.
  selectedOptionPerGroup: Record<string, string[]>;
  // One callback for the whole selection — which courses are picked and which
  // offering each multi-round course uses. Both live in the same `og` URL
  // parameter, so they must be written together (see OptionGroupModal).
  onSelectionChange: (
    groups: Record<string, string[]>,
    rounds: Record<string, string>,
  ) => void;
  // Chosen offering per course code, for the few courses KTH gives several
  // times a läsår (see CourseRound). Keyed by code rather than by (group, code)
  // because option selections are mutually exclusive across groups, so a course
  // is picked in at most one box.
  selectedRoundPerCourse: Record<string, string>;
  hiddenLayers: Set<string>;
  onHiddenLayersChange: (next: Set<string>) => void;
  hiddenGroups: Set<string>;
  onHiddenGroupsChange: (next: Set<string>) => void;
  // Inriktningar (specializations) the user has picked. The student picks
  // exactly one spec per group (e.g. CINEK = one tech + one business);
  // when the program declares no registry, this is empty and no filter
  // applies. Filter passes a course iff for every group represented in its
  // `specializations`, at least one matches the user's pick from that
  // group. Courses without `specializations` always pass.
  selectedSpecializations?: Set<string>;
  // Map from spec code → group code. Courses with specs from multiple
  // groups must match the user's pick in EACH of those groups.
  specGroupMap?: Map<string, string>;
  // Optional callback for surfacing toast messages (PDF export errors etc.)
  // up to the page-level Toast renderer in HomeClient.
  onToast?: (toast: ToastMessage | null) => void;
}

// Type guard to distinguish between Course and OptionGroup
const isCourse = (item: CourseOrOptionGroup): item is Course => {
  return 'code' in item && !('type' in item);
};

const isOptionGroup = (item: CourseOrOptionGroup): item is OptionGroup => {
  return 'type' in item && item.type === 'optionGroup';
};

export interface TimelineVisualizationHandle {
  exportChart: (format: 'png' | 'svg' | 'pdf', options?: { includeLegend?: boolean }) => Promise<void>;
}

const TimelineVisualization = forwardRef(function TimelineVisualization({ courses: rawCourses, language = 'sv', programName, programCode, studyplanUrl, programComment, cosmetics, selectedOptionPerGroup, onSelectionChange, selectedRoundPerCourse, hiddenLayers, onHiddenLayersChange, hiddenGroups, onHiddenGroupsChange, selectedSpecializations, specGroupMap, onToast }: TimelineVisualizationProps, ref: React.ForwardedRef<TimelineVisualizationHandle>) {
  // Filter courses by the active inriktning selection. AND across spec
  // groups: for every group represented in a course's `specializations`,
  // the user's pick from that group must be one of the course's specs.
  // Courses with no `specializations` are common to every inriktning and
  // always pass. After filtering, apply any per-spec period override
  // (`periodCreditsBySpecialization`) so the same KTH course can render in
  // different periods depending on the selected inriktning.
  const courses = useMemo<CourseOrOptionGroup[]>(() => {
    if (!selectedSpecializations || selectedSpecializations.size === 0) return rawCourses;
    const sel = selectedSpecializations;
    const grpOf = (s: string) => specGroupMap?.get(s) || '__default__';
    // Bucket the user's picks by group for O(1) lookup.
    const pickByGroup = new Map<string, string>();
    for (const code of sel) pickByGroup.set(grpOf(code), code);
    const filtered = rawCourses.filter(c => {
      const specs = (c as Course | OptionGroup).specializations;
      if (!specs || specs.length === 0) return true;
      // Bucket the course's specs by group.
      const specsByGroup = new Map<string, string[]>();
      for (const s of specs) {
        const g = grpOf(s);
        const arr = specsByGroup.get(g) || [];
        arr.push(s);
        specsByGroup.set(g, arr);
      }
      // Each group represented in the course must include the user's pick.
      for (const [g, list] of specsByGroup) {
        const pick = pickByGroup.get(g);
        if (!pick || !list.includes(pick)) return false;
      }
      return true;
    });
    return filtered.map(c => {
      if (!isCourse(c)) return c;
      const overrides = c.periodCreditsBySpecialization;
      if (!overrides) return c;
      // First selected spec that has an override wins. The validator
      // already prevents nonsensical inputs (override key must be one of
      // the course's specs), so in practice at most one selected spec can
      // match.
      for (const code of sel) {
        const ov = overrides[code];
        if (!ov) continue;
        const newCredits: CourseCredit[] = [];
        const overridePeriods: Period['id'][] = [];
        for (const [period, val] of Object.entries(ov)) {
          if (val > 0) {
            const p = period as Period['id'];
            newCredits.push({ period: p, credits: val, year: c.year });
            overridePeriods.push(p);
          }
        }
        // The exam slot tracks the lecture period (Riktlinje om läsårets
        // förläggning §1.1), so when the lecture moves the exam and re-exam
        // move with it. Auto-shift only when both base and override sit in
        // a single period — multi-period bars (e.g. P3+P4) would need an
        // explicit per-period mapping that we don't model yet, so leave
        // those untouched.
        const basePeriods = Array.from(new Set(c.credits.map(cr => cr.period)));
        const remapPeriods = (slots: Period['id'][]): Period['id'][] => {
          if (basePeriods.length !== 1 || overridePeriods.length !== 1) return slots;
          const from = basePeriods[0];
          const to = overridePeriods[0];
          return slots.map(p => p === from ? to : p);
        };
        return {
          ...c,
          credits: newCredits,
          exams: remapPeriods(c.exams),
          reexams: remapPeriods(c.reexams),
        };
      }
      return c;
    });
  }, [rawCourses, selectedSpecializations, specGroupMap]);

  // Highest year referenced anywhere in the (filtered) course list. Years
  // stack vertically, so this drives chart *height*, not width. Hoisted out
  // of the render effect because the JSX below also needs it (for the chart
  // title etc. via dependencies).
  const numYears = useMemo(() => {
    const maxYear = Math.max(1, ...courses.flatMap(c => {
      if (isCourse(c)) {
        return c.credits.map(cr => cr.year || c.year || 1);
      } else {
        return [(c as OptionGroup).year || 1];
      }
    }));
    return Math.max(1, maxYear);
  }, [courses]);

  // Minimum CSS-pixel width the chart needs to stay legible. The horizontal
  // axis spans one academic year (P1 → P4 re-exam) regardless of program
  // length — years stack vertically — so this is a constant, not data-driven.
  // Below this, the outer wrapper scrolls horizontally rather than letting
  // D3's clientWidth-based layout cramp the bars and labels.
  //
  // This used to carry a second job: 1200 px was also the width at which the
  // legend's fixed bottom-right slot happened to fall inside the summer gap,
  // with a note to stay within [1100, 1600]. `legendLeftIn()` now derives the
  // legend's x from the time scale, so that coupling is gone and this number
  // answers only "how narrow can the bars get before they stop being readable".
  const chartMinWidth = 1200;

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // The positioned wrapper the legend is absolutely placed inside. Its width is
  // the SVG's width, and the legend's x is derived from it.
  const canvasRef = useRef<HTMLDivElement>(null);
  // Container width in CSS px, tracked so the legend can be re-centred in the
  // summer gap on resize. Starts at chartMinWidth so the first paint is already
  // in roughly the right place rather than jumping after the observer fires.
  const [canvasWidth, setCanvasWidth] = useState<number>(chartMinWidth);

  // Keep `canvasWidth` in step with the wrapper. A window resize listener would
  // miss the cases that matter here — the page's max-width container changing
  // the chart's width without the window changing, and the info panel opening
  // below it — so observe the element itself.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const apply = () => setCanvasWidth(w => (w === el.clientWidth ? w : el.clientWidth));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Preserve the initial chart height to keep a stable px-per-ECTS baseline across re-renders/toggles
  const initialChartHeightRef = useRef<number | null>(null);
  // Single delegated tooltip element, persisted across renders.
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  // Pre-built tooltip HTML, keyed by `${kind}|${id}`. Populated at the end of
  // the main render and read by the delegated mouseover handler.
  const tooltipCacheRef = useRef<Map<string, string>>(new Map());
  // Latest data needed by the delegated click handler. Updated each render so
  // the handler (attached once) sees current props/state without re-binding.
  const dispatchCtxRef = useRef<{
    coursesByCode: Map<string, Course>;
    optionGroupsByName: Map<string, OptionGroup>;
    individualCoursesByCode: Map<string, Course>;
    selectedOptionPerGroup: Record<string, string[]>;
  }>({
    coursesByCode: new Map(),
    optionGroupsByName: new Map(),
    individualCoursesByCode: new Map(),
    selectedOptionPerGroup: {},
  });
  // Currently displayed tooltip key — used to suppress redundant updates as
  // the cursor moves between child elements within the same kind-element.
  const currentTooltipKeyRef = useRef<string | null>(null);

  // Year focus state for highlighting a whole year
  const [focusYear, setFocusYear] = useState<number | null>(null);

  // Toast emitter — forwards to the page-level Toast renderer in HomeClient
  // via the `onToast` prop. Stable reference for use inside the imperative
  // export handler.
  const emitToast = useCallback((t: ToastMessage | null) => {
    onToast?.(t);
  }, [onToast]);

  // Option group modal state
  const [selectedOptionGroup, setSelectedOptionGroup] = useState<OptionGroup | null>(null);
  
  // Track which options are currently highlighted in the modal. For pickN
  // groups the array is capped at pickN; for minCredits groups it has no cap.
  const [highlightedOptionCodes, setHighlightedOptionCodes] = useState<string[]>([]);

  // When the modal opens/closes, reset or initialize highlighting.
  // selectedOptionPerGroup is intentionally excluded: we only want to react to the
  // modal open/close event, not to individual option selections within the modal.
  useEffect(() => {
    if (selectedOptionGroup) {
      const currentSelection = selectedOptionPerGroup[selectedOptionGroup.name];
      setHighlightedOptionCodes(currentSelection ? [...currentSelection] : []);
    } else {
      setHighlightedOptionCodes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOptionGroup]);

  // Marker visual parameters - centralized for consistency
  const EXAM_MARKER_RADIUS = 4;
  const EXAM_MARKER_STROKE_WIDTH = 1;
  const REEXAM_MARKER_RADIUS = 4;
  const REEXAM_MARKER_STROKE_WIDTH = 1;

  // Per-course color selection: one fill per cosmetics family. (Multi-shade
  // per group was removed in REVIEW.md §2.9 — the previous code dispatched
  // through a length-1 variant array, doing nothing.)
  const getCourseColors = useCallback((course: Course) => {
    const group = cosmetics?.courseToGroup.get(course.code);
    if (group) return getCosmeticsColor(group.colorFamily);
    // Elective placeholders are yellow in every programme, matching the
    // 'Övrigt' family CTFYS uses for XY123Z/XY456Z.
    //
    // Deliberately here rather than in the cosmetics files: yellow already means
    // something else in half of them — Datateknik in CTMAT and CFATE,
    // Ingenjörsämnen in COPEN — so adding the placeholder codes to those groups
    // would colour them correctly but file them under the wrong heading in the
    // legend, and a second yellow group would be indistinguishable from the
    // first. CFATE, CINEK and TIEMM are also already at the five-family cap.
    // Keying off the category instead needs no cosmetics edit, cannot collide,
    // and covers placeholders generated for programmes added later. An explicit
    // cosmetics entry still wins, so CTFYS is unaffected.
    if (course.category === 'electivePlaceholder') return getCosmeticsColor('yellow');
    return defaultColor;
  }, [cosmetics]);

  // expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    exportChart: async (format: 'png' | 'svg' | 'pdf', options?: { includeLegend?: boolean }) => {
      if (!svgRef.current) return;
      const svgEl = svgRef.current;

      // Measure the on-screen SVG in CSS pixels
      const svgRect = svgEl.getBoundingClientRect();
      const exportWidth = Math.max(1, Math.round(svgRect.width));
      const exportHeight = Math.max(1, Math.round(svgRect.height));

      // Clone the SVG so we don't change the live DOM
      const cloned = svgEl.cloneNode(true) as SVGSVGElement;
      cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Set explicit pixel dimensions on the cloned SVG so the rasterizer uses them
      cloned.setAttribute('width', String(exportWidth));
      cloned.setAttribute('height', String(exportHeight));
      cloned.setAttribute('viewBox', `0 0 ${exportWidth} ${exportHeight}`);
      // Ensure font family is applied for all text in export
      cloned.setAttribute('style', `font-family: ${STYLE.fontFamily};`);

      // Prune hidden subtrees and strip data-* attributes from the clone.
      // Layer toggles set `display: none` inline on hidden elements; serialising
      // them just bloats the file (and the PDF) with content that won't paint.
      // data-* attributes are runtime hooks (data-kind, data-course, …) used by
      // the delegated event handler; they're meaningless in a static SVG.
      const removeHidden = (node: Element) => {
        // Walk children first so removal during the loop is safe (toArray copy).
        Array.from(node.children).forEach(child => removeHidden(child));
        const inlineDisplay = (node as SVGElement | HTMLElement).style?.display;
        if (inlineDisplay === 'none') {
          node.parentNode?.removeChild(node);
          return;
        }
        // Strip data-* attributes on the elements we're keeping.
        Array.from(node.attributes)
          .filter(a => a.name.startsWith('data-'))
          .forEach(a => node.removeAttribute(a.name));
      };
      removeHidden(cloned);
      
      try {
        const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        styleEl.textContent = `* { font-family: ${STYLE.fontFamily}; }`;
        cloned.insertBefore(styleEl, cloned.firstChild);

        // Inline web-font @font-face declarations (Figtree, served via
        // Google Fonts) so the exported SVG/PNG renders the same outside
        // the browser. Cached after first call — see src/lib/fonts.ts.
        const fontFaces = await getEmbeddedFontFaces(STYLE.fontFamily);
        if (fontFaces) {
          const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
          fontStyle.textContent = fontFaces;
          cloned.insertBefore(fontStyle, cloned.firstChild);
        }
      } catch {}

      // Optionally add an SVG legend into the cloned SVG for export
      if (options?.includeLegend) {
        try {
          const NS = 'http://www.w3.org/2000/svg';
          const legendPadding = 8;
          const itemGap = 8;
          const itemHeight = 18;
          const items = [
            { key: tr[language].legend.exams, type: 'exam', active: layers.exams },
            { key: tr[language].legend.reexams, type: 'reexam', active: layers.reexams },
            { key: tr[language].legend.prerequisitesCompleted, type: 'prereqCompleted', active: layers.prereqCompleted },
            { key: tr[language].legend.prerequisitesParticipation, type: 'prereqParticipated', active: layers.prereqParticipation },
            { key: tr[language].legend.courses, type: 'course', active: layers.courseBars },
            { key: tr[language].legend.studyPeriods, type: 'study', active: layers.studyPeriods },
            { key: tr[language].legend.examPeriods, type: 'examPeriod', active: layers.examPeriods },
            { key: tr[language].legend.reexamPeriods, type: 'reexamPeriod', active: layers.reexamPeriods },
          ];

          // container group
          const legendG = document.createElementNS(NS, 'g');
          // estimate width
          const legendWidth = STYLE.legend.width;
          const legendHeight = legendPadding*2 + items.length * (itemHeight + itemGap) - itemGap;
          const svgW = exportWidth;
          const svgH = exportHeight;
          // Same gap-centred placement as the on-screen legend, so an exported
          // chart matches what the user was looking at when they exported it.
          const legendX = legendLeftIn(svgW);
          const legendY = svgH - legendHeight - STYLE.legend.offsetY;
          legendG.setAttribute('transform', `translate(${legendX},${legendY})`);

          // background
          const bg = document.createElementNS(NS, 'rect');
          bg.setAttribute('x', '0');
          bg.setAttribute('y', '0');
          bg.setAttribute('width', String(legendWidth));
          bg.setAttribute('height', String(legendHeight));
          bg.setAttribute('rx', '8');
          bg.setAttribute('ry', '8');
          bg.setAttribute('fill', 'white');
          bg.setAttribute('stroke', STYLE.legend.borderColor);
          legendG.appendChild(bg);

          // add rows
          items.forEach((item, idx) => {
            const rowG = document.createElementNS(NS, 'g');
            rowG.setAttribute('transform', `translate(${legendPadding},${legendPadding + idx * (itemHeight + itemGap)})`);
            rowG.setAttribute('opacity', item.active ? '1' : '0.4');

            // icon
            if (item.type === 'exam') {
              const c = document.createElementNS(NS, 'circle');
              c.setAttribute('cx', '9');
              c.setAttribute('cy', String(itemHeight/2));
              c.setAttribute('r', '6');
              c.setAttribute('fill', kthColors.KthLightBrick?.HEX || '#FFCCC4');
              c.style.stroke = kthColors.KthDarkBrick?.HEX || '#B35A4A';
              c.style.strokeWidth = '1.5';
              rowG.appendChild(c);
            } else if (item.type === 'reexam') {
              const c = document.createElementNS(NS, 'circle');
              c.setAttribute('cx', '9');
              c.setAttribute('cy', String(itemHeight/2));
              c.setAttribute('r', '6');
              c.setAttribute('fill', kthColors.KthLightBrick?.HEX || '#FFCCC4');
              c.style.stroke = kthColors.KthDarkBrick?.HEX || '#B35A4A';
              c.style.strokeWidth = '1.5';
              c.style.strokeDasharray = '3 2';
              rowG.appendChild(c);
            } else if (item.type === 'prereqCompleted') {
              const line = document.createElementNS(NS, 'line');
              line.setAttribute('x1', '0');
              line.setAttribute('y1', String(itemHeight/2));
              line.setAttribute('x2', '18');
              line.setAttribute('y2', String(itemHeight/2));
              line.setAttribute('stroke', '#999');
              line.setAttribute('stroke-width', '1.5');
              rowG.appendChild(line);
            } else if (item.type === 'prereqParticipated') {
              const line = document.createElementNS(NS, 'line');
              line.setAttribute('x1', '0');
              line.setAttribute('y1', String(itemHeight/2));
              line.setAttribute('x2', '18');
              line.setAttribute('y2', String(itemHeight/2));
              line.setAttribute('stroke', kthColors.KthBlue?.HEX || '#004791');
              line.setAttribute('stroke-width', '1.5');
              line.setAttribute('stroke-dasharray', '4,3');
              rowG.appendChild(line);
            } else if (item.type === 'course') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthHeaven?.HEX || '#6298D2');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'study') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthSand?.HEX || '#f3f4f6');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'examPeriod') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', (kthColors.KthLightBlue?.HEX || '#DEF0FF'));
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'reexamPeriod') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthLightGray?.HEX || '#eee');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            }

            // label
            const text = document.createElementNS(NS, 'text');
            text.setAttribute('x', '26');
            text.setAttribute('y', String(itemHeight/2 + 4));
            text.setAttribute('fill', STYLE.legend.textColor);
            text.setAttribute('font-size', '12');
            text.textContent = item.key;
            rowG.appendChild(text);

            legendG.appendChild(rowG);
          });

          // Add course groups if cosmetics available
          if (cosmetics && cosmetics.groups.length > 0) {
            // defs for gradients
            const defs = document.createElementNS(NS, 'defs');
            legendG.appendChild(defs);
            let currentIdx = items.length;
            // Add a separator line
            const separatorY = legendPadding + currentIdx * (itemHeight + itemGap) - itemGap/2;
            const separatorLine = document.createElementNS(NS, 'line');
            separatorLine.setAttribute('x1', String(legendPadding));
            separatorLine.setAttribute('y1', String(separatorY));
            separatorLine.setAttribute('x2', String(legendWidth - legendPadding));
            separatorLine.setAttribute('y2', String(separatorY));
            separatorLine.setAttribute('stroke', '#e5e7eb');
            separatorLine.setAttribute('stroke-width', '1');
            legendG.appendChild(separatorLine);

            currentIdx++; // account for separator space
            cosmetics.groups.forEach((group, gIdx) => {
              const color = getCosmeticsColor(group.colorFamily);
              const rowG = document.createElementNS(NS, 'g');
              rowG.setAttribute('transform', `translate(${legendPadding},${legendPadding + (currentIdx + gIdx) * (itemHeight + itemGap)})`);

              // Make group header clickable: add a transparent rect for hit area
              const hitRect = document.createElementNS(NS, 'rect');
              hitRect.setAttribute('x', '0');
              hitRect.setAttribute('y', '0');
              hitRect.setAttribute('width', String(legendWidth - legendPadding * 2));
              hitRect.setAttribute('height', String(itemHeight));
              hitRect.setAttribute('fill', 'transparent');
              hitRect.setAttribute('cursor', 'pointer');
              hitRect.addEventListener('click', () => toggleGroup(group.name));
              rowG.appendChild(hitRect);

              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', color.fill);
              r.setAttribute('stroke', color.stroke);
              rowG.appendChild(r);

              const text = document.createElementNS(NS, 'text');
              text.setAttribute('x', '26');
              text.setAttribute('y', String(itemHeight/2 + 4));
              text.setAttribute('fill', STYLE.legend.textColor);
              text.setAttribute('font-size', '12');
              text.textContent = language === 'en' ? (group.nameEn || group.name) : group.name;
              rowG.appendChild(text);

              legendG.appendChild(rowG);
            });

            // Update legend height to include groups
            const totalItems = items.length + 1 + cosmetics.groups.length; // +1 for separator
            const newLegendHeight = legendPadding*2 + totalItems * (itemHeight + itemGap) - itemGap;
            bg.setAttribute('height', String(newLegendHeight));
            // Reposition to stay in bottom-right
            const newLegendY = svgH - newLegendHeight - STYLE.legend.offsetY;
            legendG.setAttribute('transform', `translate(${legendX},${newLegendY})`);
          }

          // append legend to cloned
          cloned.appendChild(legendG);
        } catch (e) {
          console.warn('Failed to add legend to export', e);
        }
      }

      // Always add an audit footer to exported files: program code + git
      // commit + ISO date. The user-supplied comment renders above it when
      // present. This guarantees every exported SVG/PNG/PDF carries enough
      // identification to track it back to a specific build.
      try {
        const NS = 'http://www.w3.org/2000/svg';
        const stampParts: string[] = [];
        if (programCode) stampParts.push(programCode);
        const gitHash = process.env.NEXT_PUBLIC_GIT_HASH;
        if (gitHash) stampParts.push(`build ${gitHash}`);
        stampParts.push(new Date().toISOString().slice(0, 10));
        const stamp = stampParts.join(' · ');

        const x = 12;
        const baseY = exportHeight - 8;
        const lineGap = 14;

        // Bottom line is always the audit stamp.
        const stampText = document.createElementNS(NS, 'text');
        stampText.setAttribute('x', String(x));
        stampText.setAttribute('y', String(baseY));
        stampText.setAttribute('fill', '#9ca3af');
        stampText.setAttribute('font-size', '10');
        stampText.textContent = stamp;
        cloned.appendChild(stampText);

        // Above it (when provided) goes the human-readable comment.
        if (programComment && programComment.trim().length > 0) {
          const commentText = document.createElementNS(NS, 'text');
          commentText.setAttribute('x', String(x));
          commentText.setAttribute('y', String(baseY - lineGap));
          commentText.setAttribute('fill', '#6b7280');
          commentText.setAttribute('font-size', '11');
          commentText.textContent = programComment;
          cloned.appendChild(commentText);
        }
      } catch {
        // ignore footer failures
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(cloned);

      if (format === 'svg') {
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'program-visualization.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }

      // PDF export: use Puppeteer via API for perfect font rendering
      if (format === 'pdf') {
        // Inline the same @font-face block we embed in SVG/PNG exports.
        // This lets the API switch from `waitUntil: networkidle0` to the
        // much faster `load` (no external resources to await).
        const pdfFontFaces = await getEmbeddedFontFaces(STYLE.fontFamily);
        // Create a complete HTML document with embedded SVG and fonts
        const htmlDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${pdfFontFaces}

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: ${STYLE.fontFamily};
    }

    @page {
      size: ${exportWidth}px ${exportHeight}px;
      margin: 0;
    }

    svg {
      display: block;
      width: ${exportWidth}px;
      height: ${exportHeight}px;
    }
  </style>
</head>
<body>
  ${svgString}
</body>
</html>`;
        
        try {
          const response = await fetch('/api/export-pdf', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ html: htmlDoc })
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('PDF export failed:', errorText);
            // Truncate the server response — a failed render of a 5 MB SVG
            // can return a huge stack trace; the toast is cosmetic.
            const detail = errorText.length > 200 ? errorText.slice(0, 200) + '…' : errorText;
            emitToast({ title: tr[language].pdfExportFailed, detail });
            return;
          }
          
          const pdfBlob = await response.blob();
          const url = URL.createObjectURL(pdfBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'program-visualization.pdf';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (error) {
          console.error('PDF export error:', error);
          emitToast({ title: tr[language].pdfExportFailed, detail: String(error).slice(0, 200) });
        }
        return;
      }

      // Convert to PNG via canvas
      const svg64 = btoa(unescape(encodeURIComponent(svgString)));
      const image64 = 'data:image/svg+xml;base64,' + svg64;
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        // Use devicePixelRatio to create a higher-resolution export (clamped)
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const scale = Math.min(4, Math.max(1, dpr * 2)); // e.g. DPR 1 -> 2, DPR 2 -> 4 (clamped at 4)

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(exportWidth * scale);
        canvas.height = Math.round(exportHeight * scale);
        // keep CSS size equal to logical SVG size
        canvas.style.width = `${exportWidth}px`;
        canvas.style.height = `${exportHeight}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Map drawing so that 1 unit = 1 CSS px in SVG space, while canvas pixels are scaled
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        // Fill white background in SVG coordinates
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, exportWidth, exportHeight);

        // Draw the SVG raster (img) into SVG coordinate space
        ctx.drawImage(img, 0, 0, exportWidth, exportHeight);

        // PNG export
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'program-visualization.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = image64;
    }
  }));

  // Layer visibility, derived from URL-controlled props. Memoised so that
  // post-render effects keyed off `[layers]` don't churn on every render.
  const layers = useMemo(() => {
    const base = {
      exams: !hiddenLayers.has('exams'),
      reexams: !hiddenLayers.has('reexams'),
      prereqCompleted: !hiddenLayers.has('prereqCompleted'),
      prereqParticipation: !hiddenLayers.has('prereqParticipation'),
      courseBars: !hiddenLayers.has('courseBars'),
      studyPeriods: !hiddenLayers.has('studyPeriods'),
      examPeriods: !hiddenLayers.has('examPeriods'),
      reexamPeriods: !hiddenLayers.has('reexamPeriods'),
      groups: {} as Record<string, boolean>,
    };
    if (cosmetics && cosmetics.groups) {
      cosmetics.groups.forEach(g => { base.groups[g.name] = !hiddenGroups.has(g.name); });
    }
    return base;
  }, [hiddenLayers, hiddenGroups, cosmetics]);

  const toggleLayer = useCallback((key: TopLayerKey) => {
    const next = new Set(hiddenLayers);
    if (next.has(key)) next.delete(key); else next.add(key);
    onHiddenLayersChange(next);
  }, [hiddenLayers, onHiddenLayersChange]);

  const toggleGroup = useCallback((groupName: string) => {
    const next = new Set(hiddenGroups);
    if (next.has(groupName)) next.delete(groupName); else next.add(groupName);
    onHiddenGroupsChange(next);
  }, [hiddenGroups, onHiddenGroupsChange]);

  // focused course code for fading non-relevant elements
  const [focusCourse, setFocusCourse] = useState<string | null>(null);
  // Info panel selection
  const [selectedInfo, setSelectedInfo] = useState<SelectedInfo | null>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !courses.length) return;

  const svg = select(svgRef.current);
  // Apply global font family to all SVG text
  svg.style('font-family', STYLE.fontFamily);
  const margin = CHART_MARGIN;
  const width = svgRef.current.clientWidth - margin.left - margin.right;
  // The chart height must be a pure function of the data plus a fixed baseline.
  // It used to be seeded from `svgRef.current.clientHeight` — i.e. from the
  // height the *previous* render had written onto this same node — which fed
  // each render's output back into its input. Combined with the one-way
  // `if (requiredTotalHeight > height)` expansion below, switching from a tall
  // programme (TIEMM) to a short one (CTFYS) left the SVG at the tall size, so
  // the legend ended up far below the chart. Measured before the fix:
  // CTFYS 659 -> TIEMM 2994 -> CTFYS 3882, against 659 on a fresh load.
  if (initialChartHeightRef.current == null) {
    initialChartHeightRef.current = svgRef.current.clientHeight - margin.top - margin.bottom;
  }
  let height = initialChartHeightRef.current;

  // Clear previous content
  svg.selectAll('*').remove();

  // Create SVG defs for patterns (option group stripes)
  const defs = svg.append('defs');
  
  // Create a striped pattern for each option group using colors of its option courses
  courses.filter(isOptionGroup).forEach(og => {
    const optionGroup = og as OptionGroup;
    const patternId = `option-group-pattern-${optionGroup.name.replace(/\s+/g, '-')}`;
    
    // Get colors for each option course
    const optionColors = optionGroup.options
      .map(optionCode => {
        const optionCourse = courses.find(c => isCourse(c) && (c as Course).code === optionCode) as Course | undefined;
        return optionCourse ? getCourseColors(optionCourse).fill : null;
      })
      .filter(color => color !== null) as string[];
    
    // Create diagonal striped pattern at 45 degrees
    if (optionColors.length > 0) {
      const stripeWidth = 16; // Width of each diagonal stripe
      const pattern = defs.append('pattern')
        .attr('id', patternId)
        .attr('patternUnits', 'userSpaceOnUse')
        .attr('width', optionColors.length * stripeWidth)
        .attr('height', optionColors.length * stripeWidth)
        .attr('patternTransform', 'rotate(45)');
      
      // Add a rect for each color
      optionColors.forEach((color, index) => {
        pattern.append('rect')
          .attr('x', index * stripeWidth)
          .attr('y', 0)
          .attr('width', stripeWidth)
          .attr('height', '100%')
          .attr('fill', color);
      });
    }
  });

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);    // Create scales
    const timeScale = scaleTime()
      .domain([academicPeriods[0].start, academicPeriods[3].reExamEnd])
      .range([0, width]);
  // Empty-space clicks (clearing focus / info / year) are handled by the
  // delegated click listener installed once on the container.

  // Separate option groups and individual courses, and identify courses that should be hidden
  const optionGroups = courses.filter(isOptionGroup);
  // A course can be an option in SEVERAL groups, and those groups can sit in
  // DIFFERENT study years. CTMAT offers SF1677/SF1678/SF1691 twice: once as the
  // year-2 villkorligt valfria group, and again among the year-3 elective boxes,
  // because a student picks one of them in year 2 and may take another as a free
  // elective in year 3. The data file carries a single entry per course code,
  // stamped `year: 2`, so rendering a picked option from its own entry drew it
  // in year 2 whichever box had been clicked — picking Komplex analys in the
  // year-3 P3 box made it appear in year 2.
  //
  // So a picked option is re-stamped to the year of the group it was picked
  // from: the box the user actually clicked. Its own period layout is kept,
  // which is what every other option in these boxes already does — the group
  // bar is only an envelope (its shape is the per-period maximum of its
  // options), so DD1351 picked in the "P2" box has always drawn across P1+P2.
  // Only the year was ever wrong.
  const optionOf = new Set<string>();
  const pickedIn = new Map<string, OptionGroup>();
  optionGroups.forEach(og => {
    og.options.forEach(optionCode => optionOf.add(optionCode));
    (selectedOptionPerGroup[og.name] ?? []).forEach(code => {
      // First group wins. The modal keeps selections mutually exclusive across
      // groups, so this normally decides nothing; it only makes a hand-edited
      // or stale URL that picks one code in two boxes render one bar
      // deterministically rather than two bars sharing a code.
      if (!pickedIn.has(code)) pickedIn.set(code, og);
    });
  });

  // Swap a multi-round course onto the offering that actually applies: the one
  // the user picked, else the one matching the box it was chosen from.
  //
  // This is what stops a course KTH gives four times a year from drawing as one
  // bar across the whole year. DD1380 is 1.5 hp whichever offering you take, so
  // the bar must show ONE round — and the same course offered by both the P3 and
  // the P4 elective box has to land in the box that was actually clicked.
  //
  // `examsByYear` / `reexamsByYear` are dropped deliberately: a round is a
  // single-year alternative, so a by-year exam map from the merged entry cannot
  // describe it, and keeping it would place markers in a year the round has no
  // credits in.
  const applyRound = (course: Course, group: OptionGroup): Course => {
    const round = pickRound(course, group, selectedRoundPerCourse[course.code]);
    if (!round) return course;
    return {
      ...course,
      credits: round.credits,
      exams: round.exams,
      reexams: round.reexams,
      examsByYear: undefined,
      reexamsByYear: undefined,
    };
  };

  // Shift a course into `targetYear`, preserving its period layout and the
  // relative offsets of a course that spans study years.
  const placeCourseInYear = (course: Course, targetYear: number): Course => {
    const baseYear = course.credits.length
      ? Math.min(...course.credits.map(c => c.year))
      : course.year;
    const delta = targetYear - baseYear;
    if (delta === 0) return course;
    const shiftYearKeys = <T,>(m?: Record<number, T>): Record<number, T> | undefined => {
      if (!m) return undefined;
      const out: Record<number, T> = {};
      Object.entries(m).forEach(([y, v]) => { out[Number(y) + delta] = v; });
      return out;
    };
    return {
      ...course,
      year: course.year + delta,
      credits: course.credits.map(c => ({ ...c, year: c.year + delta })),
      examsByYear: shiftYearKeys(course.examsByYear),
      reexamsByYear: shiftYearKeys(course.reexamsByYear),
    };
  };

  // Courses hidden because they are an option somewhere and picked nowhere. A
  // course picked in one box must NOT land in this set: the bar-drawing loop
  // uses it as a defensive "skip option courses" guard, so adding picked ones
  // here silently drops their bars while still drawing their connector and exam
  // markers.
  const coursesInOptionGroups = new Set(
    [...optionOf].filter(code => !pickedIn.has(code)));

  // Picked options are re-emitted in file order, so the stacking lanes within a
  // period are unaffected.
  const individualCourses = courses.flatMap<Course>(c => {
    if (isOptionGroup(c)) return [];
    const course = c as Course;
    const group = pickedIn.get(course.code);
    if (group) return [placeCourseInYear(applyRound(course, group), group.year)];
    return coursesInOptionGroups.has(course.code) ? [] : [course];
  });
  // Lookup map built once and reused everywhere a Course needs to be
  // resolved by code (prereq routing, focus mode, dispatch context). This
  // turns several per-arrow / per-bar O(n) `find(...)` scans into O(1).
  const individualCoursesByCodeMap = new Map<string, Course>();
  individualCourses.forEach(c => individualCoursesByCodeMap.set(c.code, c));

  // Combine individual courses with option groups for rendering, in FILE ORDER.
  // The placeholder bar is hidden as soon as any option in the group has been
  // picked (first cut: simple all-or-nothing — partial-fill rendering for
  // multi-select groups is a follow-up).
  //
  // This used to be `[...individualCourses, ...optionGroups]`, i.e. every course
  // before every group. The renderer stacks each period's bars in the order of
  // this list, so that concatenation silently overrode the file order the
  // alignment pass works so hard to choose — and it only showed up once
  // something was picked.
  //
  // The symptom: picking any elective turned the picked course into an
  // individual course, which then jumped above the thesis group in that period
  // while the *other* period still had the group on top. CTFYS year 3 has a
  // 15 hp Kandidatexamensarbete spanning P3+P4, so its two bars ended up at
  // different heights and the connector between them became a diagonal — 50 px
  // of step for a pick in the P4 box, 61 px for one in the P3 box. Nothing was
  // wrong with the data; the two orderings simply disagreed.
  const groupIsUnpicked = (og: OptionGroup) =>
    (selectedOptionPerGroup[og.name]?.length ?? 0) === 0;
  const displayItems: Array<Course | OptionGroup> = [];
  courses.forEach(c => {
    if (isOptionGroup(c)) {
      if (groupIsUnpicked(c)) displayItems.push(c);
      return;
    }
    // Use the placed course (round applied, year re-stamped), not the raw entry.
    const placed = individualCoursesByCodeMap.get((c as Course).code);
    if (placed) displayItems.push(placed);
  });
  
  // Increased vertical gap between year rows (px)
  // Increase inter-year gap by 20% (from 48 to ~57.6). Use integer for pixel grid.
  const yearRowGap = 58; // was 48
  const totalGaps = Math.max(0, numYears - 1) * yearRowGap;
  // Base band height from current SVG height, used to derive a baseline pixels-per-ECTS
  // Use the initial chart height for baseline band height so layer toggles don't create feedback loops
  const baseYearBandHeight = ((initialChartHeightRef.current || height) - totalGaps) / numYears;
  // Baseline pixels per ECTS (15 ECTS previously mapped to a year band)
  const pxPerECTS = baseYearBandHeight / 15;
  // Minimum ECTS to enforce for bar height so labels fit nicely
  const MIN_ECTS_FOR_HEIGHT = 2;
  const STACK_GAP_PX = 4; // gap between stacked bars

  // O(1) lookup map for academic-period objects by id. Replaces the
  // `academicPeriods.find(p => p.id === ...)` scans done per-credit and
  // per-slot below.
  const periodById = new Map<Period['id'], Period>();
  academicPeriods.forEach(p => periodById.set(p.id, p));

  // Build mapping of courses per year+period to compute stacking lanes (needed for sizing and layout)
  type SlotEntry = { item: Course | OptionGroup; credit: { period: string; credits: number; year: number } };
  const slotsByYearPeriod: Record<string, SlotEntry[]> = {};
  displayItems.forEach((item) => {
    const credits = isCourse(item) ? item.credits : Object.entries((item as OptionGroup).periodCredits)
      .filter(([, credits]) => credits > 0)
      .map(([period, credits]) => ({
        period: period as 'P1' | 'P2' | 'P3' | 'P4',
        credits,
        year: (item as OptionGroup).year
      }));

    credits.forEach((credit) => {
      const key = `${credit.year}-${credit.period}`;
      if (!slotsByYearPeriod[key]) slotsByYearPeriod[key] = [];
      slotsByYearPeriod[key].push({ item, credit });
    });
  });

  // Pre-parse keys + resolve the Period object once. The three render passes
  // below all iterate the same map, so doing the split/find work here saves
  // 3× the per-key parsing and avoids a linear `academicPeriods.find` in
  // each iteration.
  const slotEntries: Array<{ year: number; period: Period; list: SlotEntry[] }> = [];
  Object.entries(slotsByYearPeriod).forEach(([key, list]) => {
    const [yearStr, periodId] = key.split('-');
    const period = periodById.get(periodId as Period['id'])!;
    slotEntries.push({ year: Number(yearStr), period, list });
  });

  // Compute required band height per year considering the minimum bar height corresponding to 2 ECTS
  const yearBandHeights: number[] = Array.from({ length: numYears }, () => 0);
  for (let y = 1; y <= numYears; y++) {
    // for this year, find all 4 periods
    let maxPeriodHeightNeeded = 0;
    academicPeriods.forEach((p) => {
      const list = slotsByYearPeriod[`${y}-${p.id}`] || [];
      if (list.length === 0) return;
      const heightSum = list.reduce((sum, it) => {
        const effECTS = Math.max(it.credit.credits, MIN_ECTS_FOR_HEIGHT);
        return sum + effECTS * pxPerECTS;
      }, 0);
      const gaps = Math.max(0, list.length - 1) * STACK_GAP_PX;
      maxPeriodHeightNeeded = Math.max(maxPeriodHeightNeeded, heightSum + gaps);
    });
    // Ensure at least the baseline height is kept, even if no courses
    yearBandHeights[y - 1] = Math.max(baseYearBandHeight, maxPeriodHeightNeeded);
  }

  // Size the SVG to what this data needs, never smaller than the baseline. Set
  // unconditionally: the previous version only ever grew the node, which is
  // what stranded the legend after switching to a smaller programme.
  const requiredTotalHeight = yearBandHeights.reduce((a, b) => a + b, 0) + totalGaps;
  height = Math.max(requiredTotalHeight, initialChartHeightRef.current);
  select(svgRef.current)
    .attr('height', height + margin.top + margin.bottom);

  // Compute cumulative Y offsets per year using the (possibly) expanded band heights
  const yearYOffset: number[] = [];
  for (let i = 0; i < numYears; i++) {
    const prev = i === 0 ? 0 : (yearYOffset[i - 1] + yearBandHeights[i - 1] + yearRowGap);
    yearYOffset.push(prev);
  }
  const verticalOffset = 0;
  const periodExtension = 10; // How much the period backgrounds extend beyond course area (reduced for better alignment)

    // Draw program title first (at the top)
    if (programName && programCode) {
      const title = g.append('text')
        .attr('x', width / 2)
        .attr('y', -75)
        .attr('text-anchor', 'middle')
        .attr('fill', kthColors.KthBlue?.HEX)
        .attr('font-weight', 400)
        .attr('font-size', 18);

      title.append('tspan').text(`${programName} `);
      const codeText = `(${programCode})`;
      const linkUrl = studyplanUrl ? (language === 'en' ? `${studyplanUrl}?l=en` : studyplanUrl) : undefined;
      if (linkUrl) {
        const anchor = title.append('a')
          .attr('href', linkUrl)
          .attr('target', '_blank');
        anchor.append('tspan')
          .text(codeText)
          .attr('fill', kthColors.KthHeaven?.HEX || '#6298D2')
          .style('text-decoration', 'none')
          .style('cursor', 'pointer');
      } else {
        title.append('tspan')
          .text(codeText);
      }
    }

    // Draw period backgrounds with extension above and below
    academicPeriods.forEach((period, i) => {
      const periodHeight = height + 2 * periodExtension;
      const yOffset = -periodExtension;
      
      // Main period background
      g.append('rect')
        .attr('x', timeScale(period.start))
        .attr('y', yOffset)
        .attr('width', timeScale(period.lectureEnd) - timeScale(period.start))
        .attr('height', periodHeight)
        .attr('class', 'study-period')
        .attr('fill', (kthColors.KthSand?.HEX ? d3color(kthColors.KthSand.HEX)!.copy({ opacity: 0.25 }).formatRgb() : 'rgba(235,229,224,0.25)'))
        .attr('stroke', 'none')
        .attr('data-kind', 'study-period')
        .attr('data-period', period.id);

      // Add period label (P1, P2, etc.)
      g.append('text')
        .attr('x', timeScale(period.start) + (timeScale(period.lectureEnd) - timeScale(period.start)) / 2)
        .attr('y', -50) // Increased distance from the period fields
        .attr('text-anchor', 'middle')
        .attr('fill', kthColors.KthBlue?.HEX)
        .attr('font-weight', 400)
        .attr('font-size', 14)
        .text(`P${i + 1}`);
    });

    // Month labels across the whole timeline
    {
      const start = academicPeriods[0].start;
      const end = academicPeriods[academicPeriods.length - 1].reExamEnd;
      const months: Date[] = [];
      const d = new Date(start.getFullYear(), start.getMonth(), 1);
      while (d <= end) {
        months.push(new Date(d));
        d.setMonth(d.getMonth() + 1);
      }

      // vertical month boundary lines with same gray and roughly label height
      const monthLabelY = -28;
      const labelHeight = 12;
      months.forEach((md, idx) => {
        if (idx > 0) {
          const xBoundary = timeScale(new Date(md.getFullYear(), md.getMonth(), 1));
          g.append('line')
            .attr('x1', xBoundary)
            .attr('y1', monthLabelY - labelHeight / 2)
            .attr('x2', xBoundary)
            .attr('y2', monthLabelY + labelHeight / 2)
            .attr('stroke', '#f0f2f5ff')
            .attr('stroke-width', 5);
        }
      });

      months.forEach((md) => {
        const label = tr[language].months[md.getMonth()];
        // position in the middle of the month
        const monthStart = new Date(md.getFullYear(), md.getMonth(), 1);
        const monthEnd = new Date(md.getFullYear(), md.getMonth() + 1, 0);
        const mid = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
        g.append('text')
          .attr('x', timeScale(mid))
          .attr('y', monthLabelY)
          .attr('text-anchor', 'middle')
          .attr('fill', '#9ca3af')
          .attr('font-size', 10)
          .text(label);
      });
    }

    // Draw exam periods with extension above and below
    academicPeriods.forEach(period => {
      const examHeight = height + 2 * periodExtension;
      const yOffset = -periodExtension;

      // Regular exam period (subtle KTH light blue)
      g.append('rect')
        .attr('x', timeScale(period.examStart))
        .attr('y', yOffset)
        .attr('width', timeScale(period.examEnd) - timeScale(period.examStart))
        .attr('height', examHeight)
        .attr('class', 'exam-period-rect')
        .attr('fill', (kthColors.KthLightBlue?.HEX ? d3color(kthColors.KthLightBlue.HEX)!.copy({ opacity: 0.5 }).formatRgb() : 'rgba(222,240,255,0.5)'))
        .attr('stroke', 'none')
        .attr('data-kind', 'exam-period')
        .attr('data-period', period.id);

      // Re-exam period (light gray)
      g.append('rect')
        .attr('x', timeScale(period.reExamStart))
        .attr('y', yOffset)
        .attr('width', timeScale(period.reExamEnd) - timeScale(period.reExamStart))
        .attr('height', examHeight)
        .attr('class', 'reexam-period-rect')
        .attr('fill', (kthColors.KthLightGray?.HEX ? d3color(kthColors.KthLightGray.HEX)!.copy({ opacity: 0.5 }).formatRgb() : 'rgba(230,230,230,0.5)'))
        .attr('stroke', 'none')
        .attr('data-kind', 'reexam-period')
        .attr('data-period', period.id);
    });

    // Compute max parallel slots per year to determine lane heights
    const maxSlotsPerYear: Record<number, number> = {};
    slotEntries.forEach(({ year, list }) => {
      maxSlotsPerYear[year] = Math.max(maxSlotsPerYear[year] || 0, list.length);
    });

  // Prepare a position map for drawing arrows and markers later
  const positionMap: Record<string, { xStart: number; xEnd: number; yCenter: number; yTop: number; height: number }> = {};

    // First pass: collect position data for all course bars
    type BarInfo = {
      item: Course | OptionGroup;
      credit: { period: string; credits: number; year: number };
      barX: number;
      barY: number;
      barWidth: number;
      barHeight: number;
      colors: { fill: string; stroke: string; text: string };
      periodObj: Period;
    };
    const allBars: BarInfo[] = [];

    slotEntries.forEach(({ year, period, list }) => {
      const yearIndex = year - 1;
      const yearY = yearYOffset[yearIndex];
      const x = timeScale(period.start);
      const pixelsPerECTS = pxPerECTS;
      const gapPx = STACK_GAP_PX;
      let cursorY = verticalOffset + yearY;

      list.forEach((itemWrapper) => {
        const credit = itemWrapper.credit;
        const item = itemWrapper.item;
        const rawHeight = pixelsPerECTS * credit.credits;
        const minHeight = pixelsPerECTS * MIN_ECTS_FOR_HEIGHT;
        const courseHeight = Math.max(rawHeight, minHeight);
        const periodObj = periodById.get(credit.period as Period['id'])!;
        const courseWidth = timeScale(periodObj.lectureEnd) - timeScale(periodObj.start);
        const barX = x + 2;
        const barWidth = Math.max(0, courseWidth - 4);
        
        // Handle both courses and option groups for colors
        const colors = isCourse(item) ? getCourseColors(item) : getColorForFamily('yellow');

        allBars.push({
          item,
          credit: { period: credit.period as Period['id'], credits: credit.credits, year: credit.year || (isCourse(item) ? item.year : (item as OptionGroup).year) },
          barX,
          barY: cursorY,
          barWidth,
          barHeight: courseHeight,
          colors,
          periodObj
        });

        const itemId = isCourse(item) ? item.code : `optionGroup-${(item as OptionGroup).name}`;
        positionMap[`${itemId}-${credit.year}-${credit.period}`] = {
          xStart: barX,
          xEnd: barX + barWidth,
          yCenter: cursorY + courseHeight / 2,
          yTop: cursorY,
          height: courseHeight
        };

        cursorY += courseHeight + gapPx;
      });
    });

    // Second pass: draw connector shapes for consecutive periods within same year
    // Also track which bars should show labels (first in each connected sequence)
    // Handle connectors for both courses and option groups that span multiple periods
    const periodSequence = ['P1', 'P2', 'P3', 'P4'];
    const barsWithoutLabels = new Set<string>(); // track bars that shouldn't have labels
    const barsConnectedRight = new Set<string>(); // bars with connector on their right side
    const barsConnectedLeft = new Set<string>(); // bars with connector on their left side
    const connectorBorders: Array<{ points: number[][]; stroke: string; itemId: string; groupName: string }> = []; // collect connector borders to draw last
    
    // Process both courses and option groups
    const processItem = (item: Course | OptionGroup) => {
      const itemId = isCourse(item) ? (item as Course).code : `optionGroup-${(item as OptionGroup).name}`;
      // Resolve cosmetics group for courses directly; for option groups look up any constituent course
      const itemGroupName = isCourse(item)
        ? (cosmetics?.courseToGroup.get((item as Course).code)?.name ?? '')
        : ((item as OptionGroup).options.map(c => cosmetics?.courseToGroup.get(c)?.name).find(Boolean) ?? '');
      const barsByYear: Record<number, BarInfo[]> = {};
      
      // Find all bars for this item
      allBars.filter(b => {
        if (isCourse(item)) {
          return isCourse(b.item) && (b.item as Course).code === (item as Course).code;
        } else {
          return isOptionGroup(b.item) && (b.item as OptionGroup).name === (item as OptionGroup).name;
        }
      }).forEach(bar => {
        const year = bar.credit.year;
        if (!barsByYear[year]) barsByYear[year] = [];
        barsByYear[year].push(bar);
      });

      Object.entries(barsByYear).forEach(([, yearBars]) => {
        yearBars.sort((a, b) => periodSequence.indexOf(a.credit.period) - periodSequence.indexOf(b.credit.period));
        
        // Find consecutive periods
        for (let i = 0; i < yearBars.length - 1; i++) {
          const current = yearBars[i];
          const next = yearBars[i + 1];
          const currentIdx = periodSequence.indexOf(current.credit.period);
          const nextIdx = periodSequence.indexOf(next.credit.period);
          
          // Check if consecutive
          if (nextIdx === currentIdx + 1) {
            // Mark the second bar as not needing a label
            barsWithoutLabels.add(`${itemId}-${next.credit.year}-${next.credit.period}`);
            
            // Mark which bars are connected
            barsConnectedRight.add(`${itemId}-${current.credit.year}-${current.credit.period}`);
            barsConnectedLeft.add(`${itemId}-${next.credit.year}-${next.credit.period}`);
            
            // Draw connector polygon
            // Connect pre-rounding points on horizontal edges of both bars
            const cornerRadius = 4;
            const x1 = current.barX + current.barWidth; // right edge of current bar
            const y1Top = current.barY;
            const y1Bottom = current.barY + current.barHeight;
            const x2 = next.barX; // left edge of next bar
            const y2Top = next.barY;
            const y2Bottom = next.barY + next.barHeight;

            // Pre-rounding points on horizontal edges
            const points = [
              [x1 - cornerRadius, y1Top],      // top-right pre-rounding
              [x2 + cornerRadius, y2Top],      // top-left pre-rounding
              [x2 + cornerRadius, y2Bottom],   // bottom-left pre-rounding
              [x1 - cornerRadius, y1Bottom]    // bottom-right pre-rounding
            ];

            // Get the colors
            const connectorColors = isCourse(item) ? getCourseColors(item as Course) : getColorForFamily('yellow');
            
            // For option groups, use a striped pattern fill in connectors too
            const connectorFillValue = isOptionGroup(item) 
              ? `url(#option-group-pattern-${(item as OptionGroup).name.replace(/\s+/g, '-')})`
              : connectorColors.fill;

            g.append('polygon')
              .attr('points', points.map(p => p.join(',')).join(' '))
              .attr('fill', connectorFillValue)
              .attr('stroke', 'none')
              .attr('class', 'course-connector-fill')
              .attr('data-kind', 'connector')
              .attr('data-course', itemId)
              .attr('data-group', itemGroupName)
              .attr('data-year', String(current.credit.year))
              .attr('data-period', current.credit.period)
              .style('cursor', 'pointer');
            
            // Store connector border to draw later (after all fills)
            connectorBorders.push({
              points,
              stroke: connectorColors.stroke,
              itemId: itemId,
              groupName: itemGroupName
            });
          }
        }
      });
    };

    // Process individual courses
    individualCourses.forEach((course) => {
      processItem(course);
    });

    // Process option groups
    optionGroups.forEach((og) => {
      processItem(og);
    });

    // Third pass: draw the actual course bars
    slotEntries.forEach(({ year, period, list }) => {
  const yearIndex = year - 1;
  const yearY = yearYOffset[yearIndex];
      const x = timeScale(period.start);

    // pixels per ECTS for the year band (baseline set from initial layout)
    const pixelsPerECTS = pxPerECTS;

    const gapPx = STACK_GAP_PX; // doubled gap between stacked bars (was 2)
    let cursorY = verticalOffset + yearY; // start at the top of the year band

      list.forEach((itemWrapper) => {
        const credit = itemWrapper.credit;
        const item = itemWrapper.item;

        // Skip courses that are part of option groups (defensive check)
        if (isCourse(item) && coursesInOptionGroups.has((item as Course).code)) {
          return;
        }

  const rawHeight = pixelsPerECTS * credit.credits;
  const minHeight = pixelsPerECTS * MIN_ECTS_FOR_HEIGHT;
  const courseHeight = Math.max(rawHeight, minHeight); // ensure minimal visible height equal to 2 ECTS

  // Generate item ID for tracking
  const itemId = isCourse(item) ? (item as Course).code : `optionGroup-${(item as OptionGroup).name}`;
  
  // Resolve cosmetics group for courses directly; for option groups look up any constituent course
  const dataGroup = isCourse(item)
    ? (cosmetics?.courseToGroup.get(item.code)?.name ?? '')
    : ((item as OptionGroup).options.map(c => cosmetics?.courseToGroup.get(c)?.name).find(Boolean) ?? '');

  const block = g.append('g')
    .attr('class', 'course-group')
    .attr('data-course', itemId)
    .attr('data-group', dataGroup);

  const periodObj = periodById.get(credit.period as Period['id'])!;
  const courseWidth = timeScale(periodObj.lectureEnd) - timeScale(periodObj.start);
  const barX = x + 2;
  const barWidth = Math.max(0, courseWidth - 4);

  // Determine color based on item type
  const colors = isCourse(item) ? getCourseColors(item) : getColorForFamily('yellow');
  
  // For option groups, use a striped pattern fill
  const fillValue = isOptionGroup(item) 
    ? `url(#option-group-pattern-${(item as OptionGroup).name.replace(/\s+/g, '-')})`
    : colors.fill;

  // Check if this bar is connected to others (applies to both courses and option groups)
  const barKey = `${itemId}-${credit.year}-${credit.period}`;
  const connectedRight = barsConnectedRight.has(barKey);
  const connectedLeft = barsConnectedLeft.has(barKey);

  // Accessible label: "{code} {name}, {totalCredits} hp" for courses,
  // "{group name}, {totalCredits} hp ({option group})" for option groups.
  const barAriaLabel = (() => {
    if (isCourse(item)) {
      const c = item as Course;
      const name = language === 'en' ? (c.nameEn || c.name) : c.name;
      const total = c.credits.reduce((s, cr) => s + cr.credits, 0);
      return `${c.code} ${name}, ${total} ${tr[language].credits}`;
    }
    const og = item as OptionGroup;
    const name = language === 'en' ? (og.nameEn || og.name) : og.name;
    const groupWord = language === 'en' ? 'option group' : 'kursgrupp';
    return `${name}, ${og.totalCredits} ${tr[language].credits} (${groupWord})`;
  })();

  // Draw filled rectangle (always the same)
  block.append('rect')
    .attr('x', barX)
    .attr('y', cursorY)
    .attr('width', barWidth)
    .attr('height', courseHeight)
    .attr('fill', fillValue)
    .attr('stroke', 'none')
    .attr('rx', 4)
    .attr('ry', 4)
    .attr('class', 'course-block')
    .attr('data-kind', 'bar')
    .attr('data-course', itemId)
    .attr('data-year', String(credit.year))
    .attr('data-period', credit.period)
    .attr('tabindex', '0')
    .attr('aria-label', barAriaLabel)
    .style('cursor', 'pointer');

  // Draw border with custom path that excludes connected edges
  const r = 4; // corner radius
  const x0 = barX;
  const y0 = cursorY;
  const x1 = barX + barWidth;
  const y1 = cursorY + courseHeight;
  
  let borderPath = '';
  
  if (!connectedLeft && !connectedRight) {
    // No connections: draw full rounded rectangle border
    block.append('rect')
      .attr('class', 'course-bar-border')
      .attr('x', barX)
      .attr('y', cursorY)
      .attr('width', barWidth)
      .attr('height', courseHeight)
      .attr('fill', 'none')
      .attr('stroke', colors.stroke)
      .attr('rx', 4)
      .attr('ry', 4)
      .style('pointer-events', 'none');
  } else {
    // Draw custom border path excluding connected edges
    // Start from top-left, going clockwise
    borderPath = `M ${x0 + r} ${y0}`; // Start after top-left corner
    
    // Top edge
    borderPath += ` L ${x1 - r} ${y0}`;
    
    // Top-right corner (only if not connected on right)
    if (!connectedRight) {
      borderPath += ` Q ${x1} ${y0} ${x1} ${y0 + r}`;
      // Right edge
      borderPath += ` L ${x1} ${y1 - r}`;
      // Bottom-right corner
      borderPath += ` Q ${x1} ${y1} ${x1 - r} ${y1}`;
    } else {
      // Skip right edge when connected
      borderPath += ` M ${x1 - r} ${y1}`;
    }
    
    // Bottom edge
    borderPath += ` L ${x0 + r} ${y1}`;
    
    // Bottom-left corner (only if not connected on left)
    if (!connectedLeft) {
      borderPath += ` Q ${x0} ${y1} ${x0} ${y1 - r}`;
      // Left edge
      borderPath += ` L ${x0} ${y0 + r}`;
      // Top-left corner
      borderPath += ` Q ${x0} ${y0} ${x0 + r} ${y0}`;
    } else {
      // Skip left edge when connected
      borderPath += ` M ${x0 + r} ${y0}`;
    }
    
    block.append('path')
      .attr('class', 'course-bar-border')
      .attr('d', borderPath)
      .attr('fill', 'none')
      .attr('stroke', colors.stroke)
      .style('pointer-events', 'none');
  }

  // store positions for arrows and markers
  positionMap[`${itemId}-${credit.year}-${credit.period}`] = {
    xStart: barX,
    xEnd: barX + barWidth,
    yCenter: cursorY + courseHeight / 2,
    yTop: cursorY,
    height: courseHeight
  };

  // labels inside the bar (code and name on the same row)
  // Skip label if this bar is the second in a connected sequence (applies to both courses and option groups)
  const shouldShowLabel = !barsWithoutLabels.has(barKey);
        
        if (shouldShowLabel) {
          const padding = 4;
          let textX = barX + padding;
          const textY = cursorY + 12;
          let maxWidth = Math.max(0, barWidth - padding * 2);

          // For option groups, draw a circled number indicator before the text
          if (isOptionGroup(item)) {
            const og = item as OptionGroup;
            const numOptions = og.options.length;
            const circleRadius = 7;
            const circleCenterX = textX + circleRadius;
            const circleCenterY = cursorY + circleRadius + 2;
            
            // Draw circle
            block.append('circle')
              .attr('cx', circleCenterX)
              .attr('cy', circleCenterY)
              .attr('r', circleRadius)
              .attr('fill', 'none')
              .attr('stroke', kthColors.KthMarine?.HEX || '#000061')
              .attr('stroke-width', 1.5)
              .attr('pointer-events', 'none');
            
            // Draw number inside circle
            block.append('text')
              .attr('x', circleCenterX)
              .attr('y', circleCenterY)
              .attr('text-anchor', 'middle')
              .attr('dominant-baseline', 'central')
              .attr('font-size', 10)
              .attr('font-weight', 600)
              .attr('fill', kthColors.KthMarine?.HEX || '#000061')
              .attr('pointer-events', 'none')
              .text(numOptions);
            
            // Adjust text position to be after the circle
            textX += circleRadius * 2 + 4;
            maxWidth -= circleRadius * 2 + 4;
          }

          // Create single text string with code and name, using language-appropriate version
          let fullText: string = '';
          if (isCourse(item)) {
            const course = item as Course;
            let displayName: string = '';
            if (language === 'en') {
              displayName = course.briefNameEn || course.nameEn || course.briefName || course.name || '';
            } else {
              displayName = course.briefName || course.name || '';
            }
            fullText = `${course.code} ${displayName}`.trim();
          } else if (isOptionGroup(item)) {
            const og = item as OptionGroup;
            fullText = language === 'en' ? (og.nameEn || og.name) : og.name;
          }
          
          const label = block.append('text')
            .attr('x', textX)
            .attr('y', textY)
            .attr('font-size', 11)
            .attr('font-weight', 600)
            .attr('fill', kthColors.KthMarine?.HEX || '#000061')
            .attr('pointer-events', 'none')
            .attr('class', 'course-label')
            .text(fullText);

          // Truncate text if it overflows available width. Binary-search the
          // longest prefix that still fits — much faster than the previous
          // one-character-at-a-time shrink for long course names in narrow
          // bars (O(log n) measurement calls instead of O(n)).
          try {
            const node = label.node() as SVGTextElement;
            // The original implementation only truncated when fullText.length > 3,
            // so preserve that lower bound here.
            if (node.getComputedTextLength() > maxWidth && fullText.length > 3) {
              const MIN_LEN = 3;
              let lo = MIN_LEN;
              let hi = fullText.length - 1;
              let best = MIN_LEN;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                label.text(fullText.slice(0, mid) + '…');
                if (node.getComputedTextLength() <= maxWidth) {
                  best = mid;
                  lo = mid + 1;
                } else {
                  hi = mid - 1;
                }
              }
              label.text(fullText.slice(0, best) + '…');
            }
          } catch {
            // safe guard for environments where getComputedTextLength may fail
          }
        }

        // advance cursor for next stacked item
        cursorY += courseHeight + gapPx;
      });
    });

    // Fourth pass: draw connector borders on top of everything else
    // Only draw the top and bottom edges (not the vertical sides)
    connectorBorders.forEach(({ points, stroke, itemId, groupName }) => {
      if (!itemId) return;

      const topEdge = `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
      const bottomEdge = `M ${points[2][0]} ${points[2][1]} L ${points[3][0]} ${points[3][1]}`;
      
      g.append('path')
        .attr('d', topEdge)
        .attr('fill', 'none')
        .attr('stroke', stroke)
        .attr('class', 'course-connector-border')
        .attr('data-course', itemId)
        .attr('data-group', groupName)
        .style('pointer-events', 'none');
      
      g.append('path')
        .attr('d', bottomEdge)
        .attr('fill', 'none')
        .attr('stroke', stroke)
        .attr('class', 'course-connector-border')
        .attr('data-course', itemId)
        .attr('data-group', groupName)
        .style('pointer-events', 'none');
    });

    // Year labels on the left
    // Collect exam / re-exam markers so we can draw them on the top layer later
    type ExamMarker = { x: number; cy: number; r: number; course: Course; examPeriod: Period };
    type ReexamMarker = { x: number; cy: number; r: number; course: Course; rePeriod: Period };
    const examMarkers: ExamMarker[] = [];
    const reexamMarkers: ReexamMarker[] = [];
    individualCourses.forEach((course) => {
  const examsGlobal: string[] = course.exams || [];
  const reexamsGlobal: string[] = course.reexams || [];
  const examByYear = course.examsByYear;
  const reexamByYear = course.reexamsByYear;

      course.credits.forEach((credit) => {
        const y = credit.year;
        const examsForYear = examByYear?.[y];
        const reexamsForYear = reexamByYear?.[y];

        const hasExam = Array.isArray(examsForYear)
          ? examsForYear.includes(credit.period)
          : examsGlobal.includes(credit.period);
        const hasReexam = Array.isArray(reexamsForYear)
          ? reexamsForYear.includes(credit.period)
          : reexamsGlobal.includes(credit.period);

        if (hasExam) {
          const examPeriod = periodById.get(credit.period);
          if (examPeriod) {
            const pos = positionMap[`${course.code}-${y}-${credit.period}`];
            if (pos) {
              const xExam = timeScale(new Date((+examPeriod.examStart + +examPeriod.examEnd) / 2));
              examMarkers.push({ x: xExam, cy: pos.yCenter, r: EXAM_MARKER_RADIUS, course, examPeriod });
            }
          }
        }
        if (hasReexam) {
          const rePeriod = periodById.get(credit.period);
          if (rePeriod) {
            const pos = positionMap[`${course.code}-${y}-${credit.period}`];
            if (pos) {
              const xRe = timeScale(new Date((+rePeriod.reExamStart + +rePeriod.reExamEnd) / 2));
              reexamMarkers.push({ x: xRe, cy: pos.yCenter, r: REEXAM_MARKER_RADIUS, course, rePeriod });
            }
          }
        }
      });
    });
    // Per-year credit total for the year-label hover tooltip. Counts
    // every individual course's credits in that year plus the planned
    // total for any option group in that year (group totals stay constant
    // across pickN/minCredits selection states).
    const totalCreditsByYear = Array.from({ length: numYears }, () => 0);
    individualCourses.forEach(c => c.credits.forEach(cr => {
      if (cr.year >= 1 && cr.year <= numYears) totalCreditsByYear[cr.year - 1] += cr.credits;
    }));
    optionGroups.forEach(og => {
      if (og.year >= 1 && og.year <= numYears) totalCreditsByYear[og.year - 1] += og.totalCredits;
    });
    const formatCredits = (n: number) => {
      const r = Math.round(n * 10) / 10;
      return Number.isInteger(r) ? String(r) : r.toFixed(1);
    };

    for (let i = 0; i < numYears; i++) {
      const yearLabelY = yearYOffset[i] + yearBandHeights[i] / 2;
      // Active-year highlighting (font-weight) is applied by the focusYear
      // post-render effect, so toggling focus does not require a full redraw.
      const yearLabelEl = g.append('text')
        .attr('x', -margin.left + 12)
        .attr('y', yearLabelY)
        .text(`${tr[language].year} ${i + 1}`)
        .attr('font-size', 14)
        .attr('font-weight', 400)
        .attr('fill', kthColors.KthBlue?.HEX || '#111827')
        .attr('dominant-baseline', 'middle')
        .attr('class', 'year-label')
        .attr('data-kind', 'year-label')
        .attr('data-year', String(i + 1))
        .attr('tabindex', '0')
        .attr('aria-label', `${tr[language].year} ${i + 1}`)
        .style('cursor', 'pointer');
      // Native browser tooltip: per-year credit summary on the first line,
      // focus-mode hint on the second.
      const summary = `${tr[language].year} ${i + 1}: ${formatCredits(totalCreditsByYear[i])} / 60 ${tr[language].credits}`;
      yearLabelEl.append('title').text(`${summary}\n${tr[language].yearFocusHint}`);
    }

    // Draw arrows for prerequisites using stored positions
    const periodOrder: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

    // Add arrow marker definitions (gray and blue) to existing defs
    defs.append('marker')
      .attr('id', 'arrow-gray')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#999');

    defs.append('marker')
      .attr('id', 'arrow-blue')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', kthColors.KthHeaven?.HEX || '#6298D2');

    // Helper: create a rounded-corner SVG path from a polyline of only horizontal/vertical segments
    function roundedHVPolyline(points: [number, number][], radius: number) {
      if (points.length < 2) return '';
      
      // First, build the path segments (storing them to allow adjustment)
      type PathSegment = { type: 'M' | 'L' | 'Q'; coords: number[] };
      const segments: PathSegment[] = [];
      
      segments.push({ type: 'M', coords: [points[0][0], points[0][1]] });
      let lastX = points[0][0];
      let lastY = points[0][1];
      
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        
        // Check if there's a corner at the next point when we're at i=1
        // If so, skip the straight line segment and let the corner logic handle it at i=2
        let skipStraightSegment = false;
        if (i === 1 && points.length >= 3) {
          const [x2, y2] = points[i + 1];
          const dx0 = x1 - x0;
          const dy0 = y1 - y0;
          const dx1 = x2 - x1;
          const dy1 = y2 - y1;
          
          // If there's a corner coming, skip the straight line
          if ((dx0 === 0 && dy1 === 0 && dx1 !== 0) || (dy0 === 0 && dx1 === 0 && dy1 !== 0)) {
            skipStraightSegment = true;
            // Still update lastX/lastY to point[1] even though we skipped the segment,
            // so the corner logic at i=2 sees the correct previous position
            lastX = x1; lastY = y1;
          }
        }
        
        // If direction changes (i.e., from horizontal to vertical or vice versa), round the corner
        if (i > 1) {
          const [xPrev, yPrev] = points[i - 2];
          const dx0 = x0 - xPrev;
          const dy0 = y0 - yPrev;
          const dx1 = x1 - x0;
          const dy1 = y1 - y0;
          
          // Only round if direction changes and both segments are axis-aligned
          if ((dx0 === 0 && dy1 === 0 && dx1 !== 0) || (dy0 === 0 && dx1 === 0 && dy1 !== 0)) {
            // Shorten previous segment by radius
            const prevX = x0 - Math.sign(dx0) * radius;
            const prevY = y0 - Math.sign(dy0) * radius;
            // Shorten current segment by radius
            const nextX = x0 + Math.sign(dx1) * radius;
            const nextY = y0 + Math.sign(dy1) * radius;
            
            segments.push({ type: 'L', coords: [prevX, prevY] });
            lastX = prevX; lastY = prevY;
            if (i === points.length - 1) {
              // Last corner: curve directly into the exact target
              segments.push({ type: 'Q', coords: [x0, y0, x1, y1] });
              lastX = x1; lastY = y1;
              continue;
            } else {
              // Intermediate corner: curve to shortened point
              segments.push({ type: 'Q', coords: [x0, y0, nextX, nextY] });
              lastX = nextX; lastY = nextY;
              continue;
            }
          }
        }
        
        // Skip the straight line segment if we detected a corner is coming
        if (!skipStraightSegment) {
          segments.push({ type: 'L', coords: [x1, y1] });
          lastX = x1; lastY = y1;
        }
      }
      
      // Check if we ended at the target point
      const [targetX, targetY] = points[points.length - 1];
      
      // If we're short of the target, append a final segment to reach target exactly
      if (lastX !== targetX || lastY !== targetY) {
        segments.push({ type: 'L', coords: [targetX, targetY] });
      }
      
      // Convert segments to path string
      let d = '';
      segments.forEach(seg => {
        if (seg.type === 'M') {
          d += `M${seg.coords[0]},${seg.coords[1]}`;
        } else if (seg.type === 'L') {
          d += ` L${seg.coords[0]},${seg.coords[1]}`;
        } else if (seg.type === 'Q') {
          d += ` Q${seg.coords[0]},${seg.coords[1]} ${seg.coords[2]},${seg.coords[3]}`;
        }
      });
      
      return d;
    }

    // Arrow routing: assign global lanes per gap so arrows do not overlap
    // Collect ALL arrows first (both completed and participation prereqs for all courses)
    type PositionEntry = { xStart: number; xEnd: number; yCenter: number; yTop: number; height: number };
    type ArrowData = {
      prCode: string;
      targetCourse: Course;
      from: PositionEntry;
      to: PositionEntry;
      fromYearIdx: number;
      toYearIdx: number;
      fromPeriod: string;
      toPeriod: string;
      style: { stroke: string; dash?: string; markerId: string; cssClass: string };
    };
    const allArrows: ArrowData[] = [];
    
    individualCourses.forEach((course) => {
      const courseCreditsSorted = [...course.credits].sort((a: CourseCredit, b: CourseCredit) => (a.year - b.year) || (periodOrder[a.period] - periodOrder[b.period]));
      const firstCourse = courseCreditsSorted[0];
      if (!firstCourse) return;
      
      const completed = course.prerequisitesCompleted || course.prerequisites || [];
      const participated = course.prerequisitesParticipation || [];
      
      // Process completed prerequisites
      completed.forEach((prCode: string) => {
        const prereq = individualCoursesByCodeMap.get(prCode);
        if (!prereq) return;
        const prereqCreditsSorted = [...prereq.credits].sort((a: CourseCredit, b: CourseCredit) => (a.year - b.year) || (periodOrder[a.period] - periodOrder[b.period]));
        const lastPrereq = prereqCreditsSorted[prereqCreditsSorted.length - 1];
        if (!lastPrereq) return;
        const from = positionMap[`${prereq.code}-${lastPrereq.year}-${lastPrereq.period}`];
        const to = positionMap[`${course.code}-${firstCourse.year}-${firstCourse.period}`];
        if (!from || !to) return;
        allArrows.push({
          prCode,
          targetCourse: course,
          from,
          to,
          fromYearIdx: lastPrereq.year - 1,
          toYearIdx: firstCourse.year - 1,
          fromPeriod: lastPrereq.period,
          toPeriod: firstCourse.period,
          style: { stroke: (kthColors.KthHeaven?.HEX || '#6298D2'), markerId: 'arrow-blue', cssClass: 'prereq-completed' }
        });
      });
      
      // Process participation prerequisites
      participated.forEach((prCode: string) => {
        const prereq = individualCoursesByCodeMap.get(prCode);
        if (!prereq) return;
        const prereqCreditsSorted = [...prereq.credits].sort((a: CourseCredit, b: CourseCredit) => (a.year - b.year) || (periodOrder[a.period] - periodOrder[b.period]));
        const lastPrereq = prereqCreditsSorted[prereqCreditsSorted.length - 1];
        if (!lastPrereq) return;
        const from = positionMap[`${prereq.code}-${lastPrereq.year}-${lastPrereq.period}`];
        const to = positionMap[`${course.code}-${firstCourse.year}-${firstCourse.period}`];
        if (!from || !to) return;
        allArrows.push({
          prCode,
          targetCourse: course,
          from,
          to,
          fromYearIdx: lastPrereq.year - 1,
          toYearIdx: firstCourse.year - 1,
          fromPeriod: lastPrereq.period,
          toPeriod: firstCourse.period,
          style: { stroke: '#999', dash: '4,3', markerId: 'arrow-gray', cssClass: 'prereq-participation' }
        });
      });
    });
    
    // Step 1: Extract all arrow segments (horizontal and vertical) for each prerequisite arrow
    //         Store them in a clear structure with all required metadata, but do not assign lanes or endpoints yet.
    type ArrowSegment = {
      arrowIdx: number;
      arrowId: string; // e.g. `${prCode}->${targetCode}`
      type: 'horizontal' | 'vertical';
      direction: 'up' | 'down' | 'left' | 'right';
      gapType: string; // e.g. 'inter-year-gap-1', 'inter-period-y2'
      gapIdx: number; // year index for gap
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      fromSameYear: boolean;
      fromTo: { fromYearIdx: number; toYearIdx: number; fromPeriod: string; toPeriod: string };
      // Optionally: more info for sorting/assignment
    };

    // This will be filled for all arrows
    const allArrowSegments: ArrowSegment[] = [];

    allArrows.forEach((arrow, idx) => {
      const isSameYear = arrow.fromYearIdx === arrow.toYearIdx;
      const fromPeriodNum = periodOrder[arrow.fromPeriod];
      const toPeriodNum = periodOrder[arrow.toPeriod];
      const isImmediatelyAfter = isSameYear && (toPeriodNum === fromPeriodNum + 1);
      const arrowId = `${arrow.prCode}->${arrow.targetCourse.code}`;

      // Compute the main routing points (not including start/end connectors yet)
      // We'll use the same logic as before, but just record the segments
      if (isImmediatelyAfter) {
        // Inter-period routing: horizontal segment in the inter-period space
        // Start at bar edge, short horizontal, vertical, horizontal, vertical, horizontal into target
        // We'll record the vertical segments in the inter-period gap, and the horizontal in the bar/gap
        // For now, just record the main horizontal and vertical segments (not the connectors)
        // (The actual x/y values for the connectors will be added after lane assignment)

        // Horizontal segment in the inter-period gap (y = routingY)
        // We'll need to know the y value for the gap (routingY), and the x range
        // For now, just record the segment from the start of the gap to the end of the gap
        // (The actual offsets for lanes will be added later)

        // Record horizontal segment for the inter-period gap
        // Gap is identified by year and period boundary, not by source Y coordinate
        const y = Math.round(arrow.from.yCenter); // routingY will be offset later
        const xStart = Math.round(arrow.from.xEnd);
        const xEnd = Math.round(arrow.to.xStart);
        const gapType = `inter-period-y${arrow.fromYearIdx}-p${periodOrder[arrow.fromPeriod]}to${periodOrder[arrow.toPeriod]}`;
        const gapIdx = arrow.fromYearIdx; // year index
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'horizontal',
          direction: xEnd > xStart ? 'right' : 'left',
          gapType,
          gapIdx,
          x1: xStart,
          y1: y,
          x2: xEnd,
          y2: y,
          fromSameYear: true,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
        
        // Also extract vertical segments in the inter-period gap (at start and end)
        const yStart = Math.round(arrow.from.yCenter);
        const yEnd = Math.round(arrow.to.yCenter);
        // Both vertical segments are in the same gap between the two periods
        // Use consistent gap naming: p1-p2 format
        const fromPNum = periodOrder[arrow.fromPeriod];
        const toPNum = periodOrder[arrow.toPeriod];
        const verticalGapType = `inter-period-vertical-y${arrow.fromYearIdx}-p${fromPNum}-p${toPNum}`;
        
        // Start vertical segment (from bar to routing Y)
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'vertical',
          direction: yStart < y ? 'down' : 'up', // will go from yStart to routingY
          gapType: verticalGapType,
          gapIdx,
          x1: xStart,
          y1: yStart,
          x2: xStart,
          y2: y, // routingY (will be offset later)
          fromSameYear: true,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
        // End vertical segment (from routing Y to bar)
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'vertical',
          direction: y < yEnd ? 'down' : 'up', // will go from routingY to yEnd
          gapType: verticalGapType,
          gapIdx,
          x1: xEnd,
          y1: y, // routingY (will be offset later)
          x2: xEnd,
          y2: yEnd,
          fromSameYear: true,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
      } else {
        // Route via inter-year gap
        // Horizontal segment in the inter-year gap (y = yGap), x1 to x2
        // We'll need to know which gap (gapBelowYearIdx)
        const gapBelowYearIdx = Math.max(arrow.fromYearIdx, arrow.toYearIdx);
        const gapType = `inter-year-gap-${gapBelowYearIdx}`;
        const gapIdx = gapBelowYearIdx;
        // For now, just record the main horizontal segment in the gap
        // The y value for the gap will be offset later
        const xStart = Math.round(arrow.from.xEnd); // will be offset later
        const xEnd = Math.round(arrow.to.xStart); // will be offset later
        // We'll use a placeholder y (to be offset later)
        const y = 0; // placeholder, will be set after lane assignment
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'horizontal',
          direction: xEnd > xStart ? 'right' : 'left',
          gapType,
          gapIdx,
          x1: xStart,
          y1: y,
          x2: xEnd,
          y2: y,
          fromSameYear: isSameYear,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
        
        // Extract vertical segments for inter-year arrows
        // Start vertical segment: drops down from source course to inter-year gap
        const yStart = Math.round(arrow.from.yCenter);
        const yGapPlaceholder = 0; // will be calculated during drawing
        // Determine which inter-period gap the start vertical segment passes through
        // The vertical segment is at the right edge of the source course, so it's in the gap after that period
        const fromPeriodNum = periodOrder[arrow.fromPeriod];
        const toPeriodNum = periodOrder[arrow.toPeriod];
        // Gap naming: p1-p2 means between period 1 and 2, p4-after means after period 4
        const startGapName = fromPeriodNum < 4 ? `p${fromPeriodNum}-p${fromPeriodNum + 1}` : `p4-after`;
        const startVerticalGapType = `inter-period-vertical-y${arrow.fromYearIdx}-${startGapName}`;
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'vertical',
          direction: 'down', // going down to inter-year gap
          gapType: startVerticalGapType,
          gapIdx: arrow.fromYearIdx,
          x1: xStart,
          y1: yStart,
          x2: xStart,
          y2: yGapPlaceholder, // placeholder
          fromSameYear: isSameYear,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
        
        // End vertical segment: comes up from inter-year gap to target course
        const yEnd = Math.round(arrow.to.yCenter);
        // The vertical segment is at the left edge of the target course, so it's in the gap before that period
        const endGapName = toPeriodNum > 1 ? `p${toPeriodNum - 1}-p${toPeriodNum}` : `before-p1`;
        const endVerticalGapType = `inter-period-vertical-y${arrow.toYearIdx}-${endGapName}`;
        allArrowSegments.push({
          arrowIdx: idx,
          arrowId,
          type: 'vertical',
          direction: 'up', // going up from inter-year gap
          gapType: endVerticalGapType,
          gapIdx: arrow.toYearIdx,
          x1: xEnd,
          y1: yGapPlaceholder, // placeholder
          x2: xEnd,
          y2: yEnd,
          fromSameYear: isSameYear,
          fromTo: { fromYearIdx: arrow.fromYearIdx, toYearIdx: arrow.toYearIdx, fromPeriod: arrow.fromPeriod, toPeriod: arrow.toPeriod },
        });
      }
    });
    // At this point, allArrowSegments contains the main horizontal segments for each arrow, with all required metadata, but no lanes or endpoints yet.

    // Step 2: Group segments by gap and direction for overlap analysis
    // Structure: { [gapType]: { horizontal: ArrowSegment[], vertical: ArrowSegment[], ... } }
    const segmentsByGap: Record<string, { horizontal: ArrowSegment[]; vertical: ArrowSegment[]; sameYear?: ArrowSegment[]; crossYear?: ArrowSegment[]; up?: ArrowSegment[]; down?: ArrowSegment[] }> = {};

    allArrowSegments.forEach(seg => {
      if (!segmentsByGap[seg.gapType]) {
        segmentsByGap[seg.gapType] = { horizontal: [], vertical: [] };
      }
      segmentsByGap[seg.gapType][seg.type].push(seg);
      // Optionally, for inter-year gaps, separate same-year/cross-year
      if (seg.type === 'horizontal') {
        if (seg.fromSameYear) {
          if (!segmentsByGap[seg.gapType].sameYear) segmentsByGap[seg.gapType].sameYear = [];
          segmentsByGap[seg.gapType].sameYear!.push(seg);
        } else {
          if (!segmentsByGap[seg.gapType].crossYear) segmentsByGap[seg.gapType].crossYear = [];
          segmentsByGap[seg.gapType].crossYear!.push(seg);
        }
      }
      // Optionally, for inter-period gaps, separate up/down
      if (seg.type === 'vertical') {
        if (seg.direction === 'up') {
          if (!segmentsByGap[seg.gapType].up) segmentsByGap[seg.gapType].up = [];
          segmentsByGap[seg.gapType].up!.push(seg);
        } else if (seg.direction === 'down') {
          if (!segmentsByGap[seg.gapType].down) segmentsByGap[seg.gapType].down = [];
          segmentsByGap[seg.gapType].down!.push(seg);
        }
      }
    });
    // segmentsByGap is now ready for overlap analysis and lane assignment.

    // Step 3: Detect clashing segments in each gap (overlap groups)
    type OverlapGroup = ArrowSegment[];
    const overlapGroupsByGap: Record<string, { horizontal: OverlapGroup[]; vertical: OverlapGroup[] }> = {};

    Object.entries(segmentsByGap).forEach(([gapType, segsByDir]) => {
      // Horizontal segments: group by x overlap (normalize x ranges)
      const hSegs = segsByDir.horizontal || [];
      const hGroups: OverlapGroup[] = [];
      type HNorm = { seg: ArrowSegment; xMin: number; xMax: number };
      const hNorm: HNorm[] = hSegs.map(seg => ({
        seg,
        xMin: Math.min(seg.x1, seg.x2),
        xMax: Math.max(seg.x1, seg.x2),
      }));
      hNorm.sort((a, b) => a.xMin - b.xMin);
      let currentGroupN: HNorm[] = [];
      let currentEnd = -Infinity;
      hNorm.forEach(item => {
        if (currentGroupN.length === 0 || item.xMin <= currentEnd) {
          currentGroupN.push(item);
          currentEnd = Math.max(currentEnd, item.xMax);
        } else {
          hGroups.push(currentGroupN.map(i => i.seg));
          currentGroupN = [item];
          currentEnd = item.xMax;
        }
      });
      if (currentGroupN.length > 0) hGroups.push(currentGroupN.map(i => i.seg));

      // Vertical segments: group by y overlap (not used yet, but structure is ready)
      const vSegs = segsByDir.vertical || [];
      const vGroups: OverlapGroup[] = [];
      const sortedV = [...vSegs].sort((a, b) => a.y1 - b.y1);
      let vCurrentGroup: ArrowSegment[] = [];
      let vCurrentEnd = -Infinity;
      sortedV.forEach(seg => {
        if (vCurrentGroup.length === 0 || seg.y1 <= vCurrentEnd) {
          vCurrentGroup.push(seg);
          vCurrentEnd = Math.max(vCurrentEnd, seg.y2);
        } else {
          vGroups.push(vCurrentGroup);
          vCurrentGroup = [seg];
          vCurrentEnd = seg.y2;
        }
      });
      if (vCurrentGroup.length > 0) vGroups.push(vCurrentGroup);

      overlapGroupsByGap[gapType] = { horizontal: hGroups, vertical: vGroups };
    });

    // Step 4: Assign lanes to clashing segments
    const segmentLanes: Record<string, { [segmentType: string]: number }> = {};

    Object.entries(overlapGroupsByGap).forEach(([gapType, groupObj]) => {
      // For horizontal segments: assign lanes within each group
      const hGroups = groupObj.horizontal;
      hGroups.forEach((group) => {
        // Greedy interval coloring per group to avoid y collision for overlapping horizontals
        const items = group.map(seg => ({
          seg,
          xMin: Math.min(seg.x1, seg.x2),
          xMax: Math.max(seg.x1, seg.x2),
        })).sort((a, b) => a.xMin - b.xMin);
        const laneEnds: number[] = [];
        items.forEach(({ seg, xMin, xMax }) => {
          // find first lane whose end < xMin
          let laneIdx = laneEnds.findIndex(end => end < xMin);
          if (laneIdx === -1) {
            laneIdx = laneEnds.length;
            laneEnds.push(xMax);
          } else {
            laneEnds[laneIdx] = xMax;
          }
          if (!segmentLanes[seg.arrowId]) segmentLanes[seg.arrowId] = {};
          segmentLanes[seg.arrowId][`horizontal-${gapType}`] = laneIdx;
        });
      });
      
      // For vertical segments: split by x-column (start/end) within the same gap,
      // then group by Y-overlap per column and assign lanes so overlapping verticals don't share x
      const vGroups = groupObj.vertical;
      const vAll: ArrowSegment[] = ([] as ArrowSegment[]).concat(...vGroups);
      if (vAll.length > 0) {
        // Identify columns by x (typically two: left/start and right/end within this gap)
        const xs = vAll.map(s => s.x1);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const midX = (minX + maxX) / 2;

        const startCol = vAll.filter(s => s.x1 <= midX);
        const endCol = vAll.filter(s => s.x1 > midX);

        const assignColumnLanes = (colSegs: ArrowSegment[]) => {
          if (colSegs.length === 0) return;
          // Group by Y-overlap using normalized intervals [yMin, yMax]
          const normalized = colSegs.map(s => ({
            seg: s,
            yMin: Math.min(s.y1, s.y2),
            yMax: Math.max(s.y1, s.y2),
          }));
          normalized.sort((a, b) => a.yMin - b.yMin);
          const groups: { segs: ArrowSegment[]; end: number }[] = [];
          normalized.forEach(({ seg, yMin, yMax }) => {
            const g = groups[groups.length - 1];
            if (!g || yMin > g.end) {
              groups.push({ segs: [seg], end: yMax });
            } else {
              g.segs.push(seg);
              g.end = Math.max(g.end, yMax);
            }
          });
          // Within each overlap group, assign lanes by order
          groups.forEach(({ segs }) => {
            const ordered = [...segs].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
            ordered.forEach((seg, laneIdx) => {
              if (!segmentLanes[seg.arrowId]) segmentLanes[seg.arrowId] = {};
              // Robustly determine whether this vertical belongs to the start (source) or end (target)
              const arr = allArrows[seg.arrowIdx];
              const distToStart = Math.abs(seg.x1 - arr.from.xEnd);
              const distToEnd = Math.abs(seg.x1 - arr.to.xStart);
              const posKey: 'start' | 'end' = distToStart <= distToEnd ? 'start' : 'end';
              segmentLanes[seg.arrowId][`vertical-${gapType}-${posKey}`] = laneIdx;
              // Optional debug: which column we grouped it in vs assigned posKey
              // console.log(`Lane assign v: gap=${gapType}, arrow=${seg.arrowId}, column=${columnLabel}, pos=${posKey}, lane=${laneIdx}`);
            });
          });
        };

        assignColumnLanes(startCol);
        assignColumnLanes(endCol);
      }
    });

    // Step 4.5: Add endpoint connector segments and prepare for drawing
    // Now draw all arrows using the new segment and lane assignment structures
    allArrows.forEach((arrow) => {
      // Routing parameters
      const vPad = 8;
      const curveR = 8;
      const laneSpacing = 4;
      const vLaneSpacing = 7;

      const isSameYear = arrow.fromYearIdx === arrow.toYearIdx;
      const fromPeriodNum = periodOrder[arrow.fromPeriod];
      const toPeriodNum = periodOrder[arrow.toPeriod];
      const isImmediatelyAfter = isSameYear && (toPeriodNum === fromPeriodNum + 1);

      // Get the assigned lane for the main horizontal segment
      const gapType = isImmediatelyAfter
        ? `inter-period-y${arrow.fromYearIdx}-p${periodOrder[arrow.fromPeriod]}to${periodOrder[arrow.toPeriod]}`
        : `inter-year-gap-${Math.max(arrow.fromYearIdx, arrow.toYearIdx)}`;
      const hLaneIdx = segmentLanes[`${arrow.prCode}->${arrow.targetCourse.code}`]?.[`horizontal-${gapType}`] ?? 0;

      // Get the assigned lane for vertical segments
      // For inter-period arrows: both vertical segments are in the same gap (p1-p2 format)
      // For inter-year arrows: vertical segments are in different gaps based on source/target period
      const fromPNum = periodOrder[arrow.fromPeriod];
      const toPNum = periodOrder[arrow.toPeriod];
      
      const vGapTypeStart = isImmediatelyAfter 
        ? `inter-period-vertical-y${arrow.fromYearIdx}-p${fromPNum}-p${toPNum}`
        : `inter-period-vertical-y${arrow.fromYearIdx}-${fromPNum < 4 ? `p${fromPNum}-p${fromPNum + 1}` : `p4-after`}`;
      const vGapTypeEnd = isImmediatelyAfter 
        ? `inter-period-vertical-y${arrow.fromYearIdx}-p${fromPNum}-p${toPNum}`
        : `inter-period-vertical-y${arrow.toYearIdx}-${toPNum > 1 ? `p${toPNum - 1}-p${toPNum}` : `before-p1`}`;
      
      const vLaneIdxStart = segmentLanes[`${arrow.prCode}->${arrow.targetCourse.code}`]?.[`vertical-${vGapTypeStart}-start`] ?? 0;
      const vLaneIdxEnd = segmentLanes[`${arrow.prCode}->${arrow.targetCourse.code}`]?.[`vertical-${vGapTypeEnd}-end`] ?? 0;

      // Compute the main routing points (including endpoints)
      const points: [number, number][] = [];
      const startX = arrow.from.xEnd;
      const startY = arrow.from.yCenter;
      const endX = arrow.to.xStart;
      const endY = arrow.to.yCenter;
      
      if (isImmediatelyAfter) {
        // Inter-period routing: horizontal segment in the inter-period space
        const yOffset = hLaneIdx * laneSpacing;
        const routingY = startY + yOffset;
        // Start at bar edge
        points.push([startX, startY]);
        // Short horizontal to clear the bar, then vertical to routing Y level
        let xRouting = startX + vLaneSpacing + vLaneIdxStart * vLaneSpacing;
        // Check if the lane offset would push us too far past the target
        // If so, reduce it to avoid unnecessary back-and-forth routing
        const xNearEnd = endX - vLaneSpacing - vLaneIdxEnd * vLaneSpacing;
        if (xRouting > xNearEnd) {
          // Lane offset is pushing us too far; reduce it
          xRouting = startX + vLaneSpacing;
        }
        points.push([xRouting, startY]);
        points.push([xRouting, routingY]);
        // Horizontal segment across to near the target
        points.push([xNearEnd, routingY]);
        // Vertical down to target Y, then horizontal into target at exact edge
        points.push([xNearEnd, endY]);
        points.push([endX, endY]);
      } else {
        // Route via inter-year gap
        const fromYearY = yearYOffset[arrow.fromYearIdx];
        let yGap;
        if (isSameYear) {
          const yearBottom = fromYearY + yearBandHeights[arrow.fromYearIdx];
          yGap = yearBottom + vPad + hLaneIdx * laneSpacing;
        } else {
          const lowerYearIdx = Math.max(arrow.fromYearIdx, arrow.toYearIdx);
          const gapTop = yearYOffset[lowerYearIdx];
          yGap = gapTop - yearRowGap / 2 + hLaneIdx * laneSpacing;
        }
  // X positions for the vertical segments (apply lane offsets per start/end column)
  const xStartRouting = startX + vLaneSpacing + vLaneIdxStart * vLaneSpacing;
  const xEndRouting = endX - vLaneSpacing - vLaneIdxEnd * vLaneSpacing;
        // Start at course bar edge
        points.push([startX, startY]);
        // Short horizontal to start of vertical segment
        points.push([xStartRouting, startY]);
        // Vertical down to inter-year gap
        points.push([xStartRouting, yGap]);
        // Horizontal across the gap
        points.push([xEndRouting, yGap]);
        // Vertical up to target Y
        points.push([xEndRouting, endY]);
        // Short horizontal into target at exact edge
        points.push([endX, endY]);
      }

      // Step 6: Draw the path using roundedHVPolyline
      const fromGroup = cosmetics?.courseToGroup.get(arrow.prCode);
      const toGroup = cosmetics?.courseToGroup.get(arrow.targetCourse.code);
      const fromGroupName = fromGroup ? fromGroup.name : '';
      const toGroupName = toGroup ? toGroup.name : '';
      
      const path = g.append('path')
        .attr('d', roundedHVPolyline(points, curveR))
        .attr('stroke', arrow.style.stroke)
        .attr('stroke-width', 1)
        .attr('fill', 'none')
        .attr('marker-end', `url(#${arrow.style.markerId})`)
        .attr('class', `prereq-path ${arrow.style.cssClass}`)
        .attr('data-from', arrow.prCode)
        .attr('data-to', arrow.targetCourse.code)
        .attr('data-from-group', fromGroupName)
        .attr('data-to-group', toGroupName);
      if (arrow.style.dash) path.attr('stroke-dasharray', arrow.style.dash);
    });

  // Initial layer visibility is applied by the dedicated `layers` post-render
  // effect below; that effect runs after this one on every render and covers
  // every selector. No need to duplicate the work here.

  // create a dedicated top layer group so markers always render above chart elements
  const topLayer = svg.append('g')
    .attr('class', 'pv-top-layer')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Draw exam markers in topLayer, aligned horizontally to exam period and vertically to course
  examMarkers.forEach((m) => {
    const colors = getCourseColors(m.course);
    const grp = cosmetics?.courseToGroup.get(m.course.code);
    const groupName = grp ? grp.name : '';
    
    topLayer.append('circle')
      .attr('cx', m.x)
      .attr('cy', m.cy)
      .attr('r', EXAM_MARKER_RADIUS)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke)
      .attr('stroke-width', EXAM_MARKER_STROKE_WIDTH)
      .style('pointer-events', 'auto')
      .attr('class', 'exam-dot')
      .attr('data-kind', 'exam-dot')
      .attr('data-layer', 'exams')
      .attr('data-course', m.course.code)
      .attr('data-group', groupName);
  });

  reexamMarkers.forEach((m) => {
    const colors = getCourseColors(m.course);
    const grp = cosmetics?.courseToGroup.get(m.course.code);
    const groupName = grp ? grp.name : '';
    
    topLayer.append('circle')
      .attr('cx', m.x)
      .attr('cy', m.cy)
      .attr('r', REEXAM_MARKER_RADIUS)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke)
      .attr('stroke-width', REEXAM_MARKER_STROKE_WIDTH)
      .attr('stroke-dasharray', '2 2')
      .style('pointer-events', 'auto')
      .attr('class', 'reexam-dot')
      .attr('data-kind', 'reexam-dot')
      .attr('data-layer', 'reexams')
      .attr('data-course', m.course.code)
      .attr('data-group', groupName);
  });

  // SVG accessibility: title + desc referenced by aria-labelledby on the
  // root <svg>. Re-appended each render so they stay in sync with the
  // current program / data after `selectAll('*').remove()`.
  const titleText = programName && programCode
    ? `${programName} (${programCode}) — ${tr[language].year} 1${numYears > 1 ? `–${numYears}` : ''}`
    : `${tr[language].year} 1${numYears > 1 ? `–${numYears}` : ''}`;
  const descText = `${individualCourses.length} ${language === 'en' ? 'courses' : 'kurser'}, ${optionGroups.length} ${language === 'en' ? 'option groups' : 'kursgrupper'}, ${allArrows.length} ${language === 'en' ? 'prerequisite arrows' : 'förkunskapspilar'}.`;
  svg.insert('title', ':first-child').attr('id', 'chart-title').text(titleText);
  svg.insert('desc', 'title + *').attr('id', 'chart-desc').text(descText);

  // Build the per-render tooltip cache and dispatch context. The delegated
  // mouseover/click handler (installed once, see effect below) reads these
  // refs to look up tooltip HTML and resolve clicked elements back to their
  // Course / OptionGroup objects. Building once per render means hover never
  // recomputes the same string, and we get a single place to escape user
  // strings (also closes the latent tooltip-XSS in REVIEW.md §3.4).
  const tooltipCache = new Map<string, string>();
  const coursesByCode = new Map<string, Course>();
  const optionGroupsByName = new Map<string, OptionGroup>();
  courses.forEach(c => {
    if (isCourse(c)) coursesByCode.set((c as Course).code, c as Course);
    else if (isOptionGroup(c)) optionGroupsByName.set((c as OptionGroup).name, c as OptionGroup);
  });
  // Reuse the map built up at the top of the render; no need to walk
  // individualCourses a second time.
  const individualCoursesByCode = individualCoursesByCodeMap;

  academicPeriods.forEach(p => {
    tooltipCache.set(`study-period|${p.id}`, buildStudyPeriodTooltip(language, p.id));
    tooltipCache.set(`exam-period|${p.id}`, buildExamPeriodTooltip(language, p.id));
    tooltipCache.set(`reexam-period|${p.id}`, buildReexamPeriodTooltip(language, p.id));
  });
  // One tooltip per item — content is the same for every bar / connector of
  // the same course or option group.
  individualCourses.forEach(c => {
    tooltipCache.set(`course|${c.code}`, buildCourseTooltip(c, language, { individualCourses }));
    tooltipCache.set(`exam-dot|${c.code}`, buildExamDotTooltip(language, c.code));
    tooltipCache.set(`reexam-dot|${c.code}`, buildReexamDotTooltip(language, c.code));
  });
  optionGroups.forEach(og => {
    tooltipCache.set(`option-group|${og.name}`, buildOptionGroupTooltip(og, language, { courseByCode: coursesByCode }));
  });

  tooltipCacheRef.current = tooltipCache;
  dispatchCtxRef.current = {
    coursesByCode,
    optionGroupsByName,
    individualCoursesByCode,
    selectedOptionPerGroup,
  };

  // `layers` and `focusYear` are intentionally NOT in this dep list. Their
  // visual effects (visibility toggles, year-label highlight) are applied by
  // the dedicated post-render effects below, which keeps a layer toggle or
  // year-focus click from triggering a full ~3 000-call SVG rebuild.
  }, [courses, numYears, language, selectedOptionPerGroup, selectedRoundPerCourse, cosmetics, programCode, programName, studyplanUrl, getCourseColors]);

  // One-time setup: tooltip element + delegated mouseover/move/out/click on
  // the SVG. Replaces the per-element listeners that used to be attached on
  // every redraw (~hundreds of allocations per render). The handler walks
  // `closest('[data-kind]')` from the event target, looks up the pre-built
  // tooltip in tooltipCacheRef, and dispatches clicks via the current data
  // in dispatchCtxRef. We bind to the SVG specifically (not the wrapping
  // container `<div>`) so clicks on Legend / InfoPanel / OptionGroupModal —
  // which are siblings under the same container — don't fall into the
  // empty-space branch and clear focus.
  useEffect(() => {
    const containerEl = containerRef.current;
    const svgEl = svgRef.current;
    if (!containerEl || !svgEl) return;

    // Create the tooltip div once and reuse it.
    const container = select(containerEl);
    container.selectAll('.pv-tooltip').remove();
    const tooltip = container.append('div')
      .attr('class', 'pv-tooltip')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('display', 'none')
      .style('background', `rgba(${(kthColors.KthMarine?.RGB || [0, 0, 97]).join(',')}, 0.8)`)
      .style('color', '#fff')
      .style('padding', '6px 8px')
      .style('border-radius', '4px')
      .style('font-size', '12px')
      .style('z-index', '1001');
    tooltipElRef.current = tooltip.node() as HTMLDivElement;

    const hideTooltip = () => {
      tooltip.style('display', 'none');
      currentTooltipKeyRef.current = null;
    };

    // Position the tooltip near (anchorX, anchorY) in page coordinates,
    // offset by (gapX, gapY). If the resulting placement would overflow
    // the viewport on the right or bottom, flip to the opposite side of
    // the anchor so the tooltip stays fully visible. Display must already
    // be 'block' before calling — getBoundingClientRect needs real layout.
    const placeTooltip = (anchorX: number, anchorY: number, gapX: number, gapY: number) => {
      const node = tooltipElRef.current;
      if (!node) return;
      let left = anchorX + gapX;
      let top = anchorY + gapY;
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      const r = node.getBoundingClientRect();
      const viewportPad = 8;
      if (r.right > window.innerWidth - viewportPad) {
        left = anchorX - r.width - gapX;
        const minLeft = window.scrollX + viewportPad;
        if (left < minLeft) left = minLeft;
        node.style.left = `${left}px`;
      }
      if (r.bottom > window.innerHeight - viewportPad) {
        top = anchorY - r.height - gapY;
        const minTop = window.scrollY + viewportPad;
        if (top < minTop) top = minTop;
        node.style.top = `${top}px`;
      }
    };

    // Resolve the cache key for a given kind-element. Bars and connectors
    // resolve to either a course or an option-group entry, depending on
    // whether the data-course is an option-group's synthetic id.
    const cacheKeyFor = (el: Element): string | null => {
      const kind = el.getAttribute('data-kind');
      if (!kind) return null;
      if (kind === 'study-period' || kind === 'exam-period' || kind === 'reexam-period') {
        return `${kind}|${el.getAttribute('data-period') ?? ''}`;
      }
      if (kind === 'exam-dot' || kind === 'reexam-dot') {
        return `${kind}|${el.getAttribute('data-course') ?? ''}`;
      }
      if (kind === 'bar' || kind === 'connector') {
        const id = el.getAttribute('data-course') ?? '';
        if (id.startsWith('optionGroup-')) {
          return `option-group|${id.slice('optionGroup-'.length)}`;
        }
        return `course|${id}`;
      }
      return null;
    };

    const onMouseOver = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const el = target?.closest('[data-kind]') ?? null;
      if (!el) {
        hideTooltip();
        return;
      }
      const key = cacheKeyFor(el);
      if (!key) {
        hideTooltip();
        return;
      }
      if (key === currentTooltipKeyRef.current) return; // already showing this
      const html = tooltipCacheRef.current.get(key);
      if (!html) return;
      tooltip.html(html).style('display', 'block');
      currentTooltipKeyRef.current = key;
    };

    const onMouseMove = (event: MouseEvent) => {
      placeTooltip(event.pageX, event.pageY, 50, 50);
    };

    const onMouseOut = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const related = event.relatedTarget as Element | null;
      const fromKind = target?.closest('[data-kind]') ?? null;
      const toKind = related?.closest('[data-kind]') ?? null;
      // Still inside the same kind-element — keep the tooltip up.
      if (fromKind && fromKind === toKind) return;
      hideTooltip();
    };

    // Extracted so click and keyboard activation share the same logic.
    const dispatchActivation = (el: Element | null) => {
      const ctx = dispatchCtxRef.current;
      if (!el) {
        // Empty-space activation clears focus / info / year.
        setFocusCourse(null);
        setSelectedInfo(null);
        setFocusYear(null);
        return;
      }
      const kind = el.getAttribute('data-kind');
      if (kind === 'year-label') {
        const y = Number(el.getAttribute('data-year'));
        if (Number.isFinite(y)) setFocusYear(prev => (prev === y ? null : y));
        return;
      }
      if (kind === 'bar' || kind === 'connector') {
        const id = el.getAttribute('data-course') ?? '';
        const periodId = (el.getAttribute('data-period') ?? '') as Period['id'];
        const yearAttr = Number(el.getAttribute('data-year'));
        if (id.startsWith('optionGroup-')) {
          const og = ctx.optionGroupsByName.get(id.slice('optionGroup-'.length));
          if (og) {
            setSelectedOptionGroup(og);
            setHighlightedOptionCodes([]);
          }
          return;
        }
        const course = ctx.coursesByCode.get(id);
        if (!course) return;
        // Course shown as the chosen option of an option group — open the
        // owning option-group modal instead of just focusing.
        const owningGroup = Object.entries(ctx.selectedOptionPerGroup).find(
          ([, selectedCodes]) => selectedCodes.includes(course.code)
        )?.[0];
        if (owningGroup) {
          const og = ctx.optionGroupsByName.get(owningGroup);
          if (og) {
            setSelectedOptionGroup(og);
            setHighlightedOptionCodes([]);
            setSelectedInfo(null);
          }
          return;
        }
        // Normal course click: toggle focus + info-panel.
        const credit = course.credits.find(cr => cr.period === periodId && cr.year === yearAttr);
        setFocusCourse(prev => {
          const next = prev === course.code ? null : course.code;
          if (next && credit) {
            setSelectedInfo({ course, credit: { period: credit.period as Period['id'], credits: credit.credits, year: credit.year || course.year } });
          } else {
            setSelectedInfo(null);
          }
          return next;
        });
        return;
      }
      // Other kinds (period rects, exam/reexam dots) have no click action,
      // and clicking them shouldn't clear focus either.
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const el = target?.closest('[data-kind]') ?? null;
      dispatchActivation(el);
    };

    // Keyboard activation: Enter or Space on a focusable element fires the
    // same dispatcher as a click. We intercept the default Space behaviour
    // (page scroll) so screen-reader / keyboard users see the action.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      const target = event.target as Element | null;
      const el = target?.closest('[data-kind]') ?? null;
      if (!el) return;
      // Only activate kinds that have a click action; ignore decorative ones
      // so Space scrolls normally when no actionable element is focused.
      const kind = el.getAttribute('data-kind');
      if (kind !== 'bar' && kind !== 'connector' && kind !== 'year-label') return;
      event.preventDefault();
      dispatchActivation(el);
    };

    // Show the tooltip when a focusable element receives keyboard focus,
    // anchored to the element's bounding box (no mouse coords available).
    const showTooltipForElement = (el: Element) => {
      const key = cacheKeyFor(el);
      if (!key) return;
      const html = tooltipCacheRef.current.get(key);
      if (!html) return;
      const rect = el.getBoundingClientRect();
      const pageX = rect.left + window.scrollX;
      const pageY = rect.bottom + window.scrollY;
      tooltip.html(html).style('display', 'block');
      placeTooltip(pageX, pageY, 0, 8);
      currentTooltipKeyRef.current = key;
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      const el = target?.closest('[data-kind]') ?? null;
      if (el) showTooltipForElement(el);
    };

    const onFocusOut = (event: FocusEvent) => {
      const target = event.target as Element | null;
      const related = event.relatedTarget as Element | null;
      const fromKind = target?.closest('[data-kind]') ?? null;
      const toKind = related?.closest('[data-kind]') ?? null;
      if (fromKind && fromKind === toKind) return;
      hideTooltip();
    };

    svgEl.addEventListener('mouseover', onMouseOver);
    svgEl.addEventListener('mousemove', onMouseMove);
    svgEl.addEventListener('mouseout', onMouseOut);
    svgEl.addEventListener('click', onClick);
    svgEl.addEventListener('keydown', onKeyDown);
    svgEl.addEventListener('focusin', onFocusIn);
    svgEl.addEventListener('focusout', onFocusOut);

    return () => {
      svgEl.removeEventListener('mouseover', onMouseOver);
      svgEl.removeEventListener('mousemove', onMouseMove);
      svgEl.removeEventListener('mouseout', onMouseOut);
      svgEl.removeEventListener('click', onClick);
      svgEl.removeEventListener('keydown', onKeyDown);
      svgEl.removeEventListener('focusin', onFocusIn);
      svgEl.removeEventListener('focusout', onFocusOut);
      tooltip.remove();
      tooltipElRef.current = null;
    };
  }, []);

  // Update element opacities when layers change
  useEffect(() => {
    if (!containerRef.current) return;
    const container = select(containerRef.current);

    // Exams: hide/show completely and adjust pointer-events.
    // Hiding course bars also hides exam markers — markers are anchored to
    // bars, so showing them without their bars looks orphaned.
    const examsVisible = layers.exams && layers.courseBars;
    container.selectAll<SVGCircleElement, unknown>('.exam-dot')
      .interrupt()
      .style('display', examsVisible ? '' : 'none')
      .style('opacity', examsVisible ? '1' : '0.2')
      .style('pointer-events', examsVisible ? 'auto' : 'none');

    // Reexams (same rationale as exams)
    const reexamsVisible = layers.reexams && layers.courseBars;
    container.selectAll<SVGCircleElement, unknown>('.reexam-dot')
      .interrupt()
      .style('display', reexamsVisible ? '' : 'none')
      .style('opacity', reexamsVisible ? '1' : '0.2')
      .style('pointer-events', reexamsVisible ? 'auto' : 'none');

    // Prerequisites - completed (arrows connect bars; hide with bars)
    const prereqCompletedVisible = layers.prereqCompleted && layers.courseBars;
    container.selectAll<SVGPathElement, unknown>('.prereq-path.prereq-completed')
      .interrupt()
      .style('display', prereqCompletedVisible ? '' : 'none')
      .style('opacity', prereqCompletedVisible ? '1' : '0.15')
      .style('pointer-events', prereqCompletedVisible ? 'auto' : 'none');

    // Prerequisites - participation
    const prereqParticipationVisible = layers.prereqParticipation && layers.courseBars;
    container.selectAll<SVGPathElement, unknown>('.prereq-path.prereq-participation')
      .interrupt()
      .style('display', prereqParticipationVisible ? '' : 'none')
      .style('opacity', prereqParticipationVisible ? '1' : '0.15')
      .style('pointer-events', prereqParticipationVisible ? 'auto' : 'none');

    // Study periods (background alternating)
    container.selectAll<SVGRectElement, unknown>('.study-period')
      .interrupt()
      .style('display', layers.studyPeriods ? '' : 'none');

    // Course bars (main course rectangles)
    container.selectAll<SVGRectElement, unknown>('.course-block')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none')
      .style('pointer-events', layers.courseBars ? 'auto' : 'none');

    // Course labels (follow bar visibility)
    container.selectAll('.course-label')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none');

    // Course bar borders
    container.selectAll('.course-bar-border')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none');

    // Course connectors (fills and borders between consecutive bars)
    container.selectAll<SVGPolygonElement, unknown>('.course-connector-fill')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none');
    container.selectAll<SVGPathElement, unknown>('.course-connector-border')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none');

    // Exam periods (blue)
    container.selectAll<SVGRectElement, unknown>('.exam-period-rect')
      .interrupt()
      .style('display', layers.examPeriods ? '' : 'none');

    // Reexam periods (gray)
    container.selectAll<SVGRectElement, unknown>('.reexam-period-rect')
      .interrupt()
      .style('display', layers.reexamPeriods ? '' : 'none');
  }, [layers]);

  // Compose group visibility with the top-level layer flags. Runs after the
  // pure `[layers]` effect above and writes the COMPOSITE display (group AND
  // layer) for every element that has a data-group attribute. Without the
  // composition, this effect would overwrite the first effect's `display:none`
  // and silently re-show elements when their group is visible.
  useEffect(() => {
    if (!containerRef.current || !cosmetics) return;
    const container = select(containerRef.current);

    // Helpers for safe group-name filtering — defined once here and reused
    // for all groups so we don't reallocate closures inside the forEach loop.
    // Using filter functions instead of CSS [data-group="…"] attribute selectors
    // prevents group names with special CSS characters from corrupting the selector.
    const selectByGroup = (cls: string, name: string) =>
      container.selectAll(cls).filter(function() {
        return (this as Element).getAttribute('data-group') === name;
      });

    cosmetics.groups.forEach(group => {
      const isGroupVisible = layers.groups[group.name] !== false;
      const courseDisplay = (isGroupVisible && layers.courseBars) ? '' : 'none';
      const examDisplay = (isGroupVisible && layers.exams && layers.courseBars) ? '' : 'none';
      const reexamDisplay = (isGroupVisible && layers.reexams && layers.courseBars) ? '' : 'none';

      selectByGroup('.course-group', group.name).interrupt().style('display', courseDisplay);
      selectByGroup('.course-connector-fill', group.name).interrupt().style('display', courseDisplay);
      selectByGroup('.course-connector-border', group.name).interrupt().style('display', courseDisplay);
      selectByGroup('.exam-dot', group.name).interrupt().style('display', examDisplay);
      selectByGroup('.reexam-dot', group.name).interrupt().style('display', reexamDisplay);
    });

    // Prereq arrows: composite of (relevant prereq* layer) AND (both endpoint
    // groups visible). The arrow's CSS classes indicate which layer applies.
    container.selectAll<SVGPathElement, unknown>('.prereq-path')
      .each(function() {
        const arrow = select(this);
        const fromGroup = arrow.attr('data-from-group');
        const toGroup = arrow.attr('data-to-group');
        const fromHidden = fromGroup && layers.groups[fromGroup] === false;
        const toHidden = toGroup && layers.groups[toGroup] === false;
        const el = this as Element;
        const isCompleted = el.classList.contains('prereq-completed');
        const isParticipation = el.classList.contains('prereq-participation');
        const layerOn = layers.courseBars && ((isCompleted && layers.prereqCompleted) || (isParticipation && layers.prereqParticipation));
        arrow.style('display', (fromHidden || toHidden || !layerOn) ? 'none' : '');
      });
  }, [layers, cosmetics]);

  // Focus mode: fade out unrelated courses/markers/arrows when a course is selected
  useEffect(() => {
    if (!containerRef.current) return;
    const container = select(containerRef.current);
    if (!focusCourse) {
      // remove focus overrides, restore baseline from layer settings
      container.selectAll('.course-group').style('opacity', null);
      container.selectAll('.course-connector-fill').style('opacity', null);
      container.selectAll('.course-connector-border').style('opacity', null);
      container.selectAll('.exam-dot').style('opacity', null);
      container.selectAll('.reexam-dot').style('opacity', null);
      container.selectAll('.prereq-path').style('opacity', null);
      // Selected-course emphasis (see below). Clearing the inline style falls
      // back to the `fill` / `stroke-width` presentation attributes the render
      // set, so nothing has to remember the original values.
      container.selectAll('.course-bar-border, .course-connector-border').style('stroke-width', null);
      container.selectAll('.course-block, .course-connector-fill').style('fill', null);
      return;
    }

    // Resolve the focused course via the dispatch-context map (built each
    // render — no need to re-derive `filteredCourses` here just to scan it).
    // Fall back to scanning courses if the map isn't populated yet (first
    // tick after mount).
    const filteredCoursesMap = dispatchCtxRef.current.individualCoursesByCode;
    const selected = filteredCoursesMap.get(focusCourse)
      ?? (courses.find(c => isCourse(c) && (c as Course).code === focusCourse) as Course | undefined);
    if (!selected) return;
    const filteredCourses = Array.from(filteredCoursesMap.values());
    const prereqCompleted = (selected.prerequisitesCompleted || selected.prerequisites || []) as string[];
    const prereqParticipation = (selected.prerequisitesParticipation || []) as string[];
    const prereqSet = new Set([...(prereqCompleted || []), ...(prereqParticipation || [])]);
    const dependentSet = new Set(
      filteredCourses.filter(c => {
        const comp = c.prerequisitesCompleted || c.prerequisites || [];
        const part = c.prerequisitesParticipation || [];
        return (comp.includes(selected.code) || part.includes(selected.code));
      }).map(c => c.code)
    );

    container.selectAll<SVGGElement, unknown>('.course-group')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGPolygonElement, unknown>('.course-connector-fill')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGPathElement, unknown>('.course-connector-border')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGCircleElement, unknown>('.exam-dot, .reexam-dot')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGPathElement, unknown>('.prereq-path')
      .style('opacity', function() {
        const from = (this as Element).getAttribute('data-from');
        const to = (this as Element).getAttribute('data-to');
        const keep = (to === focusCourse && !!from && prereqSet.has(from)) || (from === focusCourse && !!to && dependentSet.has(to));
        return keep ? '1' : '0.1';
      });

    // Mark the SELECTED course, not just the related ones.
    //
    // Dimming answers "what is connected to this?" but everything that survives
    // the dim — the course, its prerequisites and its dependents — was drawn at
    // the same opacity, so the one actually clicked was indistinguishable from
    // its neighbours. Two cues, deliberately in this order:
    //
    // 1. A thicker border. This is the primary signal because it works on every
    //    bar, including option groups, whose fill is `url(#option-group-pattern-…)`
    //    rather than a colour.
    // 2. A slightly darker fill, as a secondary cue.
    //
    // `darker(0.25)` is chosen against the label colour, which is always
    // KthMarine #000061 (the `text` field in the palette is vestigial). Measured
    // contrast of label against fill at that setting: 12.98 blue, 11.33 green,
    // 10.38 turquoise, 10.42 brick, 12.98 yellow, and 5.02 for the
    // no-cosmetics-group fill #6298D2 — all above the 4.5:1 WCAG AA floor, with
    // the last being the binding case. `darker(0.6)` would take it to 4.05 and
    // fail, which is why this is a nudge and not a heavy shade.
    const FOCUS_STROKE_WIDTH = '3';
    const FOCUS_FILL_DARKEN = 0.25;

    container.selectAll<SVGElement, unknown>('.course-bar-border')
      .style('stroke-width', function() {
        // The border rect carries no data-course of its own; its parent group does.
        const owner = (this as Element).closest('.course-group')?.getAttribute('data-course');
        return owner === focusCourse ? FOCUS_STROKE_WIDTH : null;
      });

    container.selectAll<SVGPathElement, unknown>('.course-connector-border')
      .style('stroke-width', function() {
        return (this as Element).getAttribute('data-course') === focusCourse ? FOCUS_STROKE_WIDTH : null;
      });

    container.selectAll<SVGElement, unknown>('.course-block, .course-connector-fill')
      .style('fill', function() {
        const el = this as Element;
        if (el.getAttribute('data-course') !== focusCourse) return null;
        // Only darken an actual colour. Option-group bars are filled with a
        // pattern reference, which d3-color cannot parse — those keep the
        // thicker border as their only cue, which is why the border comes first.
        const parsed = d3color(el.getAttribute('fill') ?? '');
        return parsed ? parsed.darker(FOCUS_FILL_DARKEN).formatRgb() : null;
      });
  }, [focusCourse, courses]);

  // Year focus mode: clicking a year label fades other years and all prerequisite arrows
  useEffect(() => {
    if (!containerRef.current) return;
    const container = select(containerRef.current);
    // If a single course is focused, year focus is ignored
    if (focusCourse) return;

    if (!focusYear) {
      container.selectAll('.course-group').style('opacity', null);
      container.selectAll('.course-connector-fill').style('opacity', null);
      container.selectAll('.course-connector-border').style('opacity', null);
      container.selectAll('.exam-dot').style('opacity', null);
      container.selectAll('.reexam-dot').style('opacity', null);
      container.selectAll('.prereq-path').style('opacity', null);
      container.selectAll<SVGTextElement, unknown>('.year-label')
        .style('opacity', null)
        .attr('font-weight', 400);
      return;
    }

    // Helper to check if a course/option group has credits in the focused year
    const itemHasYear = (id: string) => {
      // Check if it's an option group (id starts with optionGroup-)
      if (id.startsWith('optionGroup-')) {
        // Find option group by name
        const ogName = id.substring('optionGroup-'.length);
        const og = courses.filter(isOptionGroup).find(c => (c as OptionGroup).name === ogName) as OptionGroup | undefined;
        return og ? og.year === focusYear : false;
      }
      // Otherwise it's a course code. Resolve through the rendered-course map
      // first: an option picked from a group is drawn in that group's year,
      // which the raw entry in `courses` does not know about, so scanning
      // `courses` would dim a year-3 pick of a course the data files under
      // year 2. Fall back to the raw scan before the map is populated.
      const c = dispatchCtxRef.current.individualCoursesByCode.get(id)
        ?? (courses.find(cc => isCourse(cc) && (cc as Course).code === id) as Course | undefined);
      if (!c) return false;
      return c.credits.some((cr: CourseCredit) => Number(cr.year) === focusYear);
    };

    container.selectAll<SVGGElement, unknown>('.course-group')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && itemHasYear(code);
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGPolygonElement, unknown>('.course-connector-fill')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && itemHasYear(code);
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGPathElement, unknown>('.course-connector-border')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && itemHasYear(code);
        return keep ? '1' : '0.1';
      });

    container.selectAll<SVGCircleElement, unknown>('.exam-dot, .reexam-dot')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && itemHasYear(code);
        return keep ? '1' : '0.1';
      });

    // Fade all prerequisite arrows when focusing a year
    container.selectAll<SVGPathElement, unknown>('.prereq-path')
      .style('opacity', '0.1');

    // Fade year labels not in focus and bold the active one.
    container.selectAll<SVGTextElement, unknown>('.year-label')
      .style('opacity', function() {
        const year = parseInt((this as Element).getAttribute('data-year') || '0');
        return year === focusYear ? '1' : '0.3';
      })
      .attr('font-weight', function() {
        const year = parseInt((this as Element).getAttribute('data-year') || '0');
        return year === focusYear ? 600 : 400;
      });
  }, [focusYear, focusCourse, courses]);

  return (
    <div ref={containerRef}>
      {/* Horizontal-scroll container: when the viewport is narrower than
          `chartMinWidth`, the inner wrapper (and the SVG it pins) overflow
          here and produce a scrollbar instead of cramping the layout.

          `overscrollBehaviorX: contain` matters on touch devices: swiping the
          chart past its left edge otherwise chains the scroll to the page and
          triggers the browser's back-navigation gesture, so a student panning
          back to year 1 can leave the page instead. */}
      <div style={{ overflowX: 'auto', overscrollBehaviorX: 'contain' }}>
        {/* Visualization canvas wrapper so legend anchors to the SVG area only */}
        <div ref={canvasRef} style={{ position: 'relative', minWidth: chartMinWidth }}>
          <svg
            ref={svgRef}
            className="w-full h-full"
            style={{ minHeight: '600px' }}
            role="img"
            aria-labelledby="chart-title chart-desc"
          />

          <Legend
            language={language}
            layers={layers}
            cosmetics={cosmetics}
            toggleLayer={toggleLayer}
            toggleGroup={toggleGroup}
            left={legendLeftIn(canvasWidth)}
          />
        </div>
      </div>

      <InfoPanel
        language={language}
        info={selectedInfo}
        courses={courses}
        onClose={() => { setFocusCourse(null); setSelectedInfo(null); }}
      />

      {/* Program comment below info panel */}
      {programComment && programComment.trim().length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          {programComment}
        </div>
      )}

      {selectedOptionGroup && (
        <OptionGroupModal
          optionGroup={selectedOptionGroup}
          language={language}
          courses={courses}
          getCourseColors={getCourseColors}
          highlightedOptionCodes={highlightedOptionCodes}
          onHighlightedOptionCodesChange={setHighlightedOptionCodes}
          selectedOptionPerGroup={selectedOptionPerGroup}
          selectedRounds={selectedRoundPerCourse}
          onCommitSelection={onSelectionChange}
          onSelectedInfoChange={setSelectedInfo}
          onClose={() => setSelectedOptionGroup(null)}
        />
      )}

    </div>
  );
});

export default TimelineVisualization;