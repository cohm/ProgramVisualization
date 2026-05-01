// Browser-side font embedding helper. Fetches Google Fonts CSS + each woff2
// file, base64-encodes them, and returns a ready-to-inline `@font-face`
// block. Cached in a module-level Map so subsequent exports skip the network
// entirely (REVIEW.md §3.5: previously every PNG/SVG/PDF export refetched
// the same ~50 KB of font data).

// Generic / system font names that should never be sent to Google Fonts.
const SYSTEM_FONTS = new Set([
  'ui-sans-serif', 'system-ui', 'sans-serif', 'serif', 'monospace',
  '-apple-system', 'BlinkMacSystemFont',
  'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'Noto Sans',
  'Apple Color Emoji', 'Segoe UI Emoji',
]);

const WEIGHTS = '300;400;500;600;700;800;900';

// Cached per font family. Promise-typed so concurrent callers share one
// in-flight fetch instead of issuing duplicate requests.
const cache = new Map<string, Promise<string>>();

function isSystemFont(name: string): boolean {
  return Array.from(SYSTEM_FONTS).some(s => name.includes(s));
}

async function fetchFontFaceCss(family: string): Promise<string> {
  // Step 1: ask Google Fonts for the @font-face declarations. The response
  // body contains URLs to woff2 files for each weight.
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${WEIGHTS}&display=swap`;
  const cssResp = await fetch(cssUrl);
  if (!cssResp.ok) return '';
  const cssText = await cssResp.text();

  const fontUrls = Array.from(cssText.matchAll(/url\((https:[^)]+\.(?:woff2|woff|ttf))\)/g)).map(m => m[1]);
  if (fontUrls.length === 0) return '';

  // Step 2: fetch each font file and inline as base64. We collapse all
  // weights into a single @font-face with `font-weight: 100 900` because the
  // SVG/PNG path doesn't differentiate weights — same as the previous
  // inline implementation in TimelineVisualization.tsx.
  const faces: string[] = [];
  for (const url of fontUrls) {
    const fontResp = await fetch(url);
    if (!fontResp.ok) continue;
    const buf = await fontResp.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    const base64 = btoa(binary);
    const format = url.includes('.woff2') ? 'woff2' : url.includes('.woff') ? 'woff' : 'truetype';
    faces.push(`@font-face { font-family: '${family}'; src: url(data:font/${format};base64,${base64}) format('${format}'); font-weight: 100 900; font-style: normal; }`);
  }
  return faces.join('\n');
}

// Returns a `@font-face` block (possibly empty) for the first non-system
// family in the comma-separated list. The first non-system family wins:
// matches the previous behaviour that broke out after the first successful
// embed.
export function getEmbeddedFontFaces(fontFamilyList: string): Promise<string> {
  const families = fontFamilyList.split(',').map(f => f.trim().replace(/['"]/g, ''));
  const target = families.find(f => !isSystemFont(f));
  if (!target) return Promise.resolve('');

  const cached = cache.get(target);
  if (cached) return cached;
  const p = fetchFontFaceCss(target).catch(() => '');
  cache.set(target, p);
  return p;
}
