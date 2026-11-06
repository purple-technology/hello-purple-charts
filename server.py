"""Local web server for the chart. Listens on 127.0.0.1 only.

Start it with:  .\\start.cmd   (or: .venv\\Scripts\\python.exe server.py)
Then open:      http://127.0.0.1:8765
"""

import json
import os
import socket
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import chartlogic
import drawings_store
import local_store
import mt5_reader

HOST = "127.0.0.1"  # loopback only: unreachable from the network
# Port 8765 unless HP_CHART_PORT says otherwise (used to test a second copy
# while the normal one keeps running).
try:
    PORT = int(os.environ.get("HP_CHART_PORT", "8765"))
except ValueError:
    PORT = 8765
if not 1024 <= PORT <= 65535:
    PORT = 8765
MIN_CANDLES = 1500   # always load at least this many candles
MAX_CANDLES = 60000  # upper limit so the page stays quick
MAX_POST_BYTES = 200_000

# Second charts are built from ticks over a recent window only.
SECOND_TIMEFRAMES = {"S5": 5, "S15": 15, "S30": 30}
SECONDS_WINDOW = 4 * 3600   # last 4 hours of ticks
MAX_TICKS = 400_000

# Candle timeframes tried (finest first) for the highs/lows during a trade.
EXCURSION_TIMEFRAMES = ("M1", "M5", "M15", "H1")

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Fixed list of files the server may send. Nothing else on disk is reachable.
_JS = "text/javascript; charset=utf-8"
STATIC_FILES = {
    "/": (STATIC / "index.html", "text/html; charset=utf-8"),
    "/style.css": (STATIC / "style.css", "text/css; charset=utf-8"),
    "/favicon.svg": (STATIC / "favicon.svg", "image/svg+xml"),
    "/vendor/lightweight-charts.js": (
        ROOT / "node_modules" / "lightweight-charts" / "dist"
        / "lightweight-charts.standalone.production.js", _JS),
}
for _name in ("app.js", "theme.js", "chartview.js", "indicators.js", "drawmath.js", "drawings.js",
              "tradelines.js", "stats.js", "journal.js", "alerts.js", "csv.js"):
    STATIC_FILES["/" + _name] = (STATIC / _name, _JS)

ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

# Journal results per closed position never change, so they are computed
# once (the first time can take a minute or two while MT5 downloads history)
# and kept in data/journal_cache.json. It holds only prices and points.
# Bump the version when the calculation changes, so old results are redone.
JOURNAL_CACHE_FILE = ROOT / "data" / "journal_cache.json"
JOURNAL_CACHE_VERSION = 2
_JOURNAL_CACHE = {}


def all_timeframes():
    return list(SECOND_TIMEFRAMES) + list(mt5_reader.TIMEFRAMES)


def symbols_payload():
    with mt5_reader.connection():
        deals = mt5_reader.read_deals()
        symbols = mt5_reader.read_symbols()
    traded = set(chartlogic.traded_symbols(deals))
    listed = sorted(
        ({"name": s["name"], "group": s["group"], "traded": s["name"] in traded}
         for s in symbols),
        key=lambda s: (s["group"].lower(), s["name"].lower()))
    return {"symbols": listed, "timeframes": all_timeframes()}


def _symbol_info(symbol):
    info = {s["name"]: s for s in mt5_reader.read_symbols()}.get(symbol)
    if info is None:
        raise ValueError("Unknown symbol")
    return info


def _second_candles(symbol, seconds, point):
    """Recent candles of a few seconds each, built from bid ticks."""
    last = mt5_reader.read_candles(symbol, "M1", 1)[-1]["time"]  # "now" in server time
    end = last + 120
    ticks = mt5_reader.read_ticks(symbol, end - SECONDS_WINDOW, end)
    if len(ticks) > MAX_TICKS:
        ticks = ticks[-MAX_TICKS:]
    candles = chartlogic.seconds_candles(ticks, seconds)
    for c in candles:
        c["spread"] = round(c.pop("_spreadSum") / c["volume"] / point, 1) if point else 0
    if not candles:
        raise mt5_reader.TerminalUnavailable(f"No ticks for {symbol} in the last hours.")
    return candles


