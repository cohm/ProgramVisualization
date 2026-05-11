'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import TimelineVisualization, { TimelineVisualizationHandle } from '@/components/TimelineVisualization';
import SpecializationFilter from '@/components/SpecializationFilter';
import Toast, { type ToastMessage } from '@/components/Toast';
import { Course, OptionGroup } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import programsConfig from '@/data/programs.json';
import type { ProgramCosmetics } from '@/types/cosmetics';
import { loadCourses, loadCosmetics } from '@/lib/useCourseModel';
import { tr, type Lang } from '@/lib/translations';

// Program configuration type
interface SpecializationDef {
  code: string;
  name: string;
  nameEn?: string;
  // Optional group code; references `specializationGroups[].code` below.
  // Programs whose inriktningar are organised as several pick-one buckets
  // (e.g. CINEK = pick one technical AND one business) tag each spec with
  // the bucket it belongs to. If omitted, all specs share an implicit
  // single group ("default").
  group?: string;
}

interface SpecializationGroupDef {
  code: string;
  name: string;
  nameEn?: string;
}

interface ProgramConfig {
  code: string;
  name: string;
  nameEn?: string;
  dataFile: string;
  cosmeticsFile?: string;
  // Whether the study plan has been verified by the program director or
  // admin personnel. Unverified plans are hidden from the program-selector
  // dropdown unless the user opts in via the "show unverified" checkbox.
  // Missing field is treated as `false`.
  verified?: boolean;
  comment?: string;
  // Optional English-language comment shown when the page language is `en`.
  // Falls back to `comment` if missing — keeps existing entries valid.
  commentEn?: string;
  studyplan?: string;
  // Optional inriktningar (specializations) for civilingenjör programs that
  // split their bachelor years by inriktning. When undefined / empty, the
  // SpecializationFilter is hidden.
  specializations?: SpecializationDef[];
  // Optional human-readable groups that organise the specs into multiple
  // pick-one rows (e.g. "Tekniskt val" + "Verksamhetsinriktning"). When
  // omitted, all specs are treated as one implicit group.
  specializationGroups?: SpecializationGroupDef[];
}

const programs: ProgramConfig[] = programsConfig as unknown as ProgramConfig[];

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
    menu: 'Meny för export och språk',
    showUnverified: 'Visa icke-verifierade utbildningsplaner',
    unverifiedSuffix: '(inte verifierad)',
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
    menu: 'Export and language menu',
    showUnverified: 'Show unverified study plans',
    unverifiedSuffix: '(unverified)',
  }
} as const;

