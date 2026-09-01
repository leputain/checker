import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ИБ-челлендж — Candidate Check',
  description: 'Пятнадцатиминутный внутренний челлендж по информационной безопасности.',
  robots: { index: false, follow: false },
};

export default function SecurityChallengeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
