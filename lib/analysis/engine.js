import { football } from '../api-football';
import {
  chunk,
  clamp,
  confidenceFromMinutes,
  fixtureLabel,
  isPreMatch,
  kickoffMs,
  mapLimit,
  mean,
  percent,
  poissonAtLeast,
} from './common';

const MAX_UPCOMING_ALL = 10;
const MAX_UPCOMING_SINGLE = 14;
const RECENT_MATCHES = 6;
const MIN_RECENT_APPS = 2;
const MIN_RECENT_MINUTES = 90;
const MAX_BATCH_IDS = 20;
const MAX_PLAYER_FALLBACK_TEAMS = 12;

function isFinished(fixture) {
  const short = fixture?.fixture?.status?.short;
  return short === 'FT' || short === 'AET' || short === 'PEN';
}

function groupKey(fixture) {
  return `${Number(fixture?.league?.id) || 0}:${Number(fixture?.league?.season) || 0}`;
}

function selectUpcomingFixtures(fixtures, leagueFilter) {
  const eligible = fixtures
    .filter(isPreMatch)
    .filter(f => !leagueFilter || Number(f?.league?.id) === Number(leagueFilter))
    .sort((a, b) => kickoffMs(a) - kickoffMs(b));

  const cap = leagueFilter ? MAX_UPCOMING_SINGLE : MAX_UPCOMING_ALL;
  if (leagueFilter) return eligible.slice(0, cap);

  // In modalità “Tutte” distribuiamo il campione su più competizioni,
  // invece di prendere solo le prime gare della notte.
  const groups = new Map();
  for (const fixture of eligible) {
    const key = groupKey(fixture);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fixture);
  }
  const buckets = [...groups.values()].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return kickoffMs(a[0]) - kickoffMs(b[0]);
  });

  const out = [];
  let round = 0;
  while (out.length < cap) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[round]) {
        out.push(bucket[round]);
        added = true;
        if (out.length >= cap) break;
      }
    }
    if (!added) break;
    round += 1;
  }
  return out;
}

function targetTeams(upcoming) {
  const map = new Map();
  for (const fixture of upcoming) {
    for (const side of ['home', 'away']) {
      const team = fixture?.teams?.[side];
      const teamId = Number(team?.id);
      if (!teamId || map.has(teamId)) continue;
      map.set(teamId, {
        teamId,
        teamName: team?.name || `Team ${teamId}`,
        fixture,
        leagueId: Number(fixture?.league?.id) || null,
        season: Number(fixture?.league?.season) || null,
        leagueName: fixture?.league?.name || 'Competizione N.D.',
      });
    }
  }
  return [...map.values()];
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
  if (blocks.length < 2) return [];
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
  return rows;
}

