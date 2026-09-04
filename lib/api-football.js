const BASE_URL = 'https://v3.football.api-sports.io';

export class ApiFootballError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ApiFootballError';
    this.status = status;
  }
}

export async function apiFootball(path, params = {}, options = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new ApiFootballError('APIFOOTBALL_KEY non configurata su Vercel.', 503);

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const revalidate = Number.isFinite(options.revalidate) ? options.revalidate : 300;
  const response = await fetch(url, {
    headers: { 'x-apisports-key': key },
    ...(revalidate > 0 ? { next: { revalidate } } : { cache: 'no-store' }),
  });

  if (!response.ok) {
    throw new ApiFootballError(`API-Football HTTP ${response.status}`, response.status);
  }

  const data = await response.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new ApiFootballError(`API-Football: ${JSON.stringify(data.errors)}`, 502);
  }
  return data;
}

export const football = {
  fixturesByDate: (date) => apiFootball('/fixtures', { date, timezone: 'Europe/Rome' }, { revalidate: 120 }),
  fixturesByIds: (ids, revalidate = 120) => apiFootball('/fixtures', { ids: (ids || []).join('-') }, { revalidate }),
  fixtureStatistics: (fixture) => apiFootball('/fixtures/statistics', { fixture }, { revalidate: 86400 * 30 }),
  fixtureEvents: (fixture) => apiFootball('/fixtures/events', { fixture }, { revalidate: 86400 * 7 }),
  fixturePlayers: (fixture) => apiFootball('/fixtures/players', { fixture }, { revalidate: 86400 * 7 }),
  fixtureLineups: (fixture) => apiFootball('/fixtures/lineups', { fixture }, { revalidate: 300 }),
  league: (league, season) => apiFootball('/leagues', { id: league, season }, { revalidate: 86400 }),
  leagueFixturesWindow: (league, season, from, to) => apiFootball(
    '/fixtures',
    { league, season, from, to, status: 'FT', timezone: 'Europe/Rome' },
    { revalidate: 21600 },
  ),
  topScorers: (league, season) => apiFootball('/players/topscorers', { league, season }, { revalidate: 21600 }),
  topYellowCards: (league, season) => apiFootball('/players/topyellowcards', { league, season }, { revalidate: 21600 }),
  topRedCards: (league, season) => apiFootball('/players/topredcards', { league, season }, { revalidate: 21600 }),
};
