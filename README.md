# Hello Purple Charts

A charting platform that runs only on your own Windows computer, reads your MetaTrader 5 terminal and shows your own trades on the chart. It was built with an AI coding agent for the Hello Purple article [Your own charting platform, built by an agent, on your broker's data](https://hello-purple.com/reports/build-your-own-charting-platform/), and it's meant as a base for you to build on.

## What it does

- Candlestick charts on every MT5 timeframe from 5 seconds to a month, for every symbol your broker offers, with volume, SMA, EMA, Bollinger Bands, RSI, MACD and the broker's spread.
- Drawing tools (trend line, horizontal line, box, eraser), up to four linked charts, alerts while the page is open and CSV export.
- Your own MT5 trades drawn automatically: entry, exit, risk to the stop loss, target and the result in R.
- A journal next to the chart with statistics in R (never in money), a replay that shows your trades at the moment you took them, and spread and slippage for every fill.

## Safety rules (keep them when you build on it)

- **Read-only.** The code may only read from MT5. `tests/test_readonly.py` fails as soon as any function that can place, change or close an order appears anywhere in the code, including disguised calls. Run the tests after every change.
- **No secrets.** It attaches to the MT5 terminal that's already open and logged in. It never asks for or stores a password, account number or server name.
- **No money on screen.** The page shows prices, times, volumes, R and points, never balances or amounts, so screenshots are safe to share.
- **Local only.** The web server listens on 127.0.0.1 and nowhere else.

## What you need

- Windows with the **MetaTrader 5 desktop terminal** installed, open and logged in (the MetaTrader5 Python package doesn't work with the web terminal or on Mac/Linux).
- **Python 3.13** (the MetaTrader5 package often supports new Python versions late).
- **Node.js** 20 or newer.

## Install and start

Open PowerShell in this folder and run:

```
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
npm ci
.\start.cmd
```

Your browser opens at http://127.0.0.1:8765. Stop it with Ctrl+C. Run the tests with `.\run-tests.cmd`. To use another port, set `HP_CHART_PORT` first.

The first time you open a symbol, MT5 may need a while to download its history.

## Building on it with a coding agent

1. Open this folder with your coding agent (for example Claude Code).
2. Install TradingView's official agent skill for the chart library: `npx skills add tradingview/lightweight-charts`. It contains two skills, one for the chart API and one for writing plugins such as drawing tools or new chart types.
3. Ask the agent to read `BUILD_NOTES.md` first. It explains every step of the build and every problem that came up, in plain English.
4. Ask for one feature at a time, check the result against your MT5 terminal, and run `.\run-tests.cmd` after every change.
5. If a feature needs something new from MT5, make sure it's a function that only reads, add it to the allowed list in `tests/test_readonly.py` on purpose, and say why in a comment.

Ideas from the article: footprint charts, TPO and volume profile, a read-only DOM, smart money concepts, session boxes, manual backtesting, a position size calculator, funded-account limits, setup tags and a weekly review.

## Files

| File | What it does |
|---|---|
| `start.cmd` / `run-tests.cmd` | Start the platform / run all tests |
| `server.py` | Local web server (127.0.0.1 only) |
| `mt5_reader.py` | The only file that talks to MT5 (read-only) |
| `chartlogic.py` | Trades, positions, R, MAE/MFE, slippage, second candles |
| `drawings_store.py`, `local_store.py` | Validate and save drawings, alerts and manual stops in `data/` |
| `static/` | The page: charts, journal, replay, indicators, drawing tools, themes |
| `tests/` | Read-only guard, privacy, storage and journal tests (Python), indicator and tool tests (JavaScript) |
| `data/` | Your own drawings, alerts, stops and journal cache; never shared |

## Licence

Apache License 2.0, see `LICENSE` and `NOTICE`. The chart library is TradingView Lightweight Charts™ (Apache 2.0); its attribution logo on the chart and the notice in the footer must stay visible.

Nothing in this project is investment advice.
