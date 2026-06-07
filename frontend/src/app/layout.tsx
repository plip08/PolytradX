import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '../components/Toaster';

export const metadata: Metadata = {
  title: 'Polymarket Quant Bot',
  description: 'Production HFT trading framework for Polymarket',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
