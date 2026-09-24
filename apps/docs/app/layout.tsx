import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://thenation.city/swarm'),
  title: {
    default: 'Nation Team Chat Docs',
    template: '%s · Nation Team Chat Docs',
  },
  description: 'Install, configure, and extend your Nation Team Chat workspace.',
  openGraph: {
    title: 'Nation Team Chat Docs',
    description: 'Persistent AI teammates sharing one durable computer.',
    type: 'website',
  },
  icons: {
    icon: '/app-icon.svg',
    apple: '/app-icon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
