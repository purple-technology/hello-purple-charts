"""Local files for things you create yourself: alerts and manual stops.

Like drawings_store.py: plain files in data/, checked strictly before
saving and written all-or-nothing. Nothing here touches MetaTrader 5.
"""

import json
import math
import os
import re
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
ALERTS_FILE = DATA_DIR / "alerts.json"
STOPS_FILE = DATA_DIR / "journal_stops.json"

ALERT_KINDS = {"price_above", "price_below", "rsi_above", "rsi_below"}
ALERT_TIMEFRAMES = {"M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"}
MAX_ALERTS = 200
MAX_STOPS = 2000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
SYMBOL_RE = re.compile(r"^[^\x00-\x1f|]{1,64}$")
KEY_RE = re.compile(r"^[^\x00-\x1f|]{1,64}\|[0-9]{1,12}\|(buy|sell)$")


class InvalidData(ValueError):
    pass


def read_json(path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, path)  # all-or-nothing: never a half-written file


def _number(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise InvalidData(f"bad {what}")
    return float(v)


# ---- Alerts ----------------------------------------------------------------

def clean_alerts(alerts):
    if not isinstance(alerts, list):
        raise InvalidData("alerts must be a list")
    if len(alerts) > MAX_ALERTS:
        raise InvalidData("too many alerts")
    clean = []
    for a in alerts:
        if not isinstance(a, dict):
            raise InvalidData("alert must be an object")
        if not isinstance(a.get("id"), str) or not ID_RE.match(a["id"]):
            raise InvalidData("bad id")
        if not isinstance(a.get("symbol"), str) or not SYMBOL_RE.match(a["symbol"]):
            raise InvalidData("bad symbol")
        if a.get("kind") not in ALERT_KINDS:
            raise InvalidData("unknown alert kind")
        tf = a.get("tf", "M1")
        if tf not in ALERT_TIMEFRAMES:
            raise InvalidData("bad timeframe")
        period = a.get("period", 14)
        if isinstance(period, bool) or not isinstance(period, int) or not 2 <= period <= 200:
            raise InvalidData("bad period")
        value = _number(a.get("value"), "value")
        if a["kind"].startswith("rsi") and not 0 <= value <= 100:
            raise InvalidData("RSI level must be 0-100")
        clean.append({
            "id": a["id"], "symbol": a["symbol"], "kind": a["kind"], "value": value,
            "tf": tf, "period": period,
            "repeat": a.get("repeat") is True, "active": a.get("active") is not False,
        })
    return clean


def load_alerts(path=ALERTS_FILE):
    try:
        return clean_alerts(read_json(path, []))
    except InvalidData:
        return []


def save_alerts(alerts, path=ALERTS_FILE):
    clean = clean_alerts(alerts)
    write_json_atomic(path, clean)
    return clean


# ---- Manual stops for the journal ----------------------------------------------

def load_stops(path=STOPS_FILE):
    data = read_json(path, {})
    out = {}
    for k, v in data.items():
        if isinstance(k, str) and KEY_RE.match(k) and isinstance(v, (int, float)) \
                and not isinstance(v, bool) and math.isfinite(v) and v > 0:
            out[k] = float(v)
    return out


def set_stop(key, stop, path=STOPS_FILE):
    """Set (or with stop=None remove) the manual stop price of one position."""
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise InvalidData("bad position key")
    stops = load_stops(path)
    if stop is None:
        stops.pop(key, None)
    else:
        value = _number(stop, "stop")
        if value <= 0:
            raise InvalidData("stop must be above zero")
        stops[key] = value
    if len(stops) > MAX_STOPS:
        raise InvalidData("too many stops")
    write_json_atomic(path, stops)
    return stops
