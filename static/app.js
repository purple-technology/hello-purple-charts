// The page: toolbar, 1-4 charts (ChartView), indicators, replay, journal,
// alerts and export. Read-only towards MetaTrader 5: everything comes from
// our own local server.
(function () {
  'use strict';

  const DM = window.DrawMath;
  const $ = (id) => document.getElementById(id);

  // ---- remembered settings (this browser only) -----------------------------
  function storageGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
  }

  // Indicator types, their parameters (with limits) and default values.
  const IND_TYPES = {
    sma: { name: 'SMA', params: { period: [20, 1, 500] } },
    ema: { name: 'EMA', params: { period: [50, 1, 500] } },
    bb: { name: 'Bollinger', params: { period: [20, 2, 500], mult: [2, 0.5, 5, 0.5] } },
    rsi: { name: 'RSI', params: { period: [14, 2, 200] } },
    macd: { name: 'MACD', params: { fast: [12, 1, 200], slow: [26, 2, 300], signal: [9, 1, 100] } },
    spread: { name: 'Spread', params: {} },
  };
  // Colours of the previous (pre-Hello Purple) design. Indicators that still
  // carry one of these go back to automatic theme colours.
  const OLD_AUTO_COLORS = ['#b388ff', '#f06292', '#4dd0e1', '#aed581', '#ffb74d', '#90a4ae', '#ce93d8', '#80cbc4'];
  const LINE_TYPES = ['sma', 'ema', 'bb', 'rsi'];
  const DEFAULT_TFS = ['H4', 'H1', 'M15', 'M5'];

  function defaultParams(type) {
    const out = {};
    Object.entries(IND_TYPES[type].params).forEach(([k, spec]) => { out[k] = spec[0]; });
    return out;
  }
  /** color: null = automatic (the theme's next hue + line style). */
  function newIndicator(type) {
    return { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type,
      params: defaultParams(type), color: null };
  }
  function loadIndicators() {
    const saved = storageGet('hp-chart-indicators-v2');
    if (Array.isArray(saved)) {
      return saved.filter((d) => d && IND_TYPES[d.type])
        .map((d) => ({ ...d, params: { ...defaultParams(d.type), ...(d.params || {}) },
          color: d.color && !OLD_AUTO_COLORS.includes(String(d.color).toLowerCase()) ? d.color : null }));
    }
    // Move over the settings of the previous version (one of each).
    const old = storageGet('hp-chart-indicators');
    if (old && typeof old === 'object') {
      const list = [];
      ['sma', 'ema', 'bb', 'rsi', 'macd'].forEach((t) => {
        if (old[t] && old[t].on) {
          const d = newIndicator(t);
          Object.keys(d.params).forEach((k) => { if (typeof old[t][k] === 'number') d.params[k] = old[t][k]; });
          list.push(d);
        }
      });
      return list;
    }
    return [newIndicator('sma')];
  }

  // ---- the hub (shared state, used by every ChartView) ----------------------
  const hub = {
    views: [],
    active: null,
    indicators: loadIndicators(),
    positions: [],     // from /api/journal
    selectedKey: null, // highlighted trade
    showTradeLines: storageGet('hp-chart-show-trades') !== false,
    symbols: [],
    timeframes: [],
    replay: { on: false, cursor: null, playing: false, timer: null, picking: false },
    _syncing: false,

    status(text, isError) {
      $('status').textContent = text;
      $('status').classList.toggle('error', !!isError);
    },
    replayCursor() { return this.replay.on ? this.replay.cursor : null; },
    positionsFor(symbol) { return this.positions.filter((p) => p.symbol === symbol); },
    activeSymbol() { return this.active ? this.active.symbol : null; },

    activate(view) {
      if (this.active === view) return;
      if (this.active) this.active.tools.cancel();
      this.active = view;
      this.views.forEach((v) => v.setActive(v === view));
      syncToolbar();
      drawPlate();
      journal.render();
    },

    crosshairMoved(src, param) {
      if (this._syncing || this.views.length < 2) return;
      this._syncing = true;
      try {
        const price = param.point ? src.candles.coordinateToPrice(param.point.y) : null;
        for (const v of this.views) {
          if (v === src || !v.data) continue;
          if (param.time === undefined) v.clearCrosshair();
          else v.showCrosshairAt(param.time, price, v.symbol === src.symbol);
        }
      } finally {
        this._syncing = false;
      }
    },

    drawingsSaved(symbol, src) {
      this.views.forEach((v) => {
        if (v !== src && v.symbol === symbol && v.data) {
          v.tools.setContext(symbol, v.visibleTimes(), v.data.barSeconds, true);
        }
      });
    },

    async focusPosition(p) {
      this.selectedKey = p.key;
      const v = this.active;
      if (v.symbol !== p.symbol) await changeSymbol(p.symbol);
      v.focusPeriod(p.entryTime, p.exitTime || p.entryTime);
      this.views.forEach((x) => x.redrawTrades());
      journal.render();
    },

    async setManualStop(key, stop) {
      try {
        const res = await fetch('/api/journal/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, stop }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        await loadJournal();
      } catch (err) {
        this.status(`Stop not saved: ${err.message}`, true);
      }
    },

    toggleJournal(open) {
      const show = open === undefined ? $('journal').hidden : open;
      $('journal').hidden = !show;
      $('journal-btn').setAttribute('aria-pressed', String(show));
      if (show) journal.render();
    },
  };
  window.__hub = hub; // handy for checking things in the browser console

  const journal = new window.JournalPanel($('journal'), hub);

  // ---- layout & views ---------------------------------------------------------
  const layoutSaved = storageGet('hp-chart-layout') || {};
  let layout = ['1', '2', '2v', '4'].includes(layoutSaved.layout) ? layoutSaved.layout : '1';
  $('layout').value = layout;
  $('link-symbols').checked = layoutSaved.link !== false;

  function saveLayout() {
    storageSet('hp-chart-layout', {
      layout, link: $('link-symbols').checked,
      views: hub.views.map((v) => ({ symbol: v.symbol, tf: v.tf })),
    });
  }

  function viewCount(l) { return { 1: 1, 2: 2, '2v': 2, 4: 4 }[l]; }

  async function applyLayout(newLayout, wanted) {
    layout = newLayout;
    const container = $('views');
    container.className = `views layout-${layout}`;
    const n = viewCount(layout);
    while (hub.views.length > n) hub.views.pop().destroy();
    const loads = [];
    while (hub.views.length < n) {
      const i = hub.views.length;
      const box = document.createElement('div');
      container.appendChild(box);
      const v = new window.ChartView(hub, box);
      v.tools.onToolChange(onToolChange);
      hub.views.push(v);
      const w = (wanted && wanted[i]) || {};
      const symbol = w.symbol || (hub.active && hub.active.symbol) || firstSymbol();
      const tf = w.tf || (i === 0 && hub.active ? hub.active.tf : DEFAULT_TFS[i]) || 'H1';
      loads.push(loadView(v, symbol, hub.timeframes.includes(tf) ? tf : 'H1'));
    }
    if (!hub.views.includes(hub.active)) { hub.active = null; hub.activate(hub.views[0]); }
    await Promise.all(loads);
    saveLayout();
  }

  function firstSymbol() {
    const t = hub.symbols.find((s) => s.traded);
    return t ? t.name : (hub.symbols[0] && hub.symbols[0].name);
  }

  async function loadView(v, symbol, tf, opts) {
    try {
      const d = await v.load(symbol, tf, opts);
      if (d) hub.status(`${d.symbol} ${d.timeframe}: ${d.candles.length} candles · ${d.trades.length} trade markers · loaded ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      hub.status(`${symbol} ${tf}: ${err.message}`, true);
    }
    if (v === hub.active) { syncToolbar(); drawPlate(); }
    saveLayout();
  }

  async function changeSymbol(symbol) {
    const targets = $('link-symbols').checked ? hub.views : [hub.active];
    await Promise.all(targets.map((v) => loadView(v, symbol, v.tf || 'H1')));
    journal.render();
  }

  function syncToolbar() {
    const v = hub.active;
    if (!v) return;
    if (v.symbol) $('symbol').value = v.symbol;
    [...$('timeframes').children].forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === v.tf)));
    onToolChange(v.tools.tool);
  }

  // ---- toolbar: symbol, timeframes, layout, reload ------------------------------
  function renderSymbols(symbols) {
    const sel = $('symbol');
    sel.innerHTML = '';
    const addGroup = (label, list) => {
      if (!list.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      list.forEach((s) => { const o = document.createElement('option'); o.value = s.name; o.textContent = s.name; g.appendChild(o); });
      sel.appendChild(g);
    };
    addGroup('★ Traded by you', symbols.filter((s) => s.traded));
    [...new Set(symbols.map((s) => s.group))].forEach((grp) => addGroup(grp, symbols.filter((s) => s.group === grp)));
    const list = $('symbol-list') || document.body.appendChild(Object.assign(document.createElement('datalist'), { id: 'symbol-list' }));
    list.innerHTML = '';
    symbols.forEach((s) => { const o = document.createElement('option'); o.value = s.name; list.appendChild(o); });
  }

  function renderTimeframes(list) {
    const box = $('timeframes');
    box.innerHTML = '';
    list.forEach((tf) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = tf;
      if (tf.startsWith('S')) b.title = 'Seconds, built from ticks: last 4 hours only';
      b.addEventListener('click', () => loadView(hub.active, hub.active.symbol, tf));
      box.appendChild(b);
    });
  }

  $('symbol').addEventListener('change', () => changeSymbol($('symbol').value));
  $('layout').addEventListener('change', () => applyLayout($('layout').value));
  $('link-symbols').addEventListener('change', saveLayout);
  $('reload').addEventListener('click', async () => {
    $('reload').disabled = true;
    await Promise.all(hub.views.map((v) => v.symbol && loadView(v, v.symbol, v.tf, { keepView: true })));
    await loadJournal();
    $('reload').disabled = false;
  });

  // ---- menus (indicators, alerts, export) -------------------------------------------
  const menus = [['indicators-btn', 'indicators-panel'], ['alerts-btn', 'alerts-panel'], ['export-btn', 'export-panel']];
  menus.forEach(([btn, panel]) => {
    $(btn).addEventListener('click', () => {
      const open = $(panel).hidden;
      menus.forEach(([b, p]) => { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); });
      $(panel).hidden = !open;
      $(btn).setAttribute('aria-expanded', String(open));
      if (open && panel === 'indicators-panel') renderIndicatorPanel();
      if (open && panel === 'alerts-panel') renderAlertsPanel();
    });
  });
  document.addEventListener('click', (e) => {
    menus.forEach(([b, p]) => {
      if (!$(p).hidden && !$(p).contains(e.target) && !$(b).contains(e.target)) {
        $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false');
      }
    });
  });

  // ---- indicators panel: any number of indicators ----------------------------------
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => { if (c !== null && c !== undefined) n.append(c); });
    return n;
  }

  function indicatorsChanged() {
    storageSet('hp-chart-indicators-v2', hub.indicators);
    hub.views.forEach((v) => v.render());
  }

  function renderIndicatorPanel() {
    const p = $('indicators-panel');
    p.innerHTML = '';
    if (!hub.indicators.length) p.append(el('p', { class: 'note' }, 'No indicators. Add as many as you like below.'));
    let lineIndex = 0;
    hub.indicators.forEach((d, idx) => {
      const spec = IND_TYPES[d.type];
      const auto = LINE_TYPES.includes(d.type) ? window.HPTheme.seriesStyle(lineIndex++) : null;
      const inputs = Object.entries(spec.params).map(([k, [, min, max, step]]) =>
        el('label', {}, `${k} `, el('input', { type: 'number', min, max, step: step || 1, value: d.params[k],
          'aria-label': `${spec.name} ${k}`,
          onchange: (e) => {
            let v = Number(e.target.value);
            if (!Number.isFinite(v)) v = defaultParams(d.type)[k];
            v = Math.min(max, Math.max(min, v));
            if (!step) v = Math.round(v);
            e.target.value = v;
            d.params[k] = v;
            indicatorsChanged();
          } })));
      p.append(el('div', { class: 'row' },
        el('span', { class: 'name' }, spec.name),
        inputs,
        auto ? el('input', { type: 'color', value: d.color || auto.color,
          'aria-label': `${spec.name} colour`, title: d.color ? 'Your colour' : 'Automatic theme colour',
          onchange: (e) => { d.color = e.target.value; indicatorsChanged(); renderIndicatorPanel(); } }) : null,
        auto && d.color ? el('button', { type: 'button', class: 'reset', title: 'Back to the automatic theme colour',
          onclick: () => { d.color = null; indicatorsChanged(); renderIndicatorPanel(); } }, '↺') : null,
        el('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${spec.name}`,
          onclick: () => { hub.indicators.splice(idx, 1); indicatorsChanged(); renderIndicatorPanel(); } }, '✕')));
    });
    const typeSel = el('select', { 'aria-label': 'Indicator to add' },
      Object.entries(IND_TYPES).map(([k, s]) => el('option', { value: k }, s.name)));
    p.append(el('div', { class: 'row' }, typeSel,
      el('button', { type: 'button', onclick: () => {
        hub.indicators.push(newIndicator(typeSel.value));
        indicatorsChanged();
        renderIndicatorPanel();
      } }, '+ Add')),
    el('p', { class: 'note' }, 'All indicators are calculated in this page, by hand-written code. Colours follow the theme: two brand hues, then a dashed and a dotted line. Spread = the broker\'s spread per candle, in points.'));
  }

  // ---- drawing tools (act on the selected chart) --------------------------------------
  const toolButtons = document.querySelectorAll('[data-tool]');
  toolButtons.forEach((b) => b.addEventListener('click', () => hub.active.tools.setTool(b.dataset.tool)));
  function onToolChange(tool) {
    if (!hub.active || hub.active.tools.tool !== tool) return;
    toolButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    document.body.classList.toggle('drawing', tool !== 'none');
    const help = {
      trend: 'Trend line: click the start, then the end.',
      hline: 'Horizontal line: click a price.',
      rect: 'Box: click one corner, then the opposite corner.',
      erase: 'Eraser: click a drawing to delete it. Esc to stop.',
    };
    if (help[tool]) hub.status(help[tool]);
  }
  $('draw-color').addEventListener('input', () => hub.views.forEach((v) => { v.tools.color = $('draw-color').value; }));
  let clearTimer = null;
  $('clear-drawings').addEventListener('click', () => {
    const tools = hub.active.tools;
    if (!tools.count()) return hub.status('No drawings on this symbol.');
    if (!clearTimer) {
      $('clear-drawings').textContent = `Delete ${tools.count()}?`;
      $('clear-drawings').classList.add('confirm');
      clearTimer = setTimeout(resetClear, 3000);
      return;
    }
    resetClear();
    tools.clearAll();
    hub.status('All drawings on this symbol deleted.');
  });
  function resetClear() {
    clearTimeout(clearTimer);
    clearTimer = null;
    $('clear-drawings').textContent = 'Clear';
    $('clear-drawings').classList.remove('confirm');
  }

  // ---- trades & journal ---------------------------------------------------------------
  $('show-trades').checked = hub.showTradeLines;
  $('show-trades').addEventListener('change', () => {
    hub.showTradeLines = $('show-trades').checked;
    storageSet('hp-chart-show-trades', hub.showTradeLines);
    hub.views.forEach((v) => v.redrawTrades());
  });
  $('journal-btn').addEventListener('click', () => hub.toggleJournal());

  async function loadJournal() {
    try {
      const res = await fetch('/api/journal', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      hub.positions = body.positions;
      journal.setPositions(body.positions);
      hub.views.forEach((v) => v.redrawTrades());
    } catch (err) {
      journal.setError(`Journal not loaded: ${err.message}`);
    }
  }

  // ---- replay ------------------------------------------------------------------------
  const R = hub.replay;
  const fmtCursor = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

  /** The chart with the shortest candles drives the replay. */
  function driver() {
    return hub.views.filter((v) => v.data).sort((a, b) => a.data.barSeconds - b.data.barSeconds)[0];
  }
  function replayUpdate() {
    hub.views.forEach((v) => v.replayMoved());
    drawPlate();
    $('replay-time').textContent = R.cursor !== null ? `${fmtCursor(R.cursor)} (server time)` : '';
  }
  function replayStart() {
    R.picking = true;
    $('replay-btn').setAttribute('aria-pressed', 'true');
    hub.status('Replay: click on the selected chart where the replay should start.');
    const v = hub.active;
    const once = (param) => {
      v.chart.unsubscribeClick(once);
      if (!R.picking) return;
      R.picking = false;
      if (param.time === undefined) { replayStop(); return; }
      R.on = true;
      R.cursor = param.time; // the clicked candle and everything after it is hidden
      $('replaybar').hidden = false;
      hub.views.forEach((x) => x.render());
      replayUpdate();
      hub.status('Replay started. Space = play/pause, → = one candle, ← = back.');
    };
    v.chart.subscribeClick(once);
  }
  function replayStep() {
    const d = driver();
    if (!d) return;
    const times = d.data.candles.map((c) => c.time);
    const n = DM.completedBarCount(times, d.data.barSeconds, R.cursor);
    if (n >= times.length) { replayPause(); hub.status('Replay reached the latest candle.'); return; }
    R.cursor = times[n] + d.data.barSeconds;
    replayUpdate();
  }
  function replayBack() {
    const d = driver();
    if (!d) return;
    const times = d.data.candles.map((c) => c.time);
    const n = DM.completedBarCount(times, d.data.barSeconds, R.cursor);
    if (n >= 2) R.cursor = times[n - 2] + d.data.barSeconds;
    replayUpdate();
  }
  function replayNextTrade() {
    const d = driver();
    const symbol = hub.activeSymbol();
    const next = hub.positionsFor(symbol).map((p) => p.entryTime).filter((t) => t >= R.cursor).sort((a, b) => a - b)[0];
    if (next === undefined || !d) { hub.status('No later trades on this symbol.'); return; }
    const times = d.data.candles.map((c) => c.time);
    const i = DM.floorIndex(times, next);
    R.cursor = (i >= 0 ? times[i] : next) + d.data.barSeconds; // the candle with the entry has just closed
    replayPause();
    replayUpdate();
  }
  function replayPlay() {
    if (R.timer) return replayPause();
    R.playing = true;
    $('rp-play').textContent = '⏸ Pause';
    R.timer = setInterval(replayStep, 1000 / Number($('rp-speed').value));
  }
  function replayPause() {
    clearInterval(R.timer);
    R.timer = null;
    R.playing = false;
    $('rp-play').textContent = '⏵ Play';
  }
  function replayStop() {
    replayPause();
    const wasOn = R.on;
    R.on = false;
    R.picking = false;
    R.cursor = null;
    $('replaybar').hidden = true;
    $('replay-time').textContent = '';
    $('replay-btn').setAttribute('aria-pressed', 'false');
    if (wasOn) hub.views.forEach((v) => v.exitReplay());
    hub.status('Replay ended.');
  }
  $('replay-btn').addEventListener('click', () => (R.on || R.picking ? replayStop() : replayStart()));
  $('rp-play').addEventListener('click', replayPlay);
  $('rp-step').addEventListener('click', () => { replayPause(); replayStep(); });
  $('rp-back').addEventListener('click', () => { replayPause(); replayBack(); });
  $('rp-next').addEventListener('click', replayNextTrade);
  $('rp-stop').addEventListener('click', replayStop);
  $('rp-speed').addEventListener('change', () => { if (R.timer) { replayPause(); replayPlay(); } });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') { if (hub.active) hub.active.tools.cancel(); if (R.picking) replayStop(); }
    if (!R.on) return;
    if (e.key === ' ') { e.preventDefault(); replayPlay(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); replayPause(); replayStep(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); replayPause(); replayBack(); }
  });

  // ---- alerts ---------------------------------------------------------------------------
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    } catch (_) { /* no sound available */ }
  }
  function toast(title, text) {
    const t = el('div', { class: 'toast', role: 'alert' }, el('strong', {}, title), text);
    $('toasts').append(t);
    setTimeout(() => t.remove(), 12000);
  }
  const alerts = new window.Alerts.AlertManager({
    onChange: () => {
      const n = alerts.alerts.filter((a) => a.active).length;
      $('alerts-count').textContent = n ? String(n) : '';
      if (!$('alerts-panel').hidden) renderAlertsPanel();
    },
    onFire: (entry) => {
      const text = `${entry.text} (now ${Number(entry.value.toFixed(5))})`;
      toast('Alert', text);
      beep();
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('HP Chart alert', { body: text }); } catch (_) { /* ignore */ }
      }
    },
    onError: (msg) => hub.status(msg, true),
  });
  hub.alerts = alerts;

  function renderAlertsPanel() {
    const p = $('alerts-panel');
    const kept = p.querySelector('form') ? Object.fromEntries(new FormData(p.querySelector('form'))) : null;
    p.innerHTML = '';
    const K = window.Alerts.KINDS;
    p.append(el('h4', {}, 'Your alerts'));
    if (!alerts.alerts.length) p.append(el('p', { class: 'note' }, 'No alerts yet.'));
    alerts.alerts.forEach((a) => p.append(el('div', { class: 'row' },
      el('label', {}, el('input', { type: 'checkbox', checked: a.active, 'aria-label': 'Active',
        onchange: () => alerts.toggle(a.id).catch((e) => hub.status(e.message, true)) })),
      el('span', {}, window.Alerts.describe(a)),
      a.repeat ? el('span', { class: 'note' }, '(repeats)') : null,
      el('button', { type: 'button', 'aria-label': 'Delete alert', onclick: () => alerts.remove(a.id).catch((e) => hub.status(e.message, true)) }, '✕'))));

    const v = hub.active;
    const lastClose = v && v.data && v.data.candles.length ? v.data.candles[v.data.candles.length - 1].close : '';
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const alert = { symbol: f.symbol, kind: f.kind, value: Number(f.value), repeat: f.repeat === 'on' };
      if (K[f.kind].rsi) { alert.tf = f.tf; alert.period = Number(f.period); }
      alerts.add(alert).then(() => hub.status(`Alert added: ${window.Alerts.describe(alert)}`))
        .catch((err) => hub.status(`Alert not saved: ${err.message}`, true));
    } },
    el('h4', {}, 'New alert'),
    el('div', { class: 'row' },
      el('input', { type: 'text', name: 'symbol', list: 'symbol-list', value: (kept && kept.symbol) || (v && v.symbol) || '', 'aria-label': 'Symbol', required: true, size: 12 }),
      el('select', { name: 'kind', 'aria-label': 'Condition' },
        Object.entries(K).map(([k, s]) => el('option', { value: k, selected: kept ? kept.kind === k : k === 'price_above' }, s.label))),
      el('input', { type: 'number', step: 'any', name: 'value', required: true, 'aria-label': 'Level',
        value: kept ? kept.value : lastClose })),
    el('div', { class: 'row' },
      el('span', { class: 'note' }, 'RSI only:'),
      el('select', { name: 'tf', 'aria-label': 'RSI timeframe' },
        ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((tf) => el('option', { value: tf, selected: (kept ? kept.tf : 'H1') === tf }, tf))),
      el('label', {}, 'period ', el('input', { type: 'number', name: 'period', min: 2, max: 200, value: kept ? kept.period : 14 })),
      el('label', {}, el('input', { type: 'checkbox', name: 'repeat', checked: kept ? kept.repeat === 'on' : false }), ' repeat')),
    el('div', { class: 'row' }, el('button', { type: 'submit' }, '+ Add alert')));
    p.append(form);

    if ('Notification' in window && Notification.permission !== 'granted') {
      p.append(el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => {
        Notification.requestPermission().then(() => renderAlertsPanel());
      } }, 'Allow Windows notifications'),
      el('span', { class: 'note' }, Notification.permission === 'denied' ? 'Blocked in this browser\'s settings.' : '')));
    }
    if (alerts.log.length) {
      p.append(el('h4', {}, 'Fired'), el('ul', { class: 'log' },
        alerts.log.map((l) => el('li', {}, `${l.when.toLocaleTimeString()} · ${l.text}`))));
    }
    p.append(el('p', { class: 'note' }, 'Alerts are checked every 15 seconds while this page is open (it may be in a background tab). They fire when price or RSI crosses the level. Saved in data/alerts.json.'));
  }

  // ---- export --------------------------------------------------------------------------
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('export-chart').addEventListener('click', () => {
    const v = hub.active;
    const text = v && v.csv();
    if (!text) return hub.status('Nothing to export yet.', true);
    download(`${v.symbol}_${v.tf}.csv`.replace(/[^A-Za-z0-9._-]/g, '_'), text);
    $('export-panel').hidden = true;
  });
  $('export-journal').addEventListener('click', () => {
    const iso = window.CSV.isoTime;
    const rows = hub.positions.filter((p) => !p.open).map((p) => ({
      ...p, entryTime: iso(p.entryTime), exitTime: iso(p.exitTime),
      entrySpread: p.entryFill ? p.entryFill.spreadPoints : null,
      entrySlip: p.entryFill ? p.entryFill.slippagePoints : null,
      exitSpread: p.exitFill ? p.exitFill.spreadPoints : null,
      exitSlip: p.exitFill ? p.exitFill.slippagePoints : null,
    }));
    const cols = [['symbol', 'symbol'], ['side', 'side'], ['volume', 'volume'], ['entryTime', 'entry time (server)'],
      ['entryPrice', 'entry price'], ['exitTime', 'exit time (server)'], ['exitPrice', 'exit price'],
      ['exitReason', 'exit reason'], ['stop', 'stop'], ['stopSource', 'stop source'], ['target', 'target'],
      ['duration', 'held (seconds)'], ['movePct', 'move %'], ['r', 'R'], ['maeR', 'MAE (R)'], ['mfeR', 'MFE (R)'],
      ['entrySpread', 'entry spread (points)'], ['entrySlip', 'entry slippage (points)'],
      ['exitSpread', 'exit spread (points)'], ['exitSlip', 'exit slippage (points)']]
      .map(([key, label]) => ({ key, label }));
    if (!rows.length) return hub.status('The journal is not loaded yet.', true);
    download('journal.csv', window.CSV.toCSV(cols, rows));
    $('export-panel').hidden = true;
  });

  // ---- theme: Paper / Midnight --------------------------------------------------------
  const themeButtons = document.querySelectorAll('[data-theme-choice]');
  function syncThemeButtons() {
    themeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === window.HPTheme.current())));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = window.HPTheme.current() === 'midnight' ? '#2A1B4E' : '#FDF8E8';
  }
  themeButtons.forEach((b) => b.addEventListener('click', () => {
    window.HPTheme.set(b.dataset.themeChoice);
    syncThemeButtons();
    hub.views.forEach((v) => v.applyTheme());
    drawPlate();
    journal.render();
  }));
  syncThemeButtons();

  // ---- the plate: the selected chart as a Hello Purple dot-matrix band ------------------
  // Same grammar as the hero plates on hello-purple.com: a grid of faint violet
  // dots, the area under the line in stronger violet, the line itself in the
  // "hot" orange, and the latest point as a larger violet anchor.
  const PLATE_COLS = 31;
  const PLATE_ROWS = 5;
  function drawPlate() {
    const canvas = $('plate');
    if (!canvas || !canvas.getClientRects().length) return;
    const v = hub.active;
    const t = window.HPTheme.get();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const stepX = w / PLATE_COLS;
    const stepY = h / PLATE_ROWS;
    const dot = (c, r, radius, rgb, alpha) => {
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.beginPath();
      ctx.arc(c * stepX + stepX / 2, r * stepY + stepY / 2, radius, 0, Math.PI * 2);
      ctx.fill();
    };
    const closes = v && v.data ? v.data.candles.slice(Math.max(0, v.shown - PLATE_COLS), v.shown).map((c) => c.close) : [];
    const rowOf = [];
    if (closes.length > 1) {
      const lo = Math.min(...closes);
      const hi = Math.max(...closes);
      const offset = PLATE_COLS - closes.length;
      closes.forEach((c, i) => {
        rowOf[offset + i] = hi === lo ? 2 : Math.round((1 - (c - lo) / (hi - lo)) * (PLATE_ROWS - 1));
      });
      canvas.setAttribute('aria-label', `Dot-matrix plate: the last ${closes.length} closes of ${v.symbol} ${v.tf}, ` +
        `${closes[closes.length - 1] >= closes[0] ? 'rising' : 'falling'} from ${closes[0]} to ${closes[closes.length - 1]}.`);
    }
    for (let c = 0; c < PLATE_COLS; c++) {
      for (let r = 0; r < PLATE_ROWS; r++) {
        const line = rowOf[c];
        if (line === undefined) dot(c, r, 1.1, t.plateGrid, 0.16);              // ambient
        else if (r === line && c === PLATE_COLS - 1) dot(c, r, 3.4, t.plateGrid, 0.95); // anchor
        else if (r === line) dot(c, r, 2.4, t.plateHot, 0.9);                   // the series
        else if (r > line) dot(c, r, 1.7, t.plateGrid, 0.32);                   // fill below
        else dot(c, r, 1.1, t.plateGrid, 0.16);                                 // ambient
      }
    }
  }
  window.addEventListener('resize', drawPlate);

  // ---- start ------------------------------------------------------------------------------
  async function init() {
    hub.status('Connecting to MetaTrader 5…');
    try {
      const res = await fetch('/api/symbols', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      hub.symbols = body.symbols;
      hub.timeframes = body.timeframes;
      renderSymbols(body.symbols);
      renderTimeframes(body.timeframes);
      const params = new URLSearchParams(location.search);
      const wanted = (layoutSaved.views || []).map((w) => ({ ...w }));
      if (params.get('symbol') || params.get('tf')) {
        wanted[0] = { symbol: params.get('symbol') || (wanted[0] || {}).symbol, tf: params.get('tf') || (wanted[0] || {}).tf };
      }
      const names = new Set(body.symbols.map((s) => s.name));
      wanted.forEach((w) => { if (!names.has(w.symbol)) w.symbol = undefined; });
      if (params.get('layout') && ['1', '2', '2v', '4'].includes(params.get('layout'))) {
        layout = params.get('layout');
        $('layout').value = layout;
      }
      await applyLayout(layout, wanted);
      loadJournal();
      alerts.load().catch((err) => hub.status(`Alerts not loaded: ${err.message}`, true));
    } catch (err) {
      hub.status(err.message || 'Could not connect', true);
    }
  }

  init();
})();
