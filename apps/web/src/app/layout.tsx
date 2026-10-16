import type { Metadata } from 'next';
import { Figtree, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Brand template §3: Figtree for UI and body, Geist Mono for files, ids and paths. Self-hosted by
// next/font at build time; no request to Google from the browser.
const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-figtree',
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Saras',
  description: 'Build and ship with your team and AI, in one place.',
};

// The signed-in shell (top bar, sidebars) lives in app/(app)/layout.tsx; sign-in and join have none.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-bg font-sans text-text">{children}</body>
    </html>
  );
}
