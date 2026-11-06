"""Pure calculations for the chart. No MetaTrader 5 access in this file.

Everything here works on plain Python lists and dicts, so it can be
tested without a running terminal (see tests/).
"""

from bisect import bisect_right

# MetaTrader 5 deal type numbers (DEAL_TYPE_BUY / DEAL_TYPE_SELL).
# Every other type (balance, credit, commission, ...) is a money movement
# and is never sent to the page.
DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1

# MetaTrader 5 deal entry numbers -> short label shown on the chart.
ENTRY_LABELS = {
    0: "entry",     # DEAL_ENTRY_IN
    1: "exit",      # DEAL_ENTRY_OUT
    2: "reversal",  # DEAL_ENTRY_INOUT
    3: "exit",      # DEAL_ENTRY_OUT_BY (closed by an opposite position)
}

# The only fields of a trade that may ever leave the server.
TRADE_FIELDS = ("time", "price", "volume", "side", "entry")


def traded_symbols(deals):
    """Sorted list of symbols that have at least one buy or sell deal."""
    return sorted({
        d["symbol"] for d in deals
        if d.get("symbol") and d.get("type") in (DEAL_TYPE_BUY, DEAL_TYPE_SELL)
    })


def shape_trades(deals):
    """Turn raw MT5 deals (as dicts) into safe trade records.

    Keeps only buy/sell deals, and only time, price, volume, direction and
    entry/exit. Profit, commission, swap, fee, comments, ticket numbers and
    everything else are dropped here, before anything reaches the page.
    """
    trades = []
    for d in deals:
        if d.get("type") not in (DEAL_TYPE_BUY, DEAL_TYPE_SELL):
            continue
        trades.append({
            "time": int(d["time"]),
            "price": float(d["price"]),
            "volume": float(d["volume"]),
            "side": "buy" if d["type"] == DEAL_TYPE_BUY else "sell",
            "entry": ENTRY_LABELS.get(d.get("entry"), "trade"),
        })
    trades.sort(key=lambda t: t["time"])
    return trades


def candles_needed(first_trade_time, now, bar_seconds, minimum, maximum):
    """How many candles to load so the chart reaches back to the first trade.

    Counts calendar time, so weekends make it a slight over-estimate, which
    is fine: a few extra candles on the left. Never fewer than `minimum`,
    never more than `maximum`.
    """
    if first_trade_time is None:
        return minimum
    span = max(0, now - first_trade_time)
    needed = span // bar_seconds + 50  # +50 candles of context before the trade
    return int(min(maximum, max(minimum, needed)))


def snap_trades_to_bars(trades, bar_times):
    """Attach each trade to the candle it happened in.

    Chart markers must sit on the exact time of an existing candle,
    otherwise the chart library silently drops them. A trade at 10:37 on an
    H1 chart therefore belongs to the 10:00 candle: the last candle whose
    open time is at or before the trade time. Trades older than the first
    loaded candle are left out.
    """
    snapped = []
    for t in trades:
        i = bisect_right(bar_times, t["time"]) - 1
        if i < 0:
            continue
        snapped.append({**t, "barTime": bar_times[i]})
    return snapped


# ---------------------------------------------------------------------------
# Trade journal (part 3). Results are expressed as price movement, percent
# and R-multiples, never as money.
# ---------------------------------------------------------------------------

# MT5 deal reasons that tell how a position was closed.
EXIT_REASONS = {4: "SL", 5: "TP", 6: "stop-out"}


def position_key(symbol, entry_time, side):
    """Stable name for a position, without any broker ticket number."""
    return f"{symbol}|{int(entry_time)}|{side}"


def _weighted(deals):
    vol = sum(d["volume"] for d in deals)
    return sum(d["price"] * d["volume"] for d in deals) / vol, vol


