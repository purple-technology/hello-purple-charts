"""Saves your chart drawings in data/drawings.json (on this computer only).

This has nothing to do with MetaTrader 5: it is a plain local file. Every
drawing is checked strictly before it is saved; anything unexpected is
refused, so the file only ever contains drawing types, colours, times and
prices.
"""

import json
import math
import os
import re
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "drawings.json"

DRAWING_TYPES = {"trend": 2, "rect": 2, "hline": 1}  # type -> number of points
MAX_DRAWINGS_PER_SYMBOL = 300
MAX_TIME = 4_102_444_800  # year 2100
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
SYMBOL_RE = re.compile(r"^[^\x00-\x1f]{1,64}$")


class InvalidDrawings(ValueError):
    pass


def _clean_point(p):
    if not isinstance(p, dict):
        raise InvalidDrawings("point must be an object")
    t, price = p.get("time"), p.get("price")
    if isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= MAX_TIME:
        raise InvalidDrawings("bad time")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
        raise InvalidDrawings("bad price")
    return {"time": int(t), "price": float(price)}


def clean_drawings(drawings):
    """Validate a list of drawings and return a clean copy (known fields only)."""
    if not isinstance(drawings, list):
        raise InvalidDrawings("drawings must be a list")
    if len(drawings) > MAX_DRAWINGS_PER_SYMBOL:
        raise InvalidDrawings("too many drawings")
    clean = []
    for d in drawings:
        if not isinstance(d, dict):
            raise InvalidDrawings("drawing must be an object")
        kind = d.get("type")
        if kind not in DRAWING_TYPES:
            raise InvalidDrawings("unknown drawing type")
        if not isinstance(d.get("id"), str) or not ID_RE.match(d["id"]):
            raise InvalidDrawings("bad id")
        if not isinstance(d.get("color"), str) or not COLOR_RE.match(d["color"]):
            raise InvalidDrawings("bad color")
        points = d.get("points")
        if not isinstance(points, list) or len(points) != DRAWING_TYPES[kind]:
            raise InvalidDrawings("wrong number of points")
        clean.append({"id": d["id"], "type": kind, "color": d["color"].lower(),
                      "points": [_clean_point(p) for p in points]})
    return clean


def check_symbol(symbol):
    if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
        raise InvalidDrawings("bad symbol")


def _read_all(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}


def load(symbol, path=DATA_FILE):
    check_symbol(symbol)
    try:
        return clean_drawings(_read_all(path).get(symbol, []))
    except InvalidDrawings:
        return []


def save(symbol, drawings, path=DATA_FILE):
    check_symbol(symbol)
    clean = clean_drawings(drawings)
    data = _read_all(path)
    if clean:
        data[symbol] = clean
    else:
        data.pop(symbol, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, path)  # all-or-nothing: never a half-written file
    return clean