def chart_payload(symbol, timeframe):
    with mt5_reader.connection():
        info = _symbol_info(symbol)
        point = 10 ** -info["digits"]
        deals = mt5_reader.read_deals()
        trades = chartlogic.shape_trades(d for d in deals if d.get("symbol") == symbol)
        if timeframe in SECOND_TIMEFRAMES:
            bar_seconds = SECOND_TIMEFRAMES[timeframe]
            candles = _second_candles(symbol, bar_seconds, point)
        else:
            bar_seconds = mt5_reader.TIMEFRAME_SECONDS[timeframe]
            count = chartlogic.candles_needed(
                trades[0]["time"] if trades else None, int(time.time()),
                bar_seconds, MIN_CANDLES, MAX_CANDLES)
            candles = mt5_reader.read_candles(symbol, timeframe, count)

    bar_times = [c["time"] for c in candles]
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "barSeconds": bar_seconds,
        "digits": info["digits"],
        "candles": [
            {k: c[k] for k in ("time", "open", "high", "low", "close")}
            for c in candles
        ],
        "volume": [{"time": c["time"], "value": c["volume"], "spread": c["spread"],
                    "up": c["close"] >= c["open"]} for c in candles],
        "trades": chartlogic.snap_trades_to_bars(trades, bar_times),
    }


def latest_payload(symbol, timeframe, count):
    """The last few closes of a symbol (used by the alerts in the page)."""
    with mt5_reader.connection():
        _symbol_info(symbol)
        candles = mt5_reader.read_candles(symbol, timeframe, count)
    return {"symbol": symbol, "timeframe": timeframe,
            "candles": [{"time": c["time"], "close": c["close"]} for c in candles]}


def _excursion_bars(pos):
    """Candles covering the trade, from the finest timeframe that has them."""
    for tf in EXCURSION_TIMEFRAMES:
        step = mt5_reader.TIMEFRAME_SECONDS[tf]
        start = pos["entryTime"] // step * step  # include the candle the entry is in
        bars = mt5_reader.read_candles_between(pos["symbol"], tf, start, pos["exitTime"])
        if bars and bars[0]["time"] <= pos["entryTime"]:
            return tf, bars
    return None, []


def _fill_quality(pos, deal, point, orders_by_ticket):
    if deal is None:
        return None
    t = int(deal["time"])
    ticks = mt5_reader.read_ticks(pos["symbol"], t - 2, t + 2)
    side = "buy" if deal["type"] == chartlogic.DEAL_TYPE_BUY else "sell"
    requested = orders_by_ticket.get(deal.get("order"), {}).get("price_open") or None
    return chartlogic.execution_quality(int(deal["time_msc"]), float(deal["price"]),
                                        side, ticks, point, requested)


def _load_journal_cache():
    data = local_store.read_json(JOURNAL_CACHE_FILE, {})
    if data.get("version") != JOURNAL_CACHE_VERSION or not isinstance(data.get("items"), dict):
        return {}
    return data["items"]


def journal_payload():
    if not _JOURNAL_CACHE:
        _JOURNAL_CACHE.update(_load_journal_cache())
    changed = False
    with mt5_reader.connection():
        deals = mt5_reader.read_deals()
        orders = mt5_reader.read_orders()
        orders_by_ticket = {o["ticket"]: o for o in orders}
        digits = {s["name"]: s["digits"] for s in mt5_reader.read_symbols()}
        positions = chartlogic.build_positions(deals, orders)
        for pos in positions:
            if pos["open"]:
                continue
            cache_key = f'{pos["key"]}|{pos["exitTime"]}'
            if cache_key not in _JOURNAL_CACHE:
                point = 10 ** -digits.get(pos["symbol"], 5)
                tf, bars = _excursion_bars(pos)
                mae, mfe = chartlogic.mae_mfe(pos, bars)
                _JOURNAL_CACHE[cache_key] = {
                    "mae": mae, "mfe": mfe, "excursionTf": tf,
                    "entryFill": _fill_quality(pos, pos["_entryDeal"], point, orders_by_ticket),
                    "exitFill": _fill_quality(pos, pos["_exitDeal"], point, orders_by_ticket),
                }
                changed = True
            pos.update(_JOURNAL_CACHE[cache_key])
    if changed:
        local_store.write_json_atomic(JOURNAL_CACHE_FILE, {
            "version": JOURNAL_CACHE_VERSION, "items": _JOURNAL_CACHE})

    manual = local_store.load_stops()
    out = []
    for pos in positions:
        if pos["key"] in manual:
            pos["stop"], pos["stopSource"] = manual[pos["key"]], "manual"
        result = chartlogic.trade_result(pos)
        risk = result["risk"]
        public = {k: v for k, v in pos.items() if not k.startswith("_")}
        public.update(result)
        public["digits"] = digits.get(pos["symbol"])
        mae, mfe = pos.get("mae"), pos.get("mfe")
        public["maeR"] = mae / risk if risk and mae is not None else None
        public["mfeR"] = mfe / risk if risk and mfe is not None else None
        public["duration"] = (pos["exitTime"] - pos["entryTime"]) if pos["exitTime"] else None
        out.append(public)
    return {"positions": out}


