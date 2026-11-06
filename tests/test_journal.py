"""Trade journal: positions, R-multiples, MAE/MFE, slippage, second candles,
local stores, and the privacy of the journal data."""

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import chartlogic as cl
import local_store
import server


def deal(ticket, order, pos_id, t, typ, entry, price, volume=1.0, reason=0, symbol="EURUSD"):
    return {"ticket": ticket, "order": order, "position_id": pos_id, "time": t,
            "time_msc": t * 1000, "type": typ, "entry": entry, "price": price,
            "volume": volume, "reason": reason, "symbol": symbol,
            "profit": 4242.25, "commission": -7.0, "swap": -1.0, "fee": 0.0,
            "comment": "secret note", "magic": 0}


# A long that is stopped out, and a short taken in two parts and closed by TP.
DEALS = [
    {"ticket": 900000001, "type": 2, "entry": 0, "time": 10, "time_msc": 10_000, "price": 0,
     "volume": 0, "position_id": 0, "order": 0, "symbol": "", "profit": 31337.5},  # deposit
    deal(900000010, 800000010, 700000001, 1000, 0, 0, 1.1000),
    deal(900000011, 800000011, 700000001, 4600, 1, 1, 1.0950, reason=4),
    deal(900000020, 800000020, 700000002, 8000, 1, 0, 1.2000, volume=1.0),
    deal(900000021, 800000021, 700000002, 8100, 1, 0, 1.2030, volume=2.0),
    deal(900000022, 800000022, 700000002, 9000, 0, 1, 1.1900, volume=3.0, reason=5),
]
ORDERS = [
    {"ticket": 800000010, "position_id": 700000001, "sl": 1.0950, "tp": 1.1100, "price_open": 1.1000, "symbol": "EURUSD"},
    {"ticket": 800000011, "position_id": 700000001, "sl": 0, "tp": 0, "price_open": 1.0950, "symbol": "EURUSD"},
    {"ticket": 800000020, "position_id": 700000002, "sl": 0.0, "tp": 1.1900, "price_open": 1.2000, "symbol": "EURUSD"},
    {"ticket": 800000022, "position_id": 700000002, "sl": 0, "tp": 0, "price_open": 1.1902, "symbol": "EURUSD"},
]


class Positions(unittest.TestCase):

    def setUp(self):
        self.pos = cl.build_positions(DEALS, ORDERS)

    def test_grouping_and_order(self):
        self.assertEqual([(p["side"], p["entryTime"]) for p in self.pos], [("buy", 1000), ("sell", 8000)])

    def test_stop_and_exit_reason_from_mt5(self):
        long, short = self.pos
        self.assertEqual((long["stop"], long["stopSource"], long["exitReason"]), (1.0950, "order", "SL"))
        self.assertEqual((short["stop"], short["exitReason"]), (None, "TP"))

    def test_scaled_in_entry_is_volume_weighted(self):
        # (1.2000 x 1 + 1.2030 x 2) / 3 = 1.2020
        short = self.pos[1]
        self.assertAlmostEqual(short["entryPrice"], 1.2020)
        self.assertEqual(short["volume"], 3.0)

    def test_result_in_price_percent_and_r(self):
        long = cl.trade_result(self.pos[0])
        # moved 1.0950 - 1.1000 = -0.0050, risk 1.1000 - 1.0950 = 0.0050 -> exactly -1R
        self.assertAlmostEqual(long["move"], -0.0050)
        self.assertAlmostEqual(long["r"], -1.0)
        self.assertAlmostEqual(long["movePct"], -0.0050 / 1.1 * 100)
        short = cl.trade_result(self.pos[1])
        self.assertAlmostEqual(short["move"], 0.0120)  # 1.2020 - 1.1900
        self.assertIsNone(short["r"])                   # no stop known -> no R

    def test_key_has_no_ticket_numbers(self):
        self.assertEqual(self.pos[0]["key"], "EURUSD|1000|buy")


