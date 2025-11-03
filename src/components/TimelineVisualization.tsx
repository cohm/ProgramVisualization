import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import * as d3 from 'd3';
import { Course, Period, academicPeriods } from '@/types/course';
import kthColors from '@/data/kth-colors.json';
import type { ProgramCosmetics } from '@/types/cosmetics';

type Lang = 'sv' | 'en';
interface TimelineVisualizationProps {
  courses: Course[];
  language?: Lang;
  programName?: string;
  programCode?: string;
  cosmetics?: ProgramCosmetics | null;
}

const TimelineVisualization = forwardRef(function TimelineVisualization({ courses, language = 'sv', programName, programCode, cosmetics }: TimelineVisualizationProps, ref: any) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Marker visual parameters - centralized for consistency
  const EXAM_MARKER_RADIUS = 4;
  const EXAM_MARKER_STROKE_WIDTH = 1;
  const REEXAM_MARKER_RADIUS = 4;
  const REEXAM_MARKER_STROKE_WIDTH = 1;

  // Centralized styling and layout constants
  const STYLE = {
    fontFamily: "Figtree, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans, 'Apple Color Emoji', 'Segoe UI Emoji'",
    legend: {
      width: 150,
      offsetX: 95,
      offsetY: 30,
      background: 'rgba(255,255,255,0.95)',
      borderColor: '#e5e7eb',
      requires: 'Särskild behörighet',
      requiredFor: 'Krävs för',
      textColor: kthColors.KthBlue?.HEX || '#004791'
    }
  } as const;

  // Map color family to KTH color shades for course bars
  const getColorForFamily = (family: 'blue' | 'green' | 'turquoise' | 'brick' | 'yellow') => {
    const families = {
      blue: { fill: kthColors.KthBlue?.HEX || '#004791', stroke: kthColors.KthMarine?.HEX || '#000061', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' },
      green: { fill: kthColors.KthGreen?.HEX || '#4DA061', stroke: kthColors.KthDarkGreen?.HEX || '#0D4A21', text: kthColors.KthLightGreen?.HEX || '#C7EBBA' },
      turquoise: { fill: kthColors.KthTurquoise?.HEX || '#339C9C', stroke: kthColors.KthDarkTurquoise?.HEX || '#1C434C', text: kthColors.KthLightTurquoise?.HEX || '#B2E0E0' },
      brick: { fill: kthColors.KthBrick?.HEX || '#E86A58', stroke: kthColors.KthDarkBrick?.HEX || '#78001A', text: kthColors.KthLightBrick?.HEX || '#FFCCC4' },
      yellow: { fill: kthColors.KthYellow?.HEX || '#FFBE00', stroke: kthColors.KthDarkYellow?.HEX || '#A65900', text: kthColors.KthLightYellow?.HEX || '#FFF0B0' }
    };
    return families[family];
  };

  // Provide multiple distinct variants within a family so courses in the same group can use different tones
  const getFamilyVariants = (family: 'blue' | 'green' | 'turquoise' | 'brick' | 'yellow') => {
    if (family === 'blue') {
      return [
        { fill: kthColors.KthMarine?.HEX || '#000061', stroke: kthColors.KthBlue?.HEX || '#004791', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' },
        { fill: kthColors.KthBlue?.HEX || '#004791', stroke: kthColors.KthMarine?.HEX || '#000061', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' },
        { fill: kthColors.KthHeaven?.HEX || '#6298D2', stroke: kthColors.KthMarine?.HEX || '#000061', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' },
      ];
    }
    if (family === 'green') {
      return [
        { fill: kthColors.KthGreen?.HEX || '#4DA061', stroke: kthColors.KthDarkGreen?.HEX || '#0D4A21', text: kthColors.KthLightGreen?.HEX || '#C7EBBA' },
        { fill: kthColors.KthDarkGreen?.HEX || '#0D4A21', stroke: kthColors.KthGreen?.HEX || '#4DA061', text: kthColors.KthLightGreen?.HEX || '#C7EBBA' },
      ];
    }
    if (family === 'turquoise') {
      return [
        { fill: kthColors.KthTurquoise?.HEX || '#339C9C', stroke: kthColors.KthDarkTurquoise?.HEX || '#1C434C', text: kthColors.KthLightTurquoise?.HEX || '#B2E0E0' },
        { fill: kthColors.KthDarkTurquoise?.HEX || '#1C434C', stroke: kthColors.KthTurquoise?.HEX || '#339C9C', text: kthColors.KthLightTurquoise?.HEX || '#B2E0E0' },
      ];
    }
    if (family === 'brick') {
      return [
        { fill: kthColors.KthBrick?.HEX || '#E86A58', stroke: kthColors.KthDarkBrick?.HEX || '#78001A', text: kthColors.KthLightBrick?.HEX || '#FFCCC4' },
        { fill: kthColors.KthDarkBrick?.HEX || '#78001A', stroke: kthColors.KthBrick?.HEX || '#E86A58', text: kthColors.KthLightBrick?.HEX || '#FFCCC4' },
      ];
    }
    // yellow
    return [
      { fill: kthColors.KthYellow?.HEX || '#FFBE00', stroke: kthColors.KthDarkYellow?.HEX || '#A65900', text: kthColors.KthLightYellow?.HEX || '#FFF0B0' },
      { fill: kthColors.KthDarkYellow?.HEX || '#A65900', stroke: kthColors.KthYellow?.HEX || '#FFBE00', text: kthColors.KthLightYellow?.HEX || '#FFF0B0' },
    ];
  };

  // Stable per-course color selection within a group
  const getCourseColors = (course: Course) => {
    const group = cosmetics?.courseToGroup.get(course.code);
    if (!group) return defaultColor;
    const variants = getFamilyVariants(group.colorFamily);
    // Use course order in the group if present; fallback to a hash of course code
    const idxInGroup = (group.courses || []).findIndex(c => c === course.code);
    const baseIndex = idxInGroup >= 0 ? idxInGroup : Array.from(course.code).reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const variant = variants[baseIndex % variants.length];
    return variant || getColorForFamily(group.colorFamily);
  };

  // Default color for courses not in any group
  const defaultColor = { fill: kthColors.KthHeaven?.HEX || '#6298D2', stroke: kthColors.KthBlue?.HEX || '#004791', text: kthColors.KthLightBlue?.HEX || '#DEF0FF' };

  // Translations
  const tr = {
    sv: {
      legend: {
        exams: 'Tentor',
        reexams: 'Omtentor',
        prerequisitesCompleted: 'Kräver avklarad kurs',
        prerequisitesParticipation: 'Kräver deltagande',
        courses: 'Kurser',
        studyPeriods: 'Läsperioder',
        examPeriods: 'Tentaperioder',
        reexamPeriods: 'Omtentaperioder'
      },
      examPeriodLabel: 'Tentaperiod',
      reexamPeriodLabel: 'Omtentaperiod',
      period: 'Läsperiod',
      start: 'Start',
      lectureEnd: 'Föreläsningar slutar',
      end: 'Slut',
      exam: 'Tenta',
      reexam: 'Omtenta',
      year: 'År',
      credits: 'hp',
      teacher: 'Lärare',
      viewCourse: '(kurshemsida)',
      requires: 'Särskild behörighet',
      requiredFor: 'Krävs för',
      months: ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec']
    },
    en: {
      legend: {
        exams: 'Exams',
        reexams: 'Re-exams',
        prerequisitesCompleted: 'Requires completion',
        prerequisitesParticipation: 'Requires participation',
        courses: 'Courses',
        studyPeriods: 'Study periods',
        examPeriods: 'Exam periods',
        reexamPeriods: 'Re-exam periods'
      },
      examPeriodLabel: 'Exam period',
      reexamPeriodLabel: 'Re-exam period',
      period: 'Study period',
      start: 'Start',
      lectureEnd: 'Lecture end',
      end: 'End',
      exam: 'Exam',
      reexam: 'Re-exam',
      year: 'Year',
      credits: 'ECTS',
      teacher: 'Teacher',
      viewCourse: '(course webpage)',
      requires: 'Requires',
      requiredFor: 'Required for',
      months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    }
  } as const;

  // expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    exportChart: async (format: 'png' | 'svg' | 'pdf', options?: { includeLegend?: boolean }) => {
      if (!svgRef.current) return;
      const svgEl = svgRef.current;

      // Measure the on-screen SVG in CSS pixels
      const svgRect = svgEl.getBoundingClientRect();
      const exportWidth = Math.max(1, Math.round(svgRect.width));
      const exportHeight = Math.max(1, Math.round(svgRect.height));

      // Clone the SVG so we don't change the live DOM
      const cloned = svgEl.cloneNode(true) as SVGSVGElement;
      cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Set explicit pixel dimensions on the cloned SVG so the rasterizer uses them
      cloned.setAttribute('width', String(exportWidth));
      cloned.setAttribute('height', String(exportHeight));
      cloned.setAttribute('viewBox', `0 0 ${exportWidth} ${exportHeight}`);
      // Ensure font family is applied for all text in export and try to inline Figtree
      cloned.setAttribute('style', `font-family: ${STYLE.fontFamily};`);
      try {
        const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        styleEl.textContent = `* { font-family: ${STYLE.fontFamily}; }`;
        cloned.insertBefore(styleEl, cloned.firstChild);

        // Attempt to inline Figtree font from Google Fonts to avoid fallback during export
        const cssResp = await fetch('https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap');
        if (cssResp.ok) {
          const cssText = await cssResp.text();
          const match = cssText.match(/url\((https:[^)]+\.woff2)\)/);
          if (match && match[1]) {
            const fontResp = await fetch(match[1]);
            if (fontResp.ok) {
              const buf = await fontResp.arrayBuffer();
              const u8 = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
              const base64 = btoa(binary);
              const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
              fontStyle.textContent = `@font-face { font-family: Figtree; src: url(data:font/woff2;base64,${base64}) format('woff2'); font-weight: 400 900; font-style: normal; font-display: swap; }`;
              cloned.insertBefore(fontStyle, cloned.firstChild);
            }
          }
        }
      } catch {}

      // Optionally add an SVG legend into the cloned SVG for export
      if (options?.includeLegend) {
        try {
          const NS = 'http://www.w3.org/2000/svg';
          const legendPadding = 8;
          const itemGap = 8;
          const itemHeight = 18;
          const items = [
            { key: tr[language].legend.exams, type: 'exam', active: layers.exams },
            { key: tr[language].legend.reexams, type: 'reexam', active: layers.reexams },
            { key: tr[language].legend.prerequisitesCompleted, type: 'prereqCompleted', active: layers.prerequisites },
            { key: tr[language].legend.prerequisitesParticipation, type: 'prereqParticipated', active: layers.prerequisites },
            { key: tr[language].legend.courses, type: 'course', active: layers.courseBars },
            { key: tr[language].legend.studyPeriods, type: 'study', active: layers.studyPeriods },
            { key: tr[language].legend.examPeriods, type: 'examPeriod', active: layers.examPeriods },
            { key: tr[language].legend.reexamPeriods, type: 'reexamPeriod', active: layers.reexamPeriods },
          ];

          // container group
          const legendG = document.createElementNS(NS, 'g');
          // estimate width
          const legendWidth = STYLE.legend.width;
          const legendHeight = legendPadding*2 + items.length * (itemHeight + itemGap) - itemGap;
          const svgW = exportWidth;
          const svgH = exportHeight;
          const legendX = svgW - legendWidth - STYLE.legend.offsetX;
          const legendY = svgH - legendHeight - STYLE.legend.offsetY;
          legendG.setAttribute('transform', `translate(${legendX},${legendY})`);

          // background
          const bg = document.createElementNS(NS, 'rect');
          bg.setAttribute('x', '0');
          bg.setAttribute('y', '0');
          bg.setAttribute('width', String(legendWidth));
          bg.setAttribute('height', String(legendHeight));
          bg.setAttribute('rx', '8');
          bg.setAttribute('ry', '8');
          bg.setAttribute('fill', 'white');
          bg.setAttribute('stroke', STYLE.legend.borderColor);
          legendG.appendChild(bg);

          // add rows
          items.forEach((item, idx) => {
            const rowG = document.createElementNS(NS, 'g');
            rowG.setAttribute('transform', `translate(${legendPadding},${legendPadding + idx * (itemHeight + itemGap)})`);
            rowG.setAttribute('opacity', item.active ? '1' : '0.4');

            // icon
            if (item.type === 'exam') {
              const c = document.createElementNS(NS, 'circle');
              c.setAttribute('cx', '9');
              c.setAttribute('cy', String(itemHeight/2));
              c.setAttribute('r', '6');
              c.setAttribute('fill', kthColors.KthBrick?.HEX || '#E86A58');
              rowG.appendChild(c);
            } else if (item.type === 'reexam') {
              const c = document.createElementNS(NS, 'circle');
              c.setAttribute('cx', '9');
              c.setAttribute('cy', String(itemHeight/2));
              c.setAttribute('r', '6');
              c.setAttribute('fill', 'none');
              c.setAttribute('stroke', kthColors.KthBrick?.HEX || '#E86A58');
              c.setAttribute('stroke-width', '1.5');
              rowG.appendChild(c);
            } else if (item.type === 'prereqCompleted') {
              const line = document.createElementNS(NS, 'line');
              line.setAttribute('x1', '0');
              line.setAttribute('y1', String(itemHeight/2));
              line.setAttribute('x2', '18');
              line.setAttribute('y2', String(itemHeight/2));
              line.setAttribute('stroke', '#999');
              line.setAttribute('stroke-width', '1.5');
              rowG.appendChild(line);
            } else if (item.type === 'prereqParticipated') {
              const line = document.createElementNS(NS, 'line');
              line.setAttribute('x1', '0');
              line.setAttribute('y1', String(itemHeight/2));
              line.setAttribute('x2', '18');
              line.setAttribute('y2', String(itemHeight/2));
              line.setAttribute('stroke', kthColors.KthBlue?.HEX || '#004791');
              line.setAttribute('stroke-width', '1.5');
              line.setAttribute('stroke-dasharray', '4,3');
              rowG.appendChild(line);
            } else if (item.type === 'course') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthHeaven?.HEX || '#6298D2');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'study') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthSand?.HEX || '#f3f4f6');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'examPeriod') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', (kthColors.KthLightBlue?.HEX || '#DEF0FF'));
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            } else if (item.type === 'reexamPeriod') {
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              r.setAttribute('fill', kthColors.KthLightGray?.HEX || '#eee');
              r.setAttribute('stroke', 'rgba(0,0,0,0.06)');
              rowG.appendChild(r);
            }

            // label
            const text = document.createElementNS(NS, 'text');
            text.setAttribute('x', '26');
            text.setAttribute('y', String(itemHeight/2 + 4));
            text.setAttribute('fill', STYLE.legend.textColor);
            text.setAttribute('font-size', '12');
            text.textContent = item.key;
            rowG.appendChild(text);

            legendG.appendChild(rowG);
          });

          // Add course groups if cosmetics available
          if (cosmetics && cosmetics.groups.length > 0) {
            // defs for gradients
            const defs = document.createElementNS(NS, 'defs');
            legendG.appendChild(defs);
            let currentIdx = items.length;
            // Add a separator line
            const separatorY = legendPadding + currentIdx * (itemHeight + itemGap) - itemGap/2;
            const separatorLine = document.createElementNS(NS, 'line');
            separatorLine.setAttribute('x1', String(legendPadding));
            separatorLine.setAttribute('y1', String(separatorY));
            separatorLine.setAttribute('x2', String(legendWidth - legendPadding));
            separatorLine.setAttribute('y2', String(separatorY));
            separatorLine.setAttribute('stroke', '#e5e7eb');
            separatorLine.setAttribute('stroke-width', '1');
            legendG.appendChild(separatorLine);

            currentIdx++; // account for separator space
            cosmetics.groups.forEach((group, gIdx) => {
              const variants = getFamilyVariants(group.colorFamily);
              const rowG = document.createElementNS(NS, 'g');
              rowG.setAttribute('transform', `translate(${legendPadding},${legendPadding + (currentIdx + gIdx) * (itemHeight + itemGap)})`);
              
              const r = document.createElementNS(NS, 'rect');
              r.setAttribute('x', '0');
              r.setAttribute('y', String((itemHeight-12)/2));
              r.setAttribute('width', '18');
              r.setAttribute('height', '12');
              // Create linear gradient for this group
              let gradId = `legendGrad_${gIdx}`;
              const lg = document.createElementNS(NS, 'linearGradient');
              lg.setAttribute('id', gradId);
              lg.setAttribute('x1', '0%');
              lg.setAttribute('y1', '0%');
              lg.setAttribute('x2', '100%');
              lg.setAttribute('y2', '0%');
              const n = Math.max(1, variants.length);
              variants.forEach((v, i) => {
                const start = Math.round((i / n) * 100);
                const end = Math.round(((i + 1) / n) * 100);
                const s1 = document.createElementNS(NS, 'stop');
                s1.setAttribute('offset', `${start}%`);
                s1.setAttribute('stop-color', v.fill);
                const s2 = document.createElementNS(NS, 'stop');
                s2.setAttribute('offset', `${end}%`);
                s2.setAttribute('stop-color', v.fill);
                lg.appendChild(s1);
                lg.appendChild(s2);
              });
              defs.appendChild(lg);
              r.setAttribute('fill', `url(#${gradId})`);
              r.setAttribute('stroke', (variants[0]?.stroke) || '#999');
              rowG.appendChild(r);

              const text = document.createElementNS(NS, 'text');
              text.setAttribute('x', '26');
              text.setAttribute('y', String(itemHeight/2 + 4));
              text.setAttribute('fill', STYLE.legend.textColor);
              text.setAttribute('font-size', '12');
              text.textContent = group.name;
              rowG.appendChild(text);

              legendG.appendChild(rowG);
            });

            // Update legend height to include groups
            const totalItems = items.length + 1 + cosmetics.groups.length; // +1 for separator
            const newLegendHeight = legendPadding*2 + totalItems * (itemHeight + itemGap) - itemGap;
            bg.setAttribute('height', String(newLegendHeight));
            // Reposition to stay in bottom-right
            const newLegendY = svgH - newLegendHeight - STYLE.legend.offsetY;
            legendG.setAttribute('transform', `translate(${legendX},${newLegendY})`);
          }

          // append legend to cloned
          cloned.appendChild(legendG);
        } catch (e) {
          console.warn('Failed to add legend to export', e);
        }
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(cloned);

      if (format === 'svg') {
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'program-visualization.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }

      // Convert to PNG via canvas
      const svg64 = btoa(unescape(encodeURIComponent(svgString)));
      const image64 = 'data:image/svg+xml;base64,' + svg64;
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        // Use devicePixelRatio to create a higher-resolution export (clamped)
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const scale = Math.min(4, Math.max(1, dpr * 2)); // e.g. DPR 1 -> 2, DPR 2 -> 4 (clamped at 4)

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(exportWidth * scale);
        canvas.height = Math.round(exportHeight * scale);
        // keep CSS size equal to logical SVG size
        canvas.style.width = `${exportWidth}px`;
        canvas.style.height = `${exportHeight}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Map drawing so that 1 unit = 1 CSS px in SVG space, while canvas pixels are scaled
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        // Fill white background in SVG coordinates
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, exportWidth, exportHeight);

        // Draw the SVG raster (img) into SVG coordinate space
        ctx.drawImage(img, 0, 0, exportWidth, exportHeight);

        if (format === 'png') {
          canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'program-visualization.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }, 'image/png');
        } else if (format === 'pdf') {
          // Server-side PDF generation: send PNG to API and download PDF
          canvas.toBlob(async (blob) => {
            if (!blob) return;
            const data = await blob.arrayBuffer();
            const res = await fetch('/api/export-pdf', {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: data
            });
            if (!res.ok) return;
            const pdfBlob = await res.blob();
            const url = URL.createObjectURL(pdfBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'program-visualization.pdf';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }, 'image/png');
        }
      };
      img.src = image64;
    }
  }));

  // layer visibility state
  const [layers, setLayers] = useState({
    exams: true,
    reexams: true,
    prerequisites: true,
    courseBars: true,
    studyPeriods: true,
    examPeriods: true,
    reexamPeriods: true,
  });

  // focused course code for fading non-relevant elements
  const [focusCourse, setFocusCourse] = useState<string | null>(null);
  // Info panel selection
  const [selectedInfo, setSelectedInfo] = useState<{
    course: Course;
    credit?: { period: string; credits: number; year: number };
  } | null>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !courses.length) return;

    const container = d3.select(containerRef.current);
    
    // Helper function to format dates without year (ISO format: MM-DD)
    const formatDateNoYear = (date: Date) => {
      const iso = date.toISOString().split('T')[0]; // YYYY-MM-DD
      return iso.substring(5); // MM-DD
    };
    
    // setup tooltip container
    container.selectAll('.pv-tooltip').remove();
    const tooltip = container.append('div')
      .attr('class', 'pv-tooltip')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('display', 'none')
      .style('background', `rgba(${(kthColors.KthMarine?.RGB || [0, 0, 97]).join(',')}, 0.8)`)
      .style('color', '#fff')
      .style('padding', '6px 8px')
      .style('border-radius', '4px')
      .style('font-size', '12px')
      .style('z-index', '1001');

  const svg = d3.select(svgRef.current);
  // Apply global font family to all SVG text
  svg.style('font-family', STYLE.fontFamily);
  const margin = { top: 100, right: 40, bottom: 40, left: 100 }; // Increased top margin for title and period labels
  const width = svgRef.current.clientWidth - margin.left - margin.right;
  let height = svgRef.current.clientHeight - margin.top - margin.bottom;

  // Clear previous content
  svg.selectAll('*').remove();

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);    // Create scales
    const timeScale = d3.scaleTime()
      .domain([academicPeriods[0].start, academicPeriods[3].reExamEnd])
      .range([0, width]);
  // Clicking on empty SVG space clears focus and closes popup
  svg.on('click', () => {
    setFocusCourse(null);
    setSelectedInfo(null);
  });

  const maxYear = Math.max(1, ...courses.flatMap(c => c.credits.map(cr => (cr as any).year || c.year || 1)));
  const numYears = Math.max(1, maxYear);
  // Increased vertical gap between year rows (px)
  const yearRowGap = 48; // 4 times larger (was 12)
  const totalGaps = Math.max(0, numYears - 1) * yearRowGap;
  // Base band height from current SVG height, used to derive a baseline pixels-per-ECTS
  const baseYearBandHeight = (height - totalGaps) / numYears;
  // Baseline pixels per ECTS (15 ECTS previously mapped to a year band)
  const pxPerECTS = baseYearBandHeight / 15;
  // Minimum ECTS to enforce for bar height so labels fit nicely
  const MIN_ECTS_FOR_HEIGHT = 2;
  const STACK_GAP_PX = 4; // gap between stacked bars

  // Build mapping of courses per year+period to compute stacking lanes (needed for sizing and layout)
  const slotsByYearPeriod: Record<string, Array<{ course: Course; credit: { period: string; credits: number; year: number } }>> = {};
  courses.forEach((course) => {
    course.credits.forEach((credit) => {
      const key = `${(credit as any).year}-${credit.period}`;
      if (!slotsByYearPeriod[key]) slotsByYearPeriod[key] = [];
      slotsByYearPeriod[key].push({ course, credit });
    });
  });

  // Compute required band height per year considering the minimum bar height corresponding to 2 ECTS
  const yearBandHeights: number[] = Array.from({ length: numYears }, () => 0);
  for (let y = 1; y <= numYears; y++) {
    // for this year, find all 4 periods
    let maxPeriodHeightNeeded = 0;
    academicPeriods.forEach((p) => {
      const list = slotsByYearPeriod[`${y}-${p.id}`] || [];
      if (list.length === 0) return;
      const heightSum = list.reduce((sum, it) => {
        const effECTS = Math.max(it.credit.credits, MIN_ECTS_FOR_HEIGHT);
        return sum + effECTS * pxPerECTS;
      }, 0);
      const gaps = Math.max(0, list.length - 1) * STACK_GAP_PX;
      maxPeriodHeightNeeded = Math.max(maxPeriodHeightNeeded, heightSum + gaps);
    });
    // Ensure at least the baseline height is kept, even if no courses
    yearBandHeights[y - 1] = Math.max(baseYearBandHeight, maxPeriodHeightNeeded);
  }

  // If required total height exceeds current height, expand the SVG to fit to avoid compressing bars below the minimum
  const requiredTotalHeight = yearBandHeights.reduce((a, b) => a + b, 0) + totalGaps;
  if (requiredTotalHeight > height) {
    height = requiredTotalHeight;
    // also set explicit height on the SVG node so layout picks it up
    d3.select(svgRef.current)
      .attr('height', height + margin.top + margin.bottom);
  }

  // Compute cumulative Y offsets per year using the (possibly) expanded band heights
  const yearYOffset: number[] = [];
  for (let i = 0; i < numYears; i++) {
    const prev = i === 0 ? 0 : (yearYOffset[i - 1] + yearBandHeights[i - 1] + yearRowGap);
    yearYOffset.push(prev);
  }
  const verticalOffset = 0;
  const periodExtension = 10; // How much the period backgrounds extend beyond course area (reduced for better alignment)

    // Draw program title first (at the top)
    if (programName && programCode) {
      g.append('text')
        .attr('x', width / 2)
        .attr('y', -75)
        .attr('text-anchor', 'middle')
        .attr('fill', kthColors.KthBlue?.HEX)
        .attr('font-weight', 700)
        .attr('font-size', 18)
        .text(`${programName} (${programCode})`);
    }

    // Draw period backgrounds with extension above and below
    academicPeriods.forEach((period, i) => {
      const periodHeight = height + 2 * periodExtension;
      const yOffset = -periodExtension;
      
      // Main period background
      g.append('rect')
        .attr('x', timeScale(period.start))
        .attr('y', yOffset)
        .attr('width', timeScale(period.end) - timeScale(period.start))
        .attr('height', periodHeight)
        .attr('class', 'study-period')
        .attr('fill', i % 2 === 0 ? (kthColors.KthSand?.HEX || '#f3f4f6') : (kthColors.KthBrokenWhite?.HEX || '#ffffff'))
          .attr('stroke', 'none')
          .on('mouseover', () => {
            tooltip.html(`
              <strong>${tr[language].period} P${i + 1}</strong>
            `).style('display', 'block');
          })
          .on('mousemove', (event: any) => {
            tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
          })
          .on('mouseout', () => tooltip.style('display', 'none'));

      // Add period label (P1, P2, etc.)
      g.append('text')
        .attr('x', timeScale(period.start) + (timeScale(period.end) - timeScale(period.start)) / 2)
        .attr('y', -50) // Increased distance from the period fields
        .attr('text-anchor', 'middle')
        .attr('fill', kthColors.KthBlue?.HEX)
        .attr('font-weight', 500)
        .attr('font-size', 14)
        .text(`P${i + 1}`);
    });

    // Month labels across the whole timeline
    {
      const start = academicPeriods[0].start;
      const end = academicPeriods[academicPeriods.length - 1].end;
      const months: Date[] = [];
      const d = new Date(start.getFullYear(), start.getMonth(), 1);
      while (d <= end) {
        months.push(new Date(d));
        d.setMonth(d.getMonth() + 1);
      }

      // vertical month boundary lines with same gray and roughly label height
      const monthLabelY = -28;
      const labelHeight = 12;
      months.forEach((md, idx) => {
        if (idx > 0) {
          const xBoundary = timeScale(new Date(md.getFullYear(), md.getMonth(), 1));
          g.append('line')
            .attr('x1', xBoundary)
            .attr('y1', monthLabelY - labelHeight / 2)
            .attr('x2', xBoundary)
            .attr('y2', monthLabelY + labelHeight / 2)
            .attr('stroke', '#f0f2f5ff')
            .attr('stroke-width', 5);
        }
      });

      months.forEach((md) => {
        const label = tr[language].months[md.getMonth()];
        // position in the middle of the month
        const monthStart = new Date(md.getFullYear(), md.getMonth(), 1);
        const monthEnd = new Date(md.getFullYear(), md.getMonth() + 1, 0);
        const mid = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
        g.append('text')
          .attr('x', timeScale(mid))
          .attr('y', monthLabelY)
          .attr('text-anchor', 'middle')
          .attr('fill', '#9ca3af')
          .attr('font-size', 10)
          .text(label);
      });
    }

    // Draw exam periods with extension above and below
    academicPeriods.forEach(period => {
      const examHeight = height + 2 * periodExtension;
      const yOffset = -periodExtension;

      // Regular exam period (subtle KTH light blue)
      g.append('rect')
        .attr('x', timeScale(period.examStart))
        .attr('y', yOffset)
        .attr('width', timeScale(period.examEnd) - timeScale(period.examStart))
        .attr('height', examHeight)
        .attr('class', 'exam-period-rect')
        .attr('fill', (kthColors.KthLightBlue?.HEX ? d3.color(kthColors.KthLightBlue.HEX)!.copy({ opacity: 0.25 }).formatRgb() : 'rgba(222,240,255,0.25)'))
          .attr('stroke', 'none')
          .on('mouseover', () => {
            tooltip.html(`
              <strong>${tr[language].examPeriodLabel} ${period.id}</strong><br/>
            `).style('display', 'block');
          })
          .on('mousemove', (event: any) => {
            tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
          })
          .on('mouseout', () => tooltip.style('display', 'none'));

      // Re-exam period (light gray)
      g.append('rect')
        .attr('x', timeScale(period.reExamStart))
        .attr('y', yOffset)
        .attr('width', timeScale(period.reExamEnd) - timeScale(period.reExamStart))
        .attr('height', examHeight)
        .attr('class', 'reexam-period-rect')
        .attr('fill', (kthColors.KthLightGray?.HEX ? d3.color(kthColors.KthLightGray.HEX)!.copy({ opacity: 0.18 }).formatRgb() : 'rgba(230,230,230,0.18)'))
          .attr('stroke', 'none')
          .on('mouseover', () => {
            tooltip.html(`
              <strong>${tr[language].reexamPeriodLabel} ${period.id}</strong><br/>
            `).style('display', 'block');
          })
          .on('mousemove', (event: any) => {
            tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
          })
          .on('mouseout', () => tooltip.style('display', 'none'));
    });

    // Compute max parallel slots per year to determine lane heights
    const maxSlotsPerYear: Record<number, number> = {};
    Object.keys(slotsByYearPeriod).forEach((key) => {
      const [yearStr] = key.split('-');
      const year = Number(yearStr);
      maxSlotsPerYear[year] = Math.max(maxSlotsPerYear[year] || 0, slotsByYearPeriod[key].length);
    });

  // Prepare a position map for drawing arrows and markers later
  const positionMap: Record<string, { xStart: number; xEnd: number; yCenter: number; yTop: number; height: number }> = {};

    // Draw courses with stacking by ECTS within each year+period (15 ECTS maps to the full year band)
    Object.entries(slotsByYearPeriod).forEach(([key, list]) => {
    const [yearStr, periodId] = key.split('-');
      const year = Number(yearStr);
      const period = academicPeriods.find((p) => p.id === (periodId as any))!;
  const yearIndex = year - 1;
  const yearY = yearYOffset[yearIndex];
      const w = timeScale(period.end) - timeScale(period.start);
      const x = timeScale(period.start);

    // pixels per ECTS for the year band (baseline set from initial layout)
    const pixelsPerECTS = pxPerECTS;

    const gapPx = STACK_GAP_PX; // doubled gap between stacked bars (was 2)
    let cursorY = verticalOffset + yearY; // start at the top of the year band

      list.forEach((item) => {
        const credit = item.credit;
        const course = item.course;
  const rawHeight = pixelsPerECTS * credit.credits;
  const minHeight = pixelsPerECTS * MIN_ECTS_FOR_HEIGHT;
  const courseHeight = Math.max(rawHeight, minHeight); // ensure minimal visible height equal to 2 ECTS

  const block = g.append('g').attr('class', 'course-group').attr('data-course', course.code);

  const periodObj = academicPeriods.find(p => p.id === credit.period)!;
  const courseWidth = timeScale(new Date(periodObj.lectureEnd)) - timeScale(new Date(periodObj.start));
  const barX = x + 2;
  const barWidth = Math.max(0, courseWidth - 4);

  // Determine color based on course group and vary within family
  const colors = getCourseColors(course);

  block.append('rect')
    .attr('x', barX)
          .attr('y', cursorY)
    .attr('width', barWidth)
          .attr('height', courseHeight)
            .attr('fill', colors.fill)
            .attr('stroke', colors.stroke)
            .attr('rx', 4)
            .attr('ry', 4)
            .attr('class', 'course-block')
            .attr('data-course-code', course.code)
            .style('cursor', 'pointer')
            .on('mouseover', (event: any) => {
              const allCompleted = (course as any).prerequisitesCompleted || course.prerequisites || [];
              const allParticipation = (course as any).prerequisitesParticipation || [];
              const prereqCombined = Array.from(new Set([...(allCompleted || []), ...(allParticipation || [])]));
              const prereqCodes = prereqCombined.join(', ') || '—';
              const dependents = courses.filter(c => {
                const comp = (c as any).prerequisitesCompleted || c.prerequisites || [];
                const part = (c as any).prerequisitesParticipation || [];
                return (comp.includes(course.code) || part.includes(course.code));
              }).map(c => c.code);
              const dependentCodes = dependents.length ? dependents.join(', ') : '—';
              const txt = `<strong>${course.code}</strong><br/>${course.name}<br/>${credit.credits} ${tr[language].credits}<br/><em>${tr[language].requires}:</em> ${prereqCodes}<br/><em>${tr[language].requiredFor}:</em> ${dependentCodes}`;
              tooltip.html(txt).style('display', 'block');
            })
            .on('mousemove', (event: any) => {
              tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
            })
            .on('mouseout', () => tooltip.style('display', 'none'))
            .on('click', (event: any) => {
              event.stopPropagation();
              setFocusCourse(prev => {
                const next = prev === course.code ? null : course.code;
                if (next) {
                  setSelectedInfo({ course, credit: { period: credit.period as any, credits: credit.credits, year: (credit as any).year || course.year } });
                } else {
                  setSelectedInfo(null);
                }
                return next;
              });
            });

        // store positions for arrows and markers
        positionMap[`${course.code}-${(credit as any).year}-${credit.period}`] = {
          xStart: barX,
          xEnd: barX + barWidth,
          yCenter: cursorY + courseHeight / 2,
          yTop: cursorY,
          height: courseHeight
        };

        // labels inside the bar (code and name on the same row)
    const padding = 6;
    const textX = barX + padding;
        const textY = cursorY + 14; // single row baseline for both code and name
  const maxWidth = Math.max(0, barWidth - padding * 2);

        const label = block.append('text')
          .attr('x', textX)
          .attr('y', textY)
          .attr('font-size', 11)
          .attr('pointer-events', 'none')
          .attr('class', 'course-label');

        // course code (bold)
        label.append('tspan')
          .text(course.code + ' ')
          .attr('font-weight', 700)
          .attr('fill', colors.text);

        // course name (normal)
        const nameTspan = label.append('tspan')
          .text((course as any).briefName || course.name)
          .attr('font-weight', 400)
          .attr('fill', kthColors.KthBrokenWhite?.HEX || '#FFFFFF');

        // truncate name if it overflows available width
        // measure combined length and trim the name portion
        try {
          let nameText = nameTspan.text();
          while ((label.node() as SVGTextElement).getComputedTextLength() > maxWidth && nameText.length > 3) {
            nameText = nameText.slice(0, -1);
            nameTspan.text(nameText + '…');
          }
        } catch (e) {
          // safe guard for environments where getComputedTextLength may fail
        }

        // advance cursor for next stacked item
        cursorY += courseHeight + gapPx;
      });
    });

    // Year labels on the left
    // Collect exam / re-exam markers so we can draw them on the top layer later
    const examMarkers: Array<any> = [];
    const reexamMarkers: Array<any> = [];
    courses.forEach((course) => {
  const examsGlobal: string[] = (course as any).exams || [];
  const reexamsGlobal: string[] = (course as any).reexams || [];
  const examByYear = (course as any).examsByYear as Record<number, string[]> | undefined;
  const reexamByYear = (course as any).reexamsByYear as Record<number, string[]> | undefined;

      course.credits.forEach((credit) => {
        const y = (credit as any).year as number;
        const examsForYear = examByYear?.[y];
        const reexamsForYear = reexamByYear?.[y];

        const hasExam = Array.isArray(examsForYear)
          ? examsForYear.includes(credit.period as any)
          : examsGlobal.includes(credit.period as any);
        const hasReexam = Array.isArray(reexamsForYear)
          ? reexamsForYear.includes(credit.period as any)
          : reexamsGlobal.includes(credit.period as any);

        if (hasExam) {
          const examPeriod = academicPeriods.find(p => p.id === (credit.period as any));
          if (examPeriod) {
            const pos = positionMap[`${course.code}-${y}-${credit.period}`];
            if (pos) {
              const xExam = timeScale(new Date((+examPeriod.examStart + +examPeriod.examEnd) / 2));
              examMarkers.push({ x: xExam, cy: pos.yCenter, r: EXAM_MARKER_RADIUS, course, examPeriod });
            }
          }
        }
        if (hasReexam) {
          const rePeriod = academicPeriods.find(p => p.id === (credit.period as any));
          if (rePeriod) {
            const pos = positionMap[`${course.code}-${y}-${credit.period}`];
            if (pos) {
              const xRe = timeScale(new Date((+rePeriod.reExamStart + +rePeriod.reExamEnd) / 2));
              reexamMarkers.push({ x: xRe, cy: pos.yCenter, r: REEXAM_MARKER_RADIUS, course, rePeriod });
            }
          }
        }
      });
    });
    for (let i = 0; i < numYears; i++) {
      const yearLabelY = yearYOffset[i] + yearBandHeights[i] / 2;
      g.append('text')
        .attr('x', -margin.left + 12)
        .attr('y', yearLabelY)
        .text(`${tr[language].year} ${i + 1}`)
        .attr('font-size', 14)
        .attr('font-weight', 700)
        .attr('fill', kthColors.KthBlue?.HEX || '#111827')
        .attr('dominant-baseline', 'middle');
    }

    // Draw arrows for prerequisites using stored positions
    const periodOrder: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

    // Add arrow marker definitions (gray and blue)
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow-gray')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#999');

    defs.append('marker')
      .attr('id', 'arrow-blue')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', kthColors.KthBlue?.HEX || '#004791');

    const drawPrereqArrows = (course: Course, prereqCodes: string[], style: { stroke: string; dash?: string; markerId: string }) => {
      if (!prereqCodes || prereqCodes.length === 0) return;
      const courseCreditsSorted = [...course.credits].sort((a: any, b: any) => (a.year - b.year) || (periodOrder[a.period] - periodOrder[b.period]));
      prereqCodes.forEach((prCode) => {
        const prereq = courses.find((c) => c.code === prCode);
        if (!prereq) return;
        const prereqCreditsSorted = [...prereq.credits].sort((a: any, b: any) => (a.year - b.year) || (periodOrder[a.period] - periodOrder[b.period]));
        const lastPrereq = prereqCreditsSorted[prereqCreditsSorted.length - 1];
        const firstCourse = courseCreditsSorted[0];
        if (!lastPrereq || !firstCourse) return;
        const from = positionMap[`${prereq.code}-${lastPrereq.year}-${lastPrereq.period}`];
        const to = positionMap[`${course.code}-${firstCourse.year}-${firstCourse.period}`];
        if (!from || !to) return;

        const midX = (from.xEnd + to.xStart) / 2;
        const points = [
          [from.xEnd, from.yCenter],
          [midX, from.yCenter],
          [midX, to.yCenter],
          [to.xStart, to.yCenter]
        ];

        const path = g.append('path')
          .attr('d', d3.line()(points as any))
          .attr('stroke', style.stroke)
          .attr('stroke-width', 1)
          .attr('fill', 'none')
          .attr('marker-end', `url(#${style.markerId})`)
          .attr('class', 'prereq-path')
          .attr('data-from', prereq.code)
          .attr('data-to', course.code);
        if (style.dash) path.attr('stroke-dasharray', style.dash);
      });
    };

    courses.forEach((course) => {
      const completed = (course as any).prerequisitesCompleted || course.prerequisites || [];
      const participated = (course as any).prerequisitesParticipation || [];
      drawPrereqArrows(course, completed, { stroke: '#999', markerId: 'arrow-gray' });
      drawPrereqArrows(course, participated, { stroke: (kthColors.KthBlue?.HEX || '#004791'), dash: '4,3', markerId: 'arrow-blue' });
    });

  // style initial visibility based on layers state
  // note: this will run on each redraw so it's safe to set here
  container.selectAll('.study-period').style('display', layers.studyPeriods ? '' : 'none');
  container.selectAll('.exam-period-rect').style('display', layers.examPeriods ? '' : 'none');
  container.selectAll('.reexam-period-rect').style('display', layers.reexamPeriods ? '' : 'none');
  // course blocks and labels
  container.selectAll('.course-block').style('display', layers.courseBars ? '' : 'none');
  container.selectAll('.course-label').style('display', layers.courseBars ? '' : 'none');
  // exam/reexam markers
  container.selectAll('.exam-dot').style('display', layers.exams ? '' : 'none');
  container.selectAll('.reexam-dot').style('display', layers.reexams ? '' : 'none');

  // create a dedicated top layer group so markers always render above chart elements
  const topLayer = svg.append('g')
    .attr('class', 'pv-top-layer')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Draw exam markers in topLayer, aligned horizontally to exam period and vertically to course
  examMarkers.forEach((m) => {
    const colors = getCourseColors(m.course);
    topLayer.append('circle')
      .attr('cx', m.x)
      .attr('cy', m.cy)
      .attr('r', EXAM_MARKER_RADIUS)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke)
      .attr('stroke-width', EXAM_MARKER_STROKE_WIDTH)
      .style('pointer-events', 'auto')
      .attr('class', 'exam-dot')
      .attr('data-layer', 'exams')
      .attr('data-course', m.course.code)
      .on('mouseover', (event: any) => {
        tooltip.html(`<strong>${m.course.code}</strong><br/>${tr[language].exam}`).style('display', 'block');
      })
      .on('mousemove', (event: any) => {
        tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
      })
      .on('mouseout', () => tooltip.style('display', 'none'));
  });

  reexamMarkers.forEach((m) => {
    const colors = getCourseColors(m.course);
    topLayer.append('circle')
      .attr('cx', m.x)
      .attr('cy', m.cy)
      .attr('r', REEXAM_MARKER_RADIUS)
      .attr('fill', 'none')
      .attr('stroke', colors.stroke)
      .attr('stroke-width', REEXAM_MARKER_STROKE_WIDTH)
      .style('pointer-events', 'auto')
      .attr('class', 'reexam-dot')
      .attr('data-layer', 'reexams')
      .attr('data-course', m.course.code)
      .on('mouseover', (event: any) => {
        tooltip.html(`<strong>${m.course.code}</strong><br/>${tr[language].reexam}`).style('display', 'block');
      })
      .on('mousemove', (event: any) => {
        tooltip.style('left', (event.pageX + 50) + 'px').style('top', (event.pageY + 50) + 'px');
      })
      .on('mouseout', () => tooltip.style('display', 'none'));
  });

  }, [courses, layers, language]);

  // Removed popup; outside clicks handled by svg.on('click') above

  // Update element opacities when layers change
  useEffect(() => {
    if (!containerRef.current) return;
    const container = d3.select(containerRef.current);

    // Exams: hide/show completely and adjust pointer-events
    container.selectAll<SVGCircleElement, any>('.exam-dot')
      .interrupt()
      .style('display', layers.exams ? '' : 'none')
      .style('opacity', layers.exams ? '1' : '0.2')
      .style('pointer-events', layers.exams ? 'auto' : 'none');

    // Reexams
    container.selectAll<SVGCircleElement, any>('.reexam-dot')
      .interrupt()
      .style('display', layers.reexams ? '' : 'none')
      .style('opacity', layers.reexams ? '1' : '0.2')
      .style('pointer-events', layers.reexams ? 'auto' : 'none');

    // Prerequisites
    container.selectAll<SVGPathElement, any>('.prereq-path')
      .interrupt()
      .style('display', layers.prerequisites ? '' : 'none')
      .style('opacity', layers.prerequisites ? '1' : '0.15')
      .style('pointer-events', layers.prerequisites ? 'auto' : 'none');

    // Study periods (background alternating)
    container.selectAll<SVGRectElement, any>('.study-period')
      .interrupt()
      .style('display', layers.studyPeriods ? '' : 'none');

    // Course bars (main course rectangles)
    container.selectAll<SVGRectElement, any>('.course-block')
      .interrupt()
      .style('display', layers.courseBars ? '' : 'none')
      .style('pointer-events', layers.courseBars ? 'auto' : 'none');

    // Exam periods (blue)
    container.selectAll<SVGRectElement, any>('.exam-period-rect')
      .interrupt()
      .style('display', layers.examPeriods ? '' : 'none');

    // Reexam periods (gray)
    container.selectAll<SVGRectElement, any>('.reexam-period-rect')
      .interrupt()
      .style('display', layers.reexamPeriods ? '' : 'none');
  }, [layers]);

  // Focus mode: fade out unrelated courses/markers/arrows when a course is selected
  useEffect(() => {
    if (!containerRef.current) return;
    const container = d3.select(containerRef.current);
    if (!focusCourse) {
      // remove focus overrides, restore baseline from layer settings
      container.selectAll('.course-group').style('opacity', null as any);
      container.selectAll('.exam-dot').style('opacity', null as any);
      container.selectAll('.reexam-dot').style('opacity', null as any);
      container.selectAll('.prereq-path').style('opacity', null as any);
      return;
    }

    const selected = courses.find(c => c.code === focusCourse);
    if (!selected) return;
    const prereqCompleted = ((selected as any).prerequisitesCompleted || selected.prerequisites || []) as string[];
    const prereqParticipation = ((selected as any).prerequisitesParticipation || []) as string[];
    const prereqSet = new Set([...(prereqCompleted || []), ...(prereqParticipation || [])]);
    const dependentSet = new Set(
      courses.filter(c => {
        const comp = (c as any).prerequisitesCompleted || c.prerequisites || [];
        const part = (c as any).prerequisitesParticipation || [];
        return (comp.includes(selected.code) || part.includes(selected.code));
      }).map(c => c.code)
    );

    container.selectAll<SVGGElement, any>('.course-group')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.15';
      });

    container.selectAll<SVGCircleElement, any>('.exam-dot, .reexam-dot')
      .style('opacity', function() {
        const code = (this as Element).getAttribute('data-course');
        const keep = !!code && (code === focusCourse || prereqSet.has(code) || dependentSet.has(code));
        return keep ? '1' : '0.15';
      });

    container.selectAll<SVGPathElement, any>('.prereq-path')
      .style('opacity', function() {
        const from = (this as Element).getAttribute('data-from');
        const to = (this as Element).getAttribute('data-to');
        const keep = (to === focusCourse && !!from && prereqSet.has(from)) || (from === focusCourse && !!to && dependentSet.has(to));
        return keep ? '1' : '0.15';
      });
  }, [focusCourse, courses]);

  return (
    <div ref={containerRef}>
      {/* Visualization canvas wrapper so legend anchors to the SVG area only */}
      <div style={{ position: 'relative' }}>
        <svg 
          ref={svgRef} 
          className="w-full h-full"
          style={{ minHeight: '600px' }}
        />

        {/* Legend positioned as an overlay in bottom-right of the SVG wrapper */}
        <div style={{ position: 'absolute', right: STYLE.legend.offsetX, bottom: STYLE.legend.offsetY, width: STYLE.legend.width, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: '8px 12px', background: STYLE.legend.background, border: `1px solid ${STYLE.legend.borderColor}`, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.12)', zIndex: 1000 }}>
        {/* Exams */}
        <div onClick={() => setLayers(s => ({ ...s, exams: !s.exams }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.exams ? 1 : 0.4 }}>
          <svg width={16} height={16} viewBox="0 0 16 16">
            <circle cx={8} cy={8} r={6} fill={kthColors.KthBrick?.HEX || '#E86A58'} />
          </svg>
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.exams}</span>
        </div>

        {/* Reexams */}
        <div onClick={() => setLayers(s => ({ ...s, reexams: !s.reexams }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.reexams ? 1 : 0.4 }}>
          <svg width={16} height={16} viewBox="0 0 16 16">
            <circle cx={8} cy={8} r={6} fill="none" stroke={kthColors.KthBrick?.HEX || '#E86A58'} strokeWidth={1.5} />
          </svg>
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.reexams}</span>
        </div>

        {/* Prerequisites - completion */}
        <div onClick={() => setLayers(s => ({ ...s, prerequisites: !s.prerequisites }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.prerequisites ? 1 : 0.4 }}>
          <svg width={16} height={16} viewBox="0 0 20 16">
            <path d="M2 8 L18 8" stroke="#999" strokeWidth={2} fill="none" />
            <path d="M14 6 L18 8 L14 10" fill="#999" />
          </svg>
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.prerequisitesCompleted}</span>
        </div>

        {/* Prerequisites - participation */}
        <div onClick={() => setLayers(s => ({ ...s, prerequisites: !s.prerequisites }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.prerequisites ? 1 : 0.4 }}>
          <svg width={16} height={16} viewBox="0 0 20 16">
            <path d="M2 8 L18 8" stroke={kthColors.KthBlue?.HEX || '#004791'} strokeWidth={2} strokeDasharray="4,3" fill="none" />
            <path d="M14 6 L18 8 L14 10" fill={kthColors.KthBlue?.HEX || '#004791'} />
          </svg>
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.prerequisitesParticipation}</span>
        </div>

        {/* Courses */}
        <div onClick={() => setLayers(s => ({ ...s, courseBars: !s.courseBars }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.courseBars ? 1 : 0.4 }}>
          <div style={{ width: 18, height: 12, background: kthColors.KthHeaven?.HEX || '#6298D2', borderRadius: 2, border: '1px solid rgba(0,0,0,0.06)' }} />
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.courses}</span>
        </div>

        {/* Study periods */}
        <div onClick={() => setLayers(s => ({ ...s, studyPeriods: !s.studyPeriods }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.studyPeriods ? 1 : 0.4 }}>
          <div style={{ width: 18, height: 12, background: kthColors.KthSand?.HEX || '#f3f4f6', borderRadius: 2, border: '1px solid rgba(0,0,0,0.06)' }} />
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.studyPeriods}</span>
        </div>

        {/* Exam periods */}
        <div onClick={() => setLayers(s => ({ ...s, examPeriods: !s.examPeriods }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.examPeriods ? 1 : 0.4 }}>
          <div style={{ width: 18, height: 12, background: kthColors.KthLightBlue?.HEX || '#DEF0FF', borderRadius: 2, border: '1px solid rgba(0,0,0,0.06)' }} />
          <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{tr[language].legend.examPeriods}</span>
        </div>

        {/* Reexam periods */}
        <div onClick={() => setLayers(s => ({ ...s, reexamPeriods: !s.reexamPeriods }))} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', opacity: layers.reexamPeriods ? 1 : 0.4 }}>
          <div style={{ width: 18, height: 12, background: kthColors.KthLightGray?.HEX || '#eee', borderRadius: 2, border: '1px solid rgba(0,0,0,0.06)' }} />
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
              return (
                <div key={group.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ width: 18, height: 12, background: gradient as any, borderRadius: 2, border: `1px solid ${borderColor}` }} />
                  <span style={{ fontSize: 12, color: STYLE.legend.textColor }}>{group.name}</span>
                </div>
              );
            })}
          </>
        )}
        </div>
      </div>

      {/* Info Panel below chart (outside SVG wrapper) */}
      <div style={{ marginTop: 12, padding: '12px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        {selectedInfo ? (
          <div style={{ color: kthColors.KthBlue?.HEX || '#004791' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {selectedInfo.course.code}{' '}
                  <a href={`https://www.kth.se/student/kurser/kurs/${selectedInfo.course.code.toLowerCase()}`}
                     target="_blank" rel="noopener noreferrer"
                     style={{ color: kthColors.KthHeaven?.HEX, textDecoration: 'none', fontWeight: 500 }}>
                    {tr[language].viewCourse}
                  </a>
                </div>
                <div style={{ marginBottom: 8 }}>
                  {selectedInfo.course.name}
                  {selectedInfo.credit ? `, ${selectedInfo.credit.credits} ${tr[language].credits}` : ''}
                </div>
              </div>
              <div>
                <button onClick={() => { setFocusCourse(null); setSelectedInfo(null); }}
                        className="px-2 py-1 border border-gray-300 rounded-md shadow-sm"
                        style={{ color: kthColors.KthBlue?.HEX }}>
                  ×
                </button>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <strong>{tr[language].requires}:</strong>{' '}
              {(selectedInfo.course.prerequisites || []).length
                ? (selectedInfo.course.prerequisites || []).join(', ')
                : '—'}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>{tr[language].requiredFor}:</strong>{' '}
              {(() => {
                const dependents = courses.filter(c => (c.prerequisites || []).includes(selectedInfo.course.code)).map(c => c.code);
                return dependents.length ? dependents.join(', ') : '—';
              })()}
            </div>
            {selectedInfo.course.teacher ? (
              <div style={{ marginBottom: 8 }}>
                <strong>{tr[language].teacher}:</strong> {selectedInfo.course.teacher}
              </div>
            ) : null}
            {selectedInfo.course.description ? (
              <div style={{ marginBottom: 8 }}>{selectedInfo.course.description}</div>
            ) : null}
          </div>
        ) : (
          <div style={{ color: '#6b7280' }}>
            {/* Empty state */}
          </div>
        )}
      </div>
    </div>
  );
});

export default TimelineVisualization;