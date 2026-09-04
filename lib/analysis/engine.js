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

const MAX_COVERAGE_SCAN_LEAGUES = 18;
const MAX_ALL_LEAGUES = 6;
const MAX_TEAMS_ALL = 18;
const MAX_TEAMS_SINGLE = 28;
const RECENT_MATCHES = 6;
const MIN_RECENT_APPS = 2;
const MIN_RECENT_MINUTES = 120;
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

function seasonCoverage(leagueResponse, season) {
  const item = leagueResponse?.response?.[0];
  const exact = (item?.seasons || []).find(s => Number(s?.year) === Number(season));
  return exact?.coverage || null;
}

function supportScore(group) {
  const c = group.coverage || {};
  const playerStats = c.fixtures?.statistics_players === true;
  const teamStats = c.fixtures?.statistics_fixtures === true;
  return (playerStats ? 6 : 0)
    + (teamStats ? 4 : 0)
    + (c.players === true ? 2 : 0)
    + (c.top_scorers === true ? 1 : 0)
    + (c.top_cards === true ? 1 : 0)
    + Math.min(group.fixtures.length, 6) / 10;
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

function selectedTeams(groups, leagueFilter) {
  const cap = leagueFilter ? MAX_TEAMS_SINGLE : MAX_TEAMS_ALL;
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const fixture of group.fixtures) {
      for (const side of ['home', 'away']) {
        const teamId = Number(fixture?.teams?.[side]?.id);
        if (!teamId || seen.has(teamId)) continue;
        seen.add(teamId);
        out.push({ teamId, group });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
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
      const goals = Number(stat?.goals?.total);
      const yellow = Number(stat?.cards?.yellow);
      const red = Number(stat?.cards?.red);
      out.push({
        teamId,
        playerId: Number(player.id),
        name: player.name || 'Giocatore N.D.',
        minutes,
        goals: Number.isFinite(goals) ? goals : 0,
        yellow: Number.isFinite(yellow) ? yellow : 0,
        red: Number.isFinite(red) ? red : 0,
        substitute: stat?.games?.substitute === true,
      });
    }
  }
  return out;
}

