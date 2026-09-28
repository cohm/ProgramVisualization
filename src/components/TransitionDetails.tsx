'use client';

// The transition plan's own reasoning, one line per change.
//
// Every credited, exempted, moved, rescheduled and added course in
// transitions.json carries a note saying why — which COPEN course credits it,
// which offering the student sits, what the plan's table says. Those notes were
// only read by the sign-off script, while the chart summarised the plan as bare
// codes ("Utgår: SF1544"). They answer the question a transfer student actually
// has, "why is my chart different from the programme's own page?", so they are
// shown here, collapsed by default so the summary line stays one line.
//
// HomeClient renders this only for a plan with `verified: true`. Until a
// programme director has signed a plan off, its notes are written for that
// review, and some still name the data format ("se 'exempt'").

import React from 'react';
import type { Course, OptionGroup } from '@/types/course';
import type { TransitionPlan } from '@/types/transition';
import type { Lang } from '@/lib/translations';

const text = {
  sv: {
    show: (n: number) => `Visa ändringarna och varför (${n})`,
    credited: 'Tillgodoräknas',
    exempt: 'Utgår',
    moved: 'Flyttas',
    rescheduled: 'Läses i annan period',
    added: 'Tillkommer',
    replaces: 'ersätter',
    creditedBy: 'tillgodoräknas genom',
    toYear: (y: number) => `till årskurs ${y}`,
    from: 'från',
  },
  en: {
    show: (n: number) => `Show the changes and why (${n})`,
    credited: 'Credited',
    exempt: 'Dropped',
    moved: 'Moved',
    rescheduled: 'Read in another period',
    added: 'Added',
    replaces: 'replaces',
    creditedBy: 'credited by',
    toYear: (y: number) => `to year ${y}`,
    from: 'from',
  },
};

interface Item {
  code: string;
  qualifier?: string;
  note?: string;
}

interface Props {
  // The plan as the selected inriktning sees it (`effectivePlan`), so the list
  // matches the chart.
  plan: TransitionPlan;
  language: Lang;
  // The composed entries, for course names. An exempted course is not among
  // them, so it is listed by code alone.
  courses: (Course | OptionGroup)[];
  color?: string;
}

export default function TransitionDetails({ plan, language, courses, color }: Props) {
  const t = text[language];
  const en = language === 'en';
  const noteOf = (e: { note?: string; noteEn?: string }) => (en ? e.noteEn || e.note : e.note);
  const names = new Map<string, string>();
  for (const c of courses) {
    if ('type' in c && c.type === 'optionGroup') continue;
    const course = c as Course;
    names.set(course.code, (en ? course.nameEn || course.name : course.name) ?? '');
  }

  const sections: { title: string; items: Item[] }[] = [
    {
      title: t.credited,
      items: plan.credited.map(c => ({
        code: c.code,
        qualifier: c.replaces?.length ? `${t.replaces} ${c.replaces.join(', ')}` : undefined,
        note: noteOf(c),
      })),
    },
    {
      title: t.exempt,
      items: (plan.exempt ?? []).map(e => ({
        code: e.code,
        qualifier: e.creditedBy ? `${t.creditedBy} ${e.creditedBy}` : undefined,
        note: noteOf(e),
      })),
    },
    {
      title: t.moved,
      items: (plan.moved ?? []).map(m => ({ code: m.code, qualifier: t.toYear(m.toYear), note: noteOf(m) })),
    },
    {
      title: t.rescheduled,
      items: (plan.rescheduled ?? []).map(r => ({ code: r.code, note: noteOf(r) })),
    },
    {
      title: t.added,
      items: (plan.added ?? []).map(a => ({
        code: a.code,
        qualifier: a.fromProgram ? `${t.from} ${a.fromProgram}` : undefined,
        note: noteOf(a),
      })),
    },
  ].filter(s => s.items.length > 0);

  const count = sections.reduce((n, s) => n + s.items.length, 0);
  if (count === 0) return null;

  return (
    <details style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', textDecoration: 'underline', width: 'fit-content' }}>
        {t.show(count)}
      </summary>
      <div style={{ marginTop: 6, maxWidth: 900, lineHeight: 1.45, color }}>
        {sections.map(s => (
          <section key={s.title} style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600 }}>{s.title}</div>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18, listStyle: 'disc' }}>
              {s.items.map(i => {
                const name = names.get(i.code);
                return (
                  <li key={`${s.title}-${i.code}`} style={{ marginTop: 3 }}>
                    <strong>{i.code}</strong>
                    {name ? ` ${name}` : ''}
                    {i.qualifier ? ` — ${i.qualifier}` : ''}
                    {i.note && (
                      <div style={{ opacity: 0.85 }}>{i.note}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}
