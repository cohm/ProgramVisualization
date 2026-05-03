'use client';

import React from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';
import type { Course, OptionGroup, SelectedInfo } from '@/types/course';

const isOptionGroup = (item: Course | OptionGroup): item is OptionGroup =>
  'type' in item && item.type === 'optionGroup';

interface InfoPanelProps {
  language: Lang;
  info: SelectedInfo | null;
  // Used to compute the "Required for" list (we filter out option groups
  // and option-group constituents to mirror the visualization's semantics).
  courses: (Course | OptionGroup)[];
  onClose: () => void;
}

export default function InfoPanel({ language, info, courses, onClose }: InfoPanelProps) {
  return (
    <div style={{ marginTop: 12, padding: '12px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      {info ? (
        <div style={{ color: kthColors.KthBlue?.HEX || '#004791' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {info.course.code}{' '}{language === 'en'
                  ? (info.course.nameEn || info.course.name)
                  : info.course.name}
                {info.credit ? `, ${info.credit.credits} ${tr[language].credits}` : ''}{' '}
                <a href={`https://www.kth.se/student/kurser/kurs/${info.course.code.toLowerCase()}${language === 'en' ? '?l=en' : ''}`}
                   target="_blank" rel="noopener noreferrer"
                   style={{ color: kthColors.KthHeaven?.HEX, textDecoration: 'none', fontWeight: 500 }}>
                  ({tr[language].viewCourse},&nbsp;
                </a>
                <a href={`https://www.kth.se/social/course/${info.course.code.toLowerCase()}/calendar`}
                   target="_blank" rel="noopener noreferrer"
                   style={{ color: kthColors.KthHeaven?.HEX, textDecoration: 'none', fontWeight: 500 }}>
                  {tr[language].viewSchedule})
                </a>
              </div>
            </div>
            <div>
              <button onClick={onClose}
                      className="px-2 py-1 border border-gray-300 rounded-md shadow-sm"
                      style={{ color: kthColors.KthBlue?.HEX }}
                      aria-label={language === 'en' ? 'Close info panel' : 'Stäng infopanel'}
                      title={language === 'en' ? 'Close' : 'Stäng'}>
                ×
              </button>
            </div>
          </div>
          {(info.course.category || info.course.gradingScale) && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              {info.course.category && (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, border: `1px solid ${kthColors.KthHeaven?.HEX || '#6298D2'}`, color: kthColors.KthBlue?.HEX || '#004791', background: kthColors.KthLightBlue?.HEX || '#DEF0FF' }}>
                  {tr[language].category[info.course.category]}
                </span>
              )}
              {info.course.gradingScale && (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, border: '1px solid #d1d5db', color: '#374151', background: '#f3f4f6' }}>
                  {tr[language].gradingScale}: {info.course.gradingScale}
                </span>
              )}
            </div>
          )}
          <div style={{ marginBottom: 6 }}>
            <div>
              {tr[language].legend.prerequisitesCompleted}:{' '}
              {(() => {
                const list = info.course.prerequisitesCompleted || info.course.prerequisites || [];
                return (list.length ? (list as string[]).join(', ') : '—');
              })()}{', '}
              {tr[language].legend.prerequisitesParticipation}:{' '}
              {(() => {
                const list = info.course.prerequisitesParticipation || [];
                return (list.length ? (list as string[]).join(', ') : '—');
              })()}{', '}
              {tr[language].requiredFor}:{' '}
              {(() => {
                // Only check individual courses, not option groups.
                const optGroupsList = courses.filter(isOptionGroup);
                const coursesInOptGroups = new Set<string>();
                optGroupsList.forEach(og => {
                  og.options.forEach(optionCode => {
                    coursesInOptGroups.add(optionCode);
                  });
                });
                const filteredCoursesList = courses.filter(c => {
                  if (isOptionGroup(c)) return false;
                  return !coursesInOptGroups.has((c as Course).code);
                }) as Course[];

                const dependents = filteredCoursesList.filter(c => {
                  const comp = c.prerequisitesCompleted || c.prerequisites || [];
                  const part = c.prerequisitesParticipation || [];
                  return (comp.includes(info.course.code) || part.includes(info.course.code));
                }).map(c => c.code);
                return dependents.length ? dependents.join(', ') : '—';
              })()}
            </div>
          </div>
          {info.course.teacher ? (
            <div style={{ marginBottom: 8 }}>
              {tr[language].teacher}: {info.course.teacher}
            </div>
          ) : null}
          {info.course.description ? (
            <div style={{ marginBottom: 8 }}>
              Info: {info.course.description}</div>
          ) : null}
        </div>
      ) : (
        <div style={{ color: '#6b7280', fontStyle: 'italic' }}>
          {tr[language].clickCourseForDetails}
        </div>
      )}
    </div>
  );
}