function mergeHistory(current, previous) {
  const seen = new Set();
  const merged = [];
  for (const f of [...current, ...previous].sort((a, b) => kickoffMs(b) - kickoffMs(a))) {
    const id = Number(f?.fixture?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(f);
  }
  return merged;
}

async function historyForGroup(group) {
  const [current, previous] = await Promise.allSettled([
    football.leagueCompletedFixtures(group.leagueId, group.season),
    football.leagueCompletedFixtures(group.leagueId, group.season - 1),
  ]);
  const currentList = current.status === 'fulfilled' ? (current.value.response || []) : [];
  const previousList = previous.status === 'fulfilled' ? (previous.value.response || []) : [];
  return {
    group,
    current: currentList,
    previous: previousList,
    merged: mergeHistory(currentList, previousList),
    errors: {
      current: current.status === 'rejected' ? String(current.reason?.message || current.reason) : null,
      previous: previous.status === 'rejected' ? String(previous.reason?.message || previous.reason) : null,
    },
  };
}

function recentIdsForTeam(history, teamId) {
  return history
    .filter(f => Number(f?.teams?.home?.id) === teamId || Number(f?.teams?.away?.id) === teamId)
    .sort((a, b) => kickoffMs(b) - kickoffMs(a))
    .slice(0, RECENT_MATCHES)
    .map(f => Number(f?.fixture?.id))
    .filter(Boolean);
}

function aggregatePlayerRows(fixtureIds, bundleById, teamId) {
  const byPlayer = new Map();
  for (const fixtureId of fixtureIds) {
    const bundle = bundleById.get(fixtureId);
    if (!bundle) continue;
    for (const row of fixturePlayerRows(bundle).filter(r => r.teamId === teamId)) {
      if (!row.playerId) continue;
      const prev = byPlayer.get(row.playerId) || {
        playerId: row.playerId,
        name: row.name,
        minutes: 0,
        appearances: 0,
        goals: 0,
        yellow: 0,
        red: 0,
        subApps: 0,
      };
      prev.minutes += row.minutes;
      prev.appearances += 1;
      prev.goals += row.goals;
      prev.yellow += row.yellow;
      prev.red += row.red;
      if (row.substitute) prev.subApps += 1;
      byPlayer.set(row.playerId, prev);
    }
  }
  return [...byPlayer.values()];
}

function aggregateRate(rows, kind) {
  const totalMinutes = rows.reduce((s, r) => s + (Number(r.minutes) || 0), 0);
  const totalEvents = rows.reduce((s, r) => s + (kind === 'cards' ? (Number(r.yellow) || 0) : (Number(r.goals) || 0)), 0);
  if (totalMinutes <= 0) return null;
  return (totalEvents * 90) / totalMinutes;
}

function signalFromRecentPlayer(row, fixture, leagueName, kind, priorRate) {
  if (!fixture || !Number.isFinite(priorRate)) return null;
  if (row.appearances < MIN_RECENT_APPS || row.minutes < MIN_RECENT_MINUTES) return null;
  const count = kind === 'cards' ? row.yellow : row.goals;
  if (!Number.isFinite(count) || count <= 0) return null;
  const rawRate = (count * 90) / row.minutes;
  const priorMinutes = kind === 'cards' ? 540 : 720;
  const shrunkRate = (count + priorRate * (priorMinutes / 90)) / ((row.minutes / 90) + (priorMinutes / 90));
  const avgMinutes = row.minutes / row.appearances;
  const subShare = row.appearances ? row.subApps / row.appearances : 0;
  const expected = clamp(avgMinutes * (subShare >= 0.6 ? 0.75 : 1), 15, 90);
  const probability = 1 - Math.exp(-shrunkRate * expected / 90);
  const base = {
    id: `${kind === 'cards' ? 'card' : 'goal'}-${row.playerId}-${fixture.fixture?.id}`,
    playerId: row.playerId,
    fixtureId: Number(fixture.fixture?.id),
    name: row.name,
    fixture: fixtureLabel(fixture),
    league: leagueName,
    percent: percent(probability),
    confidence: confidenceFromMinutes(row.minutes, row.appearances),
    sample: `${row.minutes} min / ${row.appearances} gare recenti`,
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
        model: `Ammonizione: ultime ${row.appearances} gare reali (anche stagione precedente se necessario), regolarizzate sul tasso osservato dei giocatori analizzati`,
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
      model: `Gol: ultime ${row.appearances} gare reali (anche stagione precedente se necessario), regolarizzate sul tasso osservato dei giocatori analizzati`,
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

function cornerSignalForFixture(fixture, selectedByTeam, bundleById, leagueName) {
  const homeId = Number(fixture?.teams?.home?.id);
  const awayId = Number(fixture?.teams?.away?.id);
  const profiles = [];
  for (const teamId of [homeId, awayId]) {
    const rows = [];
    for (const fixtureId of selectedByTeam.get(teamId) || []) {
      const bundle = bundleById.get(fixtureId);
      const row = fixtureStatsRows(bundle).find(r => r.teamId === teamId);
      if (row) rows.push(row);
    }
    if (rows.length < 3) return null;
    profiles.push({
      n: rows.length,
      forAvg: mean(rows.map(r => r.forCorners)),
      againstAvg: mean(rows.map(r => r.againstCorners)),
      totalAvg: mean(rows.map(r => r.total)),
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
    league: leagueName,
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
      model: 'Corner reali delle ultime gare disponibili; se la stagione corrente è corta, il campione viene completato con la stagione precedente della stessa competizione',
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
  const groups = buildLeagueGroups(allFixtures, leagueFilter);

  const coverageCandidates = leagueFilter ? groups.slice(0, 1) : groups.slice(0, MAX_COVERAGE_SCAN_LEAGUES);
  const coverageScanned = await mapLimit(coverageCandidates, 6, async group => {
    try {
      const res = await football.league(group.leagueId, group.season);
      return { ...group, coverage: seasonCoverage(res, group.season) };
    } catch (error) {
      return { ...group, coverage: null, coverageError: String(error?.message || error) };
    }
  });

  const useful = coverageScanned.filter(g => g.coverage?.fixtures?.statistics_players === true || g.coverage?.fixtures?.statistics_fixtures === true);
  const analyzedGroups = (leagueFilter ? useful.slice(0, 1) : useful.sort((a, b) => supportScore(b) - supportScore(a)).slice(0, MAX_ALL_LEAGUES));
  const targets = selectedTeams(analyzedGroups, leagueFilter);

  const histories = await mapLimit(analyzedGroups, 3, historyForGroup);
  const historyByKey = new Map(histories.map(h => [`${h.group.leagueId}:${h.group.season}`, h]));

  const selectedByTeam = new Map();
  const targetGroupByTeam = new Map();
  for (const target of targets) {
    const key = `${target.group.leagueId}:${target.group.season}`;
    const history = historyByKey.get(key)?.merged || [];
    selectedByTeam.set(target.teamId, recentIdsForTeam(history, target.teamId));
    targetGroupByTeam.set(target.teamId, target.group);
  }

  const allHistoryIds = [...new Set([...selectedByTeam.values()].flat())];
  const detailChunks = chunk(allHistoryIds, MAX_BATCH_IDS);
  const detailResponses = await mapLimit(detailChunks, 3, async ids => {
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

  const fixtureByTeam = teamFixtureMap(analyzedGroups.flatMap(g => g.fixtures));
  const aggregatedByTeam = new Map();
  for (const target of targets) {
    aggregatedByTeam.set(target.teamId, aggregatePlayerRows(selectedByTeam.get(target.teamId) || [], bundleById, target.teamId));
  }

  const allPlayerRows = [...aggregatedByTeam.values()].flat();
  const cardPrior = aggregateRate(allPlayerRows, 'cards');
  const scorerPrior = aggregateRate(allPlayerRows, 'scorers');

  let cards = [];
  let scorers = [];
  for (const target of targets) {
    const fixture = fixtureByTeam.get(target.teamId);
    const rows = aggregatedByTeam.get(target.teamId) || [];
    for (const row of rows) {
      const card = signalFromRecentPlayer(row, fixture, target.group.name, 'cards', cardPrior);
      const scorer = signalFromRecentPlayer(row, fixture, target.group.name, 'scorers', scorerPrior);
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

  const corners = [];
  for (const group of analyzedGroups.filter(g => g.coverage?.fixtures?.statistics_fixtures === true)) {
    for (const fixture of group.fixtures) {
      const signal = cornerSignalForFixture(fixture, selectedByTeam, bundleById, group.name);
      if (signal) corners.push(signal);
    }
  }
  corners.sort((a, b) => b.percent - a.percent);

  const leagueOptions = [...new Map(allFixtures.map(f => [Number(f?.league?.id), f?.league?.name]).filter(([id]) => id)).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));

  const historyCurrent = histories.reduce((s, h) => s + h.current.length, 0);
  const historyPrevious = histories.reduce((s, h) => s + h.previous.length, 0);
  const playerRowsCount = allPlayerRows.length;
  const detailedPlayerBundles = [...bundleById.values()].filter(b => Array.isArray(b?.players) && b.players.length).length;
  const detailedStatsBundles = [...bundleById.values()].filter(b => Array.isArray(b?.statistics) && b.statistics.length).length;

  return {
    cards,
    scorers,
    corners: corners.slice(0, 10),
    meta: {
      version: '0.6',
      date,
      fixturesTotal: allFixtures.length,
      preMatchFixtures: allFixtures.filter(isPreMatch).length,
      coverageLeaguesScanned: coverageScanned.length,
      analyzedLeagues: analyzedGroups.map(g => ({ id: g.leagueId, season: g.season, name: g.name, fixtures: g.fixtures.length })),
      leagueOptions,
      lineupFixturesChecked: adjusted.checked,
      deepTeamsFetched: targets.length,
      rawCardCandidates,
      rawScorerCandidates,
      scope: leagueFilter ? 'single_league' : 'recent_fixture_engine',
      limits: {
        coverageScanLeagues: leagueFilter ? 1 : MAX_COVERAGE_SCAN_LEAGUES,
        leagues: leagueFilter ? 1 : MAX_ALL_LEAGUES,
        teams: leagueFilter ? MAX_TEAMS_SINGLE : MAX_TEAMS_ALL,
        recentMatchesPerTeam: RECENT_MATCHES,
      },
      diagnostics: {
        historyCurrentFixtures: historyCurrent,
        historyPreviousFixtures: historyPrevious,
        selectedHistoryFixtures: allHistoryIds.length,
        detailedBundles: bundleById.size,
        detailedPlayerBundles,
        detailedStatsBundles,
        aggregatedPlayerRows: playerRowsCount,
        detailErrors: detailResponses.filter(x => x.error).map(x => x.error).slice(0, 3),
      },
      note: 'v0.6: motore basato sulle ultime gare reali delle squadre del palinsesto; usa la stagione precedente solo per completare campioni recenti troppo corti. Nessun null viene trasformato in zero.',
    },
  };
}
