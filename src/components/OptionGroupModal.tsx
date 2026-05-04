'use client';

import React, { useEffect, useRef } from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';
import { getOptionGroupKind, getOptionGroupPickN, getOptionGroupMinCredits } from '@/lib/optionGroupKind';
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
  onSelectedOptionPerGroupChange: (next: Record<string, string[]>) => void;
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
  onSelectedOptionPerGroupChange,
  onSelectedInfoChange,
  onClose,
}: OptionGroupModalProps) {
  const kind = getOptionGroupKind(optionGroup);
  const pickN = getOptionGroupPickN(optionGroup);
  const minCredits = getOptionGroupMinCredits(optionGroup);

  // Modal layout — kept identical to the original inline implementation,
  // with one extra row above the header for the running-total / capacity hint.
  const headerHeight = 95;
  const optionHeight = 50;
  const optionSpacing = 12;
  const padding = 20;

  const numOptions = optionGroup.options.length;
  const contentHeight = headerHeight + (numOptions * optionHeight) + ((numOptions - 1) * optionSpacing);
  const svgHeight = Math.min(contentHeight + padding + padding, 700);
  const svgWidth = 500;

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

  const commit = () => {
    if (highlightedOptionCodes.length > 0) {
      onSelectedOptionPerGroupChange({
        ...selectedOptionPerGroup,
        [optionGroup.name]: highlightedOptionCodes,
      });
    } else {
      const next = { ...selectedOptionPerGroup };
      delete next[optionGroup.name];
      onSelectedOptionPerGroupChange(next);
    }
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
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
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

        {/* Info line */}
        <text x={padding} y={padding + 40} fontSize={12} fill="#666">
          {tr[language].totalCredits}:{' '}
          <tspan fontWeight={600}>{optionGroup.totalCredits}</tspan>
        </text>

        {/* Rule banner — only for minCredits and multi-pickN groups */}
        {ruleBanner && (
          <text x={padding} y={padding + 60} fontSize={12} fontWeight={600} fill={kthColors.KthBlue?.HEX || '#004791'}>
            {ruleBanner}
          </text>
        )}

        {/* Divider line */}
        <line x1={padding} y1={padding + 75} x2={svgWidth - padding} y2={padding + 75} stroke="#e5e7eb" strokeWidth={1} />

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
          const totalCredits = optionCourse.credits.reduce((sum, c) => sum + c.credits, 0);
          const isSelected = highlightedOptionCodes.includes(optionCode);

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
              aria-label={`${optionCode} ${optionName}, ${totalCredits} ${tr[language].credits}`}
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
                y={barY + optionHeight / 2}
                fontSize={11}
                fontWeight={600}
                fill={kthColors.KthMarine?.HEX || '#000061'}
                dominantBaseline="central"
              >
                {optionCode} {optionName}, {totalCredits} {tr[language].credits}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
