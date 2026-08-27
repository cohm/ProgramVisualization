'use client';

import React, { useEffect, useRef, useState } from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';
import { getOptionGroupKind, getOptionGroupPickN, getOptionGroupMinCredits } from '@/lib/optionGroupKind';
import { creditsForRound, formatPeriods, hasRounds, pickRound, roundLabel } from '@/lib/courseRounds';
import type { Course, OptionGroup, SelectedInfo } from '@/types/course';

const isCourse = (item: Course | OptionGroup): item is Course =>
  'code' in item && !('type' in item);

interface OptionGroupModalProps {
  optionGroup: OptionGroup;
  language: Lang;
  courses: (Course | OptionGroup)[];
  getCourseColors: (course: Course) => { fill: string; stroke: string; text: string };
  highlightedOptionCodes: string[];
  onHighlightedOptionCodesChange: (codes: string[]) => void;
  selectedOptionPerGroup: Record<string, string[]>;
  /**
   * Chosen offering per course code, for courses KTH gives several times a
   * year. Absent entries mean "whichever round matches this box".
   */
  selectedRounds: Record<string, string>;
  /**
   * Commit the whole selection at once: which courses are chosen, and which
   * offering each multi-round course uses.
   *
   * Deliberately ONE callback rather than two. Both halves live in the same
   * `og` URL parameter, so writing them separately meant the second write
   * reading a stale snapshot of the first — and worse, choosing an offering
   * before ticking the course wrote a round for a course in no group at all,
   * which serialised to an empty `og` and silently discarded the choice.
   */
  onCommitSelection: (
    groups: Record<string, string[]>,
    rounds: Record<string, string>,
  ) => void;
  onSelectedInfoChange: (info: SelectedInfo | null) => void;
  onClose: () => void;
}

