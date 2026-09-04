import { football } from '../api-football';
import {
  chunk,
  confidenceFromMinutes,
  dateShift,
  expectedMinutes,
  fixtureLabel,
  isPreMatch,
  kickoffMs,
  mapLimit,
  mean,
  percent,
  playerLeagueStat,
  poissonAtLeast,
  quantile,
  clamp,
} from './common';

const MAX_ALL_LEAGUES = 8;
const MAX_CORNER_LEAGUES_ALL = 2;
const RECENT_CORNER_MATCHES = 5;
const CORNER_LOOKBACK_DAYS = 70;
const MIN_PLAYER_MINUTES = 270;
const MIN_PLAYER_APPEARANCES = 3;
const MAX_BATCH_IDS = 20;

function leagueKey(fixture) {
  return `${fixture?.league?.id}:${fixture?.league?.season}`;
}

function buildLeagueGroups(fixtures, leagueFilter) {
  const groups = new Map();
  for (const fixture of fixtures.filter(isPreMatch)) {
    const leagueId = Number(fixture?.league?.id);
    const season = Number(fixture?.league?.season);
    if (!leagueId || !season) continue;
    if (leagueFilter && Number(leagueFilter) !== leagueId) continue;
    const key = leagueKey(fixture);
    if (!groups.has(key)) {
      groups.set(key, {
        leagueId,
        season,
        name: fixture.league?.name || `League ${leagueId}`,
        fixtures: [],
      });
    }
    groups.get(key).fixtures.push(fixture);
  }
  return [...groups.values()].sort((a, b) => {
    if (b.fixtures.length !== a.fixtures.length) return b.fixtures.length - a.fixtures.length;
    return kickoffMs(a.fixtures[0]) - kickoffMs(b.fixtures[0]);
  });
}

function teamFixtureMap(fixtures) {
  const map = new Map();
  for (const fixture of fixtures) {
    const home = Number(fixture?.teams?.home?.id);
    const away = Number(fixture?.teams?.away?.id);
    if (home) map.set(home, fixture);
    if (away) map.set(away, fixture);
  }
  return map;
}

function seasonCoverage(leagueResponse, season) {
  const item = leagueResponse?.response?.[0];
  const exact = (item?.seasons || []).find(s => Number(s?.year) === Number(season));
  return exact?.coverage || null;
}

function seasonPlayerRows(entries, leagueId, season, kind) {
  const rows = [];
  for (const entry of entries || []) {
    const stat = playerLeagueStat(entry, leagueId, season);
    if (!stat) continue;
    const minutes = Number(stat?.games?.minutes);
    const appearances = Number(stat?.games?.appearences);
    const expected = expectedMinutes(stat);
    const teamId = Number(stat?.team?.id);
    if (!Number.isFinite(minutes) || minutes < MIN_PLAYER_MINUTES) continue;
    if (!Number.isFinite(appearances) || appearances < MIN_PLAYER_APPEARANCES) continue;
    if (!Number.isFinite(expected) || !teamId) continue;

    const count = kind === 'cards' ? Number(stat?.cards?.yellow) : Number(stat?.goals?.total);
    if (!Number.isFinite(count) || count < 0) continue;
    const rate90 = minutes > 0 ? (count * 90) / minutes : null;
    if (!Number.isFinite(rate90)) continue;

    rows.push({ entry, stat, minutes, appearances, expected, teamId, count, rate90 });
  }
  return rows;
}

