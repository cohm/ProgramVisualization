'use client';

import React from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';
import type { Course, OptionGroup, SelectedInfo } from '@/types/course';

const isCourse = (item: Course | OptionGroup): item is Course =>
  'code' in item && !('type' in item);

interface OptionGroupModalProps {
  optionGroup: OptionGroup;
  language: Lang;
  courses: (Course | OptionGroup)[];
  getCourseColors: (course: Course) => { fill: string; stroke: string; text: string };
  highlightedOptionCode: string | null;
  onHighlightedOptionCodeChange: (code: string | null) => void;
  selectedOptionPerGroup: Record<string, string>;
  onSelectedOptionPerGroupChange: (next: Record<string, string>) => void;
  onSelectedInfoChange: (info: SelectedInfo | null) => void;
  onClose: () => void;
}

export default function OptionGroupModal({
  optionGroup,
  language,
  courses,
  getCourseColors,
  highlightedOptionCode,
  onHighlightedOptionCodeChange,
  selectedOptionPerGroup,
  onSelectedOptionPerGroupChange,
  onSelectedInfoChange,
  onClose,
}: OptionGroupModalProps) {
  // Modal layout — kept identical to the original inline implementation.
  const headerHeight = 75;
  const optionHeight = 50;
  const optionSpacing = 12;
  const padding = 20;

  const numOptions = optionGroup.options.length;
  const contentHeight = headerHeight + (numOptions * optionHeight) + ((numOptions - 1) * optionSpacing);
  const svgHeight = Math.min(contentHeight + padding + padding, 700);
  const svgWidth = 500;

  const commit = () => {
    if (highlightedOptionCode) {
      onSelectedOptionPerGroupChange({
        ...selectedOptionPerGroup,
        [optionGroup.name]: highlightedOptionCode,
      });
    } else {
      const next = { ...selectedOptionPerGroup };
      delete next[optionGroup.name];
      onSelectedOptionPerGroupChange(next);
    }
    onClose();
    onHighlightedOptionCodeChange(null);
  };

  const cancel = () => {
    onClose();
    onHighlightedOptionCodeChange(null);
  };

  return (
    <div
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
          // Click on empty SVG area deselects current option.
          if ((e.target as SVGElement).tagName === 'svg') {
            onHighlightedOptionCodeChange(null);
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
          {language === 'en' ? 'Total credits:' : 'Totalt poäng:'}{' '}
          <tspan fontWeight={600}>{optionGroup.totalCredits}</tspan>
        </text>

        {/* Divider line */}
        <line x1={padding} y1={padding + 55} x2={svgWidth - padding} y2={padding + 55} stroke="#e5e7eb" strokeWidth={1} />

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
          {language === 'en' ? 'Choose' : 'Välj'}
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
          {language === 'en' ? 'Cancel' : 'Avbryt'}
        </text>

        {/* Course option bars */}
        {optionGroup.options.map((optionCode, index) => {
          const optionCourse = courses.find(c => isCourse(c) && (c as Course).code === optionCode) as Course | undefined;
          if (!optionCourse) return null;

          const barY = padding + headerHeight + index * (optionHeight + optionSpacing);
          const barHeight = optionHeight;
          const barWidth = svgWidth - 2 * padding;
          const barX = padding;
          const colors = getCourseColors(optionCourse);
          const optionName = language === 'en' ? (optionCourse.nameEn || optionCourse.name) : optionCourse.name;
          const totalCredits = optionCourse.credits.reduce((sum, c) => sum + c.credits, 0);

          return (
            <g
              key={index}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                if (highlightedOptionCode === optionCode) {
                  onHighlightedOptionCodeChange(null);
                  onSelectedInfoChange(null);
                } else {
                  onHighlightedOptionCodeChange(optionCode);
                  onSelectedInfoChange({
                    course: optionCourse,
                    credit: {
                      period: optionCourse.credits[0]?.period || 'P1',
                      credits: totalCredits,
                      year: optionCourse.year,
                    },
                  });
                }
              }}
            >
              <rect
                x={barX}
                y={barY}
                width={barWidth}
                height={barHeight}
                fill={colors.fill}
                stroke={highlightedOptionCode === optionCode ? '#FFD700' : colors.stroke}
                strokeWidth={highlightedOptionCode === optionCode ? 3 : 1.5}
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
