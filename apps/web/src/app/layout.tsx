import type { Metadata } from 'next';
import { Figtree, Geist_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, THEME_FALLBACK_SCRIPT, themeClass } from '../lib/theme';
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
  title: 'ParallelFlow',
  description: 'Build and ship with your team and AI, in one place.',
};

// The signed-in shell (top bar, sidebars) lives in app/(app)/layout.tsx; sign-in and join have none.
// The theme class comes from the parallelflow-theme cookie (lib/theme.ts), so the first paint is right.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(saved) ? themeClass(saved) : '';
  return (
    <html
      lang="en"
      className={`${figtree.variable} ${geistMono.variable}${theme ? ` ${theme}` : ''}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_FALLBACK_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-text">{children}</body>
    </html>
  );
}