class Excursions(unittest.TestCase):

    def test_long(self):
        pos = {"side": "buy", "entryPrice": 100.0, "exitPrice": 104.0}
        bars = [{"high": 103.0, "low": 97.0}, {"high": 106.0, "low": 99.0}]
        self.assertEqual(cl.mae_mfe(pos, bars), (3.0, 6.0))  # worst 97, best 106

    def test_short(self):
        pos = {"side": "sell", "entryPrice": 100.0, "exitPrice": 98.0}
        bars = [{"high": 101.5, "low": 96.0}]
        self.assertEqual(cl.mae_mfe(pos, bars), (1.5, 4.0))

    def test_fill_outside_bid_candles_still_counts(self):
        # Short stopped out at the ask 102, while the bid candles only reached 101.
        pos = {"side": "sell", "entryPrice": 100.0, "exitPrice": 102.0}
        self.assertEqual(cl.mae_mfe(pos, [{"high": 101.0, "low": 99.5}]), (2.0, 0.5))

    def test_no_candles(self):
        self.assertEqual(cl.mae_mfe({"side": "buy", "entryPrice": 1, "exitPrice": 1}, []), (None, None))


class Fills(unittest.TestCase):
    TICKS = [(9_000, 1.1000, 1.1002), (10_003, 1.0990, 1.0992), (12_500, 1.0980, 1.0983)]

    def test_slippage_against_order_price(self):
        # Buy stop-loss... a buy at 1.1005 requested at 1.1000: 5 points worse.
        q = cl.execution_quality(10_000, 1.1005, "buy", self.TICKS, 0.0001, requested_price=1.1000)
        self.assertEqual(q["slippagePoints"], 5.0)
        self.assertEqual(q["slippageSource"], "order")
        # Spread from the tick closest in time (3 ms after): 1.0992 - 1.0990 = 2 points
        self.assertEqual(q["spreadPoints"], 2.0)

    def test_sell_better_than_requested_is_negative(self):
        q = cl.execution_quality(10_000, 1.1010, "sell", self.TICKS, 0.0001, requested_price=1.1000)
        self.assertEqual(q["slippagePoints"], -10.0)

    def test_tick_fallback_without_order_price(self):
        q = cl.execution_quality(10_000, 1.0994, "buy", self.TICKS, 0.0001)
        self.assertEqual((q["slippagePoints"], q["slippageSource"]), (2.0, "tick"))  # vs ask 1.0992

    def test_no_ticks_nearby(self):
        q = cl.execution_quality(50_000, 1.1, "buy", self.TICKS, 0.0001, requested_price=1.1)
        self.assertEqual((q["spreadPoints"], q["slippagePoints"]), (None, 0.0))
        self.assertIsNone(cl.execution_quality(50_000, 1.1, "buy", self.TICKS, 0.0001))


class SecondCandles(unittest.TestCase):

    def test_ticks_become_candles(self):
        ticks = [(1_000, 10.0, 10.2), (4_999, 11.0, 11.1), (5_000, 9.0, 9.3), (9_000, 9.5, 9.6)]
        c = cl.seconds_candles(ticks, 5)
        self.assertEqual([(x["time"], x["open"], x["high"], x["low"], x["close"], x["volume"]) for x in c],
                         [(0, 10.0, 11.0, 10.0, 11.0, 2), (5, 9.0, 9.5, 9.0, 9.5, 2)])
        self.assertAlmostEqual(c[0]["_spreadSum"], 0.2 + 0.1)


