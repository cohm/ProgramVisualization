import { NextRequest } from 'next/server';
import puppeteer from 'puppeteer-core';
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

  // Detect if running on Vercel or locally
  const isVercel = !!process.env.VERCEL;

  let executablePath: string;
  if (isVercel) {
    // Use @sparticuz/chromium which bundles the binary for serverless environments.
    executablePath = await chromium.executablePath();
  } else {
    // Prefer an explicit override, then fall back through common install paths.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      const { existsSync } = await import('fs');
      executablePath = LOCAL_CHROME_PATHS.find(existsSync) ?? LOCAL_CHROME_PATHS[LOCAL_CHROME_PATHS.length - 1];
    }
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: isVercel
        ? chromium.args
        : ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Set the HTML content
    await page.setContent(html, {
      waitUntil: 'networkidle0', // Wait for fonts and resources to load
    });

    // Generate PDF with proper settings
    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      format: undefined, // Use the size defined in the HTML/CSS
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
    return new Response('Failed to generate PDF. Check server logs for details.', { status: 500 });
  } finally {
    // Always close the browser to avoid leaking processes, even on error.
    await browser?.close();
  }
}
