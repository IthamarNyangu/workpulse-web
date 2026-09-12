import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WorkPulse Portal',
  description: 'WorkPulse supervisor and administration portal',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
