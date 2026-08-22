import { NextRequest } from 'next/server';
import puppeteer, { Browser } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export const runtime = 'nodejs';
export const maxDuration = 60; // Increase timeout for PDF generation

// Maximum accepted HTML payload size (10 MB). Larger payloads are rejected
// before launching Chrome to prevent memory exhaustion or slow serverless runs.
const MAX_HTML_BYTES = 10 * 1024 * 1024;

// Ordered list of candidate Chrome/Chromium paths for local development.
// Checked in sequence; the first one that satisfies Puppeteer is used.
const LOCAL_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// Module-level Browser cache. Survives across requests within the same warm
// Lambda instance, saving the ~2-4 s @sparticuz/chromium cold-start on every
// PDF after the first. Vercel runs one request per instance by default, so
// concurrent reuse isn't a concern. The browser dies with the process.
let cachedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser?.connected) return cachedBrowser;

  const isVercel = !!process.env.VERCEL;
  let executablePath: string;
  if (isVercel) {
    executablePath = await chromium.executablePath();
  } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    const { existsSync } = await import('fs');
    executablePath = LOCAL_CHROME_PATHS.find(existsSync) ?? LOCAL_CHROME_PATHS[LOCAL_CHROME_PATHS.length - 1];
  }

  cachedBrowser = await puppeteer.launch({
    args: isVercel ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
    headless: true,
  });
  return cachedBrowser;
}

/**
 * Only accept same-origin browser requests.
 *
 * This endpoint renders caller-supplied HTML in a headless browser, which makes
 * it a useful oracle for anyone who can reach it: submit a document, get back a
 * rendered PDF of whatever the function was able to load. The export UI always
 * posts from the page itself, so `Origin` is present and matches the host; a
 * request without that pairing is not the export button.
 *
 * `Origin` is set by the browser and cannot be forged by page JavaScript, so
 * comparing it to the request's own host is a real check rather than a
 * formality. Falls back to `Referer` for clients that omit Origin on
 * same-origin POSTs.
 */
function isSameOrigin(req: NextRequest): boolean {
  const host = req.headers.get('host');
  if (!host) return false;
  const stated = req.headers.get('origin') ?? req.headers.get('referer');
  if (!stated) return false;
  try {
    return new URL(stated).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return new Response('Cross-origin requests are not accepted', { status: 403 });
  }

  // Enforce payload size limit before parsing JSON.
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_HTML_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  let html: string;
  try {
    const body = await req.json();
    html = body?.html ?? '';
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  if (!html) {
    return new Response('Missing HTML content', { status: 400 });
  }

  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // The document we generate is entirely static: an inline <style> with
    // base64 @font-face data URIs and a serialised SVG. It contains no <script>
    // and no external URL, and the Google Fonts fetch happens in the browser
    // before this POST. So both guards below are inert for a real export and
    // only bite on a document we did not write.

    // No page scripts. Without this, submitted HTML could fetch() an address
    // reachable from the server and write the response into the DOM, where it
    // would come back inside the PDF.
    await page.setJavaScriptEnabled(false);

    // No off-document loads. `data:`/`about:`/`blob:` cover the inlined fonts
    // and the initial document; anything else — an <img> pointing at an
    // internal host, an @import, an external stylesheet — is refused rather
    // than fetched on the caller's behalf.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (/^(data|about|blob):/i.test(url)) {
        void request.continue();
      } else {
        void request.abort('blockedbyclient');
      }
    });

    // Fonts are inlined as base64 in the HTML, so the page has no external
    // resources to wait for — `load` returns essentially immediately.
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });

    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      format: undefined,
    });

    return new Response(Buffer.from(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="program-visualization.pdf"',
      },
    });
  } catch (e) {
    console.error('PDF export failed', e);
    // If the cached browser is dead (process died, page crash), drop it so
    // the next request relaunches.
    if (cachedBrowser && !cachedBrowser.connected) {
      cachedBrowser = null;
    }
    return new Response('Failed to generate PDF. Check server logs for details.', { status: 500 });
  } finally {
    // Close only the page; keep the browser warm for subsequent requests.
    await page?.close().catch(() => {});
  }
}
