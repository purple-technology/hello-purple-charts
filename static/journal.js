// The journal side panel: your trades, statistics and execution quality.
// Only R-multiples, percent, points, counts and times: never money.
(function () {
  'use strict';

  const S = window.Stats;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---- formatting ---------------------------------------------------------
  const fmtR = (x) => (x === null || x === undefined ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const fmtPct = (x, d = 0) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`);
  const fmtNum = (x, d = 2) => (x === null || x === undefined ? '–' : x.toFixed(d));
  const fmtMove = (x) => (x === null || x === undefined ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  function fmtDur(sec) {
    if (sec === null || sec === undefined) return '–';
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  const fmtTime = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }
  const signClass = (x) => (x === null || x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

  class JournalPanel {
    constructor(root, hub) {
      this.root = root;
      this.hub = hub;
      this.positions = null;
      this.tab = 'trades';
      this.scope = 'symbol';
      this.editingKey = null;
      this.error = null;
    }

    setPositions(list) { this.positions = list; this.render(); }
    setError(msg) { this.error = msg; this.render(); }

    scoped() {
      const all = (this.positions || []).filter((p) => !p.open);
      return this.scope === 'all' ? all : all.filter((p) => p.symbol === this.hub.activeSymbol());
    }

    render() {
      const r = this.root;
      r.innerHTML = '';
      const tabs = el('div', { class: 'tabs', role: 'tablist' },
        ['trades', 'stats', 'execution'].map((t) => el('button', {
          type: 'button', role: 'tab', 'aria-selected': String(this.tab === t),
          onclick: () => { this.tab = t; this.render(); },
        }, { trades: 'Trades', stats: 'Statistics', execution: 'Execution' }[t])));
      const scope = el('div', { class: 'scope' },
        el('label', {}, el('input', { type: 'radio', name: 'jscope', value: 'symbol',
          ...(this.scope === 'symbol' ? { checked: '' } : {}),
          onchange: () => { this.scope = 'symbol'; this.render(); } }), ` ${this.hub.activeSymbol() || 'This symbol'}`),
        el('label', {}, el('input', { type: 'radio', name: 'jscope', value: 'all',
          ...(this.scope === 'all' ? { checked: '' } : {}),
          onchange: () => { this.scope = 'all'; this.render(); } }), ' All symbols'),
        el('button', { type: 'button', class: 'close', title: 'Close journal', onclick: () => this.hub.toggleJournal(false) }, '✕'));
      r.append(el('div', { class: 'jhead' }, el('span', { class: 'jtitle' }, 'Journal'), tabs, scope));

      if (this.error) { r.append(el('p', { class: 'note error' }, this.error)); return; }
      if (!this.positions) {
        r.append(el('p', { class: 'note' }, 'Reading your trade history… The first time this can take a minute or two while MT5 downloads the price history around each trade.'));
        return;
      }
      const ps = this.scoped();
      if (!ps.length) { r.append(el('p', { class: 'note' }, 'No closed trades for this selection.')); return; }
      if (this.tab === 'trades') this.renderTrades(r, ps);
      else if (this.tab === 'stats') this.renderStats(r, ps);
      else this.renderExecution(r, ps);
    }

    // ---- Trades tab ---------------------------------------------------------
    renderTrades(r, ps) {
      const rows = [...ps].sort((a, b) => b.entryTime - a.entryTime).map((p) => {
        const sel = p.key === this.hub.selectedKey;
        const rCell = el('td', { class: `num ${signClass(p.r)}` });
        if (this.editingKey === p.key) {
          const input = el('input', { type: 'number', step: 'any', value: p.stop || '', 'aria-label': 'Stop price', class: 'stopin' });
          rCell.append(input,
            el('button', { type: 'button', onclick: async (e) => {
              e.stopPropagation();
              await this.hub.setManualStop(p.key, input.value === '' ? null : Number(input.value));
              this.editingKey = null;
            } }, 'Save'),
            el('button', { type: 'button', onclick: (e) => { e.stopPropagation(); this.editingKey = null; this.render(); } }, '✕'));
          setTimeout(() => input.focus(), 0);
        } else if (p.r === null) {
          rCell.append(el('button', { type: 'button', class: 'link', title: 'No stop-loss known: enter the stop you used to get R',
            onclick: (e) => { e.stopPropagation(); this.editingKey = p.key; this.render(); } }, 'set stop'));
        } else {
          rCell.append(fmtR(p.r));
          if (p.stopSource === 'manual') {
            rCell.append(el('button', { type: 'button', class: 'link small', title: 'Stop entered by you: click to change',
              onclick: (e) => { e.stopPropagation(); this.editingKey = p.key; this.render(); } }, ' ✎'));
          }
        }
        const ef = p.entryFill || {};
        const xf = p.exitFill || {};
        return el('tr', { class: sel ? 'selected' : '', tabindex: '0', title: 'Show this trade on the chart',
          onclick: () => this.hub.focusPosition(p),
          onkeydown: (e) => { if (e.key === 'Enter') this.hub.focusPosition(p); } },
        el('td', {}, fmtTime(p.entryTime)),
        this.scope === 'all' ? el('td', {}, p.symbol) : null,
        el('td', { class: p.side === 'buy' ? 'buy' : 'sell' }, p.side === 'buy' ? '▲ buy' : '▼ sell'),
        el('td', { class: 'num' }, p.volume),
        el('td', {}, p.exitReason || '–'),
        el('td', { class: 'num' }, fmtDur(p.duration)),
        el('td', { class: `num ${signClass(p.movePct)}` }, fmtMove(p.movePct)),
        rCell,
        el('td', { class: 'num' }, p.maeR === null ? '–' : fmtNum(p.maeR)),
        el('td', { class: 'num' }, p.mfeR === null ? '–' : fmtNum(p.mfeR)),
        el('td', { class: 'num' }, ef.spreadPoints ?? '–'),
        el('td', { class: `num ${signClass(xf.slippagePoints === null || xf.slippagePoints === undefined ? null : -xf.slippagePoints)}` }, xf.slippagePoints ?? '–'));
      });
      const head = el('tr', {}, el('th', {}, 'Opened'), this.scope === 'all' ? el('th', {}, 'Symbol') : null,
        el('th', {}, 'Side'), el('th', { class: 'num' }, 'Vol'), el('th', {}, 'Exit'),
        el('th', { class: 'num' }, 'Held'), el('th', { class: 'num' }, 'Move'), el('th', { class: 'num' }, 'R'),
        el('th', { class: 'num', title: 'Maximum adverse excursion: worst point during the trade, in R' }, 'MAE'),
        el('th', { class: 'num', title: 'Maximum favourable excursion: best point during the trade, in R' }, 'MFE'),
        el('th', { class: 'num', title: 'Spread at entry, in points' }, 'Spr'),
        el('th', { class: 'num', title: 'Exit slippage vs the order price, in points (positive = worse)' }, 'Slip'));
      r.append(el('div', { class: 'tablewrap' }, el('table', { class: 'jt' }, el('thead', {}, head), el('tbody', {}, rows))),
        el('p', { class: 'note' }, 'Click a trade to show it on the chart. MAE/MFE: worst/best point during the trade in R. Times: broker server time.'));
    }

    // ---- Statistics tab -----------------------------------------------------
    renderStats(r, ps) {
      const s = S.summary(ps);
      const tile = (label, value, hint) => el('div', { class: 'tile', title: hint || '' },
        el('div', { class: 'tv' }, value), el('div', { class: 'tl' }, label));
      r.append(el('div', { class: 'tiles' },
        tile('Trades', String(s.trades)),
        tile('Win rate', fmtPct(s.winRate), 'Share of trades where price moved in your favour'),
        tile('Avg R / trade', fmtR(s.avgR), `Expectancy, over the ${s.tradesWithR} trades with a known stop`),
        tile('Profit factor (R)', fmtNum(s.profitFactorR), 'Sum of winning R / sum of losing R'),
        tile('Avg win / loss', `${fmtR(s.avgWinR)} / ${fmtR(s.avgLossR)}`),
        tile('Best / worst', `${fmtR(s.bestR)} / ${fmtR(s.worstR)}`),
        tile('Avg MAE / MFE', `${fmtNum(s.avgMaeR)}R / ${fmtNum(s.avgMfeR)}R`, 'Average worst / best point during a trade'),
        tile('Move captured', fmtPct(s.captured), 'Winners: share of the best price reached that you kept'),
        tile('Held win / loss', `${fmtDur(s.avgHoldWin)} / ${fmtDur(s.avgHoldLoss)}`)));

      const b = S.behaviour(ps, 3600);
      const sentences = [];
      if (s.reached1R) sentences.push(`${s.gaveBack} of the ${s.reached1R} trades that were at least 1R in profit at some point still closed at a loss.`);
      if (b.quickAfterLoss.count) {
        const n = b.quickAfterLoss.count;
        sentences.push(`${n} ${n === 1 ? 'trade was' : 'trades were'} opened within an hour after a loss: win rate ${fmtPct(b.quickAfterLoss.winRate)}, average ${fmtR(b.quickAfterLoss.avgR)} — versus ${fmtPct(b.otherTrades.winRate)} and ${fmtR(b.otherTrades.avgR)} for the other trades.`);
      }
      if (b.relVolumeAfterLoss !== null && b.relVolumeAfterWin !== null) {
        sentences.push(`After a loss your next trade was on average ${fmtNum(b.relVolumeAfterLoss)}× your usual size for that symbol; after a win ${fmtNum(b.relVolumeAfterWin)}×.`);
      }
      sentences.push(`Longest losing streak: ${b.longestLossStreak}. Longest winning streak: ${b.longestWinStreak}.`);
      r.append(el('h3', {}, 'Behaviour'), el('ul', { class: 'facts' }, sentences.map((t) => el('li', {}, t))));

      r.append(this.barChart('Average R by hour of entry (server time)', S.byHour(ps), (k) => String(k).padStart(2, '0')));
      r.append(this.barChart('Average R by weekday of entry', S.byWeekday(ps), (k) => WEEKDAYS[k]));
      r.append(this.groupTable('By symbol', S.bySymbol(ps)));
      r.append(this.groupTable('By direction', S.bySide(ps)));
      r.append(this.groupTable('By exit', S.byExit(ps)));
      r.append(el('p', { class: 'note' }, 'R uses the stop-loss of the order that opened each trade (or the stop you entered). "Move" is price movement, before costs.'));
    }

    /** Diverging bars around zero: avg R per group, with a tooltip per bar. */
    barChart(title, groups, labelOf) {
      const vals = groups.map((g) => g.avgR).filter((v) => v !== null);
      const max = Math.max(0.5, ...vals.map(Math.abs));
      const bars = groups.map((g) => {
        const v = g.avgR;
        const h = v === null ? 0 : (Math.abs(v) / max) * 50; // % of the half height
        const tip = `${labelOf(g.key)}: ${g.count} trade${g.count === 1 ? '' : 's'}` +
          (g.count ? `, win rate ${fmtPct(g.winRate)}, avg ${fmtR(v)}` : '');
        return el('div', { class: 'col', title: tip, 'aria-label': tip, tabindex: '0' },
          v === null ? null : el('div', { class: `bar ${v >= 0 ? 'up' : 'down'}`,
            style: v >= 0 ? `bottom:50%;height:${h}%` : `top:50%;height:${h}%` }),
          el('div', { class: 'cl' }, labelOf(g.key)));
      });
      return el('figure', { class: 'bars' },
        el('figcaption', {}, title),
        el('div', { class: 'plot' }, el('div', { class: 'zero' }), el('span', { class: 'ymax' }, `+${max.toFixed(1)}R`),
          el('span', { class: 'ymin' }, `−${max.toFixed(1)}R`), bars));
    }

    groupTable(title, groups) {
      const rows = groups.filter((g) => g.count).map((g) => el('tr', {},
        el('td', {}, String(g.key)), el('td', { class: 'num' }, g.count),
        el('td', { class: 'num' }, fmtPct(g.winRate)),
        el('td', { class: `num ${signClass(g.avgR)}` }, fmtR(g.avgR)),
        el('td', { class: `num ${signClass(g.totalR)}` }, fmtR(g.totalR))));
      return el('div', {}, el('h3', {}, title), el('table', { class: 'jt compact' },
        el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'num' }, 'Trades'),
          el('th', { class: 'num' }, 'Win'), el('th', { class: 'num' }, 'Avg R'), el('th', { class: 'num' }, 'Total R'))),
        el('tbody', {}, rows)));
    }

    // ---- Execution tab --------------------------------------------------------
    renderExecution(r, ps) {
      const rows = S.execution(ps).map((e) => el('tr', {},
        el('td', {}, e.symbol), el('td', { class: 'num' }, e.medianSpreadPoints ?? '–'),
        el('td', { class: 'num' }, e.stopExits),
        el('td', { class: 'num' }, e.stopExits ? `${e.stopExitsWorse} (${fmtPct(e.stopExitsWorse / e.stopExits)})` : '–'),
        el('td', { class: `num ${signClass(e.medianStopSlippagePoints === null ? null : -e.medianStopSlippagePoints)}` }, e.medianStopSlippagePoints ?? '–')));
      r.append(el('table', { class: 'jt compact' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Symbol'), el('th', { class: 'num' }, 'Median spread at entry'),
          el('th', { class: 'num' }, 'Stop-loss exits'), el('th', { class: 'num' }, 'Filled worse than stop'),
          el('th', { class: 'num' }, 'Median stop slippage'))),
        el('tbody', {}, rows)),
      el('p', { class: 'note' }, 'All in points (the smallest price step of the symbol). Slippage is your fill against the price on the order (stop level, limit, take-profit or the price when you clicked): positive = worse for you. Spread comes from the broker\'s ticks at the moment of the fill.'));
    }
  }

  window.JournalPanel = JournalPanel;
})();
