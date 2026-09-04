export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function quantile(values, q = 0.5) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const pos = (clean.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return clean[base + 1] !== undefined
    ? clean[base] + rest * (clean[base + 1] - clean[base])
    : clean[base];
}

export function poissonAtLeast(lambda, minimum) {
  if (!Number.isFinite(lambda) || lambda < 0 || minimum < 0) return null;
  if (minimum <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let k = 1; k < minimum; k += 1) {
    term *= lambda / k;
    cdf += term;
  }
  return clamp(1 - cdf, 0, 1);
}

export function percent(value) {
  return Number.isFinite(value) ? Math.round(clamp(value, 0, 1) * 100) : null;
}

export function confidenceFromMinutes(minutes, appearances) {
  if (minutes >= 1350 && appearances >= 15) return 'Alta';
  if (minutes >= 720 && appearances >= 8) return 'Media';
  return 'Bassa';
}

export function playerLeagueStat(entry, leagueId, season) {
  const list = Array.isArray(entry?.statistics) ? entry.statistics : [];
  return list.find(s => Number(s?.league?.id) === Number(leagueId) && Number(s?.league?.season) === Number(season))
    || list.find(s => Number(s?.league?.id) === Number(leagueId))
    || null;
}

export function expectedMinutes(stat) {
  const minutes = Number(stat?.games?.minutes);
  const appearances = Number(stat?.games?.appearences);
  if (!Number.isFinite(minutes) || !Number.isFinite(appearances) || appearances <= 0) return null;
  // Non imponiamo 45': i giocatori usati spesso da subentranti devono restare penalizzati.
  return clamp(minutes / appearances, 15, 90);
}

export function fixtureLabel(fixture) {
  return `${fixture?.teams?.home?.name || 'N.D.'} — ${fixture?.teams?.away?.name || 'N.D.'}`;
}

export function isPreMatch(fixture) {
  const short = fixture?.fixture?.status?.short;
  return short === 'NS' || short === 'TBD';
}

export function kickoffMs(fixture) {
  const value = Date.parse(fixture?.fixture?.date || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function dateShift(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
