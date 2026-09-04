import ExcelJS from 'exceljs';
import { buildTopAnalysis } from '../../../lib/analysis/engine';
import { football } from '../../../lib/api-football';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLORS = {
  bg: '080808',
  panel: '141414',
  panel2: '0D0D0D',
  header: '202020',
  white: 'FFFFFF',
  muted: 'B5B5B5',
  yellow: 'FFD54A',
  green: '45D483',
  orange: 'FF9F43',
  border: '333333',
};

function darkSheet(ws, freezeRow = 4) {
  ws.views = [{ state: 'frozen', ySplit: freezeRow }];
  ws.properties.defaultRowHeight = 22;
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };
  ws.sheetProperties.pageSetUpPr = { fitToPage: true };
}

function title(ws, text, subtitle, lastCol) {
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = {
    bold: true,
    size: 18,
    color: { argb: COLORS.white },
  };
  ws.getCell('A1').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLORS.bg },
  };
  ws.getCell('A1').alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = {
    size: 10,
    color: { argb: COLORS.muted },
  };
  ws.getCell('A2').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLORS.bg },
  };
  ws.getCell('A2').alignment = {
    vertical: 'middle',
    wrapText: true,
  };
  ws.getRow(2).height = 32;
}

function header(ws, row, fill = COLORS.header) {
  row.eachCell(cell => {
    cell.font = {
      bold: true,
      color: { argb: COLORS.white },
      size: 10,
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fill },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: COLORS.border } },
    };
  });
  row.height = 30;
}

function body(ws, startRow = 5) {
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < startRow) return;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = {
        color: { argb: COLORS.white },
        size: 10,
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: COLORS.panel },
      };
      cell.alignment = {
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = {
        bottom: { style: 'hair', color: { argb: COLORS.border } },
      };
    });
  });
}

function setAutoFilter(ws, lastCol) {
  ws.autoFilter = {
    from: 'A4',
    to: `${lastCol}${Math.max(4, ws.rowCount)}`,
  };
}

function pct(v) {
  return Number.isFinite(v) ? `${v}%` : 'N.D.';
}

function fixtureLabel(fixture) {
  return `${fixture?.teams?.home?.name || 'N.D.'} — ${fixture?.teams?.away?.name || 'N.D.'}`;
}

function formatTime(value) {
  if (!value) return 'N.D.';
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return 'N.D.';
  }
}

function buildFixtureLookup(fixtures) {
  const byLabel = new Map();
  for (const fixture of fixtures || []) {
    const label = fixtureLabel(fixture);
    byLabel.set(label, fixture);
  }
  return byLabel;
}

function signalTime(signal, fixtureLookup) {
  const key = signal?.fixture || signal?.name;
  const fixture = fixtureLookup.get(key);
  return formatTime(fixture?.fixture?.date);
}

function summaryInfo(item, kind) {
  const d = item?.details || {};

  if (kind === 'Ammonito') {
    const pieces = [
      Number.isFinite(d.rate90) ? `Gialli/90 ${d.rate90}` : null,
      Number.isFinite(d.expectedMinutes) ? `Min ${d.expectedMinutes}` : null,
      d.lineup || null,
    ].filter(Boolean);
    return pieces.join(' • ');
  }

  if (kind === 'Marcatore') {
    const pieces = [
      Number.isFinite(d.rate90) ? `Gol/90 ${d.rate90}` : null,
      Number.isFinite(d.expectedMinutes) ? `Min ${d.expectedMinutes}` : null,
      d.lineup || null,
    ].filter(Boolean);
    return pieces.join(' • ');
  }

  const pieces = [
    Number.isFinite(d.expectedCorners) ? `Attesi ${d.expectedCorners}` : null,
    Number.isFinite(d.over75) ? `O7.5 ${d.over75}%` : null,
    Number.isFinite(d.over95) ? `O9.5 ${d.over95}%` : null,
    Number.isFinite(d.over105) ? `O10.5 ${d.over105}%` : null,
  ].filter(Boolean);
  return pieces.join(' • ');
}

