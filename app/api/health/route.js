export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    platform: 'vercel',
    apiKeyConfigured: Boolean(process.env.APIFOOTBALL_KEY),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
  });
}
