import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BASE = 'https://v3.football.api-sports.io';
const TZ = 'Europe/Rome';
const TOP_LIMIT = 10;
const MAX_LEAGUES = 16;
const CORNER_FIXTURE_LIMIT = 14;

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function pct(n) { return Math.round(clamp(n, 0, 1) * 100); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function italyTime(iso) {
  try { return new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }
  catch { return '--:--'; }
}

async function football(path, params = {}) {
  const key = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || process.env.RAPIDAPI_KEY;
  if (!key) throw new Error('Manca API_FOOTBALL_KEY nelle variabili ambiente Vercel.');
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = process.env.RAPIDAPI_KEY
    ? { 'x-rapidapi-key': key, 'x-rapidapi-host': 'v3.football.api-sports.io' }
    : { 'x-apisports-key': key };
  const res = await fetch(url, { headers, cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  if (json?.errors && Object.keys(json.errors).length) throw new Error(`API-Football: ${JSON.stringify(json.errors)}`);
  return Array.isArray(json?.response) ? json.response : [];
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let next = 0;
  async function run() { while (true) { const i = next++; if (i >= items.length) return; try { out[i] = await worker(items[i], i); } catch { out[i] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function statForLeague(item, leagueId) {
  return (item?.statistics || []).find(s => Number(s?.league?.id) === Number(leagueId)) || item?.statistics?.[0] || null;
}

function reliability(minutes, apps) {
  if (minutes >= 900 && apps >= 10) return 'Alta';
  if (minutes >= 450 && apps >= 6) return 'Media';
  return 'Bassa';
}

function expectedMinutes(minutes, apps) {
  if (!minutes || !apps) return 60;
  return Math.round(clamp(minutes / apps, 35, 90));
}

function poissonAtLeastOne(lambda) { return 1 - Math.exp(-Math.max(0, lambda)); }
function poissonOver(lambda, line) {
  const need = Math.floor(line) + 1;
  let term = Math.exp(-lambda), cdf = term;
  for (let k = 1; k < need; k++) { term *= lambda / k; cdf += term; }
  return clamp(1 - cdf, 0, 1);
}

function distinctTop(list, limit = TOP_LIMIT) {
  const seen = new Set(); const out = [];
  for (const x of [...list].sort((a, b) => b.probability - a.probability)) {
    if (!x?.fixtureId || seen.has(x.fixtureId)) continue;
    seen.add(x.fixtureId); out.push(x); if (out.length >= limit) break;
  }
  return out;
}

function groupFixtures(fixtures) {
  const m = new Map();
  for (const f of fixtures) {
    const id = Number(f?.league?.id); const season = Number(f?.league?.season);
    if (!id || !season) continue;
    const key = `${id}:${season}`;
    if (!m.has(key)) m.set(key, { leagueId: id, season, name: f?.league?.name || 'Campionato', fixtures: [] });
    m.get(key).fixtures.push(f);
  }
  return [...m.values()].sort((a, b) => b.fixtures.length - a.fixtures.length).slice(0, MAX_LEAGUES);
}

function fixtureBase(f) {
  return {
    fixtureId: Number(f?.fixture?.id),
    time: italyTime(f?.fixture?.date),
    league: f?.league?.name || 'Campionato',
    match: `${f?.teams?.home?.name || '?'} — ${f?.teams?.away?.name || '?'}`,
    date: f?.fixture?.date || null,
    status: 'PRE-LINEUP'
  };
}

async function playerCandidates(groups) {
  const cards = [], scorers = [];
  await mapLimit(groups, 4, async g => {
    const [yellow, goals] = await Promise.all([
      football('/players/topyellowcards', { league: g.leagueId, season: g.season }),
      football('/players/topscorers', { league: g.leagueId, season: g.season })
    ]);
    const fixtureByTeam = new Map();
    for (const f of g.fixtures) {
      fixtureByTeam.set(Number(f?.teams?.home?.id), f);
      fixtureByTeam.set(Number(f?.teams?.away?.id), f);
    }
    for (const item of yellow) {
      const s = statForLeague(item, g.leagueId); if (!s) continue;
      const teamId = Number(s?.team?.id); const f = fixtureByTeam.get(teamId); if (!f) continue;
      const apps = num(s?.games?.appearences); const minutes = num(s?.games?.minutes); const yellows = num(s?.cards?.yellow);
      if (!apps || minutes < 120 || !yellows) continue;
      const rate90 = yellows * 90 / minutes; const mins = expectedMinutes(minutes, apps); const probability = poissonAtLeastOne(rate90 * mins / 90);
      cards.push({ ...fixtureBase(f), player: item?.player?.name || 'Giocatore', probability, rate90: rate90.toFixed(2), minutes, appearances: apps, yellows, expectedMinutes: mins, reliability: reliability(minutes, apps) });
    }
    for (const item of goals) {
      const s = statForLeague(item, g.leagueId); if (!s) continue;
      const teamId = Number(s?.team?.id); const f = fixtureByTeam.get(teamId); if (!f) continue;
      const apps = num(s?.games?.appearences); const minutes = num(s?.games?.minutes); const gs = num(s?.goals?.total);
      if (!apps || minutes < 120 || !gs) continue;
      const rate90 = gs * 90 / minutes; const mins = expectedMinutes(minutes, apps); const probability = poissonAtLeastOne(rate90 * mins / 90);
      scorers.push({ ...fixtureBase(f), player: item?.player?.name || 'Giocatore', probability, rate90: rate90.toFixed(2), minutes, appearances: apps, goals: gs, expectedMinutes: mins, reliability: reliability(minutes, apps) });
    }
  });
  return { cards: distinctTop(cards).map(x => ({ ...x, probability: pct(x.probability) })), scorers: distinctTop(scorers).map(x => ({ ...x, probability: pct(x.probability) })) };
}

const fixtureStatsCache = new Map();
async function totalCorners(fixtureId) {
  if (fixtureStatsCache.has(fixtureId)) return fixtureStatsCache.get(fixtureId);
  const p = football('/fixtures/statistics', { fixture: fixtureId }).then(rows => {
    let total = 0, found = false;
    for (const team of rows) {
      const c = (team?.statistics || []).find(s => String(s?.type).toLowerCase() === 'corner kicks');
      const v = Number(c?.value); if (Number.isFinite(v)) { total += v; found = true; }
    }
    return found ? total : null;
  }).catch(() => null);
  fixtureStatsCache.set(fixtureId, p); return p;
}

async function recentTeamFixtures(teamId, leagueId, season) {
  let rows = await football('/fixtures', { team: teamId, league: leagueId, season, last: 6 });
  rows = rows.filter(f => ['FT','AET','PEN'].includes(f?.fixture?.status?.short)).slice(-4);
  if (rows.length < 3 && season > 2000) {
    const prev = await football('/fixtures', { team: teamId, league: leagueId, season: season - 1, last: 6 }).catch(() => []);
    rows = [...prev.filter(f => ['FT','AET','PEN'].includes(f?.fixture?.status?.short)), ...rows].slice(-4);
  }
  return rows;
}

async function cornerForFixture(f) {
  const leagueId = Number(f?.league?.id), season = Number(f?.league?.season);
  const home = Number(f?.teams?.home?.id), away = Number(f?.teams?.away?.id);
  if (!leagueId || !season || !home || !away) return null;
  const [h, a] = await Promise.all([recentTeamFixtures(home, leagueId, season), recentTeamFixtures(away, leagueId, season)]);
  const ids = [...new Set([...h, ...a].map(x => Number(x?.fixture?.id)).filter(Boolean))].slice(-8);
  if (ids.length < 3) return null;
  const vals = (await mapLimit(ids, 5, id => totalCorners(id))).filter(v => Number.isFinite(v));
  if (vals.length < 3) return null;
  const expected = vals.reduce((s, v) => s + v, 0) / vals.length;
  const over75 = poissonOver(expected, 7.5), over85 = poissonOver(expected, 8.5), over95 = poissonOver(expected, 9.5);
  return { ...fixtureBase(f), selection: f?.teams?.home?.name + ' — ' + f?.teams?.away?.name, probability: pct(over85), expected: expected.toFixed(1), over75: pct(over75), over85: pct(over85), over95: pct(over95), sample: vals.length, reliability: vals.length >= 7 ? 'Alta' : vals.length >= 5 ? 'Media' : 'Bassa', status: 'AVAILABLE' };
}

function roundRobinFixtures(groups, limit) {
  const arrays = groups.map(g => [...g.fixtures]); const out = []; let i = 0;
  while (out.length < limit && arrays.some(a => a.length)) {
    const a = arrays[i % arrays.length]; if (a?.length) out.push(a.shift()); i++;
  }
  return out;
}

async function cornerCandidates(groups) {
  const pool = roundRobinFixtures(groups, CORNER_FIXTURE_LIMIT);
  const rows = (await mapLimit(pool, 3, cornerForFixture)).filter(Boolean).sort((a, b) => b.probability - a.probability);
  return rows.slice(0, TOP_LIMIT);
}

export async function analyzeDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Data non valida.');
  const all = await football('/fixtures', { date, timezone: TZ });
  const fixtures = all.filter(f => ['NS','TBD'].includes(f?.fixture?.status?.short));
  const groups = groupFixtures(fixtures);
  const [{ cards, scorers }, corner] = await Promise.all([playerCandidates(groups), cornerCandidates(groups)]);
  return { date, fixtureCount: fixtures.length, leagueCount: groups.length, ammoniti: cards, marcatori: scorers, corner };
}

function fillSheetBlack(ws, rows = 500, cols = 6) {
  ws.views = [{ showGridLines: false, zoomScale: 115, state: 'frozen', ySplit: 4 }];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) {
    const cell = ws.getCell(r, c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF050505' } };
    cell.font = { name: 'Arial', size: 12, color: { argb: 'FFFFFFFF' } };
  }
}

function setupSheet(ws, title, color, subtitle) {
  fillSheetBlack(ws);
  ws.mergeCells('A1:F1'); ws.getCell('A1').value = title; ws.getCell('A1').font = { name: 'Arial', size: 20, bold: true, color: { argb: `FF${color}` } };
  ws.mergeCells('A2:F2'); ws.getCell('A2').value = subtitle; ws.getCell('A2').font = { name: 'Arial', size: 10, color: { argb: 'FFAAAAAA' } };
  ws.getRow(1).height = 30; ws.getRow(2).height = 24;
  ws.columns = [{ width: 6 }, { width: 10 }, { width: 18 }, { width: 31 }, { width: 24 }, { width: 13 }];
  const hdr = ['#','ORA','CAMPIONATO','PARTITA','SELEZIONE','PROB.'];
  hdr.forEach((v, i) => { const c = ws.getCell(4, i + 1); c.value = v; c.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF050505' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }; c.alignment = { vertical: 'middle', horizontal: i === 0 || i === 5 ? 'center' : 'left' }; });
  ws.getRow(4).height = 28;
}

function addRows(ws, rows, type, color) {
  rows.forEach((x, i) => {
    const selection = type === 'corner' ? x.selection : x.player;
    const values = [i + 1, x.time, x.league, x.match, selection, `${x.probability}%`];
    values.forEach((v, c) => { const cell = ws.getCell(i + 5, c + 1); cell.value = v; cell.font = { name: 'Arial', size: c === 5 ? 14 : 12, bold: c === 4 || c === 5, color: { argb: c === 5 ? `FF${color}` : 'FFFFFFFF' } }; cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c === 0 || c === 5 ? 'center' : 'left' }; cell.border = { bottom: { style: 'thin', color: { argb: 'FF252525' } } }; });
    ws.getRow(i + 5).height = 34;
  });
  ws.autoFilter = { from: 'A4', to: `F${Math.max(5, rows.length + 4)}` };
}

async function makeWorkbook(data) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); wb.creator = 'Calcio Analysis'; wb.created = new Date();
  const colors = { ammoniti: 'FFD54A', marcatori: '48D38A', corner: 'FF9F43', riepilogo: '6EC1FF' };
  const sum = wb.addWorksheet('RIEPILOGO'); setupSheet(sum, 'RIEPILOGO TOP', colors.riepilogo, `Data ${data.date} · ora Europe/Rome · ${data.fixtureCount} partite`);
  const combined = [
    ...data.ammoniti.map(x => ({ ...x, t: 'AMMONITO', s: x.player, c: colors.ammoniti })),
    ...data.marcatori.map(x => ({ ...x, t: 'MARCATORE', s: x.player, c: colors.marcatori })),
    ...data.corner.map(x => ({ ...x, t: 'CORNER', s: x.selection, c: colors.corner }))
  ].sort((a, b) => b.probability - a.probability).slice(0, 30);
  combined.forEach((x, i) => {
    const vals = [i + 1, x.time, x.league, x.match, `${x.t}: ${x.s}`, `${x.probability}%`];
    vals.forEach((v, c) => { const cell = sum.getCell(i + 5, c + 1); cell.value = v; cell.font = { name: 'Arial', size: c === 5 ? 14 : 12, bold: c >= 4, color: { argb: c === 5 ? `FF${x.c}` : 'FFFFFFFF' } }; cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c === 0 || c === 5 ? 'center' : 'left' }; cell.border = { bottom: { style: 'thin', color: { argb: 'FF252525' } } }; });
    sum.getRow(i + 5).height = 36;
  });
  const a = wb.addWorksheet('AMMONITI'); setupSheet(a, 'TOP AMMONITI', colors.ammoniti, 'Probabilità di almeno un giallo · dati reali API-Football'); addRows(a, data.ammoniti, 'ammoniti', colors.ammoniti);
  const m = wb.addWorksheet('MARCATORI'); setupSheet(m, 'TOP MARCATORI', colors.marcatori, 'Probabilità di almeno un gol · dati reali API-Football'); addRows(m, data.marcatori, 'marcatori', colors.marcatori);
  const c = wb.addWorksheet('CORNER'); setupSheet(c, 'TOP CORNER', colors.corner, 'Ranking su Over 8.5 · storico corner reale delle squadre'); addRows(c, data.corner, 'corner', colors.corner);
  return wb.xlsx.writeBuffer();
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url); const date = searchParams.get('date'); const format = searchParams.get('format');
    const data = await analyzeDate(date);
    if (format === 'xlsx') {
      const buf = await makeWorkbook(data);
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="calcio-analysis-${date}.xlsx"`, 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return NextResponse.json({ error: e?.message || 'Errore' }, { status: 500 }); }
}
