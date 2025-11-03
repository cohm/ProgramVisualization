'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import TimelineVisualization from '@/components/TimelineVisualization';
import { Course } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import programsConfig from '@/data/programs.json';
import type { CourseGroup, ProgramCosmetics } from '@/types/cosmetics';

// Program configuration type
interface ProgramConfig {
  code: string;
  name: string;
  dataFile: string;
  cosmeticsFile?: string;
}

const programs: ProgramConfig[] = programsConfig as any;

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

// Helper to load and map course data
const loadCourses = async (dataFile: string): Promise<Course[]> => {
  const rawCourses = await import(`@/data/${dataFile}`);
  // Merge entries by code to support multi-year courses represented across multiple rows or nested per-year dicts
  const byCode = new Map<string, any>();
  (rawCourses.default as any[]).forEach((c) => {
    // Normalize to nested per-year map: { Year1: {P1:..}, ... }
    let nested: Record<string, Record<string, number>> = {};
    const pc = c.periodCredits || {};
    const hasYearBuckets = Object.keys(pc).some(k => /^Year\d+$/i.test(k));
    if (hasYearBuckets) {
      // Already nested
      nested = {};
      Object.entries(pc).forEach(([yk, periods]: any) => {
        nested[yk] = {};
        Object.entries(periods || {}).forEach(([p, val]: any) => {
          const num = Number(val) || 0;
          if (num > 0) nested[yk][p] = num;
        });
      });
    } else {
      const yearNum = c.year || 1;
      const yk = `Year${yearNum}`;
      nested[yk] = {};
      Object.entries(pc).forEach(([p, val]: any) => {
        const num = Number(val) || 0;
        if (num > 0) nested[yk][p] = num;
      });
    }

    const code: string = c.code;
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, {
        code,
        name: c.name,
        briefName: c.briefName || undefined,
        perYear: nested,
        prerequisites: Array.isArray(c.prerequisites) ? [...c.prerequisites] : [],
        exams: Array.isArray(c.exams) ? [...c.exams] : [],
        reexams: Array.isArray(c.reexams) ? [...c.reexams] : [],
        examByYear: !Array.isArray(c.exams) && c.exams && typeof c.exams === 'object'
          ? Object.fromEntries(
              Object.entries(c.exams).map(([yk, arr]: any) => [Number(String(yk).replace(/\D/g, '')) || 1, Array.isArray(arr) ? arr : []])
            )
          : undefined,
        reexamByYear: !Array.isArray(c.reexams) && c.reexams && typeof c.reexams === 'object'
          ? Object.fromEntries(
              Object.entries(c.reexams).map(([yk, arr]: any) => [Number(String(yk).replace(/\D/g, '')) || 1, Array.isArray(arr) ? arr : []])
            )
          : undefined,
        teacher: c.teacher || '',
        webpage: c.webpage || '',
        description: c.description || ''
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
      const unique = (arr: any[]) => Array.from(new Set(arr));
      existing.prerequisites = unique([...(existing.prerequisites || []), ...(c.prerequisites || [])]);
      existing.exams = unique([...(existing.exams || []), ...(c.exams || [])]);
      existing.reexams = unique([...(existing.reexams || []), ...(c.reexams || [])]);
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
      const examsObj = !Array.isArray(c.exams) && c.exams && typeof c.exams === 'object'
        ? Object.fromEntries(
            Object.entries(c.exams).map(([yk, arr]: any) => [Number(String(yk).replace(/\D/g, '')) || 1, Array.isArray(arr) ? arr : []])
          ) as Record<number, string[]>
        : undefined;
      const reexamsObj = !Array.isArray(c.reexams) && c.reexams && typeof c.reexams === 'object'
        ? Object.fromEntries(
            Object.entries(c.reexams).map(([yk, arr]: any) => [Number(String(yk).replace(/\D/g, '')) || 1, Array.isArray(arr) ? arr : []])
          ) as Record<number, string[]>
        : undefined;
      existing.examByYear = mergeYearMap(existing.examByYear || {}, examsObj);
      existing.reexamByYear = mergeYearMap(existing.reexamByYear || {}, reexamsObj);
      // prefer existing name/briefName unless missing
      if (!existing.name && c.name) existing.name = c.name;
      if (!existing.briefName && c.briefName) existing.briefName = c.briefName;
      if (!existing.teacher && c.teacher) existing.teacher = c.teacher;
      if (!existing.webpage && c.webpage) existing.webpage = c.webpage;
      if (!existing.description && c.description) existing.description = c.description;
    }
  });

  // Now map to Course[] with flattened credits including year
  const courses: Course[] = Array.from(byCode.values()).map((entry) => {
    const credits: Course['credits'] = [];
    Object.entries(entry.perYear as Record<string, Record<string, number>>).forEach(([yk, periods]) => {
      const year = Number(String(yk).replace(/\D/g, '')) || 1;
      Object.entries(periods).forEach(([p, val]) => {
        const num = Number(val) || 0;
        if (num > 0) credits.push({ period: p as any, credits: num, year });
      });
    });
    // Determine primary year for compatibility
    const primaryYear = credits.length ? Math.min(...credits.map(c => c.year)) : 1;
    return {
      code: entry.code,
      name: entry.name,
      briefName: entry.briefName,
      credits,
      year: primaryYear,
      prerequisites: entry.prerequisites || [],
      exams: entry.exams || [],
      reexams: entry.reexams || [],
      examsByYear: entry.examByYear,
      reexamsByYear: entry.reexamByYear,
      teacher: entry.teacher || '',
      webpage: entry.webpage || '',
      description: entry.description || ''
    } as Course;
  });

  return courses;
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
  const [selectedProgram, setSelectedProgram] = useState(programs[0]);
  const [language, setLanguage] = useState<Lang>('sv');
  const [courses, setCourses] = useState<Course[]>([]);
  const [cosmetics, setCosmetics] = useState<ProgramCosmetics | null>(null);
  const vizRef = useRef<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportSubOpen, setExportSubOpen] = useState(false);
  const [includeLegend, setIncludeLegend] = useState(true);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Load courses and cosmetics when program changes
  useEffect(() => {
    loadCourses(selectedProgram.dataFile).then(setCourses);
    loadCosmetics(selectedProgram.cosmeticsFile).then(setCosmetics);
  }, [selectedProgram]);

  // Sync selected program from URL (?program=CODE)
  useEffect(() => {
    const param = (searchParams.get('program') || '').trim();
    const fromUrl = param
      ? programs.find(p => p.code.toLowerCase() === param.toLowerCase())
      : undefined;
    if (fromUrl && fromUrl.code !== selectedProgram.code) {
      setSelectedProgram(fromUrl);
      return;
    }
    // If no param, write current selection to URL for persistence
    if (!param) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('program', selectedProgram.code);
      // replace to avoid polluting history
      router.replace(`/?${params.toString()}`);
    }
  }, [searchParams, router, selectedProgram.code]);

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
                setSelectedProgram(program);
                // Update URL param to persist selection across reloads
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
            programName={selectedProgram.name}
            programCode={selectedProgram.code}
            cosmetics={cosmetics}
          />
        </div>

      </main>
    </div>
  );
}
