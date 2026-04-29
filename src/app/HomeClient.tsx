'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import TimelineVisualization, { TimelineVisualizationHandle } from '@/components/TimelineVisualization';
import { Course, CourseCategory, GradingScale, OptionGroup, Period } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import programsConfig from '@/data/programs.json';
import type { CourseGroup, ProgramCosmetics } from '@/types/cosmetics';

// Program configuration type
interface ProgramConfig {
  code: string;
  name: string;
  nameEn?: string;
  dataFile: string;
  cosmeticsFile?: string;
  comment?: string;
  studyplan?: string;
}

const programs: ProgramConfig[] = programsConfig as unknown as ProgramConfig[];

interface RawCourseEntry {
  code: string;
  name: string;
  nameEn?: string;
  briefName?: string;
  briefNameEn?: string;
  type?: string;
  year?: number;
  periodCredits?: Record<string, unknown>;
  prerequisites?: string[];
  prerequisitesCompleted?: string[];
  prerequisitesParticipation?: string[];
  exams?: unknown;
  reexams?: unknown;
  teacher?: string;
  webpage?: string;
  description?: string;
  category?: CourseCategory;
  gradingScale?: GradingScale;
  [key: string]: unknown;
}

interface RawEntry {
  code: string;
  name: string;
  nameEn?: string;
  briefName?: string;
  briefNameEn?: string;
  perYear: Record<string, Record<string, number>>;
  prerequisites: string[];
  prerequisitesCompleted: string[];
  prerequisitesParticipation: string[];
  exams: string[];
  reexams: string[];
  examByYear?: Record<number, string[]>;
  reexamByYear?: Record<number, string[]>;
  teacher: string;
  webpage: string;
  description: string;
  category?: CourseCategory;
  gradingScale?: GradingScale;
}

// Helper to load cosmetics for a program
const loadCosmetics = async (cosmeticsFile: string | undefined): Promise<ProgramCosmetics | null> => {
  if (!cosmeticsFile) return null;
  try {
    const rawGroups = await import(`@/data/${cosmeticsFile}`);
    const groups: CourseGroup[] = rawGroups.default as CourseGroup[];
    const courseToGroup = new Map<string, CourseGroup>();
    groups.forEach(group => {
      group.courses.forEach(code => courseToGroup.set(code, group));
    });
    return { groups, courseToGroup };
  } catch (e) {
    console.warn('Failed to load cosmetics:', e);
    return null;
  }
};

// Parse an exams/reexams JSON value into the canonical { flat, byYear } shape.
// Accepts an array (flat) or a Year<n>-keyed object. Returns empty flat + undefined byYear if absent/invalid.
const parsePeriodList = (raw: unknown): { flat: string[]; byYear: Record<number, string[]> | undefined } => {
  if (Array.isArray(raw)) return { flat: [...raw as string[]], byYear: undefined };
  if (raw && typeof raw === 'object') {
    const byYear = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([yk, arr]) => [
        Number(String(yk).replace(/\D/g, '')) || 1,
        Array.isArray(arr) ? (arr as string[]) : [],
      ])
    ) as Record<number, string[]>;
    return { flat: [], byYear };
  }
  return { flat: [], byYear: undefined };
};

