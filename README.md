# Calcio Analysis — Vercel

Nuova app indipendente, pensata per Vercel e smartphone.

## Stack

- Next.js 16.3.3 / App Router
- Vercel Functions tramite Route Handlers
- API-Football solo lato server
- Neon Postgres previsto per lo storico e i ranking
- Excel scuro in `public/report-template.xlsx`

## Regole dati

- Nessun dato mancante viene trasformato in zero.
- Nessuna percentuale viene inventata.
- Stati: `AVAILABLE`, `MISSING`, `INSUFFICIENT_SAMPLE`, `NOT_SUPPORTED`.
- I Top Ammoniti, Marcatori e Corner restano vuoti finché non è disponibile un campione reale sufficiente.

## Avvio locale

```bash
cp .env.example .env.local
npm install
npm run dev
```

Apri `http://localhost:3000`.

## Deploy Vercel

1. Crea un NUOVO progetto Vercel, separato dall'app attuale.
2. Collega questo progetto a un repository GitHub dedicato.
3. In Vercel → Project → Settings → Environment Variables aggiungi:
   - `APIFOOTBALL_KEY`
4. Esegui il deploy.

Non usare un nome `NEXT_PUBLIC_...` per la chiave API-Football: deve rimanere server-side.

## Database — prossimo blocco

Aggiungere Neon Postgres dal Vercel Marketplace e configurare `DATABASE_URL`. Poi implementare:

- ingestione palinsesto;
- storico giocatori e squadre;
- statistiche cartellini;
- statistiche marcatori/minuti;
- statistiche corner;
- motori di scoring prudente;
- generazione Excel con i risultati del giorno;
- job Vercel Cron per refresh programmati.
