import type { Metadata } from "next";
import { Figtree } from 'next/font/google';
import "./globals.css";

const figtree = Figtree({
  variable: '--font-figtree',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: "KTH - Visualisering av utbildningsprogram",
  description: "Interactive timeline visualization of KTH degree programs, showing courses, study periods, exam dates, and prerequisites.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${figtree.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