def build_positions(deals, orders):
    """Group buy/sell deals into positions (entry + exit).

    `orders` is used only to find the stop-loss and take-profit set on the
    order that opened the position. Returns a list of dicts, oldest first.
    Internal fields (starting with "_") are for the server only.
    """
    orders_by_ticket = {o["ticket"]: o for o in orders}
    groups = {}
    for d in deals:
        if d.get("type") not in (DEAL_TYPE_BUY, DEAL_TYPE_SELL):
            continue
        groups.setdefault(d["position_id"], []).append(d)

    positions = []
    for group in groups.values():
        group.sort(key=lambda d: (d["time_msc"], d["time"]))
        ins = [d for d in group if d["entry"] == 0]
        outs = [d for d in group if d["entry"] in (1, 3)]
        if not ins or any(d["entry"] == 2 for d in group):
            continue  # reversals (in/out in one deal) are not supported
        first = ins[0]
        side = "buy" if first["type"] == DEAL_TYPE_BUY else "sell"
        entry_price, volume = _weighted(ins)
        opening = orders_by_ticket.get(first.get("order"), {})
        stop = opening.get("sl") or None
        target = opening.get("tp") or None
        pos = {
            "key": position_key(first["symbol"], first["time"], side),
            "symbol": first["symbol"],
            "side": side,
            "volume": round(volume, 8),
            "entryTime": int(first["time"]),
            "entryPrice": entry_price,
            "stop": stop,
            "stopSource": "order" if stop else None,
            "target": target,
            "open": not outs,
            "exitTime": None, "exitPrice": None, "exitReason": None,
            "_entryDeal": first, "_exitDeal": None,
        }
        if outs:
            exit_price, _ = _weighted(outs)
            last = outs[-1]
            pos.update({
                "exitTime": int(last["time"]),
                "exitPrice": exit_price,
                "exitReason": EXIT_REASONS.get(last.get("reason"), "manual"),
                "_exitDeal": last,
            })
        positions.append(pos)
    positions.sort(key=lambda p: p["entryTime"])
    return positions


def trade_result(pos):
    """Price movement in the trade's favour, percent, and R (if a stop is known)."""
    if pos["exitPrice"] is None:
        return {"move": None, "movePct": None, "risk": None, "r": None}
    direction = 1 if pos["side"] == "buy" else -1
    move = (pos["exitPrice"] - pos["entryPrice"]) * direction
    risk = abs(pos["entryPrice"] - pos["stop"]) if pos.get("stop") else None
    if risk == 0:
        risk = None
    return {
        "move": move,
        "movePct": move / pos["entryPrice"] * 100,
        "risk": risk,
        "r": move / risk if risk else None,
    }


def mae_mfe(pos, bars):
    """Maximum adverse / favourable excursion during the trade.

    MAE: how far price went against the position at its worst.
    MFE: how far it went in favour at its best. Both as positive price
    distances, from the highs and lows of `bars` (candles covering the
    trade).

    Candles are bid prices, but a short position is closed at the ask, so
    candles alone can miss exactly the spread (seen on an index CFD: up to 186
    points). The real exit price was actually reached, so MAE is at least the
    realised loss and MFE at least the realised gain.
    """
    if not bars:
        return None, None
    high = max(b["high"] for b in bars)
    low = min(b["low"] for b in bars)
    e = pos["entryPrice"]
    if pos["side"] == "buy":
        mae, mfe = max(0.0, e - low), max(0.0, high - e)
    else:
        mae, mfe = max(0.0, high - e), max(0.0, e - low)
    move = trade_result(pos)["move"]
    if move is not None:
        mae = max(mae, -move)
        mfe = max(mfe, move)
    return mae, mfe


def execution_quality(deal_time_msc, deal_price, side, ticks, point, requested_price=None):
    """Spread at the fill and slippage, in points.

    Slippage = how much worse (positive) or better (negative) the fill was
    than the price requested on the order: the limit price, the stop-loss
    level, the take-profit level, or for a market order the price shown when
    you clicked. This is how MT5 itself defines slippage.

    The spread comes from the tick closest in time to the fill. Tick and
    fill timestamps differ by up to a few hundred milliseconds (measured:
    the matching tick was once 3 ms after, once 140 ms before the fill), so
    ticks are NOT used for slippage when the order price is known.
    """
    if not point:
        return None
    near = [t for t in ticks if abs(t[0] - deal_time_msc) <= 1000]
    closest = min(near, key=lambda t: abs(t[0] - deal_time_msc)) if near else None
    out = {"spreadPoints": round((closest[2] - closest[1]) / point, 1) if closest else None,
           "slippagePoints": None, "slippageSource": None}
    if requested_price:
        ref, source = requested_price, "order"
    elif closest:
        ref, source = (closest[2] if side == "buy" else closest[1]), "tick"
    else:
        return out if closest else None
    slip = (deal_price - ref) if side == "buy" else (ref - deal_price)
    out["slippagePoints"] = round(slip / point, 1)
    out["slippageSource"] = source
    return out


def seconds_candles(ticks, seconds):
    """Build candles of `seconds` length from (time_msc, bid, ask) ticks (bid prices)."""
    candles = []
    for t_msc, bid, ask in ticks:
        t = (t_msc // 1000) // seconds * seconds
        if candles and candles[-1]["time"] == t:
            c = candles[-1]
            c["high"] = max(c["high"], bid)
            c["low"] = min(c["low"], bid)
            c["close"] = bid
            c["volume"] += 1
            c["_spreadSum"] += ask - bid
        else:
            candles.append({"time": t, "open": bid, "high": bid, "low": bid, "close": bid,
                            "volume": 1, "_spreadSum": ask - bid})
    return candles
