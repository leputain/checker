import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Candidate Check',
    short_name: 'Candidate Check',
    description: 'Короткий адаптивный тест для прозрачной оценки кандидатов.',
    start_url: '/',
    display: 'standalone',
    background_color: '#09100e',
    theme_color: '#09100e',
    orientation: 'any',
    icons: [
      {
        src: '/assets/brand/checker-mascot-v1.png',
        sizes: '2048x2048',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/assets/brand/checker-mascot-v1.png',
        sizes: '2048x2048',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
