'use client';

import React, { type KeyboardEvent } from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';

export interface SpecializationDef {
  code: string;
  name: string;
  nameEn?: string;
  group?: string;
}

export interface SpecializationGroupDef {
  code: string;
  name: string;
  nameEn?: string;
}

interface Props {
  language: Lang;
  specializations: SpecializationDef[];
  groups?: SpecializationGroupDef[];
  // Codes currently picked (one per group). Empty set means "no pick yet" —
  // the parent typically initialises this to the first option per group.
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

function activate(e: KeyboardEvent, fn: () => void) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    fn();
  }
}

const DEFAULT_GROUP = '__default__';

// Pick-exactly-one per group. Selecting a chip in a group replaces any prior
// pick within that same group, leaving picks in other groups untouched.
// Hidden when the program declares no specs.
export default function SpecializationFilter({ language, specializations, groups, selected, onChange }: Props) {
  if (!specializations || specializations.length === 0) return null;

  // Bucket specs by group code; specs without a `group` go in DEFAULT_GROUP.
  const byGroup = new Map<string, SpecializationDef[]>();
  for (const s of specializations) {
    const k = s.group || DEFAULT_GROUP;
    const list = byGroup.get(k) || [];
    list.push(s);
    byGroup.set(k, list);
  }

  // Group rows render in registry order, with any leftover (default) group
  // last. Programs without a specializationGroups registry render as one
  // implicit row.
  const orderedGroups: { code: string; name: string; nameEn?: string }[] = [];
  if (groups && groups.length > 0) {
    for (const g of groups) if (byGroup.has(g.code)) orderedGroups.push(g);
    if (byGroup.has(DEFAULT_GROUP)) {
      orderedGroups.push({ code: DEFAULT_GROUP, name: tr[language].specializations });
    }
  } else {
    // Single implicit group — label it with the generic translation.
    orderedGroups.push({ code: DEFAULT_GROUP, name: tr[language].specializations });
  }

  const blue = kthColors.KthBlue?.HEX || '#004791';
  const lightBlue = kthColors.KthLightBlue?.HEX || '#DEF0FF';

  const pick = (groupCode: string, specCode: string) => {
    const groupCodes = new Set((byGroup.get(groupCode) || []).map(s => s.code));
    const next = new Set<string>();
    // Carry over picks from other groups; replace this group's pick.
    for (const c of selected) if (!groupCodes.has(c)) next.add(c);
    next.add(specCode);
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
      {orderedGroups.map(g => {
        const list = byGroup.get(g.code) || [];
        const groupLabel = language === 'en' ? (g.nameEn || g.name) : g.name;
        return (
          <div
            key={g.code}
            role="radiogroup"
            aria-label={groupLabel}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
          >
            <span style={{ color: blue, fontWeight: 600, fontSize: 13, minWidth: 140 }}>
              {groupLabel}:
            </span>
            {list.map(s => {
              const active = selected.has(s.code);
              const label = language === 'en' ? (s.nameEn || s.name) : s.name;
              return (
                <div
                  key={s.code}
                  role="radio"
                  tabIndex={0}
                  aria-checked={active}
                  onClick={() => pick(g.code, s.code)}
                  onKeyDown={(e) => activate(e, () => pick(g.code, s.code))}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 12,
                    border: `1px solid ${blue}`,
                    background: active ? blue : lightBlue,
                    color: active ? 'white' : blue,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                    userSelect: 'none',
                  }}
                  title={s.code}
                >
                  {label}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
