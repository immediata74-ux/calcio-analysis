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

const MAX_ALL_LEAGUES = 6;
const MAX_CORNER_LEAGUES_ALL = 3;
const MAX_CORNER_FIXTURES_PER_GROUP = 4;
const RECENT_CORNER_MATCHES = 7;
const CORNER_LOOKBACK_DAYS = 210;
const MAX_DEEP_TEAMS_ALL = 10;
const MAX_DEEP_TEAMS_SINGLE = 16;
const MAX_PLAYER_PAGES_PER_TEAM = 2;
const MIN_PLAYER_MINUTES = 120;
const MIN_PLAYER_APPEARANCES = 2;
const MAX_BATCH_IDS = 20;
const MAX_EVENT_FALLBACK_TEAMS = 10;
const EVENT_RECENT_MATCHES = 5;
const MAX_EXPLICIT_EVENT_FIXTURES = 44;
const MAX_EXPLICIT_CORNER_STATS = 40;

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

function currentCoverageIndex(catalog) {
  const index = new Map();
  for (const item of catalog?.response || []) {
    const leagueId = Number(item?.league?.id);
    if (!leagueId) continue;
    for (const season of item?.seasons || []) {
      const year = Number(season?.year);
      if (!year) continue;
      index.set(`${leagueId}:${year}`, {
        coverage: season?.coverage || null,
        country: item?.country?.name || null,
        leagueName: item?.league?.name || null,
        current: season?.current === true,
      });
    }
  }
  return index;
}

function attachCoverage(groups, index) {
  return groups.map(group => {
    const found = index.get(`${group.leagueId}:${group.season}`);
    return { ...group, coverage: found?.coverage || null, country: found?.country || null };
  });
}

function hasPlayerSupport(group) {
  const c = group.coverage || {};
  return c.top_cards === true
    || c.top_scorers === true
    || c.players === true
    || c.fixtures?.statistics_players === true
    || c.fixtures?.events === true;
}

function hasCornerSupport(group) {
  return group.coverage?.fixtures?.statistics_fixtures === true;
}

function hasAnySupport(group) {
  return hasPlayerSupport(group) || hasCornerSupport(group);
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
    if (!Number.isFinite(count) || count <= 0) continue;
    const rate90 = minutes > 0 ? (count * 90) / minutes : null;
    if (!Number.isFinite(rate90)) continue;

    rows.push({ entry, stat, minutes, appearances, expected, teamId, count, rate90 });
  }
  return rows;
}

