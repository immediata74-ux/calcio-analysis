export const metadata = {
  title: 'Calcio Analysis',
  description: 'Top ammoniti, marcatori e corner con report Excel mobile-first'
};

export default function RootLayout({ children }) {
  return (
    <html lang="it">
      <body style={{ margin: 0, background: '#050505', color: '#fff', fontFamily: 'Arial, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
