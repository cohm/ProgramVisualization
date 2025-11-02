import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const arrayBuffer = await req.arrayBuffer();
    const pngBytes = new Uint8Array(arrayBuffer);

  const pdfDoc = await PDFDocument.create();
  // Embed the PNG as an image
  const pngImage = await pdfDoc.embedPng(pngBytes);
  const { width, height } = pngImage; // use native image dimensions

  // Create a page sized exactly to the image and draw it without margins
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(pngImage, { x: 0, y: 0, width, height });

    const pdfBytes = await pdfDoc.save();

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="program-visualization.pdf"'
      }
    });
  } catch (e) {
    console.error('PDF export failed', e);
    return new Response('Failed to generate PDF', { status: 500 });
  }
}
