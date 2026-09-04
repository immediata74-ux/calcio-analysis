import './globals.css';

export const metadata = {
  title: 'Calcio Analysis',
  description: 'Analisi prudente di ammoniti, marcatori e corner con dati API-Football',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#080808',
};

export default function RootLayout({ children }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
