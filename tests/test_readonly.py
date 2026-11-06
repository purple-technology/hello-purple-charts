"""Safety guard: the project may only READ from MetaTrader 5.

Fails as soon as any code in the project contains a function that can
place, change or close an order (order_send, order_check, Buy, Sell,
Close, ...), or uses MetaTrader 5 in any way other than the short list of
read-only calls below.

This file itself is the only file not scanned, because it has to name the
forbidden functions in order to look for them.
"""

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THIS_FILE = Path(__file__).resolve()
SKIP_DIRS = {".venv", "node_modules", ".claude", "__pycache__", ".git"}
CODE_SUFFIXES = {".py", ".js", ".mjs", ".html", ".cmd", ".bat", ".ps1"}

# Functions that send, check or close orders, or reveal/change the account.
# A bare mention anywhere (code, string or comment) fails the test.
FORBIDDEN_NAMES = re.compile(
    r"\b(order_send|order_check|order_calc_margin|order_calc_profit"
    r"|account_info|symbol_select|market_book_add)\b"
)
# Package shortcuts that place/close orders, or log in with credentials.
FORBIDDEN_CALLS = re.compile(r"\b(Buy|Sell|Close|login)\s*\(")

# The only MetaTrader 5 functions the code may call.
ALLOWED_MT5_FUNCTIONS = {
    "initialize", "shutdown", "last_error",
    "symbols_get",
    "copy_rates_from_pos", "copy_rates_from", "copy_rates_range",
    "history_deals_get",
    # Added in part 3 with the user's approval (both only read history):
    "history_orders_get",   # the stop-loss of each opening order, for R-multiples
    "copy_ticks_range",     # bid/ask ticks, for spread, slippage and second charts
}
CONSTANT = re.compile(r"^[A-Z][A-Z0-9_]*$")  # e.g. TIMEFRAME_H1
MT5_FILE = "mt5_reader.py"


def project_code_files():
    for path in sorted(ROOT.rglob("*")):
        if path.resolve() == THIS_FILE or not path.is_file():
            continue
        if SKIP_DIRS.intersection(path.relative_to(ROOT).parts):
            continue
        if path.suffix.lower() in CODE_SUFFIXES:
            yield path


class ReadOnlyGuard(unittest.TestCase):

    def test_scanner_finds_the_code(self):
        names = {p.name for p in project_code_files()}
        for expected in ("mt5_reader.py", "server.py", "chartlogic.py", "app.js"):
            self.assertIn(expected, names)

    def test_no_order_functions_anywhere(self):
        problems = []
        for path in project_code_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for n, line in enumerate(text.splitlines(), 1):
                if FORBIDDEN_NAMES.search(line) or FORBIDDEN_CALLS.search(line):
                    problems.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()}")
        self.assertEqual(problems, [], "Forbidden trading/account function found:\n"
                         + "\n".join(problems))

    def test_only_allowed_mt5_calls(self):
        problems = []
        for path in project_code_files():
            if path.suffix != ".py":
                continue
            rel = path.relative_to(ROOT)
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(rel))
            aliases = set()
            for node in ast.walk(tree):
                # Dynamic imports could hide anything: not allowed at all.
                if isinstance(node, ast.Name) and node.id in ("__import__", "importlib"):
                    problems.append(f"{rel}:{node.lineno}: dynamic import")
                if isinstance(node, ast.Import):
                    for a in node.names:
                        if a.name == "importlib":
                            problems.append(f"{rel}:{node.lineno}: importlib")
                        if a.name.split(".")[0] == "MetaTrader5":
                            if path.name != MT5_FILE:
                                problems.append(f"{rel}:{node.lineno}: MetaTrader5 "
                                                f"may only be imported in {MT5_FILE}")
                            aliases.add(a.asname or a.name)
                if isinstance(node, ast.ImportFrom) and node.module and (
                        node.module.split(".")[0] in ("MetaTrader5", "importlib")):
                    problems.append(f"{rel}:{node.lineno}: 'from {node.module} import' "
                                    "is not allowed")
            if not aliases:
                continue
            # Every use of the MT5 module must be `mt5.<allowed name>`.
            attr_parents = {id(n.value) for n in ast.walk(tree)
                            if isinstance(n, ast.Attribute)}
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                        and node.value.id in aliases:
                    if node.attr not in ALLOWED_MT5_FUNCTIONS and not CONSTANT.match(node.attr):
                        problems.append(f"{rel}:{node.lineno}: mt5.{node.attr} is not "
                                        "on the read-only list")
                elif isinstance(node, ast.Name) and node.id in aliases \
                        and id(node) not in attr_parents:
                    # e.g. getattr(mt5, "...") or passing the module around
                    problems.append(f"{rel}:{node.lineno}: indirect use of the "
                                    "MetaTrader5 module")
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
