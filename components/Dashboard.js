'use client';

import { useMemo, useState } from 'react';

const TABS = [
  { key: 'cards', label: '🟨 Ammoniti' },
  { key: 'scorers', label: '⚽ Marcatori' },
  { key: 'corners', label: '🚩 Corner' },
];

function localDateISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function Dashboard() {
  const [tab, setTab] = useState('cards');
  const [date, setDate] = useState(localDateISO());
  const [fixtures, setFixtures] = useState([]);
  const [league, setLeague] = useState('');
  const [leagueOptions, setLeagueOptions] = useState([]);
  const [tops, setTops] = useState({ cards: [], scorers: [], corners: [] });
  const [meta, setMeta] = useState(null);
  const [health, setHealth] = useState(null);
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [message, setMessage] = useState('');

  const active = useMemo(() => tops[tab] || [], [tops, tab]);
  const reportHref = `/api/report?date=${encodeURIComponent(date)}${league ? `&league=${encodeURIComponent(league)}` : ''}`;

  async function checkHealth() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      setHealth(await res.json());
    } catch {
      setHealth({ ok: false, apiKeyConfigured: false });
    }
  }

  async function loadFixtures() {
    setLoadingFixtures(true);
    setMessage('');
    setTops({ cards: [], scorers: [], corners: [] });
    setMeta(null);
    try {
      await checkHealth();
      const res = await fetch(`/api/fixtures?date=${encodeURIComponent(date)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Errore nel caricamento');
      const list = data.fixtures || [];
      setFixtures(list);
      const unique = [...new Map(list.map(f => [Number(f?.league?.id), f?.league?.name]).filter(([id]) => id)).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
      setLeagueOptions(unique);
      if (league && !unique.some(x => String(x.id) === String(league))) setLeague('');
      setMessage(`${data.results || 0} partite caricate da API-Football.`);
    } catch (error) {
      setFixtures([]);
      setLeagueOptions([]);
      setMessage(error.message);
    } finally {
      setLoadingFixtures(false);
    }
  }

  async function analyzeTops() {
    setLoadingAnalysis(true);
    setMessage('Analisi in corso: controllo copertura, giocatori, lineup e corner reali…');
    try {
      const query = new URLSearchParams({ date });
      if (league) query.set('league', league);
      const res = await fetch(`/api/analyze?${query.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Errore durante analisi');
      setTops({ cards: data.cards || [], scorers: data.scorers || [], corners: data.corners || [] });
      setMeta(data.meta || null);
      if (data.meta?.leagueOptions?.length) setLeagueOptions(data.meta.leagueOptions);
      setMessage(`Analisi completata: ${data.cards?.length || 0} ammoniti, ${data.scorers?.length || 0} marcatori, ${data.corners?.length || 0} corner.`);
    } catch (error) {
      setTops({ cards: [], scorers: [], corners: [] });
      setMeta(null);
      setMessage(error.message);
    } finally {
      setLoadingAnalysis(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <div className="eyebrow">Nuova app separata • Vercel • v0.6</div>
        <h1>Calcio Analysis</h1>
        <p>Top Ammoniti, Marcatori e Corner con dati reali API-Football. Nessun dato mancante viene inventato o trasformato in zero.</p>
      </header>

      <section className="toolbar">
        <input className="dateBox" aria-label="Data palinsesto" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <button className="button" onClick={loadFixtures} disabled={loadingFixtures || loadingAnalysis}>{loadingFixtures ? 'Carico…' : 'Carica palinsesto'}</button>
        <select className="leagueBox" value={league} onChange={e => setLeague(e.target.value)} disabled={!leagueOptions.length || loadingAnalysis}>
          <option value="">Tutte • analisi prudente</option>
          {leagueOptions.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
        <button className="button primary" onClick={analyzeTops} disabled={loadingAnalysis || !fixtures.length}>{loadingAnalysis ? 'Analizzo…' : 'Analizza Top'}</button>
        <a className={`download ${!meta ? 'disabledLink' : ''}`} href={meta ? reportHref : undefined} aria-disabled={!meta}>Scarica Excel report</a>
      </section>

      <div className="status">
        <strong>API-Football:</strong>{' '}
        {health === null ? 'premi “Carica palinsesto”' : health.apiKeyConfigured ? 'chiave configurata lato server' : 'chiave non configurata su Vercel'}
        {message ? ` • ${message}` : ''}
      </div>

      {meta && (
        <div className="scopeNote">
          <strong>Analisi prudente:</strong>{' '}
          {meta.scope === 'single_league'
            ? 'competizione selezionata: analizziamo le partite coperte di quella lega'
            : `modalità Tutte: fino a ${meta.limits?.leagues || 6} competizioni con storico dettagliato API-Football`}
          {' '}• {meta.deepTeamsFetched || 0} squadre • fino a {meta.limits?.recentMatchesPerTeam || 6} gare recenti per squadra, con stagione precedente solo se serve a completare il campione
          {' '}• lineup ufficiali controllate su {meta.lineupFixturesChecked || 0} fixture.
          {meta.diagnostics && ` Dettagli recuperati: ${meta.diagnostics.detailedBundles || 0} fixture, ${meta.diagnostics.aggregatedPlayerRows || 0} righe giocatore.`}
        </div>
      )}

      <nav className="tabs" aria-label="Analisi">
        {TABS.map(item => (
          <button key={item.key} className={`tab ${item.key} ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>

      <section>
        <div className="sectionHead">
          <h2>{TABS.find(x => x.key === tab)?.label}</h2>
          <span>{active.length ? `Top ${active.length}` : 'nessun segnale forzato'}</span>
        </div>

        {active.length === 0 ? (
          <div className="empty">
            {meta ? 'Nessun candidato ha superato i controlli minimi con i dati disponibili per questa selezione.' : 'Carica il palinsesto e premi “Analizza Top”. Il motore esclude dati mancanti e campioni troppo piccoli invece di inventare percentuali.'}
          </div>
        ) : (
          <div className="grid two">
            {active.map((item, i) => <SignalCard key={item.id || i} item={item} rank={i + 1} kind={tab} />)}
          </div>
        )}
      </section>

      <section>
        <div className="sectionHead">
          <h2>Palinsesto caricato</h2>
          <span>{fixtures.length} partite</span>
        </div>
        <div className="card fixtureList">
          {fixtures.length === 0 ? (
            <div className="meta">Seleziona una data e premi “Carica palinsesto”.</div>
          ) : fixtures.slice(0, 60).map(f => (
            <div className="fixture" key={f.fixture?.id}>
              <div className="fixtureTeams">{f.teams?.home?.name || 'N.D.'} — {f.teams?.away?.name || 'N.D.'}</div>
              <div className="fixtureMeta">{f.league?.name || 'Competizione N.D.'} • {formatKickoff(f.fixture?.date)}</div>
            </div>
          ))}
        </div>
      </section>

      <p className="footerNote">Stati dati: AVAILABLE, MISSING, INSUFFICIENT_SAMPLE, NOT_SUPPORTED. Le percentuali sono stime statistiche, non certezze; i null API-Football restano null e non diventano zero.</p>
    </main>
  );
}

function SignalCard({ item, rank, kind }) {
  const d = item.details || {};
  return (
    <article className="card signalCard">
      <div className="cardTop">
        <div>
          <div className="rank">#{rank} • {item.league || 'N.D.'}</div>
          <div className="name">{item.name}</div>
          <div className="meta">{item.fixture}</div>
        </div>
        <div className="percent">{item.percent ?? '—'}%</div>
      </div>
      <div className="badges">
        <span className="badge">Affidabilità: {item.confidence}</span>
        <span className="badge">Campione: {item.sample}</span>
        {d.lineup && <span className={`badge lineup ${String(d.lineup).toLowerCase()}`}>{d.lineup}</span>}
        <span className="badge ok">{item.status}</span>
      </div>
      {kind === 'cards' && (
        <div className="details">
          <span>Gialli: <b>{d.yellow ?? 'N.D.'}</b></span>
          <span>Gialli/90: <b>{d.rate90 ?? 'N.D.'}</b></span>
          <span>Minuti stimati: <b>{d.expectedMinutes ?? 'N.D.'}</b></span>
          <span>Rossi: <b>{d.red ?? 'N.D.'}</b></span>
        </div>
      )}
      {kind === 'scorers' && (
        <div className="details">
          <span>Gol: <b>{d.goals ?? 'N.D.'}</b></span>
          <span>Gol/90: <b>{d.rate90 ?? 'N.D.'}</b></span>
          <span>Minuti stimati: <b>{d.expectedMinutes ?? 'N.D.'}</b></span>
        </div>
      )}
      {kind === 'corners' && (
        <div className="details cornersGrid">
          <span>Attesi: <b>{d.expectedCorners ?? 'N.D.'}</b></span>
          <span>O7.5: <b>{d.over75 ?? '—'}%</b></span>
          <span>O8.5: <b>{d.over85 ?? '—'}%</b></span>
          <span>O9.5: <b>{d.over95 ?? '—'}%</b></span>
          <span>O10.5: <b>{d.over105 ?? '—'}%</b></span>
          <span>O11.5: <b>{d.over115 ?? '—'}%</b></span>
        </div>
      )}
      <div className="modelNote">{d.model}</div>
    </article>
  );
}

function formatKickoff(value) {
  if (!value) return 'Orario N.D.';
  try {
    return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}
