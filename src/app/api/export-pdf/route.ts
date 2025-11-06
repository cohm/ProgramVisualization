import { NextRequest } from 'next/server';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';

export const runtime = 'nodejs';
export const maxDuration = 60; // Increase timeout for PDF generation

export async function POST(req: NextRequest) {
  try {
    // Get the HTML content from the request body
    const { html } = await req.json();
    
    if (!html) {
      return new Response('Missing HTML content', { status: 400 });
    }
    
    // Detect if running on Vercel or locally
    const isVercel = !!process.env.VERCEL;
    
    // Launch headless browser
    const browser = await puppeteer.launch({
      args: isVercel 
        ? [...chromium.args, '--single-process'] 
        : ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: isVercel 
        ? await chromium.executablePath()
        : process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    
    const page = await browser.newPage();
    
    // Set the HTML content
    await page.setContent(html, {
      waitUntil: 'networkidle0' // Wait for fonts and resources to load
    });
    
    // Generate PDF with proper settings
    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      format: undefined // Use the size defined in the HTML/CSS
    });
    
    await browser.close();

    return new Response(Buffer.from(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="program-visualization.pdf"'
      }
    });
  } catch (e) {
    console.error('PDF export failed', e);
    return new Response(`Failed to generate PDF: ${e}`, { status: 500 });
  }
}
