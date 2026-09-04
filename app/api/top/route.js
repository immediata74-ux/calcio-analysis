import { analyzeCards } from '../../../lib/analysis/cards';
import { analyzeScorers } from '../../../lib/analysis/scorers';
import { analyzeCorners } from '../../../lib/analysis/corners';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    cards: analyzeCards(),
    scorers: analyzeScorers(),
    corners: analyzeCorners(),
    note: 'Nessun dato sintetico: i ranking restano vuoti finché lo storico reale non è sufficiente.',
  });
}
