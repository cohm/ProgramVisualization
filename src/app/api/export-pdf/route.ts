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

export async function POST(req: NextRequest) {
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

    // Fonts are inlined as base64 in the HTML, so the page has no external
    // resources to wait for — `load` returns essentially immediately.
    await page.setContent(html, { waitUntil: 'load' });

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
