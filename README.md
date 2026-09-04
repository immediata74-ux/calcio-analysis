# Calcio Analysis — Vercel v0.4

Nuova app **separata** mobile-first, sfondo nero, per:
- Top Ammoniti / cartellini
- Top Marcatori
- Top Corner
- Excel con fogli Report, Ammoniti, Marcatori, Corner

## Variabile obbligatoria Vercel

`APIFOOTBALL_KEY` = chiave API-Football / API-Sports.

## Novità v0.4

1. **Carica palinsesto** con `/fixtures?date=...`.
2. Filtro opzionale per singola competizione.
3. Prima dell'analisi controlla la **coverage** della lega/stagione.
4. **Ammoniti**: candidati reali da `/players/topyellowcards`, tasso gialli/90 regolarizzato, minuti medi reali. I giocatori usati da subentranti non vengono gonfiati artificialmente.
5. **Marcatori**: candidati reali da `/players/topscorers`, gol/90 regolarizzato e probabilità di almeno un gol.
6. **Lineup**: quando API-Football ha già pubblicato le formazioni, il motore distingue `TITOLARE`, `PANCHINA` e giocatore non presente. Un giocatore in panchina riceve minuti attesi ridotti; un giocatore escluso dalla formazione non entra nel Top.
7. **Corner**: storico della stessa lega, fino a 5 gare valide recenti per squadra. Le fixture storiche sono scaricate in batch fino a 20 ID per richiesta; `Corner Kicks` mancanti restano mancanti.
8. **Excel automatico** con 4 fogli e gli stessi Top dell'app.

## Regole prudenziali

- `null` non diventa mai zero.
- Giocatori con meno di 270 minuti o 3 presenze vengono esclusi.
- Corner: minimo 3 gare con statistiche corner valide per entrambe le squadre.
- Le percentuali sono stime statistiche e non certezze.
- Modalità **Tutte**: massimo 8 competizioni per Ammoniti/Marcatori e 2 competizioni coperte per Corner per contenere quota e tempi.
- Se vuoi il Top Corner più completo, seleziona una singola competizione prima di premere **Analizza Top**.
- Le risposte storiche vengono cacheate da Next/Vercel.

## Aggiornamento su Vercel

Carica questa versione come nuovo deployment dello **stesso progetto Calcio Analysis**. Non creare o modificare gli altri progetti. La variabile `APIFOOTBALL_KEY` resta nel progetto Vercel e non va inserita nei file.

Dopo il deployment:
1. `Carica palinsesto`.
2. opzionalmente scegli una competizione.
3. `Analizza Top`.
4. passa tra Ammoniti / Marcatori / Corner.
5. `Scarica Excel report`.
