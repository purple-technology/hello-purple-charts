// Local alerts. The rules (Alerts.evaluate) are plain functions, tested in
// Node. The AlertManager runs in the page: every 15 seconds it asks our own
// server for the latest prices, checks your alerts, and shows a Windows
// notification (through the browser) plus a message on the page.
// Alerts only run while this page is open; they are saved in data/alerts.json.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Alerts = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const KINDS = {
    price_above: { label: 'Price rises above', rsi: false, above: true },
    price_below: { label: 'Price falls below', rsi: false, above: false },
    rsi_above: { label: 'RSI rises above', rsi: true, above: true },
    rsi_below: { label: 'RSI falls below', rsi: true, above: false },
  };

  /**
   * Is the alert's condition true now, and should it fire?
   * It fires only on a *crossing*: the condition was false at the previous
   * check and is true now. The very first check only records the state, so
   * an alert set "above 1.20" while price is already 1.21 waits for the
   * next real crossing instead of firing straight away.
   */
  function evaluate(alert, value, previousState) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return { state: previousState, fire: false };
    }
    const k = KINDS[alert.kind];
    const state = k.above ? value >= alert.value : value <= alert.value;
    return { state, fire: previousState === false && state === true };
  }

  function describe(a) {
    const k = KINDS[a.kind];
    return k.rsi ? `${a.symbol} RSI(${a.period}) ${a.tf} ${k.above ? '≥' : '≤'} ${a.value}`
      : `${a.symbol} ${k.above ? '≥' : '≤'} ${a.value}`;
  }

  /** What to ask the server for: one request per symbol + timeframe. */
  function requests(alerts) {
    const map = new Map();
    alerts.filter((a) => a.active).forEach((a) => {
      const k = KINDS[a.kind];
      const tf = k.rsi ? a.tf : 'M1';
      const count = k.rsi ? Math.min(500, a.period * 10 + 1) : 1;
      const key = `${a.symbol}|${tf}`;
      const prev = map.get(key);
      map.set(key, { symbol: a.symbol, tf, count: Math.max(count, prev ? prev.count : 0) });
    });
    return [...map.values()];
  }

  // ---- Browser part --------------------------------------------------------
  class AlertManager {
    constructor({ onChange, onFire, onError }) {
      this.alerts = [];
      this.states = new Map(); // alert id -> last condition state
      this.log = [];           // fired alerts, newest first
      this.onChange = onChange || (() => {});
      this.onFire = onFire || (() => {});
      this.onError = onError || (() => {});
      this.timer = null;
    }

    async load() {
      const res = await fetch('/api/alerts', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load alerts');
      this.alerts = body.alerts;
      this.onChange();
      this.start();
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this.check(), 15000);
      this.check();
    }

    async save() {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts: this.alerts }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.alerts = body.alerts;
      this.onChange();
    }

    async add(alert) {
      const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      this.alerts = this.alerts.concat([{ id, active: true, repeat: false, tf: 'M1', period: 14, ...alert }]);
      await this.save();
      this.check();
    }

    async remove(id) {
      this.alerts = this.alerts.filter((a) => a.id !== id);
      this.states.delete(id);
      await this.save();
    }

    async toggle(id) {
      this.alerts = this.alerts.map((a) => (a.id === id ? { ...a, active: !a.active } : a));
      this.states.delete(id);
      await this.save();
    }

    async check() {
      const active = this.alerts.filter((a) => a.active);
      if (!active.length) return;
      const values = new Map();
      for (const r of requests(active)) {
        try {
          const res = await fetch(`/api/latest?symbol=${encodeURIComponent(r.symbol)}&tf=${r.tf}&count=${r.count}`, { cache: 'no-store' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error);
          values.set(`${r.symbol}|${r.tf}`, body.candles.map((c) => c.close));
        } catch (err) {
          this.onError(`Alert check failed for ${r.symbol}: ${err.message}`);
        }
      }
      let changed = false;
      for (const a of active) {
        const k = KINDS[a.kind];
        const closes = values.get(`${a.symbol}|${k.rsi ? a.tf : 'M1'}`);
        if (!closes || !closes.length) continue;
        const value = k.rsi ? root.Indicators.rsi(closes, a.period).pop() : closes[closes.length - 1];
        const { state, fire } = evaluate(a, value, this.states.get(a.id));
        this.states.set(a.id, state);
        if (fire) {
          const entry = { when: new Date(), text: describe(a), value };
          this.log.unshift(entry);
          this.log = this.log.slice(0, 50);
          this.onFire(entry);
          if (!a.repeat) { a.active = false; changed = true; }
        }
      }
      if (changed) this.save().catch((e) => this.onError(e.message));
      this.onChange();
    }
  }

  return { KINDS, evaluate, describe, requests, AlertManager };
});
