export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    cards: [],
    scorers: [],
    corners: [],
    note: 'Usa /api/analyze?date=YYYY-MM-DD per calcolare i Top con dati reali API-Football.',
  });
}