function buildCardSignals(entries, group) {
  const fixtureByTeam = teamFixtureMap(group.fixtures);
  const rows = seasonPlayerRows(entries, group.leagueId, group.season, 'cards');
  const priorRaw = quantile(rows.map(r => r.rate90), 0.25);
  const priorRate = Number.isFinite(priorRaw) ? Math.min(priorRaw, 0.25) : null;
  if (!Number.isFinite(priorRate)) return [];
  const priorMinutes = 900;

  return rows.flatMap(row => {
    const fixture = fixtureByTeam.get(row.teamId);
    if (!fixture) return [];
    const exposure = row.minutes / 90;
    const priorExposure = priorMinutes / 90;
    const shrunkRate = (row.count + priorRate * priorExposure) / (exposure + priorExposure);
    const probability = 1 - Math.exp(-shrunkRate * row.expected / 90);
    const player = row.entry?.player || {};
    const red = Number(row.stat?.cards?.red);
    const yellowRed = Number(row.stat?.cards?.yellowred);

    return [{
      id: `card-${player.id}-${fixture.fixture?.id}`,
      playerId: Number(player.id),
      fixtureId: Number(fixture.fixture?.id),
      name: player.name || 'Giocatore N.D.',
      fixture: fixtureLabel(fixture),
      league: group.name,
      percent: percent(probability),
      confidence: confidenceFromMinutes(row.minutes, row.appearances),
      sample: `${row.minutes} min / ${row.appearances} pres.`,
      status: 'AVAILABLE',
      details: {
        yellow: row.count,
        red: Number.isFinite(red) ? red : null,
        yellowRed: Number.isFinite(yellowRed) ? yellowRed : null,
        rate90: Number(row.rate90.toFixed(2)),
        expectedMinutes: Math.round(row.expected),
        lineup: 'PRE-LINEUP',
        model: 'Ammonizione: Poisson regolarizzato sul tasso gialli/90 reale; minuti medi senza gonfiare i subentranti',
      },
      _shrunkRate: shrunkRate,
    }];
  }).sort((a, b) => b.percent - a.percent);
}

function buildScorerSignals(entries, group) {
  const fixtureByTeam = teamFixtureMap(group.fixtures);
  const rows = seasonPlayerRows(entries, group.leagueId, group.season, 'scorers');
  const priorRaw = quantile(rows.map(r => r.rate90), 0.25);
  const priorRate = Number.isFinite(priorRaw) ? Math.min(priorRaw, 0.25) : null;
  if (!Number.isFinite(priorRate)) return [];
  const priorMinutes = 1200;

  return rows.flatMap(row => {
    const fixture = fixtureByTeam.get(row.teamId);
    if (!fixture) return [];
    const exposure = row.minutes / 90;
    const priorExposure = priorMinutes / 90;
    const shrunkRate = (row.count + priorRate * priorExposure) / (exposure + priorExposure);
    const probability = 1 - Math.exp(-shrunkRate * row.expected / 90);
    const player = row.entry?.player || {};

    return [{
      id: `goal-${player.id}-${fixture.fixture?.id}`,
      playerId: Number(player.id),
      fixtureId: Number(fixture.fixture?.id),
      name: player.name || 'Giocatore N.D.',
      fixture: fixtureLabel(fixture),
      league: group.name,
      percent: percent(probability),
      confidence: confidenceFromMinutes(row.minutes, row.appearances),
      sample: `${row.minutes} min / ${row.appearances} pres.`,
      status: 'AVAILABLE',
      details: {
        goals: row.count,
        rate90: Number(row.rate90.toFixed(2)),
        expectedMinutes: Math.round(row.expected),
        lineup: 'PRE-LINEUP',
        model: 'Gol: Poisson regolarizzato sul tasso gol/90 reale; nessun bonus inventato per forma o avversario',
      },
      _shrunkRate: shrunkRate,
    }];
  }).sort((a, b) => b.percent - a.percent);
}

function lineupIndexFromFixtureBundle(bundle) {
  const lineups = Array.isArray(bundle?.lineups) ? bundle.lineups : [];
  if (!lineups.length) return null;
  const starters = new Set();
  const substitutes = new Set();
  for (const team of lineups) {
    for (const row of team?.startXI || []) {
      const id = Number(row?.player?.id);
      if (id) starters.add(id);
    }
    for (const row of team?.substitutes || []) {
      const id = Number(row?.player?.id);
      if (id) substitutes.add(id);
    }
  }
  return { starters, substitutes };
}