export default function HomeClient() {
  const [courses, setCourses] = useState<(Course | OptionGroup)[]>([]);
  const [cosmetics, setCosmetics] = useState<ProgramCosmetics | null>(null);
  // Page-level toast for non-blocking failures (PDF export errors,
  // cosmetics-load failures). Children emit via the `onToast` callback.
  const [toast, setToast] = useState<ToastMessage | null>(null);
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

  // Whether unverified study plans are shown in the program dropdown.
  // Off by default; flipped via the checkbox next to the selector.
  // Persisted in the URL as `unverified=1` so bookmarks survive reloads.
  const showUnverified = useMemo<boolean>(() => searchParams.get('unverified') === '1', [searchParams]);

  const setLanguage = (lang: Lang) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('l', lang);
    router.replace(`/?${params.toString()}`);
  };

  const setShowUnverified = (next: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('unverified', '1');
    else params.delete('unverified');
    router.replace(`/?${params.toString()}`);
  };

  // Always include the currently-selected program even if it's unverified
  // and the toggle is off — otherwise a bookmarked `?program=CTMAT` would
  // hide its own entry from the dropdown and silently look broken.
  const visiblePrograms = useMemo<ProgramConfig[]>(() => {
    if (showUnverified) return programs;
    return programs.filter(p => p.verified === true || p.code === selectedProgram.code);
  }, [showUnverified, selectedProgram]);

  // ----- View state derived from URL params -----
  // og=Group1:Code1,Group2:Code2 — user's pick per option group
  // hide=layer1,layer2          — top-level layers that are off
  // hideGroups=Name1,Name2      — cosmetics course-groups that are off
  // All three are absent by default; absence = "default visibility / no choice".
  // Selections persist across program switches (an `og` entry that doesn't match
  // the new program is simply ignored).

  // Codes after the colon are joined with '+' — multi-select for groups
  // with kind: 'pickN' (pickN > 1) or kind: 'minCredits'. Single-string
  // form is still accepted for back-compat with bookmarks from the
  // pre-multiselect days.
  const selectedOptionPerGroup = useMemo<Record<string, string[]>>(() => {
    const og = searchParams.get('og');
    if (!og) return {};
    const out: Record<string, string[]> = {};
    for (const pair of og.split(',')) {
      const colon = pair.indexOf(':');
      if (colon <= 0) continue;
      const name = decodeURIComponent(pair.slice(0, colon));
      const codesRaw = pair.slice(colon + 1);
      if (!name || !codesRaw) continue;
      const codes = codesRaw.split('+').map(c => decodeURIComponent(c)).filter(Boolean);
      if (codes.length > 0) out[name] = codes;
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

  // Map spec code → group code, derived from the program's registry. The
  // filter pre-pass uses this to enforce AND-across-groups semantics.
  const specGroupMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const s of selectedProgram.specializations || []) {
      m.set(s.code, s.group || '__default__');
    }
    return m;
  }, [selectedProgram]);

  // ?spec=A,B = the user's pick per spec group. When the program has a
  // specs registry, the visualisation defaults to the first option in each
  // group so the chart isn't ambiguous on first load.
  const selectedSpecializations = useMemo<Set<string>>(() => {
    const v = searchParams.get('spec');
    if (v) return new Set(v.split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean));
    // Default: first spec per group.
    const specs = selectedProgram.specializations;
    if (!specs || specs.length === 0) return new Set();
    const seenGroups = new Set<string>();
    const defaults = new Set<string>();
    for (const s of specs) {
      const g = s.group || '__default__';
      if (seenGroups.has(g)) continue;
      seenGroups.add(g);
      defaults.add(s.code);
    }
    return defaults;
  }, [searchParams, selectedProgram]);

  const replaceParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`/?${params.toString()}`);
  }, [searchParams, router]);

  const setSelectedOptionPerGroup = useCallback((next: Record<string, string[]>) => {
    replaceParams((p) => {
      const entries = Object.entries(next)
        .filter(([, codes]) => Array.isArray(codes) && codes.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) p.delete('og');
      else p.set('og', entries
        .map(([k, codes]) => `${encodeURIComponent(k)}:${codes.map(c => encodeURIComponent(c)).join('+')}`)
        .join(','));
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

  const setSelectedSpecializations = useCallback((next: Set<string>) => {
    replaceParams((p) => {
      if (next.size === 0) p.delete('spec');
      else p.set('spec', [...next].sort().map(encodeURIComponent).join(','));
    });
  }, [replaceParams]);

  // Load courses and cosmetics when program changes
  useEffect(() => {
    loadCourses(selectedProgram.dataFile).then(setCourses);
    loadCosmetics(selectedProgram.cosmeticsFile)
      .then(setCosmetics)
      .catch((e) => {
        console.warn('Failed to load cosmetics:', e);
        setCosmetics(null);
        setToast({ title: tr[language].cosmeticsLoadFailed, detail: String(e).slice(0, 200) });
      });
    // Disabling exhaustive-deps because `language` is intentionally not a
    // dep — switching language shouldn't re-fetch the cosmetics file. The
    // toast text uses whatever `language` was at the moment the failure
    // fires, which is acceptable for a transient banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            {visiblePrograms.map(program => (
              <option key={program.code} value={program.code}>
                {program.verified === true ? program.code : `${program.code} ${ui[language].unverifiedSuffix}`}
              </option>
            ))}
          </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: kthColors.KthBlue?.HEX, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={showUnverified}
                onChange={(e) => setShowUnverified(e.target.checked)}
              />
              {ui[language].showUnverified}
            </label>

            <div style={{ position: 'relative' }}>
              <button ref={exportBtnRef} onClick={() => setMenuOpen(v => !v)} className="px-2 py-2 border border-gray-300 rounded-md shadow-sm" aria-label={ui[language].menu} aria-expanded={menuOpen} aria-haspopup="menu">
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
                        {process.env.NEXT_PUBLIC_DISABLE_PDF !== '1' && (
                          <button onClick={() => { vizRef.current?.exportChart('pdf', { includeLegend }); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-left" style={{ color: kthColors.KthBlue?.HEX }}>{ui[language].savePdf}</button>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Divider */}
                  <div style={{ height: 1, background: '#e5e7eb', margin: '12px 0' }} />
                  {/* Language flags */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    {/* <div style={{ color: kthColors.KthBlue?.HEX, fontWeight: 600 }}>{ui[language].language}</div> */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setLanguage('sv'); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-1 border border-gray-300 rounded-md shadow-sm font-semibold" aria-label="Svenska" title="Svenska" style={{ color: kthColors.KthBlue?.HEX, fontSize: 13, outline: language==='sv' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>SV</button>
                      <button onClick={() => { setLanguage('en'); setMenuOpen(false); setExportSubOpen(false); }} className="px-3 py-1 border border-gray-300 rounded-md shadow-sm font-semibold" aria-label="English" title="English" style={{ color: kthColors.KthBlue?.HEX, fontSize: 13, outline: language==='en' ? `2px solid ${kthColors.KthBlue?.HEX}` : 'none' }}>EN</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-lg p-6 min-h-[600px]">
          {selectedProgram.specializations && selectedProgram.specializations.length > 0 && (
            <SpecializationFilter
              language={language}
              specializations={selectedProgram.specializations}
              groups={selectedProgram.specializationGroups}
              selected={selectedSpecializations}
              onChange={setSelectedSpecializations}
            />
          )}
          <TimelineVisualization
            ref={vizRef}
            courses={courses}
            language={language}
            programName={language === 'en' ? (selectedProgram.nameEn || selectedProgram.name) : selectedProgram.name}
            programCode={selectedProgram.code}
            studyplanUrl={selectedProgram.studyplan}
            programComment={language === 'en' ? (selectedProgram.commentEn || selectedProgram.comment) : selectedProgram.comment}
            cosmetics={cosmetics}
            selectedOptionPerGroup={selectedOptionPerGroup}
            onSelectedOptionPerGroupChange={setSelectedOptionPerGroup}
            hiddenLayers={hiddenLayers}
            onHiddenLayersChange={setHiddenLayers}
            hiddenGroups={hiddenGroups}
            onHiddenGroupsChange={setHiddenGroups}
            selectedSpecializations={selectedSpecializations}
            specGroupMap={specGroupMap}
            onToast={setToast}
          />
        </div>
        <Toast language={language} toast={toast} onClose={() => setToast(null)} />
        
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
