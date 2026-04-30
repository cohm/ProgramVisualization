'use client';

import React from 'react';
import kthColors from '@/data/kth-colors.json';
import { STYLE, getFamilyVariants } from '@/lib/colors';
import { tr, type Lang } from '@/lib/translations';
import type { ProgramCosmetics } from '@/types/cosmetics';

// Visibility flags consumed by the legend. Same shape produced by
// TimelineVisualization's `layers` useMemo.
export interface LegendLayers {
  exams: boolean;
  reexams: boolean;
  prereqCompleted: boolean;
  prereqParticipation: boolean;
  courseBars: boolean;
  studyPeriods: boolean;
  examPeriods: boolean;
  reexamPeriods: boolean;
  groups: Record<string, boolean>;
}

export type ToggleableLayerKey =
  | 'exams' | 'reexams'
  | 'prereqCompleted' | 'prereqParticipation'
  | 'courseBars'
  | 'studyPeriods' | 'examPeriods' | 'reexamPeriods';

interface LegendProps {
  language: Lang;
  layers: LegendLayers;
  cosmetics: ProgramCosmetics | null | undefined;
  toggleLayer: (key: ToggleableLayerKey) => void;
  toggleGroup: (groupName: string) => void;
}

export default function Legend({ language, layers, cosmetics, toggleLayer, toggleGroup }: LegendProps) {
  return (
    <div style={{ position: 'absolute', right: STYLE.legend.offsetX, bottom: STYLE.legend.offsetY, width: STYLE.legend.width, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: '8px 12px', background: STYLE.legend.background, border: `1px solid ${STYLE.legend.borderColor}`, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.12)', zIndex: 1000 }}>
      {/* Exams */}
      <div onClick={() => toggleLayer('exams')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.exams ? 1 : 0.4 }}>
        <svg width={16} height={16} viewBox="0 0 16 16">
          <circle cx={8} cy={8} r={6} fill={kthColors.KthLightBrick?.HEX || '#FFCCC4'} stroke={kthColors.KthDarkBrick?.HEX || '#B35A4A'} strokeWidth={1.5}/>
        </svg>
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.exams}</span>
      </div>

      {/* Reexams */}
      <div onClick={() => toggleLayer('reexams')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.reexams ? 1 : 0.4 }}>
        <svg width={16} height={16} viewBox="0 0 16 16">
          <circle cx={8} cy={8} r={6} fill={kthColors.KthLightBrick?.HEX || '#FFCCC4'} stroke={kthColors.KthDarkBrick?.HEX || '#B35A4A'} strokeWidth={1.5} strokeDasharray="3 2" />
        </svg>
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.reexams}</span>
      </div>

      {/* Prerequisites - completion */}
      <div onClick={() => toggleLayer('prereqCompleted')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.prereqCompleted ? 1 : 0.4 }}>
        <svg width={16} height={16} viewBox="0 0 20 16">
          <path d="M2 8 L16 8" stroke={kthColors.KthHeaven?.HEX || '#6298D2'} strokeWidth={2} fill="none" />
          <path d="M12 4 L20 8 L12 12" fill={kthColors.KthHeaven?.HEX || '#6298D2'} />
        </svg>
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.prerequisitesCompleted}</span>
      </div>

      {/* Prerequisites - participation */}
      <div onClick={() => toggleLayer('prereqParticipation')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.prereqParticipation ? 1 : 0.4 }}>
        <svg width={16} height={16} viewBox="0 0 20 16">
          <path d="M2 8 L16 8" stroke="#999" strokeWidth={2} strokeDasharray="4,3" fill="none" />
          <path d="M12 4 L20 8 L12 12" fill="#999" />
        </svg>
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.prerequisitesParticipation}</span>
      </div>

      {/* Courses */}
      <div onClick={() => toggleLayer('courseBars')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.courseBars ? 1 : 0.4 }}>
        <div style={{ width: 18, height: 12, background: kthColors.KthHeaven?.HEX || '#6298D2', borderRadius: 2, border: '1px solid rgba(0,0,0,0.06)' }} />
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.courses}</span>
      </div>

      {/* Study periods */}
      <div onClick={() => toggleLayer('studyPeriods')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.studyPeriods ? 1 : 0.4 }}>
        <div style={{ width: 18, height: 12, background: kthColors.KthSand?.HEX || '#f3f4f6' }} />
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.studyPeriods}</span>
      </div>

      {/* Exam periods */}
      <div onClick={() => toggleLayer('examPeriods')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.examPeriods ? 1 : 0.4 }}>
        <div style={{ width: 18, height: 12, background: kthColors.KthLightBlue?.HEX || '#DEF0FF' }} />
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.examPeriods}</span>
      </div>

      {/* Reexam periods */}
      <div onClick={() => toggleLayer('reexamPeriods')} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.reexamPeriods ? 1 : 0.4 }}>
        <div style={{ width: 18, height: 12, background: kthColors.KthLightGray?.HEX || '#e6e6e6' }} />
        <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.reexamPeriods}</span>
      </div>

      {/* Course groups if cosmetics available */}
      {cosmetics && cosmetics.groups.length > 0 && (
        <>
          <div style={{ width: '100%', height: 1, background: '#e5e7eb', margin: '4px 0' }} />
          {cosmetics.groups.map((group) => {
            const variants = getFamilyVariants(group.colorFamily);
            const gradient = variants.length > 1
              ? `linear-gradient(90deg, ${variants.map((v, i) => {
                  const start = Math.round((i / variants.length) * 100);
                  const end = Math.round(((i + 1) / variants.length) * 100);
                  return `${v.fill} ${start}%, ${v.fill} ${end}%`;
                }).join(', ')})`
              : variants[0]?.fill || '#ccc';
            const borderColor = variants[0]?.stroke || '#999';
            const isHidden = layers.groups[group.name] === false;
            return (
              <div
                key={group.name}
                onClick={() => toggleGroup(group.name)}
                style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: isHidden ? 0.4 : 1 }}
                title={isHidden ? 'Show group' : 'Hide group'}
              >
                <div style={{ width: 18, height: 12, background: gradient, borderRadius: 2, border: `1px solid ${borderColor}` }} />
                <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>
                  {language === 'en' ? (group.nameEn || group.name) : group.name}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