async function applyOfficialLineups(cards, scorers) {
  const fixtureIds = [...new Set([...cards, ...scorers].map(x => x.fixtureId).filter(Boolean))].slice(0, MAX_BATCH_IDS);
  if (!fixtureIds.length) return { cards, scorers, checked: 0 };

  let response;
  try {
    response = await football.fixturesByIds(fixtureIds, 0);
  } catch {
    return { cards, scorers, checked: 0 };
  }

  const byFixture = new Map();
  for (const bundle of response.response || []) {
    const id = Number(bundle?.fixture?.id);
    const index = lineupIndexFromFixtureBundle(bundle);
    if (id && index) byFixture.set(id, index);
  }

  function adjust(signal) {
    const lineup = byFixture.get(signal.fixtureId);
    if (!lineup) return signal;
    const playerId = Number(signal.playerId);
    if (lineup.starters.has(playerId)) {
      const mins = clamp(Math.max(signal.details.expectedMinutes || 0, 65), 55, 90);
      return {
        ...signal,
        percent: percent(1 - Math.exp(-signal._shrunkRate * mins / 90)),
        details: { ...signal.details, expectedMinutes: Math.round(mins), lineup: 'TITOLARE' },
      };
    }
    if (lineup.substitutes.has(playerId)) {
      const mins = clamp(Math.min(signal.details.expectedMinutes || 25, 25), 10, 25);
      return {
        ...signal,
        percent: percent(1 - Math.exp(-signal._shrunkRate * mins / 90)),
        confidence: signal.confidence === 'Alta' ? 'Media' : 'Bassa',
        details: { ...signal.details, expectedMinutes: Math.round(mins), lineup: 'PANCHINA' },
      };
    }
    // Formazione ufficiale presente ma giocatore non incluso: non forziamo il segnale.
    return null;
  }

  return {
    cards: cards.map(adjust).filter(Boolean),
    scorers: scorers.map(adjust).filter(Boolean),
    checked: byFixture.size,
  };
}