export default function OptionGroupModal({
  optionGroup,
  language,
  courses,
  getCourseColors,
  highlightedOptionCodes,
  onHighlightedOptionCodesChange,
  selectedOptionPerGroup,
  selectedRounds,
  onCommitSelection,
  onSelectedInfoChange,
  onClose,
}: OptionGroupModalProps) {
  const kind = getOptionGroupKind(optionGroup);
  const pickN = getOptionGroupPickN(optionGroup);
  const minCredits = getOptionGroupMinCredits(optionGroup);

  // Offering choices are a DRAFT until the user confirms, exactly like the
  // course ticks themselves. The modal is mounted per opening, so seeding from
  // the committed value here also resets the draft each time it opens — and
  // Avbryt discards it by simply unmounting.
  const [draftRounds, setDraftRounds] = useState<Record<string, string>>(selectedRounds);

  // Modal layout — kept identical to the original inline implementation,
  // with one extra row above the header for the running-total / capacity hint.
  // The group's own note, wrapped to the modal width. It sits between the divider
  // and the first option because it usually qualifies what the list means — a
  // note like "även andra kan väljas" tells the reader the options are examples,
  // which changes how every row below should be read.
  const comment = language === 'en'
    ? (optionGroup.commentEn || optionGroup.comment)
    : optionGroup.comment;
  // SVG <text> does not wrap, so the note is split into lines by character count.
  // ~11 px italic at 620 px wide fits roughly 100 characters.
  const commentLines = (() => {
    if (!comment) return [];
    const MAX = 100;
    const out: string[] = [];
    let line = '';
    for (const word of comment.split(/\s+/)) {
      if (line && (line + ' ' + word).length > MAX) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
    return out;
  })();
  const commentHeight = commentLines.length * 15;

  const headerHeight = 95 + commentHeight;
  const optionHeight = 50;
  const optionSpacing = 12;
  const padding = 20;

  const numOptions = optionGroup.options.length;
  const contentHeight = headerHeight + (numOptions * optionHeight) + ((numOptions - 1) * optionSpacing);
  // The SVG is as tall as its content; a scrolling wrapper caps what is VISIBLE.
  // It used to be `Math.min(..., 700)`, which simply cut the drawing off — the P4
  // elective box has 13 options and its last row sat 224 px below the boundary
  // with no way to reach it, because an SVG does not scroll its own overflow.
  const svgHeight = contentHeight + padding + padding;
  // Leave room for the page around the dialog rather than filling the viewport.
  const MAX_VISIBLE_HEIGHT = 700;
  // 620 rather than 500: an option row carries a code, a course title, a credit
  // figure and often an eligibility note, and at 500 px the long titles were
  // colliding with the note. Widening is the honest fix — truncating a course
  // name to fit is a last resort, not a layout strategy.
  const svgWidth = 620;

  // Per-option course lookup so the rule banner can compute a running total
  // without re-scanning `courses` for every code.
  const optionCourseByCode = new Map<string, Course>();
  optionGroup.options.forEach(code => {
    const c = courses.find(x => isCourse(x) && (x as Course).code === code) as Course | undefined;
    if (c) optionCourseByCode.set(code, c);
  });
  const creditsForCode = (code: string) => {
    const c = optionCourseByCode.get(code);
    if (!c) return 0;
    return c.credits.reduce((sum, cr) => sum + cr.credits, 0);
  };
  const selectedSum = highlightedOptionCodes.reduce((sum, code) => sum + creditsForCode(code), 0);

  /**
   * Credits the student actually earns from this box.
   *
   * NOT `optionGroup.totalCredits`, which is the size of the SLOT — the sum of
   * the bar's periods, an envelope over options that may have different shapes,
   * and an invariant the validator enforces so the bar's geometry stays
   * consistent. For every group whose options share a period footprint the two
   * numbers coincide, which is why this never mattered before.
   *
   * CMATD's "Kurs för valt masterprogram" is the first where they diverge: its
   * four options are 6 hp each but sit in different periods (MG1024 in P2, the
   * rest in P3), so the envelope spans P2+P3 and sums to 12 — while a student
   * picks exactly one and earns 6. The header read "Totalt: 12", which is not a
   * quantity anyone takes.
   *
   * So it is computed from the options: pickN × one option's size, shown as a
   * range when the options differ in size.
   */
  const takeCreditsLabel = (() => {
    const sizes = optionGroup.options
      .map(code => optionCourseByCode.get(code))
      .filter((c): c is Course => !!c)
      .map(c => c.credits.reduce((a, cr) => a + cr.credits, 0))
      .filter(n => n > 0);
    const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
    if (sizes.length === 0) return fmt(optionGroup.totalCredits);
    if (kind === 'minCredits') return `${fmt(minCredits)}+`;
    const lo = Math.min(...sizes) * pickN;
    const hi = Math.max(...sizes) * pickN;
    return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  })();

  // Banner text: "X / Y hp" for minCredits; "N / pickN selected" for pickN > 1.
  // Pure pickN: 1 groups (the historical default) get no banner — they
  // visually behave exactly as before.
  const ruleBanner = (() => {
    if (kind === 'minCredits') {
      const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
      return `${fmt(selectedSum)} / ${fmt(minCredits)} ${tr[language].credits}`;
    }
    if (pickN > 1) {
      return `${highlightedOptionCodes.length} / ${pickN}`;
    }
    return null;
  })();

  // Rough character budget for the option label. SVG <text> does not wrap or clip,
  // so a long title simply runs past the box — "Praktiskt jämställdhets- och
  // mångfaldsarbete" (MH1023) overflowed. The label shares the row with the code,
  // the credits and, when present, a right-aligned eligibility note, so the
  // budget shrinks when that note is there.
  //
  // Measured against the 620 px modal at font-size 11, weight 600: ~5.9 px per
  // character for this typeface, so ~98 characters fit the full row. Truncating
  // by character count rather than measuring keeps this a pure function — the
  // modal renders inside an SVG built before layout, so getComputedTextLength is
  // not available here.
  const truncateName = (name: string, code: string, note: string, periods = ''): string => {
    const CHARS_PER_ROW = 98;
    const budget = CHARS_PER_ROW - code.length - 12
      - (note ? note.length + 3 : 0)
      - (periods ? periods.length + 1 : 0);
    if (name.length <= budget) return name;
    return `${name.slice(0, Math.max(8, budget - 1)).trimEnd()}…`;
  };

  /**
   * "(P3: 3 hp, P4: 4 hp)" — where the option lands if chosen.
   *
   * Without this the modal said what a course is and how big it is but not
   * *when*, so choosing between two otherwise similar options was a guess: the
   * chart only revealed the answer after the box had been closed.
   *
   * For a multi-round course this shows the round that would actually be used —
   * the one matching this box, or the user's override — not the union of every
   * offering, which is the whole point of the round model.
   */
  const periodSummary = (course: Course): string =>
    formatPeriods(
      creditsForRound(course, pickRound(course, optionGroup, draftRounds[course.code])),
      tr[language].credits,
    );

  // "behörighetsgivande för TTFYM (TFYA/TFYB/TFYG)" — empty for an option the
  // study plan does not mention.
  const eligibilityLabel = (code: string): string => {
    const masters = optionGroup.qualifiesFor?.[code];
    if (!masters?.length) return '';
    const label = (m: typeof masters[number]) => {
      const spar = m.tracks?.length ? m.tracks.join('/') : m.track;
      return spar ? `${m.code} (${spar})` : m.code;
    };
    // A behörighetsgivande course is a hard eligibility condition; a
    // rekommenderad one is advice. The study plans state both and saying
    // "qualifies for" of a mere recommendation overstates it, so they are kept
    // apart here exactly as in the chart tooltip.
    const required = masters.filter(m => m.required !== false).map(label);
    const recommended = masters.filter(m => m.required === false).map(label);
    // Short forms here, full wording in the chart tooltip: this note shares a row
    // with the course title, and "behörighetsgivande för" alone is 22 characters.
    return [
      required.length ? `${tr[language].qualifiesForShort} ${required.join(', ')}` : '',
      recommended.length ? `${tr[language].recommendedForShort} ${recommended.join(', ')}` : '',
    ].filter(Boolean).join('; ');
  };

  const commit = () => {
    // A course is taken once, but it can be offered by several boxes — CTMAT
    // lists SF1677/SF1678/SF1691 both in the year-2 villkorligt valfria group
    // and in the year-3 elective boxes. Selections are therefore mutually
    // exclusive across groups: picking a course here releases it from whatever
    // other box held it, so it has exactly one place in the chart, which is the
    // box the user last clicked. Emptied groups are dropped rather than left as
    // an empty array, matching how this group is cleared below.
    const next: Record<string, string[]> = {};
    Object.entries(selectedOptionPerGroup).forEach(([name, codes]) => {
      if (name === optionGroup.name) return;
      const kept = codes.filter(code => !highlightedOptionCodes.includes(code));
      if (kept.length > 0) next[name] = kept;
    });
    if (highlightedOptionCodes.length > 0) {
      next[optionGroup.name] = highlightedOptionCodes;
    }
    // Keep an offering choice only for a course that is actually selected
    // somewhere, so an abandoned pick cannot resurface later with a stale round.
    const stillSelected = new Set(Object.values(next).flat());
    const rounds: Record<string, string> = {};
    for (const [code, roundId] of Object.entries(draftRounds)) {
      if (stillSelected.has(code)) rounds[code] = roundId;
    }
    onCommitSelection(next, rounds);
    onClose();
    onHighlightedOptionCodesChange([]);
  };

  const cancel = () => {
    onClose();
    onHighlightedOptionCodesChange([]);
  };

  // Focus trap: Tab/Shift-Tab cycle inside the modal, Escape closes,
  // and on close focus returns to whatever element opened the modal
  // (typically the option-group bar in the chart).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    const root = rootRef.current;
    if (!root) return;

    const queryFocusables = () =>
      Array.from(root.querySelectorAll<SVGElement | HTMLElement>('[tabindex="0"]'));

    // Defer initial focus so React has rendered the SVG children.
    const raf = requestAnimationFrame(() => {
      const focusables = queryFocusables();
      if (focusables.length > 0) (focusables[0] as HTMLElement).focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = queryFocusables();
        if (focusables.length === 0) return;
        const first = focusables[0] as HTMLElement;
        const last = focusables[focusables.length - 1] as HTMLElement;
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !root.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener('keydown', onKeyDown);
      const prev = previouslyFocusedRef.current as HTMLElement | SVGElement | null;
      if (prev && typeof (prev as HTMLElement).focus === 'function') {
        try { (prev as HTMLElement).focus({ preventScroll: true }); } catch { /* element unmounted */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Activate (Enter/Space) for SVG controls. SVG elements aren't natively
  // activated by keyboard; handlers must call the click action explicitly.
  const onActivateKey = (handler: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Figtree, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans',
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={language === 'en' ? (optionGroup.nameEn || optionGroup.name) : optionGroup.name}
    >
      {/*
        Scroll container. The card styling lives here rather than on the <svg> so
        the rounded corners and shadow stay put while the drawing scrolls inside.
        `maxHeight` is what makes a long option list reachable at all.
      */}
      <div
        style={{
          maxHeight: MAX_VISIBLE_HEIGHT,
          overflowY: 'auto',
          overflowX: 'hidden',
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
          pointerEvents: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{
          backgroundColor: 'white',
          display: 'block',
          pointerEvents: 'auto',
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Click on empty SVG area deselects all currently highlighted options.
          if ((e.target as SVGElement).tagName === 'svg') {
            onHighlightedOptionCodesChange([]);
            onSelectedInfoChange(null);
          }
        }}
      >
        {/* Title */}
        <text x={padding} y={padding + 20} fontSize={18} fontWeight={600} fill="#004791">
          {language === 'en' ? (optionGroup.nameEn || optionGroup.name) : optionGroup.name}
        </text>

        {/* Info line — what the STUDENT takes, not the size of the slot */}
        <text x={padding} y={padding + 40} fontSize={12} fill="#666">
          {tr[language].totalCredits}:{' '}
          <tspan fontWeight={600}>{takeCreditsLabel}</tspan>
        </text>

        {/* Rule banner — only for minCredits and multi-pickN groups */}
        {ruleBanner && (
          <text x={padding} y={padding + 60} fontSize={12} fontWeight={600} fill={kthColors.KthBlue?.HEX || '#004791'}>
            {ruleBanner}
          </text>
        )}

        {/* Divider line */}
        <line x1={padding} y1={padding + 75} x2={svgWidth - padding} y2={padding + 75} stroke="#e5e7eb" strokeWidth={1} />

        {/* The group's free-text note, above the options it qualifies */}
        {commentLines.map((line, i) => (
          <text
            key={i}
            x={padding}
            y={padding + 92 + i * 15}
            fontSize={11}
            fontStyle="italic"
            fill="#555"
          >
            {line}
          </text>
        ))}

        {/* Choose button */}
        <rect
          x={svgWidth - padding - 160}
          y={padding + 6}
          width={70}
          height={32}
          fill={(kthColors.KthBlue?.HEX || '#004791')}
          rx={4}
          ry={4}
          style={{ cursor: 'pointer' }}
          onClick={commit}
          tabIndex={0}
          role="button"
          aria-label={tr[language].choose}
          onKeyDown={onActivateKey(commit)}
        />
        <text
          x={svgWidth - padding - 125}
          y={padding + 22}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={13}
          fontWeight={600}
          fill="#FFFFFF"
          style={{ cursor: 'pointer', pointerEvents: 'none' }}
        >
          {tr[language].choose}
        </text>

        {/* Cancel button */}
        <rect
          x={svgWidth - padding - 80}
          y={padding + 6}
          width={70}
          height={32}
          fill="#e5e7eb"
          rx={4}
          ry={4}
          style={{ cursor: 'pointer' }}
          onClick={cancel}
          tabIndex={0}
          role="button"
          aria-label={tr[language].cancel}
          onKeyDown={onActivateKey(cancel)}
        />
        <text
          x={svgWidth - padding - 45}
          y={padding + 22}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={13}
          fontWeight={600}
          fill="#4B5563"
          style={{ cursor: 'pointer', pointerEvents: 'none' }}
        >
          {tr[language].cancel}
        </text>

        {/* Course option bars */}
        {optionGroup.options.map((optionCode, index) => {
          const optionCourse = optionCourseByCode.get(optionCode);
          if (!optionCourse) return null;

          const barY = padding + headerHeight + index * (optionHeight + optionSpacing);
          const barHeight = optionHeight;
          const barWidth = svgWidth - 2 * padding;
          const barX = padding;
          const colors = getCourseColors(optionCourse);
          const optionName = language === 'en' ? (optionCourse.nameEn || optionCourse.name) : optionCourse.name;
          const isSelected = highlightedOptionCodes.includes(optionCode);

          // A multi-round course is 1.5 hp however you take it, so its size
          // comes from the round in force — never from summing the offerings,
          // which is what produced the 6 hp DD1380 bar.
          const rounds = optionCourse.rounds ?? [];
          const multiRound = hasRounds(optionCourse);
          const activeRound = pickRound(optionCourse, optionGroup, draftRounds[optionCode]);
          const totalCredits = creditsForRound(optionCourse, activeRound)
            .reduce((sum, c) => sum + c.credits, 0);
          // Two lines inside the existing 50 px row rather than a taller row:
          // the label rides higher and the offering chips sit under it.
          const labelY = multiRound ? barY + 17 : barY + optionHeight / 2;

          const toggle = () => {
            if (isSelected) {
              const next = highlightedOptionCodes.filter(c => c !== optionCode);
              onHighlightedOptionCodesChange(next);
              onSelectedInfoChange(null);
            } else {
              // For pickN groups, enforce the cap by dropping the oldest
              // selection (FIFO). For minCredits there is no cap.
              let next = [...highlightedOptionCodes, optionCode];
              if (kind === 'pickN' && next.length > pickN) {
                next = next.slice(next.length - pickN);
              }
              onHighlightedOptionCodesChange(next);
              onSelectedInfoChange({
                course: optionCourse,
                credit: {
                  period: optionCourse.credits[0]?.period || 'P1',
                  credits: totalCredits,
                  year: optionCourse.year,
                },
              });
            }
          };

          return (
            <g
              key={index}
              style={{ cursor: 'pointer' }}
              onClick={toggle}
              tabIndex={0}
              role="button"
              aria-pressed={isSelected}
              aria-label={`${optionCode} ${optionName}, ${totalCredits} ${tr[language].credits} ${periodSummary(optionCourse)}`.trim()}
              onKeyDown={onActivateKey(toggle)}
            >
              <rect
                x={barX}
                y={barY}
                width={barWidth}
                height={barHeight}
                fill={colors.fill}
                stroke={isSelected ? '#FFD700' : colors.stroke}
                strokeWidth={isSelected ? 3 : 1.5}
                rx={3}
                ry={3}
              />
              <text
                x={barX + 6}
                y={labelY}
                fontSize={11}
                fontWeight={600}
                fill={kthColors.KthMarine?.HEX || '#000061'}
                dominantBaseline="central"
              >
                {optionCode} {truncateName(optionName, optionCode, eligibilityLabel(optionCode), periodSummary(optionCourse))}, {totalCredits} {tr[language].credits}
                {periodSummary(optionCourse) && (
                  <tspan fill="#6b7280" fontWeight={400}>{' '}{periodSummary(optionCourse)}</tspan>
                )}
              </text>
              {/*
                Offering picker, for the handful of courses KTH gives more than
                once a läsår. The chip matching this box is preselected, so the
                common case needs no interaction; changing it moves the course to
                another offering in the chart.
              */}
              {multiRound && (
                <g>
                  <text
                    x={barX + 6}
                    y={barY + 36}
                    fontSize={9}
                    fill="#6b7280"
                    dominantBaseline="central"
                  >
                    {tr[language].offering}:
                  </text>
                  {rounds.map((r, ri) => {
                    const chipText = roundLabel(r, rounds);
                    // Chips are laid out by character count rather than measured:
                    // the modal's SVG is built before layout, so there is no
                    // getComputedTextLength here (same constraint as the row labels).
                    const chipW = Math.max(26, 10 + chipText.length * 5.4);
                    const chipX = barX + 6 + 74 + ri * (chipW + 4);
                    const on = activeRound?.id === r.id;
                    const choose = () =>
                      setDraftRounds(prev => ({ ...prev, [optionCode]: r.id }));
                    return (
                      <g
                        key={r.id}
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => {
                          // Must not bubble: the row's own click toggles course
                          // selection, and picking an offering is not picking
                          // the course.
                          e.stopPropagation();
                          choose();
                        }}
                        tabIndex={0}
                        role="radio"
                        aria-checked={on}
                        aria-label={`${optionCode} ${tr[language].offering} ${chipText}`}
                        onKeyDown={onActivateKey(choose)}
                      >
                        <rect
                          x={chipX}
                          y={barY + 27}
                          width={chipW}
                          height={17}
                          rx={8}
                          ry={8}
                          fill={on ? (kthColors.KthBlue?.HEX || '#004791') : 'rgba(255,255,255,0.75)'}
                          stroke={on ? (kthColors.KthBlue?.HEX || '#004791') : '#9ca3af'}
                          strokeWidth={1}
                        />
                        <text
                          x={chipX + chipW / 2}
                          y={barY + 36}
                          fontSize={9}
                          fontWeight={on ? 700 : 400}
                          textAnchor="middle"
                          fill={on ? '#ffffff' : '#4b5563'}
                          dominantBaseline="central"
                          style={{ pointerEvents: 'none' }}
                        >
                          {chipText}
                        </text>
                      </g>
                    );
                  })}
                </g>
              )}
              {/*
                The master programmes this option qualifies for, per the study
                plan. This is the reason most conditionally-elective courses are
                offered at all, so it belongs where the choice is actually made —
                right-aligned so it cannot collide with a long course name.
              */}
              {eligibilityLabel(optionCode) && (
                <text
                  x={barX + barWidth - 6}
                  y={labelY}
                  fontSize={10}
                  fontStyle="italic"
                  textAnchor="end"
                  fill={kthColors.KthMarine?.HEX || '#000061'}
                  dominantBaseline="central"
                >
                  {eligibilityLabel(optionCode)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}