def _q(url, name, default=""):
    return parse_qs(url.query).get(name, [default])[0]


class Handler(BaseHTTPRequestHandler):
    server_version = "hp-chart"
    sys_version = ""

    def do_GET(self):
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return self._send_json(403, {"error": "Forbidden host"})

        url = urlparse(self.path)
        try:
            if url.path in STATIC_FILES:
                path, ctype = STATIC_FILES[url.path]
                return self._send(200, path.read_bytes(), ctype)
            if url.path == "/api/symbols":
                return self._send_json(200, symbols_payload())
            if url.path == "/api/drawings":
                try:
                    return self._send_json(200, {"drawings": drawings_store.load(_q(url, "symbol"))})
                except drawings_store.InvalidDrawings as e:
                    return self._send_json(400, {"error": str(e)})
            if url.path == "/api/alerts":
                return self._send_json(200, {"alerts": local_store.load_alerts()})
            if url.path == "/api/journal":
                return self._send_json(200, journal_payload())
            if url.path == "/api/chart":
                timeframe = _q(url, "tf")
                if timeframe not in all_timeframes():
                    return self._send_json(400, {"error": "Unknown timeframe"})
                try:
                    return self._send_json(200, chart_payload(_q(url, "symbol"), timeframe))
                except ValueError as e:
                    return self._send_json(400, {"error": str(e)})
            if url.path == "/api/latest":
                timeframe = _q(url, "tf")
                try:
                    count = int(_q(url, "count", "1"))
                except ValueError:
                    count = 0
                if timeframe not in mt5_reader.TIMEFRAMES or not 1 <= count <= 500:
                    return self._send_json(400, {"error": "Bad timeframe or count"})
                try:
                    return self._send_json(200, latest_payload(_q(url, "symbol"), timeframe, count))
                except ValueError as e:
                    return self._send_json(400, {"error": str(e)})
            return self._send_json(404, {"error": "Not found"})
        except mt5_reader.TerminalUnavailable as e:
            return self._send_json(503, {"error": str(e)})

    def do_POST(self):
        """Saves things you create (drawings, alerts, manual stops) to local files."""
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return self._send_json(403, {"error": "Forbidden host"})
        # Only our own page may save: other websites send a different Origin.
        if self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self._send_json(403, {"error": "Forbidden origin"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._send_json(415, {"error": "JSON only"})
        url = urlparse(self.path)
        if url.path not in ("/api/drawings", "/api/alerts", "/api/journal/stop"):
            return self._send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 < length <= MAX_POST_BYTES:
            return self._send_json(413, {"error": "Too large"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("Invalid data")
            if url.path == "/api/drawings":
                result = {"drawings": drawings_store.save(_q(url, "symbol"), body.get("drawings"))}
            elif url.path == "/api/alerts":
                result = {"alerts": local_store.save_alerts(body.get("alerts"))}
            else:
                local_store.set_stop(body.get("key"), body.get("stop"))
                result = {"ok": True}
        except (ValueError, UnicodeDecodeError) as e:  # includes the stores' InvalidData
            return self._send_json(400, {"error": str(e) or "Invalid data"})
        return self._send_json(200, result)

    def _send_json(self, status, obj):
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         # The chart library sets inline styles (e.g. for the
                         # TradingView attribution logo), so styles may be inline.
                         # Scripts stay restricted to our own files.
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; "
                         "connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


class ExclusiveHTTPServer(HTTPServer):
    """Claims the port exclusively.

    Python's HTTPServer allows address reuse by default. On Windows that
    lets a second program bind the same port and take over requests. Here a
    second copy fails with a clear error instead.
    """
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    try:
        httpd = ExclusiveHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use: the chart is probably already running.\n"
              f"Open http://{HOST}:{PORT}/ or close the other window first.")
        sys.exit(1)
    url = f"http://{HOST}:{PORT}/"
    print(f"Chart running at {url}  (press Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
