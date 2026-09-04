import { football } from '../../../lib/api-football';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'Data richiesta nel formato YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const data = await football.fixturesByDate(date);
    return Response.json({ results: data.results ?? 0, fixtures: data.response ?? [] });
  } catch (error) {
    return Response.json({ error: error.message || 'Errore API-Football' }, { status: error.status || 500 });
  }
}
