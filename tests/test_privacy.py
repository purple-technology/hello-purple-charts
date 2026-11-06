"""Nothing about money or the account may reach the page.

Uses made-up deals and candles (no terminal needed) and checks that the
data sent to the browser contains only prices, times, volumes and
buy/sell directions.
"""

import json
import unittest
from contextlib import contextmanager
from unittest import mock

import chartlogic
import server

FAKE_DEALS = [
    # A deposit (type 2 = balance): must disappear completely.
    {"ticket": 1, "order": 0, "time": 1_000, "type": 2, "entry": 0, "volume": 0.0,
     "price": 0.0, "profit": 10_000.0, "commission": 0.0, "swap": 0.0, "fee": 0.0,
     "symbol": "", "comment": "Deposit", "magic": 0, "position_id": 0},
    {"ticket": 2, "order": 11, "time": 7_300, "type": 0, "entry": 0, "volume": 0.5,
     "price": 1.1012, "profit": 0.0, "commission": -3.5, "swap": 0.0, "fee": 0.0,
     "symbol": "EURUSD", "comment": "secret note", "magic": 0, "position_id": 99},
    {"ticket": 3, "order": 12, "time": 10_900, "type": 1, "entry": 1, "volume": 0.5,
     "price": 1.1040, "profit": 140.0, "commission": -3.5, "swap": -1.2, "fee": 0.0,
     "symbol": "EURUSD", "comment": "[tp 1.1040]", "magic": 0, "position_id": 99},
]

FAKE_CANDLES = [
    {"time": t, "open": 1.10, "high": 1.11, "low": 1.09, "close": 1.10 + i / 1000,
     "volume": 100 + i, "spread": 12}
    for i, t in enumerate(range(0, 3600 * 30, 3600))
]

FAKE_SYMBOLS = [
    {"name": "EURUSD", "group": "Forex", "digits": 5},
    {"name": "GBPUSD", "group": "Forex", "digits": 5},
    {"name": "US500", "group": "Indices", "digits": 2},
]

ALLOWED_KEYS = {
    "symbol", "timeframe", "barSeconds", "digits", "candles", "volume", "trades",
    "time", "open", "high", "low", "close", "value", "up", "spread",
    "price", "side", "entry", "barTime",
}


def all_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from all_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from all_keys(v)


@contextmanager
def no_terminal():
    yield


class Privacy(unittest.TestCase):

    def test_shape_trades_drops_money_and_balance_deals(self):
        trades = chartlogic.shape_trades(FAKE_DEALS)
        self.assertEqual(trades, [
            {"time": 7_300, "price": 1.1012, "volume": 0.5, "side": "buy", "entry": "entry"},
            {"time": 10_900, "price": 1.1040, "volume": 0.5, "side": "sell", "entry": "exit"},
        ])

    def test_trades_snap_to_the_candle_they_happened_in(self):
        trades = chartlogic.shape_trades(FAKE_DEALS)
        snapped = chartlogic.snap_trades_to_bars(trades, [3600, 7200, 10800])
        self.assertEqual([t["barTime"] for t in snapped], [7200, 10800])
        # A trade before the first loaded candle is left out.
        self.assertEqual(chartlogic.snap_trades_to_bars(trades, [8000]), [
            {**trades[1], "barTime": 8000}])

    def test_candles_needed_reaches_first_trade(self):
        day = 86400
        # 100 days of H1 = 2400 candles, +50 context
        self.assertEqual(chartlogic.candles_needed(0, 100 * day, 3600, 1500, 60000), 2450)
        # Recent trade: the minimum still applies
        self.assertEqual(chartlogic.candles_needed(0, 2 * day, 3600, 1500, 60000), 1500)
        # Very old trade: capped at the maximum
        self.assertEqual(chartlogic.candles_needed(0, 5000 * day, 900, 1500, 60000), 60000)
        # No trades at all
        self.assertEqual(chartlogic.candles_needed(None, 0, 3600, 1500, 60000), 1500)

    def test_symbol_list_ignores_deposits(self):
        self.assertEqual(chartlogic.traded_symbols(FAKE_DEALS), ["EURUSD"])

    def test_page_data_contains_no_money_or_account_fields(self):
        with mock.patch.object(server.mt5_reader, "connection", no_terminal), \
             mock.patch.object(server.mt5_reader, "read_deals", lambda: FAKE_DEALS), \
             mock.patch.object(server.mt5_reader, "read_candles",
                               lambda s, tf, n: FAKE_CANDLES), \
             mock.patch.object(server.mt5_reader, "read_symbols", lambda: FAKE_SYMBOLS):
            payload = server.chart_payload("EURUSD", "H1")
            symbols = server.symbols_payload()

        self.assertEqual(set(all_keys(payload)) - ALLOWED_KEYS, set())
        self.assertEqual(set(all_keys(symbols)),
                         {"symbols", "timeframes", "name", "group", "traded"})
        self.assertEqual([(s["name"], s["traded"]) for s in symbols["symbols"]],
                         [("EURUSD", True), ("GBPUSD", False), ("US500", False)])
        text = json.dumps([payload, symbols]).lower()
        for word in ("profit", "commission", "swap", "fee", "balance", "deposit",
                     "comment", "secret", "ticket", "login", "account", "server"):
            self.assertNotIn(word, text)
        self.assertEqual(len(payload["trades"]), 2)
        self.assertEqual(payload["barSeconds"], 3600)

    def _patched(self):
        return [
            mock.patch.object(server.mt5_reader, "connection", no_terminal),
            mock.patch.object(server.mt5_reader, "read_deals", lambda: FAKE_DEALS),
            mock.patch.object(server.mt5_reader, "read_candles", lambda s, tf, n: FAKE_CANDLES),
            mock.patch.object(server.mt5_reader, "read_symbols", lambda: FAKE_SYMBOLS),
        ]

    def test_untraded_symbol_works_without_markers(self):
        patches = self._patched()
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        self.assertEqual(server.chart_payload("GBPUSD", "H1")["trades"], [])

    def test_unknown_symbol_is_refused(self):
        patches = self._patched()
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        with self.assertRaises(ValueError):
            server.chart_payload("NOTREAL", "H1")

    def test_server_listens_on_loopback_only(self):
        self.assertEqual(server.HOST, "127.0.0.1")

    def test_second_server_cannot_take_over_the_port(self):
        first = server.ExclusiveHTTPServer(("127.0.0.1", 0), server.Handler)
        try:
            port = first.server_address[1]
            with self.assertRaises(OSError):
                server.ExclusiveHTTPServer(("127.0.0.1", port), server.Handler)
        finally:
            first.server_close()


if __name__ == "__main__":
    unittest.main()
