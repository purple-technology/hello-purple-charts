// Hello Purple themes for the charts: "Paper" (cream, the default) and
// "Midnight" (the site's midnight-berry band). One place for every colour the
// canvas uses; the page itself takes the same values from style.css.
//
// Brand tokens come from hello-purple.com's own design system (--hp-* variables)
// and the hero-plate renderer in the Hello Purple skill (violet 124,58,237 and
// orange 255,158,100 on a 24px dot grid).
//
// Chart colours were checked with the dataviz palette validator against the
// chart surface of each theme (see BUILD_NOTES, part 4). The brand has exactly
// two hues that stay apart for every reader (indigo/violet and orange), so
// indicators alternate those two and change line style from the third one on,
// instead of inventing extra colours.
(function () {
  'use strict';

  const THEMES = {
    paper: {
      id: 'paper',
      label: 'Paper',
      graph: '#f7f7fe',        // --surface-graph
      text: '#2a1b4e',         // --hp-midnight-berry
      muted: '#5b5470',        // --hp-ink-500
      grid: '#d8d7fb',         // dots of the grid (--hp-lavender-200), sparse dotted
      border: '#e3decf',       // --hp-line-300
      candleInk: '#2a1b4e',    // candles in ink: rising hollow, falling filled
      candleHollow: '#f7f7fe',
      volUp: 'rgba(42,27,78,0.14)',
      volDown: 'rgba(42,27,78,0.32)',
      buy: '#7c3aed',          // your buys: blue-violet
      sell: '#c85e38',         // your sells: orange-600
      win: '#7c3aed',
      loss: '#c85e38',
      winBand: '124,58,237',
      lossBand: '200,94,56',
      series: ['#5d5ad8', '#c85e38'], // indicator hues, fixed order (validated)
      histUp: 'rgba(124,58,237,0.42)',
      histDown: 'rgba(200,94,56,0.48)',
      spread: 'rgba(93,90,216,0.40)',
      level: '#857f97',        // RSI 70/30 lines (--hp-ink-400)
      crosshair: '#7c3aed',
      crosshairLabel: '#2a1b4e',
      labelBg: 'rgba(255,253,246,0.94)', // --hp-cream-50
      labelText: '#2a1b4e',
      plateGrid: '124,58,237',
      plateHot: '222,115,71',  // orange-500: the plate's "hot" dots on cream
    },
    midnight: {
      id: 'midnight',
      label: 'Midnight',
      graph: '#1e123a',        // --hp-berry-900
      text: '#fdf8e8',         // --hp-cream-white
      muted: '#b2a6c6',
      grid: '#3d2f6b',
      border: '#453470',       // --hp-berry-500
      candleInk: '#bdbbf8',    // --hp-periwinkle
      candleHollow: '#1e123a',
      volUp: 'rgba(189,187,248,0.16)',
      volDown: 'rgba(189,187,248,0.38)',
      buy: '#8b5cf6',          // violet-500
      sell: '#c85e38',
      win: '#8b5cf6',
      loss: '#c85e38',
      winBand: '139,92,246',
      lossBand: '200,94,56',
      series: ['#6f6cf0', '#c85e38'],
      histUp: 'rgba(139,92,246,0.5)',
      histDown: 'rgba(200,94,56,0.55)',
      spread: 'rgba(111,108,240,0.45)',
      level: '#857f97',
      crosshair: '#918ef4',    // tropical indigo
      crosshairLabel: '#7c3aed',
      labelBg: 'rgba(42,27,78,0.92)',
      labelText: '#fdf8e8',
      plateGrid: '145,142,244',
      plateHot: '255,158,100', // the site's pastel orange on berry
    },
  };

  // Line styles used together with the two hues: 1 solid, 2 solid, 3 dashed...
  const STYLE_STEPS = [0, 0, 2, 2, 1, 1]; // LineStyle Solid, Dashed, Dotted

  const SANS = '"Greycliff CF", system-ui, -apple-system, "Segoe UI", sans-serif';
  const SERIF = '"Castoro", Georgia, "Times New Roman", serif';

  let current = 'paper';
  try {
    const saved = localStorage.getItem('hp-chart-theme');
    if (saved && THEMES[saved]) current = saved;
  } catch (_) { /* ignore */ }

  function get() { return THEMES[current]; }

  function set(id) {
    if (!THEMES[id]) return;
    current = id;
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('hp-chart-theme', id); } catch (_) { /* ignore */ }
  }

  /** Colour and line style for the n-th single-line indicator. */
  function seriesStyle(n) {
    const t = get();
    return { color: t.series[n % t.series.length], lineStyle: STYLE_STEPS[n % STYLE_STEPS.length] };
  }

  document.documentElement.dataset.theme = current;
  window.HPTheme = { THEMES, get, set, seriesStyle, SANS, SERIF, current: () => current };
})();