// Helper to load and map course data
const loadCourses = async (dataFile: string): Promise<(Course | OptionGroup)[]> => {
  const rawCourses = await import(`@/data/${dataFile}`);
  // Separate option groups from regular courses
  const rawData = rawCourses.default as RawCourseEntry[];
  const optionGroups = rawData.filter(c => c.type === 'optionGroup');
  const regularCourses = rawData.filter(c => c.type !== 'optionGroup');

  // Merge entries by code to support multi-year courses represented across multiple rows or nested per-year dicts
  const byCode = new Map<string, RawEntry>();
  regularCourses.forEach((c) => {
    // Normalize to nested per-year map: { Year1: {P1:..}, ... }
    let nested: Record<string, Record<string, number>> = {};
    const pc = c.periodCredits || {};
    const hasYearBuckets = Object.keys(pc).some(k => /^Year\d+$/i.test(k));
    if (hasYearBuckets) {
      // Already nested
      nested = {};
      Object.entries(pc as Record<string, Record<string, unknown>>).forEach(([yk, periods]) => {
        nested[yk] = {};
        Object.entries(periods || {}).forEach(([p, val]) => {
          const num = Number(val) || 0;
          if (num > 0) nested[yk][p] = num;
        });
      });
    } else {
      const yearNum = c.year || 1;
      const yk = `Year${yearNum}`;
      nested[yk] = {};
      Object.entries(pc as Record<string, unknown>).forEach(([p, val]) => {
        const num = Number(val) || 0;
        if (num > 0) nested[yk][p] = num;
      });
    }

    // Re-exam scheduling defaults to follow the ordinary exams: per
    // *Riktlinje om läsårets förläggning* §1.1 each exam period has a fixed
    // re-exam slot. Authors only need to set `reexams` to add EXTRA slots
    // (e.g. an additional tillfälle for a critical first-year math course).
    const examShape = parsePeriodList(c.exams);
    const reexamShape = c.reexams !== undefined && c.reexams !== null
      ? parsePeriodList(c.reexams)
      : examShape;

    const code: string = c.code;
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, {
        code,
        name: c.name,
        nameEn: c.nameEn || undefined,
        briefName: c.briefName || undefined,
        briefNameEn: c.briefNameEn || undefined,
        perYear: nested,
        prerequisites: Array.isArray(c.prerequisites) ? [...c.prerequisites] : [],
        prerequisitesCompleted: Array.isArray(c.prerequisitesCompleted) ? [...c.prerequisitesCompleted] : [],
        prerequisitesParticipation: Array.isArray(c.prerequisitesParticipation) ? [...c.prerequisitesParticipation] : [],
        exams: examShape.flat,
        reexams: reexamShape.flat,
        examByYear: examShape.byYear,
        reexamByYear: reexamShape.byYear,
        teacher: c.teacher || '',
        webpage: c.webpage || '',
        description: c.description || '',
        category: c.category,
        gradingScale: c.gradingScale,
      });
  } else {
      // merge nested perYear
      Object.entries(nested).forEach(([yk, periods]) => {
        existing.perYear[yk] = existing.perYear[yk] || {};
        Object.entries(periods).forEach(([p, val]) => {
          // Sum credits if duplicates found
          existing.perYear[yk][p] = (existing.perYear[yk][p] || 0) + (val as number);
        });
      });
      // merge arrays uniquely
      const unique = <T,>(arr: T[]) => Array.from(new Set(arr));
  existing.prerequisites = unique([...(existing.prerequisites || []), ...(c.prerequisites || [])]);
  existing.prerequisitesCompleted = unique([...(existing.prerequisitesCompleted || []), ...(c.prerequisitesCompleted || [])]);
  existing.prerequisitesParticipation = unique([...(existing.prerequisitesParticipation || []), ...(c.prerequisitesParticipation || [])]);
      existing.exams = unique([...(existing.exams || []), ...examShape.flat]);
      existing.reexams = unique([...(existing.reexams || []), ...reexamShape.flat]);
      // merge year-specific exam maps
      const mergeYearMap = (dst: Record<number, string[]>, src: Record<number, string[]> | undefined) => {
        if (!src) return dst;
        Object.entries(src).forEach(([yStr, arr]) => {
          const y = Number(yStr);
          const cur = dst[y] || [];
          dst[y] = Array.from(new Set([...cur, ...arr]));
        });
        return dst;
      };
      existing.examByYear = mergeYearMap(existing.examByYear || {}, examShape.byYear);
      existing.reexamByYear = mergeYearMap(existing.reexamByYear || {}, reexamShape.byYear);
      // prefer existing name/briefName unless missing
      if (!existing.name && c.name) existing.name = c.name;
      if (!existing.nameEn && c.nameEn) existing.nameEn = c.nameEn;
      if (!existing.briefName && c.briefName) existing.briefName = c.briefName;
      if (!existing.briefNameEn && c.briefNameEn) existing.briefNameEn = c.briefNameEn;
      if (!existing.teacher && c.teacher) existing.teacher = c.teacher;
      if (!existing.webpage && c.webpage) existing.webpage = c.webpage;
      if (!existing.description && c.description) existing.description = c.description;
      if (!existing.category && c.category) existing.category = c.category;
      if (!existing.gradingScale && c.gradingScale) existing.gradingScale = c.gradingScale;
    }
  });

  // Now map to Course[] with flattened credits including year
  const courses: Course[] = Array.from(byCode.values()).map((entry) => {
    const credits: Course['credits'] = [];
    Object.entries(entry.perYear as Record<string, Record<string, number>>).forEach(([yk, periods]) => {
      const year = Number(String(yk).replace(/\D/g, '')) || 1;
      Object.entries(periods).forEach(([p, val]) => {
        const num = Number(val) || 0;
        if (num > 0) credits.push({ period: p as Period['id'], credits: num, year });
      });
    });
    // Determine primary year for compatibility
    const primaryYear = credits.length ? Math.min(...credits.map(c => c.year)) : 1;
    return {
      code: entry.code,
      name: entry.name,
      nameEn: entry.nameEn,
      briefName: entry.briefName,
      briefNameEn: entry.briefNameEn,
      credits,
      year: primaryYear,
      prerequisites: entry.prerequisites || [],
      // Backward compatibility: if detailed arrays are empty but flat prerequisites exist, treat as completion
      prerequisitesCompleted: (entry.prerequisitesCompleted && entry.prerequisitesCompleted.length ? entry.prerequisitesCompleted : (entry.prerequisites || [])),
      prerequisitesParticipation: entry.prerequisitesParticipation || [],
      exams: entry.exams || [],
      reexams: entry.reexams || [],
      examsByYear: entry.examByYear,
      reexamsByYear: entry.reexamByYear,
      teacher: entry.teacher || '',
      webpage: entry.webpage || '',
      description: entry.description || '',
      category: entry.category,
      gradingScale: entry.gradingScale,
    } as Course;
  });

  return [...courses, ...optionGroups as unknown as OptionGroup[]];
};

