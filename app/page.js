'use client';

import { useMemo, useState } from 'react';

function todayRome() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}

const COLORS = { ammoniti: '#FFD54A', marcatori: '#48D38A', corner: '#FF9F43' };

function ResultRow({ item, type, rank }) {
  const color = COLORS[type];
  const selection = type === 'corner' ? item.selection : item.player;
  const detail = type === 'corner'
    ? `Attesi ${item.expected} · O7.5 ${item.over75}% · O8.5 ${item.over85}% · O9.5 ${item.over95}%`
    : type === 'ammoniti'
      ? `Gialli/90 ${item.rate90} · ${item.minutes} min · ${item.appearances} pres.`
      : `Gol/90 ${item.rate90} · ${item.goals} gol · ${item.minutes} min`;

  return (
    <div className="result">
      <div className="topline">
        <span className="rank">#{rank}</span>
        <span className="time">{item.time}</span>
        <span className="league">{item.league}</span>
        <strong className="prob" style={{ color }}>{item.probability}%</strong>
      </div>
      <div className="match">{item.match}</div>
      <div className="selection" style={{ color }}>{selection}</div>
      <div className="detail">{detail}</div>
      <div className="badges"><span>{item.reliability}</span><span>{item.status || 'PRE-LINEUP'}</span></div>
    </div>
  );
}

function Section({ title, type, items }) {
  const color = COLORS[type];
  return (
    <section>
      <h2 style={{ color }}>{title} <small>Top {items?.length || 0}</small></h2>
      {!items?.length ? <div className="empty">Nessun candidato con dati sufficienti.</div> :
        items.map((x, i) => <ResultRow key={`${type}-${x.fixtureId}-${x.player || x.selection}-${i}`} item={x} type={type} rank={i + 1} />)}
    </section>
  );
}

export default function Page() {
  const [date, setDate] = useState(todayRome());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('riepilogo');

  const combined = useMemo(() => {
    if (!data) return [];
    return [
      ...data.ammoniti.map(x => ({ ...x, type: 'ammoniti' })),
      ...data.marcatori.map(x => ({ ...x, type: 'marcatori' })),
      ...data.corner.map(x => ({ ...x, type: 'corner' }))
    ].sort((a, b) => b.probability - a.probability);
  }, [data]);

  async function analyze() {
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch(`/api/analysis?date=${encodeURIComponent(date)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Errore analisi');
      setData(j);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  function downloadExcel() {
    window.location.href = `/api/analysis?date=${encodeURIComponent(date)}&format=xlsx`;
  }

  return (
    <main>
      <header>
        <div className="eyebrow">CALCIO ANALYSIS · MOBILE</div>
        <h1>Ammoniti · Marcatori · Corner</h1>
        <p>Niente foto. Ora, campionato, partita, selezione e probabilità in formato compatto.</p>
      </header>

      <div className="controls">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <button onClick={analyze} disabled={loading}>{loading ? 'Analisi…' : 'Analizza'}</button>
        <button className="excel" onClick={downloadExcel}>Excel nero</button>
      </div>

      {error && <div className="error">{error}</div>}
      {data && <div className="meta">{data.fixtureCount} partite · {data.leagueCount} campionati analizzati · ora Europe/Rome</div>}

      {data && <>
        <nav>
          {['riepilogo','ammoniti','marcatori','corner'].map(t => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'active' : ''}>{t}</button>)}
        </nav>

        {tab === 'riepilogo' && <section>
          <h2>Riepilogo <small>Top segnali</small></h2>
          {combined.slice(0, 20).map((x, i) => <ResultRow key={`all-${i}-${x.fixtureId}`} item={x} type={x.type} rank={i + 1} />)}
        </section>}
        {tab === 'ammoniti' && <Section title="Ammoniti" type="ammoniti" items={data.ammoniti} />}
        {tab === 'marcatori' && <Section title="Marcatori" type="marcatori" items={data.marcatori} />}
        {tab === 'corner' && <Section title="Corner" type="corner" items={data.corner} />}
      </>}

      <style jsx global>{`
        *{box-sizing:border-box} body{background:#050505;color:#fff} main{max-width:820px;margin:0 auto;padding:20px 14px 80px}
        header{padding:12px 2px 18px}.eyebrow{color:#48D38A;font-size:12px;font-weight:800;letter-spacing:1.5px}h1{font-size:28px;margin:8px 0 6px}p{color:#aaa;line-height:1.45;margin:0}
        .controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 14px}.controls input,.controls button{min-height:52px;border-radius:14px;border:1px solid #303030;background:#121212;color:#fff;font-size:16px;font-weight:700;padding:0 14px}.controls .excel{grid-column:1/-1;background:#0e0e0e;border-color:#48D38A;color:#48D38A}.controls button:disabled{opacity:.5}
        .meta,.error,.empty{background:#101010;border:1px solid #292929;border-radius:12px;padding:12px;margin:10px 0;color:#bbb}.error{border-color:#7b2b2b;color:#ffb5b5}
        nav{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;position:sticky;top:0;background:#050505;padding:8px 0;z-index:4}nav button{border:1px solid #2b2b2b;background:#101010;color:#aaa;border-radius:11px;min-height:42px;text-transform:capitalize;font-weight:800;font-size:12px}nav button.active{color:#fff;border-color:#555}
        section{margin-top:16px}h2{font-size:24px;margin:12px 2px}h2 small{float:right;color:#888;font-size:14px;font-weight:600;margin-top:7px}
        .result{background:#111;border:1px solid #2d2d2d;border-radius:16px;padding:13px;margin:9px 0}.topline{display:grid;grid-template-columns:auto auto 1fr auto;gap:8px;align-items:center}.rank,.time{color:#aaa;font-size:12px;font-weight:800}.league{font-size:12px;font-weight:800;text-transform:uppercase;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prob{font-size:26px}.match{font-size:16px;font-weight:800;margin-top:7px}.selection{font-size:20px;font-weight:900;margin-top:4px}.detail{margin-top:9px;color:#bbb;font-size:13px;line-height:1.35}.badges{display:flex;gap:6px;margin-top:10px}.badges span{font-size:11px;color:#9ddfb8;border:1px solid #245a39;border-radius:999px;padding:4px 8px}
        @media(min-width:650px){.controls{grid-template-columns:1fr 1fr 1fr}.controls .excel{grid-column:auto}h1{font-size:34px}.result{padding:16px}.match{font-size:18px}}
      `}</style>
    </main>
  );
}