function styleSummaryRows(ws) {
  for (let r = 5; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    row.height = 32;

    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: COLORS.panel },
      };
      cell.font = {
        color: { argb: COLORS.white },
        size: 11,
      };
      cell.alignment = {
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = {
        bottom: { style: 'hair', color: { argb: COLORS.border } },
      };
    });

    const kind = row.getCell(2).value;
    const accent =
      kind === 'Ammonito'
        ? COLORS.yellow
        : kind === 'Marcatore'
          ? COLORS.green
          : COLORS.orange;

    row.getCell(2).font = {
      bold: true,
      color: { argb: accent },
      size: 11,
    };
    row.getCell(6).font = {
      bold: true,
      color: { argb: COLORS.white },
      size: 13,
    };
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || '';
  const league = searchParams.get('league') || '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: 'Data richiesta nel formato YYYY-MM-DD' },
      { status: 400 },
    );
  }

  try {
    const [analysis, fixtureData] = await Promise.all([
      buildTopAnalysis({ date, league }),
      football.fixturesByDate(date),
    ]);

    const fixtures = fixtureData?.response || [];
    const fixtureLookup = buildFixtureLookup(fixtures);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Calcio Analysis';
    wb.created = new Date();

    // ============================================================
    // 1) RIEPILOGO MOBILE - FOGLIO PRINCIPALE, COMPATTO, SFONDO NERO
    // ============================================================
    const mobile = wb.addWorksheet('Riepilogo Mobile');
    darkSheet(mobile);
    title(
      mobile,
      'CALCIO ANALYSIS — RIEPILOGO MOBILE',
      `Data ${date} • Ammoniti, Marcatori e Corner • ora italiana • dati reali API-Football`,
      'H',
    );

    mobile.addRow([]);
    mobile.addRow([
      '#',
      'Tipo',
      'Ora',
      'Campionato',
      'Partita',
      'Nome / Mercato',
      '%',
      'Info rapida',
    ]);
    header(mobile, mobile.getRow(4), COLORS.header);

    let rank = 1;

    for (const x of analysis.cards || []) {
      mobile.addRow([
        rank++,
        'Ammonito',
        signalTime(x, fixtureLookup),
        x.league || 'N.D.',
        x.fixture || 'N.D.',
        x.name || 'N.D.',
        pct(x.percent),
        summaryInfo(x, 'Ammonito'),
      ]);
    }

    rank = 1;
    for (const x of analysis.scorers || []) {
      mobile.addRow([
        rank++,
        'Marcatore',
        signalTime(x, fixtureLookup),
        x.league || 'N.D.',
        x.fixture || 'N.D.',
        x.name || 'N.D.',
        pct(x.percent),
        summaryInfo(x, 'Marcatore'),
      ]);
    }

    rank = 1;
    for (const x of analysis.corners || []) {
      mobile.addRow([
        rank++,
        'Corner',
        signalTime(x, fixtureLookup),
        x.league || 'N.D.',
        x.fixture || x.name || 'N.D.',
        'Over 8.5 corner',
        pct(x.details?.over85 ?? x.percent),
        summaryInfo(x, 'Corner'),
      ]);
    }

    mobile.columns = [
      { width: 5 },
      { width: 12 },
      { width: 8 },
      { width: 20 },
      { width: 30 },
      { width: 22 },
      { width: 8 },
      { width: 30 },
    ];

    styleSummaryRows(mobile);
    setAutoFilter(mobile, 'H');

    // ============================================================
    // 2) REPORT GENERALE
    // ============================================================
    const report = wb.addWorksheet('Report');
    darkSheet(report);
    title(
      report,
      'CALCIO ANALYSIS — REPORT',
      `Data ${date} • dati reali API-Football • copertura verificata • nessun null trasformato in zero`,
      'H',
    );
    report.addRow([]);
    report.addRow([
      'Sezione',
      'Segnali',
      'Top %',
      'Affidabilità alta',
      'Affidabilità media',
      'Affidabilità bassa',
      'Scope',
      'Note',
    ]);
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

    // ============================================================
    // 3) AMMONITI
    // ============================================================
    const cards = wb.addWorksheet('Ammoniti');
    darkSheet(cards);
    title(
      cards,
      'TOP AMMONITI / CARTELLINI',
      'Stima di ammonizione da gialli/90 reali. Ora e campionato inclusi. Lineup ufficiale applicata quando disponibile.',
      'Q',
    );

    cards.addRow([]);
    cards.addRow([
      'Rank',
      'Ora',
      'Giocatore',
      'Partita',
      'Campionato',
      '% ammonizione',
      'Affidabilità',
      'Campione',
      'Gialli',
      'Rossi',
      'Gialli/90',
      'Minuti attesi',
      'Lineup',
      'Stato',
      'Modello',
      'Data',
      'Fonte',
    ]);
    header(cards, cards.getRow(4), '5B4A00');

    analysis.cards.forEach((x, i) =>
      cards.addRow([
        i + 1,
        signalTime(x, fixtureLookup),
        x.name,
        x.fixture,
        x.league,
        pct(x.percent),
        x.confidence,
        x.sample,
        x.details?.yellow ?? 'N.D.',
        x.details?.red ?? 'N.D.',
        x.details?.rate90 ?? 'N.D.',
        x.details?.expectedMinutes ?? 'N.D.',
        x.details?.lineup ?? 'PRE-LINEUP',
        x.status,
        x.details?.model,
        date,
        'API-Football',
      ]),
    );

    cards.columns = [
      7, 8, 22, 29, 20, 14, 14, 18, 9, 9, 12, 14, 13, 14, 48, 12, 14,
    ].map(width => ({ width }));
    body(cards);
    setAutoFilter(cards, 'Q');

    // ============================================================
    // 4) MARCATORI
    // ============================================================
    const scorers = wb.addWorksheet('Marcatori');
    darkSheet(scorers);
    title(
      scorers,
      'TOP MARCATORI',
      'Probabilità di almeno un gol da gol/90 reali. Ora e campionato inclusi. Lineup ufficiale applicata quando disponibile.',
      'P',
    );

    scorers.addRow([]);
    scorers.addRow([
      'Rank',
      'Ora',
      'Giocatore',
      'Partita',
      'Campionato',
      '% gol',
      'Affidabilità',
      'Campione',
      'Gol',
      'Gol/90',
      'Minuti attesi',
      'Lineup',
      'Stato',
      'Modello',
      'Data',
      'Fonte',
    ]);
    header(scorers, scorers.getRow(4), '064B2B');

    analysis.scorers.forEach((x, i) =>
      scorers.addRow([
        i + 1,
        signalTime(x, fixtureLookup),
        x.name,
        x.fixture,
        x.league,
        pct(x.percent),
        x.confidence,
        x.sample,
        x.details?.goals ?? 'N.D.',
        x.details?.rate90 ?? 'N.D.',
        x.details?.expectedMinutes ?? 'N.D.',
        x.details?.lineup ?? 'PRE-LINEUP',
        x.status,
        x.details?.model,
        date,
        'API-Football',
      ]),
    );

    scorers.columns = [
      7, 8, 22, 29, 20, 11, 14, 18, 9, 11, 14, 13, 14, 48, 12, 14,
    ].map(width => ({ width }));
    body(scorers);
    setAutoFilter(scorers, 'P');

    // ============================================================
    // 5) CORNER
    // ============================================================
    const corners = wb.addWorksheet('Corner');
    darkSheet(corners);
    title(
      corners,
      'TOP CORNER',
      'Corner reali delle ultime gare nella stessa competizione. Ora e campionato inclusi. Soglie mostrate solo con campione valido.',
      'P',
    );

    corners.addRow([]);
    corners.addRow([
      'Rank',
      'Ora',
      'Partita',
      'Campionato',
      'Corner attesi',
      'Over 7.5',
      'Over 8.5',
      'Over 9.5',
      'Over 10.5',
      'Over 11.5',
      'Affidabilità',
      'Campione',
      'Stato',
      'Modello',
      'Data',
      'Fonte',
    ]);
    header(corners, corners.getRow(4), '6A3500');

    analysis.corners.forEach((x, i) =>
      corners.addRow([
        i + 1,
        signalTime(x, fixtureLookup),
        x.fixture || x.name,
        x.league,
        x.details?.expectedCorners ?? 'N.D.',
        pct(x.details?.over75),
        pct(x.details?.over85),
        pct(x.details?.over95),
        pct(x.details?.over105),
        pct(x.details?.over115),
        x.confidence,
        x.sample,
        x.status,
        x.details?.model,
        date,
        'API-Football',
      ]),
    );

    corners.columns = [
      7, 8, 30, 20, 14, 11, 11, 11, 12, 12, 14, 18, 14, 50, 12, 14,
    ].map(width => ({ width }));
    body(corners);
    setAutoFilter(corners, 'P');

    const buffer = await wb.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="calcio-analysis-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json(
      { error: error.message || 'Errore generazione Excel' },
      { status: error.status || 500 },
    );
  }
}
