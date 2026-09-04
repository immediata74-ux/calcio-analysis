# Calcio Analysis v0.5

Versione Vercel/Next.js con Top Ammoniti, Marcatori e Corner.

Novità v0.5:
- selezione competizioni dopo controllo coverage, non solo per numero di fixture;
- fallback `/players?team=&season=` per le squadre del palinsesto, perché gli endpoint Top restituiscono solo 20 giocatori;
- paginazione limitata e quote prudenti;
- corner: lookback 180 giorni e fino a 7 gare valide;
- diagnostica meta con squadre approfondite e candidati grezzi.

Nessun null API-Football viene trasformato in zero.