function fixturePlayerRows(bundle) {
  const out = [];
  const teamBlocks = Array.isArray(bundle?.players) ? bundle.players : [];
  for (const block of teamBlocks) {
    const teamId = Number(block?.team?.id);
    if (!teamId) continue;
    for (const row of block?.players || []) {
      const player = row?.player || {};
      const stat = Array.isArray(row?.statistics) ? row.statistics[0] : null;
      if (!stat) continue;
      const minutes = Number(stat?.games?.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      const goalsRaw = stat?.goals?.total;
      const yellowRaw = stat?.cards?.yellow;
      const redRaw = stat?.cards?.red;
      const goals = goalsRaw === null || goalsRaw === undefined ? null : Number(goalsRaw);
      const yellow = yellowRaw === null || yellowRaw === undefined ? null : Number(yellowRaw);
      const red = redRaw === null || redRaw === undefined ? null : Number(redRaw);
      out.push({
        teamId,
        playerId: Number(player.id),
        name: player.name || 'Giocatore N.D.',
        minutes,
        goals: Number.isFinite(goals) ? goals : null,
        yellow: Number.isFinite(yellow) ? yellow : null,
        red: Number.isFinite(red) ? red : null,
        substitute: stat?.games?.substitute === true,
        source: 'recent',
      });
    }
  }
  return out;
}

function aggregateRecentPlayerRows(fixtureIds, bundleById, teamId) {
  const byPlayer = new Map();
  for (const fixtureId of fixtureIds) {
    const bundle = bundleById.get(fixtureId);
    if (!bundle) continue;
    for (const row of fixturePlayerRows(bundle).filter(r => r.teamId === teamId)) {
      if (!row.playerId) continue;
      const prev = byPlayer.get(row.playerId) || {
        playerId: row.playerId,
        name: row.name,
        appearances: 0,
        minutes: 0,
        subApps: 0,
        goals: 0,
        yellow: 0,
        red: null,
        goalMinutes: 0,
        cardMinutes: 0,
        goalApps: 0,
        cardApps: 0,
        source: 'recent',
      };
      prev.appearances += 1;
      prev.minutes += row.minutes;
      if (row.substitute) prev.subApps += 1;
      if (Number.isFinite(row.goals)) {
        prev.goals += row.goals;
        prev.goalMinutes += row.minutes;
        prev.goalApps += 1;
      }
      if (Number.isFinite(row.yellow)) {
        prev.yellow += row.yellow;
        prev.cardMinutes += row.minutes;
        prev.cardApps += 1;
      }
      if (Number.isFinite(row.red)) prev.red = (Number.isFinite(prev.red) ? prev.red : 0) + row.red;
      byPlayer.set(row.playerId, prev);
    }
  }
  return [...byPlayer.values()];
}

function bestSeasonStat(entry, target) {
  const list = Array.isArray(entry?.statistics) ? entry.statistics : [];
  return list.find(s => Number(s?.team?.id) === target.teamId && Number(s?.league?.id) === target.leagueId && Number(s?.league?.season) === target.season)
    || list.find(s => Number(s?.team?.id) === target.teamId && Number(s?.league?.season) === target.season)
    || list.find(s => Number(s?.team?.id) === target.teamId)
    || null;
}

async function fetchSeasonPlayers(target) {
  const first = await football.playersByTeamSeason(target.teamId, target.season, 1);
  const pages = Math.min(Number(first?.paging?.total) || 1, 2);
  const responses = [first];
  if (pages > 1) {
    const second = await football.playersByTeamSeason(target.teamId, target.season, 2);
    responses.push(second);
  }
  const out = [];
  for (const entry of responses.flatMap(r => r?.response || [])) {
    const stat = bestSeasonStat(entry, target);
    if (!stat) continue;
    const minutes = Number(stat?.games?.minutes);
    const appearances = Number(stat?.games?.appearences);
    if (!Number.isFinite(minutes) || !Number.isFinite(appearances) || minutes <= 0 || appearances <= 0) continue;
    const goalsRaw = stat?.goals?.total;
    const yellowRaw = stat?.cards?.yellow;
    const redRaw = stat?.cards?.red;
    const goals = goalsRaw === null || goalsRaw === undefined ? null : Number(goalsRaw);
    const yellow = yellowRaw === null || yellowRaw === undefined ? null : Number(yellowRaw);
    const red = redRaw === null || redRaw === undefined ? null : Number(redRaw);
    const subsIn = Number(stat?.substitutes?.in);
    out.push({
      playerId: Number(entry?.player?.id),
      name: entry?.player?.name || 'Giocatore N.D.',
      appearances,
      minutes,
      subApps: Number.isFinite(subsIn) ? Math.min(subsIn, appearances) : 0,
      goals: Number.isFinite(goals) ? goals : 0,
      yellow: Number.isFinite(yellow) ? yellow : 0,
      red: Number.isFinite(red) ? red : null,
      goalMinutes: Number.isFinite(goals) ? minutes : 0,
      cardMinutes: Number.isFinite(yellow) ? minutes : 0,
      goalApps: Number.isFinite(goals) ? appearances : 0,
      cardApps: Number.isFinite(yellow) ? appearances : 0,
      source: 'season',
    });
  }
  return out.filter(x => x.playerId);
}

function empiricalPrior(rows, kind) {
  let minutes = 0;
  let events = 0;
  for (const row of rows) {
    if (kind === 'cards') {
      if (!row.cardMinutes) continue;
      minutes += row.cardMinutes;
      events += Number(row.yellow) || 0;
    } else {
      if (!row.goalMinutes) continue;
      minutes += row.goalMinutes;
      events += Number(row.goals) || 0;
    }
  }
  return minutes > 0 ? (events * 90) / minutes : null;
}

function signalFromPlayer(row, target, kind, priorRate) {
  if (!target?.fixture || !Number.isFinite(priorRate)) return null;
  const minutes = kind === 'cards' ? row.cardMinutes : row.goalMinutes;
  const appearances = kind === 'cards' ? row.cardApps : row.goalApps;
  const count = kind === 'cards' ? row.yellow : row.goals;
  if (!Number.isFinite(minutes) || !Number.isFinite(appearances) || appearances < MIN_RECENT_APPS || minutes < MIN_RECENT_MINUTES) return null;
  if (!Number.isFinite(count) || count <= 0) return null;

  const rawRate = (count * 90) / minutes;
  const priorMinutes = kind === 'cards' ? 450 : 630;
  const shrunkRate = (count + priorRate * (priorMinutes / 90)) / ((minutes / 90) + (priorMinutes / 90));
  const avgMinutes = row.minutes / row.appearances;
  const subShare = row.appearances ? row.subApps / row.appearances : 0;
  const expected = clamp(avgMinutes * (subShare >= 0.6 ? 0.72 : 1), 15, 90);
  const probability = 1 - Math.exp(-shrunkRate * expected / 90);
  const sampleKind = row.source === 'season' ? 'stagione' : 'gare recenti';

  const base = {
    id: `${kind === 'cards' ? 'card' : 'goal'}-${row.playerId}-${target.fixture.fixture?.id}`,
    playerId: row.playerId,
    fixtureId: Number(target.fixture.fixture?.id),
    name: row.name,
    fixture: fixtureLabel(target.fixture),
    league: target.leagueName,
    percent: percent(probability),
    confidence: confidenceFromMinutes(minutes, appearances),
    sample: `${Math.round(minutes)} min / ${appearances} presenze (${sampleKind})`,
    status: 'AVAILABLE',
    _shrunkRate: shrunkRate,
  };

  if (kind === 'cards') {
    return {
      ...base,
      details: {
        yellow: row.yellow,
        red: row.red,
        rate90: Number(rawRate.toFixed(2)),
        expectedMinutes: Math.round(expected),
        lineup: 'PRE-LINEUP',
        model: row.source === 'season'
          ? 'Ammonizione: statistiche stagionali reali della squadra, usate solo come fallback quando le ultime fixture non espongono statistiche giocatore.'
          : 'Ammonizione: statistiche reali delle ultime fixture disponibili della squadra, regolarizzate sul tasso osservato del campione.',
      },
    };
  }
  return {
    ...base,
    details: {
      goals: row.goals,
      rate90: Number(rawRate.toFixed(2)),
      expectedMinutes: Math.round(expected),
      lineup: 'PRE-LINEUP',
      model: row.source === 'season'
        ? 'Gol: statistiche stagionali reali della squadra, usate solo come fallback quando le ultime fixture non espongono statistiche giocatore.'
        : 'Gol: statistiche reali delle ultime fixture disponibili della squadra, regolarizzate sul tasso osservato del campione.',
    },
  };
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
  try {
    const response = await football.fixturesByIds(fixtureIds, 0);
    const byFixture = new Map();
    for (const bundle of response.response || []) {
      const id = Number(bundle?.fixture?.id);
      const index = lineupIndexFromFixtureBundle(bundle);
      if (id && index) byFixture.set(id, index);
    }
    function adjust(signal) {
      const lineup = byFixture.get(signal.fixtureId);
      if (!lineup) return signal;
      if (lineup.starters.has(signal.playerId)) {
        const mins = clamp(Math.max(signal.details.expectedMinutes || 0, 65), 55, 90);
        return { ...signal, percent: percent(1 - Math.exp(-signal._shrunkRate * mins / 90)), details: { ...signal.details, expectedMinutes: Math.round(mins), lineup: 'TITOLARE' } };
      }
      if (lineup.substitutes.has(signal.playerId)) {
        const mins = clamp(Math.min(signal.details.expectedMinutes || 25, 25), 10, 25);
        return { ...signal, percent: percent(1 - Math.exp(-signal._shrunkRate * mins / 90)), confidence: 'Bassa', details: { ...signal.details, expectedMinutes: Math.round(mins), lineup: 'PANCHINA' } };
      }
      return null;
    }
    return { cards: cards.map(adjust).filter(Boolean), scorers: scorers.map(adjust).filter(Boolean), checked: byFixture.size };
  } catch {
    return { cards, scorers, checked: 0 };
  }
}

function cornerSignalForFixture(fixture, recentByTeam, bundleById) {
  const homeId = Number(fixture?.teams?.home?.id);
  const awayId = Number(fixture?.teams?.away?.id);
  const profiles = [];
  for (const teamId of [homeId, awayId]) {
    const rows = [];
    for (const fixtureId of recentByTeam.get(teamId) || []) {
      const bundle = bundleById.get(fixtureId);
      const row = fixtureStatsRows(bundle).find(r => r.teamId === teamId);
      if (row) rows.push(row);
    }
    if (rows.length < 3) return null;
    profiles.push({
      n: rows.length,
      forAvg: mean(rows.map(r => r.forCorners)),
      againstAvg: mean(rows.map(r => r.againstCorners)),
    });
  }
  const [home, away] = profiles;
  const expectedHome = mean([home.forAvg, away.againstAvg]);
  const expectedAway = mean([away.forAvg, home.againstAvg]);
  const lambda = Number.isFinite(expectedHome) && Number.isFinite(expectedAway) ? expectedHome + expectedAway : null;
  if (!Number.isFinite(lambda) || lambda <= 0 || lambda > 25) return null;
  const thresholds = [7.5, 8.5, 9.5, 10.5, 11.5];
  const overs = Object.fromEntries(thresholds.map(t => [String(t), percent(poissonAtLeast(lambda, Math.floor(t) + 1))]));
  const n = Math.min(home.n, away.n);
  return {
    id: `corner-${fixture.fixture?.id}`,
    name: fixtureLabel(fixture),
    fixture: fixtureLabel(fixture),
    league: fixture?.league?.name || 'Competizione N.D.',
    percent: overs['8.5'],
    confidence: n >= 5 ? 'Alta' : n >= 4 ? 'Media' : 'Bassa',
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
      model: 'Corner reali delle ultime gare disponibili delle due squadre; nessun valore mancante viene trattato come zero.',
    },
  };
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
  const upcoming = selectUpcomingFixtures(allFixtures, leagueFilter);
  const targets = targetTeams(upcoming);

  const historyResults = await mapLimit(targets, 6, async target => {
    try {
      const res = await football.teamLastFixtures(target.teamId, RECENT_MATCHES);
      const rows = (res.response || []).filter(isFinished).sort((a, b) => kickoffMs(b) - kickoffMs(a)).slice(0, RECENT_MATCHES);
      return { target, rows, error: null };
    } catch (error) {
      return { target, rows: [], error: String(error?.message || error) };
    }
  });

  const recentByTeam = new Map();
  for (const item of historyResults) {
    recentByTeam.set(item.target.teamId, item.rows.map(f => Number(f?.fixture?.id)).filter(Boolean));
  }

  const recentIds = [...new Set([...recentByTeam.values()].flat())];
  const detailResponses = await mapLimit(chunk(recentIds, MAX_BATCH_IDS), 3, async ids => {
    try {
      const res = await football.fixturesByIds(ids, 86400 * 7);
      return { rows: res.response || [], error: null };
    } catch (error) {
      return { rows: [], error: String(error?.message || error) };
    }
  });
  const bundleById = new Map();
  for (const bundle of detailResponses.flatMap(x => x.rows)) {
    const id = Number(bundle?.fixture?.id);
    if (id) bundleById.set(id, bundle);
  }

  const rowsByTeam = new Map();
  for (const target of targets) {
    rowsByTeam.set(target.teamId, aggregateRecentPlayerRows(recentByTeam.get(target.teamId) || [], bundleById, target.teamId));
  }

  // Se le fixture recenti non espongono statistiche giocatore, usiamo le statistiche
  // stagionali reali della squadra come fallback, senza fingere che siano “ultime 6”.
  const fallbackTargets = targets.filter(t => !(rowsByTeam.get(t.teamId) || []).length).slice(0, MAX_PLAYER_FALLBACK_TEAMS);
  const fallbackResults = await mapLimit(fallbackTargets, 4, async target => {
    try {
      const rows = await fetchSeasonPlayers(target);
      return { target, rows, error: null };
    } catch (error) {
      return { target, rows: [], error: String(error?.message || error) };
    }
  });
  for (const item of fallbackResults) {
    if (item.rows.length) rowsByTeam.set(item.target.teamId, item.rows);
  }

  const allPlayerRows = [...rowsByTeam.values()].flat();
  const cardPrior = empiricalPrior(allPlayerRows, 'cards');
  const scorerPrior = empiricalPrior(allPlayerRows, 'scorers');

  let cards = [];
  let scorers = [];
  for (const target of targets) {
    for (const row of rowsByTeam.get(target.teamId) || []) {
      const card = signalFromPlayer(row, target, 'cards', cardPrior);
      const scorer = signalFromPlayer(row, target, 'scorers', scorerPrior);
      if (card) cards.push(card);
      if (scorer) scorers.push(scorer);
    }
  }
  cards.sort((a, b) => b.percent - a.percent);
  scorers.sort((a, b) => b.percent - a.percent);
  const rawCardCandidates = cards.length;
  const rawScorerCandidates = scorers.length;
  const adjusted = await applyOfficialLineups(cards.slice(0, 30), scorers.slice(0, 30));
  cards = adjusted.cards.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);
  scorers = adjusted.scorers.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);

  const corners = upcoming.map(f => cornerSignalForFixture(f, recentByTeam, bundleById)).filter(Boolean).sort((a, b) => b.percent - a.percent).slice(0, 10);

  const leagueOptions = [...new Map(allFixtures.map(f => [Number(f?.league?.id), f?.league?.name]).filter(([id]) => id)).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));

  const analyzedLeagueMap = new Map();
  for (const f of upcoming) {
    const id = Number(f?.league?.id);
    if (!id) continue;
    if (!analyzedLeagueMap.has(id)) analyzedLeagueMap.set(id, { id, season: Number(f?.league?.season) || null, name: f?.league?.name || `League ${id}`, fixtures: 0 });
    analyzedLeagueMap.get(id).fixtures += 1;
  }

  const detailedPlayerBundles = [...bundleById.values()].filter(b => Array.isArray(b?.players) && b.players.length).length;
  const detailedStatsBundles = [...bundleById.values()].filter(b => Array.isArray(b?.statistics) && b.statistics.length).length;
  const teamsWithHistory = [...recentByTeam.values()].filter(ids => ids.length).length;
  const teamsWithPlayerRows = [...rowsByTeam.values()].filter(rows => rows.length).length;

  return {
    cards,
    scorers,
    corners,
    meta: {
      version: '0.7',
      date,
      fixturesTotal: allFixtures.length,
      preMatchFixtures: allFixtures.filter(isPreMatch).length,
      analyzedLeagues: [...analyzedLeagueMap.values()],
      leagueOptions,
      lineupFixturesChecked: adjusted.checked,
      deepTeamsFetched: targets.length,
      rawCardCandidates,
      rawScorerCandidates,
      scope: leagueFilter ? 'single_league' : 'team_recent_engine',
      limits: {
        upcomingFixtures: leagueFilter ? MAX_UPCOMING_SINGLE : MAX_UPCOMING_ALL,
        teams: targets.length,
        recentMatchesPerTeam: RECENT_MATCHES,
      },
      diagnostics: {
        selectedUpcomingFixtures: upcoming.length,
        teamHistoryCalls: historyResults.length,
        teamsWithHistory,
        selectedHistoryFixtures: recentIds.length,
        detailedBundles: bundleById.size,
        detailedPlayerBundles,
        detailedStatsBundles,
        seasonFallbackTeamsTried: fallbackTargets.length,
        seasonFallbackTeamsWithRows: fallbackResults.filter(x => x.rows.length).length,
        teamsWithPlayerRows,
        aggregatedPlayerRows: allPlayerRows.length,
        historyErrors: historyResults.filter(x => x.error).map(x => x.error).slice(0, 3),
        detailErrors: detailResponses.filter(x => x.error).map(x => x.error).slice(0, 3),
        fallbackErrors: fallbackResults.filter(x => x.error).map(x => x.error).slice(0, 3),
      },
      note: 'v0.7: rimosso il blocco rigido sulla coverage. Il motore parte direttamente dalle squadre del palinsesto, usa le loro ultime gare reali e, solo se mancano statistiche giocatore nelle fixture, usa le statistiche stagionali reali come fallback.',
    },
  };
}
