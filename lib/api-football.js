const BASE_URL = 'https://v3.football.api-sports.io';

export class ApiFootballError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ApiFootballError';
    this.status = status;
  }
}

export async function apiFootball(path, params = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new ApiFootballError('APIFOOTBALL_KEY non configurata su Vercel.', 503);

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const response = await fetch(url, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
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
  fixturesByDate: (date) => apiFootball('/fixtures', { date, timezone: 'Europe/Rome' }),
  fixtureStatistics: (fixture) => apiFootball('/fixtures/statistics', { fixture }),
  fixtureEvents: (fixture) => apiFootball('/fixtures/events', { fixture }),
  fixturePlayers: (fixture) => apiFootball('/fixtures/players', { fixture }),
  fixtureLineups: (fixture) => apiFootball('/fixtures/lineups', { fixture }),
  league: (league, season) => apiFootball('/leagues', { id: league, season }),
  topScorers: (league, season) => apiFootball('/players/topscorers', { league, season }),
  topYellowCards: (league, season) => apiFootball('/players/topyellowcards', { league, season }),
  topRedCards: (league, season) => apiFootball('/players/topredcards', { league, season }),
};
