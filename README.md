# Calcio Analysis v0.9

App Next.js separata per Vercel, mobile-first, sfondo nero.

## Fix v0.9
- seleziona prima le competizioni del palinsesto con coverage reale API-Football;
- Ammoniti e Marcatori: Top/players stagionali; se non bastano, fallback sugli **eventi reali delle ultime 5 gare** delle squadre (gol e cartellini), con stima Wilson prudente;
- Corner: prova il batch `/fixtures?ids`; se il piano/competizione non include il blocco `statistics`, usa esplicitamente `/fixtures/statistics?fixture=...`;
- autogol esclusi dai marcatori; null mai convertiti in zero;
- diagnostica visibile per capire quante fixture hanno eventi/statistiche reali.

Variabile Vercel: `APIFOOTBALL_KEY`.
