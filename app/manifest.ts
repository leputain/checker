import type { MetadataRoute } from 'next';
import { appPath } from '@/lib/app-path.ts';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Candidate Check',
    short_name: 'Candidate Check',
    description: 'Короткий адаптивный тест для прозрачной оценки кандидатов.',
    start_url: appPath('/'),
    display: 'standalone',
    background_color: '#09100e',
    theme_color: '#09100e',
    orientation: 'any',
    icons: [
      {
        src: appPath('/assets/brand/checker-mascot-v1.png'),
        sizes: '2048x2048',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: appPath('/assets/brand/checker-mascot-v1.png'),
        sizes: '2048x2048',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
