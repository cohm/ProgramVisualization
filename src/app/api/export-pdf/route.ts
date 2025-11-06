import { NextRequest } from 'next/server';
import puppeteer from 'puppeteer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    // Get the HTML content from the request body
    const { html } = await req.json();
    
    if (!html) {
      return new Response('Missing HTML content', { status: 400 });
    }
    
    // Launch headless browser
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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
