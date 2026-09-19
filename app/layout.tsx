import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'WorkPulse Portal',
  description: 'WorkPulse supervisor and administration portal',
  icons: {
    icon: '/workpulse-app-icon.png',
    shortcut: '/workpulse-app-icon.png',
    apple: '/workpulse-app-icon.png',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
