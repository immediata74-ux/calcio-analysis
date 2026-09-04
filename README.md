# Calcio Analysis v0.7

Nuova app separata per Vercel con API-Football.

## Novità v0.7

- rimosso il filtro rigido di coverage che poteva lasciare `0 squadre` anche con centinaia di fixture;
- l'analisi parte direttamente dalle squadre del palinsesto selezionato;
- recupera le ultime 6 gare reali per squadra con `/fixtures?team=...&last=6`;
- carica i dettagli fixture in batch con `ids` (eventi, lineup, statistiche e giocatori quando disponibili);
- fallback prudente su statistiche stagionali reali `/players?team=...&season=...` solo quando le fixture recenti non hanno statistiche giocatore;
- corner calcolati solo con almeno 3 gare recenti valide per entrambe le squadre;
- nessun `null` viene trasformato in zero;
- diagnostica visibile nell'app per capire quante squadre/fixture/statistiche sono state davvero recuperate.

## Variabile Vercel

`APIFOOTBALL_KEY`