function mergeSignals(...lists) {
  const byId = new Map();
  for (const item of lists.flat()) {
    if (!item?.id) continue;
    const previous = byId.get(item.id);
    if (!previous || Number(item.percent) > Number(previous.percent)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function teamSeasonPlayers(teamId, season) {
  const out = [];
  let page = 1;
  let total = 1;
  do {
    const res = await football.playersByTeamSeason(teamId, season, page);
    out.push(...(res.response || []));
    total = Math.max(1, Number(res?.paging?.total) || 1);
    page += 1;
  } while (page <= total && page <= MAX_PLAYER_PAGES_PER_TEAM);
  return out;
}

function supportScore(group) {
  const coverage = group.coverage || {};
  return (coverage.top_cards === true ? 6 : 0)
    + (coverage.top_scorers === true ? 6 : 0)
    + (coverage.players === true ? 4 : 0)
    + (coverage.fixtures?.statistics_players === true ? 4 : 0)
    + (coverage.fixtures?.statistics_fixtures === true ? 5 : 0)
    + (coverage.fixtures?.events === true ? 1 : 0)
    + (coverage.fixtures?.lineups === true ? 1 : 0)
    + Math.min(group.fixtures.length, 8) / 10;
}

function deepTeamTargets(groups, leagueFilter) {
  const cap = leagueFilter ? MAX_DEEP_TEAMS_SINGLE : MAX_DEEP_TEAMS_ALL;
  const targets = [];
  const seen = new Set();
  for (const group of groups) {
    for (const fixture of group.fixtures) {
      for (const side of ['home', 'away']) {
        const teamId = Number(fixture?.teams?.[side]?.id);
        if (!teamId || seen.has(teamId)) continue;
        seen.add(teamId);
        targets.push({ teamId, group });
        if (targets.length >= cap) return targets;
      }
    }
  }
  return targets;
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
        percent: Number.isFinite(signal._shrunkRate) ? percent(1 - Math.exp(-signal._shrunkRate * mins / 90)) : signal.percent,
        details: { ...signal.details, expectedMinutes: Number.isFinite(signal._shrunkRate) ? Math.round(mins) : signal.details.expectedMinutes, lineup: 'TITOLARE' },
      };
    }
    if (lineup.substitutes.has(playerId)) {
      const mins = clamp(Math.min(signal.details.expectedMinutes || 25, 25), 10, 25);
      return {
        ...signal,
        percent: Number.isFinite(signal._shrunkRate) ? percent(1 - Math.exp(-signal._shrunkRate * mins / 90)) : signal.percent,
        confidence: signal.confidence === 'Alta' ? 'Media' : 'Bassa',
        details: { ...signal.details, expectedMinutes: Number.isFinite(signal._shrunkRate) ? Math.round(mins) : signal.details.expectedMinutes, lineup: 'PANCHINA' },
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

function statisticsBlocksRows(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) return null;
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

function fixtureStatsRows(bundle) {
  return statisticsBlocksRows(Array.isArray(bundle?.statistics) ? bundle.statistics : []);
}

function isFinishedFixture(fixture) {
  return ['FT', 'AET', 'PEN'].includes(fixture?.fixture?.status?.short);
}

function wilsonLower(successes, total, z = 1.28) {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || successes <= 0) return 0;
  const p = clamp(successes / total, 0, 1);
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return clamp((centre - margin) / denominator, 0, 1);
}

function eventFallbackTargets(groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups.filter(g => g.coverage?.fixtures?.events === true)) {
    for (const fixture of group.fixtures) {
      for (const side of ['home', 'away']) {
        const team = fixture?.teams?.[side];
        const teamId = Number(team?.id);
        if (!teamId || seen.has(teamId)) continue;
        seen.add(teamId);
        out.push({ teamId, teamName: team?.name || `Team ${teamId}`, group, fixture });
        if (out.length >= MAX_EVENT_FALLBACK_TEAMS) return out;
      }
    }
  }
  return out;
}

function eventSignalsForTarget(target, fixtureIds, eventsByFixture) {
  const players = new Map();
  for (const fixtureId of fixtureIds) {
    const events = eventsByFixture.get(fixtureId) || [];
    for (const event of events) {
      if (Number(event?.team?.id) !== target.teamId) continue;
      const playerId = Number(event?.player?.id);
      if (!playerId) continue;
      const name = event?.player?.name || 'Giocatore N.D.';
      const current = players.get(playerId) || { playerId, name, goalFixtures: new Set(), cardFixtures: new Set(), goals: 0, cards: 0 };
      const type = String(event?.type || '').toLowerCase();
      const detail = String(event?.detail || '').toLowerCase();
      if (type === 'goal' && !detail.includes('own goal') && !detail.includes('missed penalty')) {
        current.goalFixtures.add(fixtureId);
        current.goals += 1;
      }
      if (type === 'card' && (detail.includes('yellow card') || detail.includes('yellow-red card'))) {
        current.cardFixtures.add(fixtureId);
        current.cards += 1;
      }
      players.set(playerId, current);
    }
  }

  const n = fixtureIds.length;
  if (n < 3) return { cards: [], scorers: [] };
  const cards = [];
  const scorers = [];
  for (const row of players.values()) {
    if (row.cardFixtures.size > 0) {
      const probability = wilsonLower(row.cardFixtures.size, n);
      cards.push({
        id: `card-event-${row.playerId}-${target.fixture?.fixture?.id}`,
        playerId: row.playerId,
        fixtureId: Number(target.fixture?.fixture?.id),
        name: row.name,
        fixture: fixtureLabel(target.fixture),
        league: target.group.name,
        percent: percent(probability),
        confidence: n >= 5 ? 'Media' : 'Bassa',
        sample: `${row.cardFixtures.size}/${n} gare con ammonizione`,
        status: 'AVAILABLE',
        details: {
          yellow: row.cards, red: null, yellowRed: null, rate90: null, expectedMinutes: null, lineup: 'PRE-LINEUP',
          model: 'Ammonizione: fallback su eventi reali delle ultime gare. Percentuale = limite inferiore Wilson della frequenza per partita, quindi volutamente prudente.',
        },
      });
    }
    if (row.goalFixtures.size > 0) {
      const probability = wilsonLower(row.goalFixtures.size, n);
      scorers.push({
        id: `goal-event-${row.playerId}-${target.fixture?.fixture?.id}`,
        playerId: row.playerId,
        fixtureId: Number(target.fixture?.fixture?.id),
        name: row.name,
        fixture: fixtureLabel(target.fixture),
        league: target.group.name,
        percent: percent(probability),
        confidence: n >= 5 ? 'Media' : 'Bassa',
        sample: `${row.goalFixtures.size}/${n} gare a segno`,
        status: 'AVAILABLE',
        details: {
          goals: row.goals, rate90: null, expectedMinutes: null, lineup: 'PRE-LINEUP',
          model: 'Marcatore: fallback su gol reali delle ultime gare (autogol esclusi). Percentuale = limite inferiore Wilson della frequenza per partita, quindi prudente.',
        },
      });
    }
  }
  return { cards, scorers };
}

async function recentEventFallback(groups) {
  const targets = eventFallbackTargets(groups);
  if (!targets.length) return { cards: [], scorers: [], diagnostics: { targets: 0, historyFixtures: 0, explicitEventCalls: 0, eventFixtures: 0 } };

  const histories = await mapLimit(targets, 5, async target => {
    try {
      const res = await football.teamLastFixtures(target.teamId, EVENT_RECENT_MATCHES);
      const ids = (res.response || []).filter(isFinishedFixture).sort((a, b) => kickoffMs(b) - kickoffMs(a)).slice(0, EVENT_RECENT_MATCHES).map(f => Number(f?.fixture?.id)).filter(Boolean);
      return { target, ids };
    } catch {
      return { target, ids: [] };
    }
  });

  const allIds = [...new Set(histories.flatMap(x => x.ids))].slice(0, MAX_EXPLICIT_EVENT_FIXTURES);
  const eventsByFixture = new Map();
  if (allIds.length) {
    const batches = await mapLimit(chunk(allIds, MAX_BATCH_IDS), 3, async ids => {
      try {
        const res = await football.fixturesByIds(ids, 86400 * 7);
        return res.response || [];
      } catch { return []; }
    });
    for (const bundle of batches.flat()) {
      const id = Number(bundle?.fixture?.id);
      const events = Array.isArray(bundle?.events) ? bundle.events : [];
      if (id && events.length) eventsByFixture.set(id, events);
    }
  }

  const missing = allIds.filter(id => !eventsByFixture.has(id));
  const explicit = await mapLimit(missing, 8, async id => {
    try {
      const res = await football.fixtureEvents(id);
      return { id, events: res.response || [] };
    } catch { return { id, events: [] }; }
  });
  for (const item of explicit) if (item.events.length) eventsByFixture.set(item.id, item.events);

  const cards = [];
  const scorers = [];
  for (const item of histories) {
    const ids = item.ids.filter(id => allIds.includes(id));
    const signals = eventSignalsForTarget(item.target, ids, eventsByFixture);
    cards.push(...signals.cards);
    scorers.push(...signals.scorers);
  }
  return {
    cards, scorers,
    diagnostics: { targets: targets.length, historyFixtures: allIds.length, explicitEventCalls: missing.length, eventFixtures: eventsByFixture.size },
  };
}

async function cornerSignalsForGroup(group, date) {
  const candidateFixtures = group.fixtures.slice(0, MAX_CORNER_FIXTURES_PER_GROUP);
  const teamIds = [...new Set(candidateFixtures.flatMap(f => [Number(f?.teams?.home?.id), Number(f?.teams?.away?.id)]).filter(Boolean))];
  if (!teamIds.length) return [];

  const currentPromise = football.leagueFixturesWindow(
    group.leagueId,
    group.season,
    dateShift(date, -CORNER_LOOKBACK_DAYS),
    dateShift(date, -1),
  );
  const previousPromise = football.leagueCompletedFixtures(group.leagueId, group.season - 1);
  const [currentResult, previousResult] = await Promise.allSettled([currentPromise, previousPromise]);
  const current = currentResult.status === 'fulfilled'
    ? (currentResult.value.response || []).filter(f => ['FT', 'AET', 'PEN'].includes(f?.fixture?.status?.short))
    : [];
  const previous = previousResult.status === 'fulfilled'
    ? (previousResult.value.response || []).filter(f => ['FT', 'AET', 'PEN'].includes(f?.fixture?.status?.short))
    : [];

  const selectedByTeam = new Map();
  for (const teamId of teamIds) {
    const currentTeam = current
      .filter(f => Number(f?.teams?.home?.id) === teamId || Number(f?.teams?.away?.id) === teamId)
      .sort((a, b) => kickoffMs(b) - kickoffMs(a));
    const previousTeam = previous
      .filter(f => Number(f?.teams?.home?.id) === teamId || Number(f?.teams?.away?.id) === teamId)
      .sort((a, b) => kickoffMs(b) - kickoffMs(a));
    const merged = [];
    const seen = new Set();
    for (const f of [...currentTeam, ...previousTeam]) {
      const id = Number(f?.fixture?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(f);
      if (merged.length >= RECENT_CORNER_MATCHES) break;
    }
    selectedByTeam.set(teamId, merged.map(f => Number(f?.fixture?.id)).filter(Boolean));
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

  // Alcuni piani/competizioni restituiscono con /fixtures?ids solo il blocco base.
  // In quel caso interroghiamo esplicitamente /fixtures/statistics per le fixture
  // necessarie, senza mai sostituire null con zero.
  const missingStatsIds = allIds.filter(id => !rowsByFixture.has(id)).slice(0, MAX_EXPLICIT_CORNER_STATS);
  const explicitStats = await mapLimit(missingStatsIds, 8, async fixtureId => {
    try {
      const res = await football.fixtureStatistics(fixtureId);
      return { fixtureId, rows: statisticsBlocksRows(res.response || []) };
    } catch {
      return { fixtureId, rows: null };
    }
  });
  for (const item of explicitStats) if (item.rows) rowsByFixture.set(item.fixtureId, item.rows);

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

  const signals = candidateFixtures.flatMap(fixture => {
    const homeId = Number(fixture?.teams?.home?.id);
    const awayId = Number(fixture?.teams?.away?.id);
    const home = profile.get(homeId);
    const away = profile.get(awayId);
    if (!home || !away) return [];

    const expectedHome = mean([home.forAvg, away.againstAvg]);
    const expectedAway = mean([away.forAvg, home.againstAvg]);
    const rawLambda = Number.isFinite(expectedHome) && Number.isFinite(expectedAway) ? expectedHome + expectedAway : null;
    if (!Number.isFinite(rawLambda) || rawLambda <= 0 || rawLambda > 25) return [];

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
        model: 'Corner reali delle ultime gare della stessa competizione; se la stagione è appena iniziata, il campione viene completato con gare reali della stagione precedente.',
      },
    }];
  });

  return {
    signals,
    diagnostics: {
      requestedHistoryFixtures: allIds.length,
      embeddedStatsFixtures: bundles.filter(b => fixtureStatsRows(b)).length,
      explicitStatsCalls: missingStatsIds.length,
      validStatsFixtures: rowsByFixture.size,
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
  const rawGroups = buildLeagueGroups(allFixtures, leagueFilter);

  let catalog = null;
  let catalogError = null;
  try {
    catalog = await football.currentLeagues();
  } catch (error) {
    catalogError = String(error?.message || error);
  }

  const coverageIndex = currentCoverageIndex(catalog);
  let groups = attachCoverage(rawGroups, coverageIndex);

  // Se l'utente seleziona una singola lega e il catalogo current non contiene
  // ancora quella stagione, facciamo un solo lookup preciso come fallback.
  if (leagueFilter && groups[0] && !groups[0].coverage) {
    try {
      const exact = await football.league(groups[0].leagueId, groups[0].season);
      groups[0] = { ...groups[0], coverage: seasonCoverage(exact, groups[0].season) };
    } catch {
      // La UI mostrerà NOT_SUPPORTED tramite la diagnostica, senza inventare dati.
    }
  }

  const supportedGroups = groups
    .filter(hasAnySupport)
    .sort((a, b) => {
      const diff = supportScore(b) - supportScore(a);
      if (diff) return diff;
      if (b.fixtures.length !== a.fixtures.length) return b.fixtures.length - a.fixtures.length;
      return kickoffMs(a.fixtures[0]) - kickoffMs(b.fixtures[0]);
    });

  const playerGroups = leagueFilter
    ? supportedGroups.filter(hasPlayerSupport).slice(0, 1)
    : supportedGroups.filter(hasPlayerSupport).slice(0, MAX_ALL_LEAGUES);
  const cornerGroups = leagueFilter
    ? supportedGroups.filter(hasCornerSupport).slice(0, 1)
    : supportedGroups.filter(hasCornerSupport).slice(0, MAX_CORNER_LEAGUES_ALL);
  const eventGroups = leagueFilter
    ? groups.filter(g => g.coverage?.fixtures?.events === true).slice(0, 1)
    : groups.filter(g => g.coverage?.fixtures?.events === true).sort((a, b) => supportScore(b) - supportScore(a)).slice(0, MAX_ALL_LEAGUES);

  const perLeague = await mapLimit(playerGroups, 3, async group => {
    const canCards = group.coverage?.top_cards === true;
    const canScorers = group.coverage?.top_scorers === true;
    const [cardsRes, scorersRes] = await Promise.allSettled([
      canCards ? football.topYellowCards(group.leagueId, group.season) : Promise.resolve(null),
      canScorers ? football.topScorers(group.leagueId, group.season) : Promise.resolve(null),
    ]);
    return {
      group,
      cards: cardsRes.status === 'fulfilled' && cardsRes.value ? buildCardSignals(cardsRes.value.response || [], group) : [],
      scorers: scorersRes.status === 'fulfilled' && scorersRes.value ? buildScorerSignals(scorersRes.value.response || [], group) : [],
      cardsOk: cardsRes.status === 'fulfilled' && !!cardsRes.value,
      scorersOk: scorersRes.status === 'fulfilled' && !!scorersRes.value,
    };
  });

  // Fallback sulle rose delle squadre realmente nel palinsesto. Ora viene fatto
  // solo su leghe che dichiarano copertura giocatori/statistiche giocatore.
  const deepTargets = deepTeamTargets(
    playerGroups.filter(g => g.coverage?.players === true || g.coverage?.fixtures?.statistics_players === true),
    leagueFilter,
  );
  const deepFetched = await mapLimit(deepTargets, 4, async target => {
    try {
      const entries = await teamSeasonPlayers(target.teamId, target.group.season);
      return {
        target,
        entries: entries.length,
        cards: buildCardSignals(entries, target.group),
        scorers: buildScorerSignals(entries, target.group),
        error: null,
      };
    } catch (error) {
      return { target, entries: 0, cards: [], scorers: [], error: String(error?.message || error) };
    }
  });

  let cardCandidates = mergeSignals(perLeague.flatMap(x => x.cards), deepFetched.flatMap(x => x.cards))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 30);
  let scorerCandidates = mergeSignals(perLeague.flatMap(x => x.scorers), deepFetched.flatMap(x => x.scorers))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 30);

  let eventFallback = { cards: [], scorers: [], diagnostics: { targets: 0, historyFixtures: 0, explicitEventCalls: 0, eventFixtures: 0 } };
  if (cardCandidates.length < 5 || scorerCandidates.length < 5) {
    eventFallback = await recentEventFallback(eventGroups);
    cardCandidates = mergeSignals(cardCandidates, eventFallback.cards).sort((a, b) => b.percent - a.percent).slice(0, 30);
    scorerCandidates = mergeSignals(scorerCandidates, eventFallback.scorers).sort((a, b) => b.percent - a.percent).slice(0, 30);
  }

  const rawCardCandidates = cardCandidates.length;
  const rawScorerCandidates = scorerCandidates.length;
  const lineupAdjusted = await applyOfficialLineups(cardCandidates, scorerCandidates);
  cardCandidates = lineupAdjusted.cards;
  scorerCandidates = lineupAdjusted.scorers;

  const cards = cardCandidates.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);
  const scorers = scorerCandidates.sort((a, b) => b.percent - a.percent).slice(0, 10).map(publicSignal);

  const cornerResults = await mapLimit(cornerGroups, 2, group => cornerSignalsForGroup(group, date));
  const corners = cornerResults.flatMap(x => x?.signals || []).filter(Boolean).sort((a, b) => b.percent - a.percent).slice(0, 10);
  const cornerDiagnostics = {
    requestedHistoryFixtures: cornerResults.reduce((s, x) => s + (x?.diagnostics?.requestedHistoryFixtures || 0), 0),
    embeddedStatsFixtures: cornerResults.reduce((s, x) => s + (x?.diagnostics?.embeddedStatsFixtures || 0), 0),
    explicitStatsCalls: cornerResults.reduce((s, x) => s + (x?.diagnostics?.explicitStatsCalls || 0), 0),
    validStatsFixtures: cornerResults.reduce((s, x) => s + (x?.diagnostics?.validStatsFixtures || 0), 0),
  };

  const leagueOptions = [...new Map(allFixtures.map(f => [Number(f?.league?.id), f?.league?.name]).filter(([id]) => id)).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));

  const coverageSummary = supportedGroups.slice(0, 16).map(g => ({
    id: g.leagueId,
    season: g.season,
    name: g.name,
    country: g.country,
    fixtures: g.fixtures.length,
    events: g.coverage?.fixtures?.events === true,
    lineups: g.coverage?.fixtures?.lineups === true,
    playerStatistics: g.coverage?.fixtures?.statistics_players === true,
    fixtureStatistics: g.coverage?.fixtures?.statistics_fixtures === true,
    players: g.coverage?.players === true,
    topCards: g.coverage?.top_cards === true,
    topScorers: g.coverage?.top_scorers === true,
    score: supportScore(g),
  }));

  return {
    cards,
    scorers,
    corners,
    meta: {
      version: '0.9',
      date,
      fixturesTotal: allFixtures.length,
      preMatchFixtures: allFixtures.filter(isPreMatch).length,
      coverageLeaguesScanned: coverageIndex.size,
      analyzedLeagues: [...new Map([...playerGroups, ...cornerGroups].map(g => [`${g.leagueId}:${g.season}`, g])).values()]
        .map(g => ({ id: g.leagueId, season: g.season, name: g.name, fixtures: g.fixtures.length })),
      coverageSummary,
      leagueOptions,
      lineupFixturesChecked: lineupAdjusted.checked,
      deepTeamsFetched: deepTargets.length,
      rawCardCandidates,
      rawScorerCandidates,
      scope: leagueFilter ? 'single_league' : 'coverage_catalog_engine',
      limits: {
        leagues: leagueFilter ? 1 : MAX_ALL_LEAGUES,
        deepTeams: leagueFilter ? MAX_DEEP_TEAMS_SINGLE : MAX_DEEP_TEAMS_ALL,
        playerPagesPerTeam: MAX_PLAYER_PAGES_PER_TEAM,
        cornerLeagues: leagueFilter ? 1 : MAX_CORNER_LEAGUES_ALL,
        cornerFixturesPerLeague: MAX_CORNER_FIXTURES_PER_GROUP,
        recentCornerMatchesPerTeam: RECENT_CORNER_MATCHES,
        cornerLookbackDays: CORNER_LOOKBACK_DAYS,
      },
      diagnostics: {
        fixtureLeagueGroups: rawGroups.length,
        coverageCatalogEntries: coverageIndex.size,
        supportedGroups: supportedGroups.length,
        playerGroups: playerGroups.length,
        cornerGroups: cornerGroups.length,
        topCardsCallsOk: perLeague.filter(x => x.cardsOk).length,
        topScorersCallsOk: perLeague.filter(x => x.scorersOk).length,
        deepTeamsTried: deepFetched.length,
        deepTeamsWithEntries: deepFetched.filter(x => x.entries > 0).length,
        deepTeamsWithSignals: deepFetched.filter(x => x.cards.length || x.scorers.length).length,
        eventFallbackTargets: eventFallback.diagnostics.targets,
        eventFallbackHistoryFixtures: eventFallback.diagnostics.historyFixtures,
        eventFallbackExplicitCalls: eventFallback.diagnostics.explicitEventCalls,
        eventFallbackFixturesWithEvents: eventFallback.diagnostics.eventFixtures,
        cornerRequestedHistoryFixtures: cornerDiagnostics.requestedHistoryFixtures,
        cornerEmbeddedStatsFixtures: cornerDiagnostics.embeddedStatsFixtures,
        cornerExplicitStatsCalls: cornerDiagnostics.explicitStatsCalls,
        cornerValidStatsFixtures: cornerDiagnostics.validStatsFixtures,
        deepErrors: deepFetched.filter(x => x.error).map(x => x.error).slice(0, 3),
        catalogError,
      },
      note: 'v0.9: selezione per coverage reale. Se Top/players non bastano, Ammoniti e Marcatori usano eventi reali delle ultime gare; per i Corner, se il batch /fixtures?ids non include statistiche, viene interrogato esplicitamente /fixtures/statistics. Nessun null diventa zero.',
    },
  };
}