type Lang = 'sv' | 'en';
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
  }
} as const;

export default function HomeClient() {
  const [courses, setCourses] = useState<(Course | OptionGroup)[]>([]);
  const [cosmetics, setCosmetics] = useState<ProgramCosmetics | null>(null);
  const vizRef = useRef<TimelineVisualizationHandle | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportSubOpen, setExportSubOpen] = useState(false);
  const [includeLegend, setIncludeLegend] = useState(true);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  const selectedProgram = useMemo(() => {
    const param = (searchParams.get('program') || '').trim();
    return (param ? programs.find(p => p.code.toLowerCase() === param.toLowerCase()) : null) ?? programs[0];
  }, [searchParams]);

  const language = useMemo<Lang>(() => {
    const langParam = searchParams.get('l');
    return (langParam === 'en' || langParam === 'sv') ? langParam : 'sv';
  }, [searchParams]);

  const setLanguage = (lang: Lang) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('l', lang);
    router.replace(`/?${params.toString()}`);
  };

  // ----- View state derived from URL params -----
  // og=Group1:Code1,Group2:Code2 — user's pick per option group
  // hide=layer1,layer2          — top-level layers that are off
  // hideGroups=Name1,Name2      — cosmetics course-groups that are off
  // All three are absent by default; absence = "default visibility / no choice".
  // Selections persist across program switches (an `og` entry that doesn't match
  // the new program is simply ignored).

  const selectedOptionPerGroup = useMemo<Record<string, string>>(() => {
    const og = searchParams.get('og');
    if (!og) return {};
    const out: Record<string, string> = {};
    for (const pair of og.split(',')) {
      const colon = pair.indexOf(':');
      if (colon <= 0) continue;
      const name = decodeURIComponent(pair.slice(0, colon));
      const code = decodeURIComponent(pair.slice(colon + 1));
      if (name && code) out[name] = code;
    }
    return out;
  }, [searchParams]);

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

  const replaceParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`/?${params.toString()}`);
  }, [searchParams, router]);

  const setSelectedOptionPerGroup = useCallback((next: Record<string, string>) => {
    replaceParams((p) => {
      const entries = Object.entries(next).filter(([, v]) => !!v).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) p.delete('og');
      else p.set('og', entries.map(([k, v]) => `${encodeURIComponent(k)}:${encodeURIComponent(v)}`).join(','));
    });
  }, [replaceParams]);

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

  // Load courses and cosmetics when program changes
  useEffect(() => {
    loadCourses(selectedProgram.dataFile).then(setCourses);
    loadCosmetics(selectedProgram.cosmeticsFile).then(setCosmetics);
  }, [selectedProgram]);

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
      <main className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold" style={{ color: kthColors.KthHeaven?.HEX }}>{ui[language].title}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>{ui[language].programLabel}</label>
            <select 
            value={selectedProgram.code}
            onChange={(e) => {
              const program = programs.find(p => p.code === e.target.value);
              if (program) {
                const params = new URLSearchParams(searchParams.toString());
                params.set('program', program.code);
                router.replace(`/?${params.toString()}`);
              }
            }}
            style={{ color: kthColors.KthBlue?.HEX }}
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm"
          >
            {programs.map(program => (
              <option key={program.code} value={program.code}>{program.code}</option>
            ))}
          </select>
          
            <div style={{ position: 'relative' }}>
              <button ref={exportBtnRef} onClick={() => setMenuOpen(v => !v)} className="px-2 py-2 border border-gray-300 rounded-md shadow-sm" aria-label="Menu">
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
                        <button onClick={() => { vizRef.current?.exportChart('pdf', { includeLegend }); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-left" style={{ color: kthColors.KthBlue?.HEX }}>{ui[language].savePdf}</button>
                      </div>
                    </div>
                  )}
                  {/* Divider */}
                  <div style={{ height: 1, background: '#e5e7eb', margin: '12px 0' }} />
                  {/* Language flags */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    {/* <div style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>{ui[language].language}</div> */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setLanguage('sv'); setMenuOpen(false); setExportSubOpen(false); }} className="px-2 py-1 border border-gray-300 rounded-md shadow-sm" aria-label="Svenska" title="Svenska" style={{ outline: language==='sv' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>🇸🇪</button>
                      <button onClick={() => { setLanguage('en'); setMenuOpen(false); setExportSubOpen(false); }} className="px-2 py-1 border border-gray-300 rounded-md shadow-sm" aria-label="English" title="English" style={{ outline: language==='en' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>🇺🇸</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-lg p-6 min-h-[600px]">
          <TimelineVisualization
            ref={vizRef}
            courses={courses}
            language={language}
            programName={language === 'en' ? (selectedProgram.nameEn || selectedProgram.name) : selectedProgram.name}
            programCode={selectedProgram.code}
            studyplanUrl={selectedProgram.studyplan}
            programComment={selectedProgram.comment}
            cosmetics={cosmetics}
            selectedOptionPerGroup={selectedOptionPerGroup}
            onSelectedOptionPerGroupChange={setSelectedOptionPerGroup}
            hiddenLayers={hiddenLayers}
            onHiddenLayersChange={setHiddenLayers}
            hiddenGroups={hiddenGroups}
            onHiddenGroupsChange={setHiddenGroups}
          />
        </div>
        
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
