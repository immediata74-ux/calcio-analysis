'use client';

import { useEffect, useMemo, useState } from 'react';

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
  const [tops, setTops] = useState({ cards: [], scorers: [], corners: [] });
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const active = useMemo(() => tops[tab] || [], [tops, tab]);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => setHealth({ ok: false }));
    fetch('/api/top').then(r => r.json()).then(setTops).catch(() => {});
  }, []);

  async function loadFixtures() {
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch(`/api/fixtures?date=${encodeURIComponent(date)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Errore nel caricamento');
      setFixtures(data.fixtures || []);
      setMessage(`${data.results || 0} partite caricate da API-Football.`);
    } catch (error) {
      setFixtures([]);
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <div className="eyebrow">Nuova app separata • Vercel</div>
        <h1>Calcio Analysis</h1>
        <p>Top Ammoniti, Marcatori e Corner con dati reali API-Football. Nessun dato mancante viene inventato o trasformato in zero.</p>
      </header>

      <section className="toolbar">
        <input className="dateBox" aria-label="Data palinsesto" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <button className="button" onClick={loadFixtures} disabled={loading}>{loading ? 'Carico…' : 'Carica palinsesto'}</button>
        <a className="download" href="/report-template.xlsx">Scarica Excel</a>
      </section>

      <div className="status">
        <strong>API-Football:</strong>{' '}
        {health === null ? 'controllo…' : health.apiKeyConfigured ? 'chiave configurata lato server' : 'chiave non ancora configurata su Vercel'}
        {message ? ` • ${message}` : ''}
      </div>

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
          <span>{active.length ? `${active.length} segnali` : 'nessun segnale forzato'}</span>
        </div>

        {active.length === 0 ? (
          <div className="empty">
            Il motore non mostra percentuali finché non dispone dello storico reale sufficiente. Questo è intenzionale: prima colleghiamo database e statistiche API-Football, poi generiamo i Top.
          </div>
        ) : (
          <div className="grid two">
            {active.map((item, i) => (
              <article className="card" key={`${item.id || i}`}>
                <div className="cardTop">
                  <div>
                    <div className="rank">#{i + 1}</div>
                    <div className="name">{item.name}</div>
                    <div className="meta">{item.fixture}</div>
                  </div>
                  <div className="percent">{item.percent}%</div>
                </div>
                <div className="badges">
                  <span className="badge">Affidabilità: {item.confidence}</span>
                  <span className="badge">Campione: {item.sample}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="sectionHead">
          <h2>Palinsesto caricato</h2>
          <span>{fixtures.length} partite</span>
        </div>
        <div className="card">
          {fixtures.length === 0 ? (
            <div className="meta">Seleziona una data e premi “Carica palinsesto”.</div>
          ) : fixtures.slice(0, 40).map(f => (
            <div className="fixture" key={f.fixture?.id}>
              <div className="fixtureTeams">{f.teams?.home?.name || 'N.D.'} — {f.teams?.away?.name || 'N.D.'}</div>
              <div className="fixtureMeta">{f.league?.name || 'Competizione N.D.'} • {formatKickoff(f.fixture?.date)}</div>
            </div>
          ))}
        </div>
      </section>

      <p className="footerNote">Stato dati previsto: AVAILABLE, MISSING, INSUFFICIENT_SAMPLE, NOT_SUPPORTED. I Top entreranno in classifica solo quando il campione supera le soglie minime definite dal motore.</p>
    </main>
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
