import type { Metadata } from 'next';
import { Manrope, Playfair_Display } from 'next/font/google';
import './globals.css';

const manrope = Manrope({ variable: '--font-manrope', subsets: ['cyrillic', 'latin'] });
const playfair = Playfair_Display({ variable: '--font-playfair', subsets: ['cyrillic', 'latin'], style: ['italic'] });

export const metadata: Metadata = { title: 'Candidate Check — оценка кандидатов', description: 'Короткий адаптивный тест для прозрачной оценки кандидатов.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body className={`${manrope.variable} ${playfair.variable}`}>{children}</body></html>; }
