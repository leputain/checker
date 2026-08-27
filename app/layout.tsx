import type { Metadata, Viewport } from 'next';
import { Manrope, Playfair_Display } from 'next/font/google';
import './globals.css';

const manrope = Manrope({ variable: '--font-manrope', subsets: ['cyrillic', 'latin'] });
const playfair = Playfair_Display({ variable: '--font-playfair', subsets: ['cyrillic', 'latin'], style: ['italic'] });

const metadataBase = new URL(process.env.SITE_ORIGIN ?? 'http://localhost:3001');

export const metadata: Metadata = {
  metadataBase,
  title: 'Candidate Check — оценка кандидатов',
  description: 'Короткий адаптивный тест для прозрачной оценки кандидатов.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Candidate Check',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Candidate Check',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: '/assets/brand/checker-mascot-v1.png',
    apple: '/assets/brand/checker-mascot-v1.png',
  },
  openGraph: {
    type: 'website',
    title: 'Candidate Check',
    description: 'Оценка кандидатов без лишнего стресса.',
    images: [{ url: '/og.png', width: 1730, height: 909, alt: 'Candidate Check' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Candidate Check',
    description: 'Оценка кандидатов без лишнего стресса.',
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#09100e',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <head>
        <link rel="preload" as="image" href="/assets/brand/checker-background-v1.webp" type="image/webp" />
        <link rel="preload" as="image" href="/assets/brand/checker-mascot-v1.webp" type="image/webp" />
      </head>
      <body className={`${manrope.variable} ${playfair.variable}`}>{children}</body>
    </html>
  );
}
