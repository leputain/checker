import type { Metadata, Viewport } from 'next';
import type { CSSProperties } from 'react';
import './globals.css';
import { appPath } from '@/lib/app-path.ts';

const metadataBase = new URL('https://hub.themuha.cc/');

export const metadata: Metadata = {
  metadataBase,
  title: 'Candidate Check — оценка кандидатов',
  description: 'Короткий адаптивный тест для прозрачной оценки кандидатов.',
  manifest: appPath('/manifest.webmanifest'),
  applicationName: 'Candidate Check',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Candidate Check',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: appPath('/assets/brand/checker-mascot-v1.png'),
    apple: appPath('/assets/brand/checker-mascot-v1.png'),
  },
  openGraph: {
    type: 'website',
    title: 'Candidate Check',
    description: 'Оценка кандидатов без лишнего стресса.',
    images: [{ url: appPath('/og.png'), width: 1730, height: 909, alt: 'Candidate Check' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Candidate Check',
    description: 'Оценка кандидатов без лишнего стресса.',
    images: [appPath('/og.png')],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#09100e',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const bodyStyle = {
    '--candidate-background-image': `url("${appPath('/assets/brand/checker-background-v1.webp')}")`,
    '--candidate-mascot-image': `url("${appPath('/assets/brand/checker-mascot-v1.webp')}")`,
  } as CSSProperties;

  return (
    <html lang="ru">
      <head>
        <link rel="preload" as="image" href={appPath('/assets/brand/checker-background-v1.webp')} type="image/webp" />
        <link rel="preload" as="image" href={appPath('/assets/brand/checker-mascot-v1.webp')} type="image/webp" />
      </head>
      <body style={bodyStyle}>{children}</body>
    </html>
  );
}
