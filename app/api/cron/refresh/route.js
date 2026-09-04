export const dynamic = 'force-dynamic';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Endpoint pronto per Vercel Cron. Verrà collegato al database quando
  // implementiamo ingestione fixture/statistiche e ricalcolo dei ranking.
  return Response.json({ ok: true, refreshed: false, reason: 'database_not_connected_yet' });
}
