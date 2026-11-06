"""The ONLY file that talks to MetaTrader 5. Read-only.

Allowed MT5 calls (enforced by tests/test_readonly.py):
  initialize, shutdown, last_error   - open/close the connection, read errors
  symbols_get                        - list symbols
  copy_rates_from_pos, copy_rates_range - read candles
  history_deals_get                  - read closed deals
  history_orders_get                 - read past orders (for the stop-loss)
  copy_ticks_range                   - read bid/ask ticks

No login details are used: initialize() without arguments attaches to the
terminal that is already open and logged in on this computer.
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
    "W1": mt5.TIMEFRAME_W1,
    "MN1": mt5.TIMEFRAME_MN1,
}

# Length of one candle in seconds (a month is counted as 30 days; only used
# to estimate how many candles to load and to extend drawings to the right).
TIMEFRAME_SECONDS = {
    "M1": 60, "M5": 300, "M15": 900, "M30": 1800,
    "H1": 3600, "H4": 4 * 3600, "D1": 86400, "W1": 7 * 86400, "MN1": 30 * 86400,
}

HISTORY_START = datetime(2000, 1, 1, tzinfo=timezone.utc)


class TerminalUnavailable(Exception):
    """MetaTrader 5 could not be reached or returned no data."""


@contextmanager
def connection():
    """Open a connection to the running terminal and always close it again."""
    if not mt5.initialize():
        code, _ = mt5.last_error()
        raise TerminalUnavailable(
            f"Could not connect to MetaTrader 5 (error {code}). "
            "Is the terminal open and logged in?"
        )
    try:
        yield
    finally:
        mt5.shutdown()


def read_deals():
    """All closed deals in the account history, as plain dicts."""
    end = datetime.now(timezone.utc) + timedelta(days=2)
    deals = mt5.history_deals_get(HISTORY_START, end)
    if deals is None:
        code, _ = mt5.last_error()
        raise TerminalUnavailable(f"Could not read deal history (error {code}).")
    return [d._asdict() for d in deals]


def read_symbols():
    """Every symbol the broker offers: name, category and number of decimals.

    The category is the first part of MT5's symbol path, e.g. "Forex" for
    the path Forex > Majors > EURUSD.
    """
    found = mt5.symbols_get()
    if found is None:
        code, _ = mt5.last_error()
        raise TerminalUnavailable(f"Could not read the symbol list (error {code}).")
    return [{
        "name": s.name,
        "group": (s.path.replace("/", "\\").split("\\")[0] or "Other")
                 if s.path else "Other",
        "digits": int(s.digits),
    } for s in found]


def read_orders():
    """All past orders, as dicts: only the fields the journal needs."""
    end = datetime.now(timezone.utc) + timedelta(days=2)
    orders = mt5.history_orders_get(HISTORY_START, end)
    if orders is None:
        code, _ = mt5.last_error()
        raise TerminalUnavailable(f"Could not read order history (error {code}).")
    keep = ("ticket", "position_id", "sl", "tp", "price_open", "symbol")
    return [{k: o._asdict()[k] for k in keep} for o in orders]


def _utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc)


def read_ticks(symbol, start_seconds, end_seconds):
    """Bid/ask ticks between two times, as (time_msc, bid, ask) tuples.

    Times use the same clock as deals and candles (broker server time).
    Returns [] when the broker has no ticks for that period.
    """
    ticks = mt5.copy_ticks_range(symbol, _utc(start_seconds), _utc(end_seconds),
                                 mt5.COPY_TICKS_ALL)
    if ticks is None:
        return []
    return [(int(t["time_msc"]), float(t["bid"]), float(t["ask"])) for t in ticks]


def read_candles_between(symbol, timeframe, start_seconds, end_seconds):
    """Candles between two times (used for the highs/lows during a trade)."""
    rates = mt5.copy_rates_range(symbol, TIMEFRAMES[timeframe],
                                 _utc(start_seconds), _utc(end_seconds))
    if rates is None:
        return []
    return [{"time": int(r["time"]), "high": float(r["high"]), "low": float(r["low"])}
            for r in rates]


def read_candles(symbol, timeframe, count):
    """The latest `count` candles as a list of dicts (time in seconds)."""
    rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[timeframe], 0, count)
    if rates is None or len(rates) == 0:
        code, _ = mt5.last_error()
        raise TerminalUnavailable(
            f"No candles for {symbol} {timeframe} (error {code})."
        )
    candles = []
    for r in rates:
        real = int(r["real_volume"])
        candles.append({
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "spread": int(r["spread"]),  # in points, as reported by MT5 for this candle
            # Exchange volume when the broker provides it, otherwise tick volume.
            "volume": real if real > 0 else int(r["tick_volume"]),
        })
    return candles
