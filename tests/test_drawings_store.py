"""Saving drawings: only clean, valid drawings ever reach the file."""

import json
import tempfile
import unittest
from pathlib import Path

import drawings_store as store

TREND = {"id": "d1", "type": "trend", "color": "#2F8CFF",
         "points": [{"time": 1_700_000_000, "price": 1.1}, {"time": 1_700_360_000, "price": 1.2}]}
HLINE = {"id": "d2", "type": "hline", "color": "#ffca28",
         "points": [{"time": 1_700_000_000, "price": 1.15}]}


class DrawingsStore(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "data" / "drawings.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_and_load_per_symbol(self):
        store.save("EURUSD", [TREND, HLINE], self.file)
        store.save("XAUUSD", [HLINE], self.file)
        self.assertEqual(len(store.load("EURUSD", self.file)), 2)
        self.assertEqual(store.load("XAUUSD", self.file)[0]["id"], "d2")
        self.assertEqual(store.load("GBPUSD", self.file), [])

    def test_unknown_fields_are_dropped_and_colour_lowercased(self):
        extra = dict(TREND, note="hello", profit=123)
        saved = store.save("EURUSD", [extra], self.file)
        self.assertEqual(set(saved[0]), {"id", "type", "color", "points"})
        self.assertEqual(saved[0]["color"], "#2f8cff")
        self.assertNotIn("profit", self.file.read_text(encoding="utf-8"))

    def test_saving_an_empty_list_removes_the_symbol(self):
        store.save("EURUSD", [TREND], self.file)
        store.save("EURUSD", [], self.file)
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8")), {})

    def test_bad_drawings_are_refused(self):
        bad = [
            "not a list",
            [dict(TREND, type="script")],
            [dict(TREND, id="<b>x</b>")],
            [dict(TREND, color="red; background:url(x)")],
            [dict(TREND, points=[TREND["points"][0]])],            # trend needs 2 points
            [dict(HLINE, points=[{"time": 1, "price": float("nan")}])],
            [dict(HLINE, points=[{"time": -5, "price": 1.0}])],
            [dict(HLINE, points=[{"time": True, "price": 1.0}])],
            [dict(HLINE, id=f"x{i}") for i in range(store.MAX_DRAWINGS_PER_SYMBOL + 1)],
        ]
        for drawings in bad:
            with self.subTest(drawings=str(drawings)[:60]):
                with self.assertRaises(store.InvalidDrawings):
                    store.save("EURUSD", drawings, self.file)
        self.assertFalse(self.file.exists())

    def test_bad_symbol_is_refused(self):
        with self.assertRaises(store.InvalidDrawings):
            store.save("", [TREND], self.file)
        with self.assertRaises(store.InvalidDrawings):
            store.load("A\nB", self.file)

    def test_damaged_file_does_not_crash(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text("{ this is not json", encoding="utf-8")
        self.assertEqual(store.load("EURUSD", self.file), [])
        store.save("EURUSD", [TREND], self.file)  # overwrites the damaged file
        self.assertEqual(len(store.load("EURUSD", self.file)), 1)


if __name__ == "__main__":
    unittest.main()
