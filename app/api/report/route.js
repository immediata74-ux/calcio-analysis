import ExcelJS from 'exceljs';
import { buildTopAnalysis } from '../../../lib/analysis/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLORS = {
  bg: '080808',
  panel: '141414',
  header: '202020',
  white: 'FFFFFF',
  muted: 'B5B5B5',
  yellow: 'FFD54A',
  green: '45D483',
  orange: 'FF9F43',
  border: '333333',
};

function darkSheet(ws) {
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  ws.properties.defaultRowHeight = 22;
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function title(ws, text, subtitle, lastCol) {
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { bold: true, size: 18, color: { argb: COLORS.white } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bg } };
  ws.getCell('A1').alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;
  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { size: 10, color: { argb: COLORS.muted } };
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bg } };
  ws.getCell('A2').alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 30;
}

function header(ws, row, fill) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.border } } };
  });
  row.height = 30;
}

function body(ws) {
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < 5) return;
    row.eachCell(cell => {
      cell.font = { color: { argb: COLORS.white }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.panel } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: COLORS.border } } };
    });
  });
}

function setAutoFilter(ws, lastCol) {
  ws.autoFilter = { from: 'A4', to: `${lastCol}${Math.max(4, ws.rowCount)}` };
}

function pct(v) {
  return Number.isFinite(v) ? `${v}%` : 'N.D.';
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || '';
  const league = searchParams.get('league') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'Data richiesta nel formato YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const analysis = await buildTopAnalysis({ date, league });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Calcio Analysis';
    wb.created = new Date();

    const report = wb.addWorksheet('Report');
    darkSheet(report);
    title(report, 'CALCIO ANALYSIS — REPORT', `Data ${date} • dati reali API-Football • copertura verificata • nessun null trasformato in zero`, 'H');
    report.addRow([]);
    report.addRow(['Sezione', 'Segnali', 'Top %', 'Affidabilità alta', 'Affidabilità media', 'Affidabilità bassa', 'Scope', 'Note']);
    header(report, report.getRow(4), COLORS.header);
    const sections = [
      ['Ammoniti', analysis.cards],
      ['Marcatori', analysis.scorers],
      ['Corner', analysis.corners],
    ];
    for (const [name, list] of sections) {
      report.addRow([
        name,
        list.length,
        pct(list[0]?.percent),
        list.filter(x => x.confidence === 'Alta').length,
        list.filter(x => x.confidence === 'Media').length,
        list.filter(x => x.confidence === 'Bassa').length,
        analysis.meta?.scope || '',
        analysis.meta?.note || '',
      ]);
    }
    report.columns = [14, 10, 10, 16, 18, 18, 18, 48].map(width => ({ width }));
    body(report);
    setAutoFilter(report, 'H');

    const cards = wb.addWorksheet('Ammoniti');
    darkSheet(cards);
    title(cards, 'TOP AMMONITI / CARTELLINI', 'Stima di ammonizione da gialli/90 reali. Lineup ufficiale applicata quando disponibile; subentranti penalizzati.', 'P');
    cards.addRow([]);
    cards.addRow(['Rank', 'Giocatore', 'Partita', 'Campionato', '% ammonizione', 'Affidabilità', 'Campione', 'Gialli', 'Rossi', 'Gialli/90', 'Minuti attesi', 'Lineup', 'Stato', 'Modello', 'Data', 'Fonte']);
    header(cards, cards.getRow(4), '5B4A00');
    analysis.cards.forEach((x, i) => cards.addRow([
      i + 1, x.name, x.fixture, x.league, pct(x.percent), x.confidence, x.sample,
      x.details?.yellow ?? 'N.D.', x.details?.red ?? 'N.D.', x.details?.rate90 ?? 'N.D.',
      x.details?.expectedMinutes ?? 'N.D.', x.details?.lineup ?? 'PRE-LINEUP', x.status,
      x.details?.model, date, 'API-Football',
    ]));
    cards.columns = [7, 22, 29, 20, 14, 14, 18, 9, 9, 12, 14, 13, 14, 48, 12, 14].map(width => ({ width }));
    body(cards);
    setAutoFilter(cards, 'P');

    const scorers = wb.addWorksheet('Marcatori');
    darkSheet(scorers);
    title(scorers, 'TOP MARCATORI', 'Probabilità di almeno un gol da gol/90 reali con regolarizzazione prudente. Lineup ufficiale applicata quando disponibile.', 'O');
    scorers.addRow([]);
    scorers.addRow(['Rank', 'Giocatore', 'Partita', 'Campionato', '% gol', 'Affidabilità', 'Campione', 'Gol', 'Gol/90', 'Minuti attesi', 'Lineup', 'Stato', 'Modello', 'Data', 'Fonte']);
    header(scorers, scorers.getRow(4), '064B2B');
    analysis.scorers.forEach((x, i) => scorers.addRow([
      i + 1, x.name, x.fixture, x.league, pct(x.percent), x.confidence, x.sample,
      x.details?.goals ?? 'N.D.', x.details?.rate90 ?? 'N.D.', x.details?.expectedMinutes ?? 'N.D.',
      x.details?.lineup ?? 'PRE-LINEUP', x.status, x.details?.model, date, 'API-Football',
    ]));
    scorers.columns = [7, 22, 29, 20, 11, 14, 18, 9, 11, 14, 13, 14, 48, 12, 14].map(width => ({ width }));
    body(scorers);
    setAutoFilter(scorers, 'O');

    const corners = wb.addWorksheet('Corner');
    darkSheet(corners);
    title(corners, 'TOP CORNER', 'Corner reali delle ultime gare nella stessa competizione. Soglie mostrate solo con almeno 3 gare valide per squadra.', 'O');
    corners.addRow([]);
    corners.addRow(['Rank', 'Partita', 'Campionato', 'Corner attesi', 'Over 7.5', 'Over 8.5', 'Over 9.5', 'Over 10.5', 'Over 11.5', 'Affidabilità', 'Campione', 'Stato', 'Modello', 'Data', 'Fonte']);
    header(corners, corners.getRow(4), '6A3500');
    analysis.corners.forEach((x, i) => corners.addRow([
      i + 1, x.name, x.league, x.details?.expectedCorners ?? 'N.D.', pct(x.details?.over75), pct(x.details?.over85),
      pct(x.details?.over95), pct(x.details?.over105), pct(x.details?.over115), x.confidence, x.sample,
      x.status, x.details?.model, date, 'API-Football',
    ]));
    corners.columns = [7, 30, 20, 14, 11, 11, 11, 12, 12, 14, 18, 14, 50, 12, 14].map(width => ({ width }));
    body(corners);
    setAutoFilter(corners, 'O');

    const buffer = await wb.xlsx.writeBuffer();
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="calcio-analysis-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json({ error: error.message || 'Errore generazione Excel' }, { status: error.status || 500 });
  }
}
