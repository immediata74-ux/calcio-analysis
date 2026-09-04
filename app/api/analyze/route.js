import { buildTopAnalysis } from '../../../lib/analysis/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || '';
  const league = searchParams.get('league') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'Data richiesta nel formato YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const analysis = await buildTopAnalysis({ date, league });
    return Response.json(analysis);
  } catch (error) {
    return Response.json({ error: error.message || 'Errore durante analisi API-Football' }, { status: error.status || 500 });
  }
}