class Stores(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.alerts = Path(self.tmp.name) / "alerts.json"
        self.stops = Path(self.tmp.name) / "stops.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_alerts_round_trip_and_defaults(self):
        saved = local_store.save_alerts([{"id": "a1", "symbol": "EURUSD", "kind": "price_above",
                                          "value": 1.2, "extra": "dropped"}], self.alerts)
        self.assertEqual(saved, [{"id": "a1", "symbol": "EURUSD", "kind": "price_above", "value": 1.2,
                                  "tf": "M1", "period": 14, "repeat": False, "active": True}])
        self.assertEqual(local_store.load_alerts(self.alerts), saved)

    def test_bad_alerts_refused(self):
        good = {"id": "a1", "symbol": "EURUSD", "kind": "rsi_below", "value": 30, "tf": "H1", "period": 14}
        for bad in ({**good, "kind": "send_order"}, {**good, "value": 130}, {**good, "tf": "S5"},
                    {**good, "period": 1}, {**good, "id": "<x>"}, {**good, "value": float("inf")},
                    {**good, "symbol": "A|B"}):
            with self.subTest(bad=bad):
                with self.assertRaises(local_store.InvalidData):
                    local_store.save_alerts([bad], self.alerts)

    def test_manual_stops(self):
        local_store.set_stop("EURUSD|1000|buy", 1.09, self.stops)
        self.assertEqual(local_store.load_stops(self.stops), {"EURUSD|1000|buy": 1.09})
        local_store.set_stop("EURUSD|1000|buy", None, self.stops)
        self.assertEqual(local_store.load_stops(self.stops), {})
        for key, stop in (("EURUSD|1000|long", 1.0), ("bad", 1.0), ("EURUSD|1000|buy", -1.0),
                          ("EURUSD|1000|buy", "1.0")):
            with self.assertRaises(local_store.InvalidData):
                local_store.set_stop(key, stop, self.stops)


@contextmanager
def no_terminal():
    yield


class JournalPrivacy(unittest.TestCase):

    def test_journal_has_no_money_or_ticket_numbers(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bars = [{"time": 0, "high": 1.2100, "low": 1.0900}]
        with mock.patch.object(server.mt5_reader, "connection", no_terminal), \
             mock.patch.object(server.mt5_reader, "read_deals", lambda: DEALS), \
             mock.patch.object(server.mt5_reader, "read_orders", lambda: ORDERS), \
             mock.patch.object(server.mt5_reader, "read_symbols",
                               lambda: [{"name": "EURUSD", "group": "Forex", "digits": 4}]), \
             mock.patch.object(server.mt5_reader, "read_candles_between", lambda *a: bars), \
             mock.patch.object(server.mt5_reader, "read_ticks", lambda *a: []), \
             mock.patch.object(server, "JOURNAL_CACHE_FILE", Path(tmp.name) / "cache.json"), \
             mock.patch.object(server, "_JOURNAL_CACHE", {}), \
             mock.patch.object(server.local_store, "STOPS_FILE", Path(tmp.name) / "stops.json"):
            payload = server.journal_payload()

        text = json.dumps(payload).lower()
        for word in ("profit", "commission", "swap", "fee", "balance", "comment", "secret",
                     "ticket", "position_id", "31337", "4242"):
            self.assertNotIn(word, text)
        # No value anywhere may be a ticket, order or position number.
        def values(obj):
            if isinstance(obj, dict):
                for v in obj.values():
                    yield from values(v)
            elif isinstance(obj, list):
                for v in obj:
                    yield from values(v)
            else:
                yield obj
        ids = {d["ticket"] for d in DEALS} | {d["order"] for d in DEALS} \
            | {d["position_id"] for d in DEALS} | {o["ticket"] for o in ORDERS}
        ids.discard(0)
        self.assertEqual([v for v in values(payload) if v in ids], [])
        long = payload["positions"][0]
        self.assertAlmostEqual(long["r"], -1.0)
        # MAE: entry 1.1000, lowest 1.0900 -> 0.0100 = 2R; MFE: 1.2100 - 1.1000 = 0.1100 = 22R
        self.assertAlmostEqual(long["maeR"], 2.0)
        self.assertAlmostEqual(long["mfeR"], 22.0)
        self.assertEqual(long["duration"], 3600)


if __name__ == "__main__":
    unittest.main()