function statValue(statistics, type) {
  const item = (statistics || []).find(s => s?.type === type);
  const value = item?.value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function fixtureStatsRows(bundle) {
  const blocks = Array.isArray(bundle?.statistics) ? bundle.statistics : [];
  if (blocks.length < 2) return null;
  const rows = [];
  for (const own of blocks) {
    const teamId = Number(own?.team?.id);
    if (!teamId) continue;
    const opp = blocks.find(b => Number(b?.team?.id) !== teamId);
    const forCorners = statValue(own?.statistics, 'Corner Kicks');
    const againstCorners = statValue(opp?.statistics, 'Corner Kicks');
    if (!Number.isFinite(forCorners) || !Number.isFinite(againstCorners)) continue;
    rows.push({ teamId, forCorners, againstCorners, total: forCorners + againstCorners });
  }
  return rows.length ? rows : null;
}

async function cornerSignalsForGroup(group, date) {
  const teamIds = [...new Set(group.fixtures.flatMap(f => [Number(f?.teams?.home?.id), Number(f?.teams?.away?.id)]).filter(Boolean))];
  if (!teamIds.length) return [];

  let history;
  try {
    history = await football.leagueFixturesWindow(group.leagueId, group.season, dateShift(date, -CORNER_LOOKBACK_DAYS), dateShift(date, -1));
  } catch {
    return [];
  }

  const completed = (history.response || []).filter(f => f?.fixture?.status?.short === 'FT');
  const selectedByTeam = new Map();
  for (const teamId of teamIds) {
    const selected = completed
      .filter(f => Number(f?.teams?.home?.id) === teamId || Number(f?.teams?.away?.id) === teamId)
      .sort((a, b) => kickoffMs(b) - kickoffMs(a))
      .slice(0, RECENT_CORNER_MATCHES);
    selectedByTeam.set(teamId, selected.map(f => Number(f?.fixture?.id)).filter(Boolean));
  }

  const allIds = [...new Set([...selectedByTeam.values()].flat())];
  if (!allIds.length) return [];

  const bundleChunks = chunk(allIds, MAX_BATCH_IDS);
  const fetched = await mapLimit(bundleChunks, 3, async ids => {
    try {
      const res = await football.fixturesByIds(ids, 86400 * 30);
      return res.response || [];
    } catch {
      return [];
    }
  });
  const bundles = fetched.flat();
  const rowsByFixture = new Map();
  for (const bundle of bundles) {
    const fixtureId = Number(bundle?.fixture?.id);
    const rows = fixtureStatsRows(bundle);
    if (fixtureId && rows) rowsByFixture.set(fixtureId, rows);
  }

  const profile = new Map();
  for (const teamId of teamIds) {
    const rows = [];
    for (const fixtureId of selectedByTeam.get(teamId) || []) {
      const fixtureRows = rowsByFixture.get(fixtureId) || [];
      const row = fixtureRows.find(r => r.teamId === teamId);
      if (row) rows.push(row);
    }
    if (rows.length >= 3) {
      profile.set(teamId, {
        n: rows.length,
        forAvg: mean(rows.map(r => r.forCorners)),
        againstAvg: mean(rows.map(r => r.againstCorners)),
        totalAvg: mean(rows.map(r => r.total)),
      });
    }
  }

  const leagueTotals = [...rowsByFixture.values()]
    .map(rows => rows?.[0]?.total)
    .filter(Number.isFinite);
  const leagueMean = mean(leagueTotals);

  return group.fixtures.flatMap(fixture => {
    const homeId = Number(fixture?.teams?.home?.id);
    const awayId = Number(fixture?.teams?.away?.id);
    const home = profile.get(homeId);
    const away = profile.get(awayId);
    if (!home || !away) return [];

    const expectedHome = mean([home.forAvg, away.againstAvg]);
    const expectedAway = mean([away.forAvg, home.againstAvg]);
    const rawLambda = Number.isFinite(expectedHome) && Number.isFinite(expectedAway) ? expectedHome + expectedAway : null;
    if (!Number.isFinite(rawLambda) || rawLambda <= 0 || rawLambda > 25) return [];

    // Piccola regressione verso la media della competizione quando disponibile.
    const lambda = Number.isFinite(leagueMean) ? rawLambda * 0.8 + leagueMean * 0.2 : rawLambda;
    const thresholds = [7.5, 8.5, 9.5, 10.5, 11.5];
    const overs = Object.fromEntries(thresholds.map(t => [String(t), percent(poissonAtLeast(lambda, Math.floor(t) + 1))]));
    const n = Math.min(home.n, away.n);
    const confidence = n >= 5 ? 'Alta' : n >= 4 ? 'Media' : 'Bassa';

    return [{
      id: `corner-${fixture.fixture?.id}`,
      name: fixtureLabel(fixture),
      fixture: fixtureLabel(fixture),
      league: fixture?.league?.name || 'N.D.',
      percent: overs['8.5'],
      confidence,
      sample: `${home.n}+${away.n} gare recenti`,
      status: 'AVAILABLE',
      details: {
        expectedCorners: Number(lambda.toFixed(1)),
        over75: overs['7.5'],
        over85: overs['8.5'],
        over95: overs['9.5'],
        over105: overs['10.5'],
        over115: overs['11.5'],
        homeForAvg: Number(home.forAvg.toFixed(1)),
        awayForAvg: Number(away.forAvg.toFixed(1)),
        model: 'Corner reali delle ultime gare della stessa competizione + Poisson con regressione prudente verso la media lega',
      },
    }];
  });
}

function publicSignal(signal) {
  if (!signal) return signal;
  const { _shrunkRate, playerId, fixtureId, ...publicData } = signal;
  return publicData;
}

export async function buildTopAnalysis({ date, league }) {
  const fixtureData = await football.fixturesByDate(date);
  const allFixtures = fixtureData.response || [];
  const leagueFilter = league ? Number(league) : null;
  const groups = buildLeagueGroups(allFixtures, leagueFilter);
  const selectedGroups = leagueFilter ? groups.slice(0, 1) : groups.slice(0, MAX_ALL_LEAGUES);

  const withCoverage = await mapLimit(selectedGroups, 4, async group => {
    try {
      const res = await football.league(group.leagueId, group.season);
      return { ...group, coverage: seasonCoverage(res, group.season) };
    } catch {
      return { ...group, coverage: null };
    }
  });

  const perLeague = await mapLimit(withCoverage, 3, async group => {
    const canCards = group.coverage?.top_cards === true;
    const canScorers = group.coverage?.top_scorers === true;
    const tasks = [
      canCards ? football.topYellowCards(group.leagueId, group.season) : Promise.resolve(null),
      canScorers ? football.topScorers(group.leagueId, group.season) : Promise.resolve(null),
    ];
    const [cardsRes, scorersRes] = await Promise.allSettled(tasks);
    return {
      group,
      cards: cardsRes.status === 'fulfilled' && cardsRes.value ? buildCardSignals(cardsRes.value.response || [], group) : [],
      scorers: scorersRes.status === 'fulfilled' && scorersRes.value ? buildScorerSignals(scorersRes.value.response || [], group) : [],
    };
  });

  let cardCandidates = perLeague.flatMap(x => x.cards).sort((a, b) => b.percent - a.percent).slice(0, 24);
  let scorerCandidates = perLeague.flatMap(x => x.scorers).sort((a, b) => b.percent - a.percent).slice(0, 24);

  const lineupAdjusted = await applyOfficialLineups(cardCandidates, scorerCandidates);
  cardCandidates = lineupAdjusted.cards;
  scorerCandidates = lineupAdjusted.scorers;

  const cards = cardCandidates.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);
  const scorers = scorerCandidates.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);

  const cornerCovered = withCoverage.filter(g => g.coverage?.fixtures?.statistics_fixtures === true);
  const cornerGroups = leagueFilter ? cornerCovered.slice(0, 1) : cornerCovered.slice(0, MAX_CORNER_LEAGUES_ALL);
  const cornerNested = await mapLimit(cornerGroups, 2, group => cornerSignalsForGroup(group, date));
  const corners = cornerNested.flat().filter(Boolean).sort((a, b) => b.percent - a.percent).slice(0, 10);

  const leagueOptions = [...new Map(allFixtures.map(f => [Number(f?.league?.id), f?.league?.name]).filter(([id]) => id)).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));

  const coverageSummary = withCoverage.map(g => ({
    id: g.leagueId,
    name: g.name,
    topCards: g.coverage?.top_cards === true,
    topScorers: g.coverage?.top_scorers === true,
    fixtureStatistics: g.coverage?.fixtures?.statistics_fixtures === true,
  }));

  return {
    cards,
    scorers,
    corners,
    meta: {
      date,
      fixturesTotal: allFixtures.length,
      preMatchFixtures: allFixtures.filter(isPreMatch).length,
      analyzedLeagues: withCoverage.map(g => ({ id: g.leagueId, season: g.season, name: g.name, fixtures: g.fixtures.length })),
      coverageSummary,
      leagueOptions,
      lineupFixturesChecked: lineupAdjusted.checked,
      scope: leagueFilter ? 'single_league' : 'quota_prudente',
      limits: {
        leagues: leagueFilter ? 1 : MAX_ALL_LEAGUES,
        cornerLeagues: leagueFilter ? 1 : MAX_CORNER_LEAGUES_ALL,
        recentCornerMatchesPerTeam: RECENT_CORNER_MATCHES,
        cornerLookbackDays: CORNER_LOOKBACK_DAYS,
      },
      note: 'Percentuali solo su dati API-Football disponibili. Copertura verificata per lega/stagione; i null restano null e i campioni insufficienti sono esclusi.',
    },
  };
}
