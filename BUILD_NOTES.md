# Build notes: my own MT5 charting platform

Plain-English log of how this project was built on 6 November 2026: every step, every problem, and what the TradingView agent skill contributed.

## What it is

A web page that runs only on this computer. It shows candlestick charts from my MetaTrader 5 terminal for every symbol my broker offers, on nine timeframes (M1 to MN1), with volume underneath, my own buy and sell deals drawn as arrows, five indicators (SMA, EMA, Bollinger Bands, RSI, MACD) and drawing tools (trend line, horizontal line, box, eraser). It only reads from MetaTrader 5. It cannot trade, and it shows no account number, balance or money amounts.

Part 1 (below) built the first version: one moving average and only the symbols I've traded. Part 2 added the extra features. Part 3 added what TradingView itself can't do or charges for: a trade journal on the chart (MAE/MFE, R-multiples, statistics on my own behaviour), replay of my own trades, ticks and spread (second charts, spread, slippage per fill), and "no limits" (any number of indicators, 1–4 linked charts, CSV export, local alerts).

**Start it:** open PowerShell in the project folder and run

```
.\start.cmd
```

The browser opens at http://127.0.0.1:8765. Stop it with Ctrl+C. (Double-clicking `start.cmd` in Explorer works too.)

**Run the tests:** `.\run-tests.cmd`

**Bookmark a chart:** `http://127.0.0.1:8765/?symbol=BTCUSD&tf=H4`

---

## The steps

### Step 1: Check the computer
The folder was empty. Node.js 24 (needed for the skill installer and the chart library) and two Python versions (3.13 and 3.14) were already installed.

### Step 2: Install TradingView's official agent skill
Command: `npx skills add tradingview/lightweight-charts`.
- The package contains two skills: `lightweight-charts` (general use) and `lightweight-charts-plugin-authoring` (for writing plugins). I only needed the first one, so I installed just that: `--skill lightweight-charts --agent claude-code -y --copy`. It landed in `.claude/skills/lightweight-charts/SKILL.md`, and the installer wrote `skills-lock.json` to record exactly which version was installed.
- The installer showed a security summary: "Safe" from two scanners and "Med Risk" from a third, plus the reminder that skills run with the agent's full permissions. So I read the whole skill file (517 lines) before using it. It turned out to be documentation only, with no scripts, so it couldn't run anything by itself.

### Step 3: Create an isolated Python environment for MT5
- `py -3.13 -m venv .venv`, then `pip install MetaTrader5` inside it (version 5.0.6231, plus numpy, which it needs). I chose Python 3.13 rather than 3.14 because the MetaTrader5 package usually supports new Python versions late.
- I listed every function in the package. Besides `order_send` and `order_check`, it also has the shortcuts `Buy`, `Sell` and `Close`, which also place orders. So the safety test forbids those too (see step 7).
- A first read-only check: `initialize()` with **no arguments** attaches to the terminal that's already open and logged in. No password, account number or server name is needed or stored anywhere. Result: the full deal history and the list of traded symbols.
- The deal history contains "type 2" deals: deposits and withdrawals. Those are pure money movements, so the code drops them.
- I checked that candles could be read for all 16 symbols without adding them to Market Watch first (that would have needed `symbol_select`, which changes the terminal). They all worked.

### Step 4: Install Lightweight Charts v5
- `npm install --save-exact lightweight-charts@5` gave version **5.2.1**, Apache-2.0 licence. The library is served from this computer, not from the internet.
- **Problem:** my first attempt to set fields in package.json with `npm pkg set ... --json` failed ("not valid JSON"). It didn't matter: I wrote package.json by hand later and marked it `"private": true`, so npm will refuse to publish it.
- Following the skill's first rule ("inspect the installed package first, don't invent API names"), I checked the installed type file for every function and option I planned to use: `createSeriesMarkers`, `attributionLogo`, `atPriceTop/atPriceBottom`, `separatorColor`, `CrosshairMode`, `setHeight`, `getVisibleRange`, and others.
- **Small puzzle:** searching the type file for `CandlestickSeries` found nothing at first. It's declared under a lower-case name (`candlestickSeries`) and exported under the capitalised name through an alias at the end of the file, so it does exist.

### Step 5: Python code (three small files)
- `mt5_reader.py`: the **only** file that touches MetaTrader 5. It uses only `initialize`, `shutdown`, `last_error`, `symbols_get` (for the symbol's number of decimals), `copy_rates_from_pos` (candles) and `history_deals_get` (closed deals). It opens and closes the connection for each request, so "Reload" still works after the terminal restarts.
- `chartlogic.py`: pure calculations with no MT5 involved, so they're easy to test:
  - `simple_moving_average`: the moving average, written by hand. It keeps a running total, adding the newest close and subtracting the one that drops out of the window.
  - `shape_trades`: keeps only buy/sell deals, and from each one only time, price, volume, direction and entry/exit. Profit, commission, swap, fee, comments and ticket numbers are thrown away here, before anything goes near the page.
  - `snap_trades_to_bars`: puts each trade on the candle it happened in (see "skill" below for why).
  - `traded_symbols`: the list for the symbol picker.
- `server.py`: a small web server built from Python's standard library, so there's nothing extra to install.
  - Listens on **127.0.0.1 only**. `netstat` confirmed `127.0.0.1:8765 LISTENING` and nothing on `0.0.0.0`.
  - Serves only a fixed list of five files; any other path gives "Not found".
  - Rejects requests whose "Host" name isn't `127.0.0.1:8765` or `localhost:8765`. This blocks a known trick (DNS rebinding) where an outside website tries to read data from servers on your own computer.
  - Accepts only symbols you have actually traded and the four timeframes.
  - Sends security headers that, among other things, allow only our own scripts to run on the page.

### Step 6: The web page
`static/index.html`, `static/app.js`, `static/style.css`:
- Symbol drop-down (your traded symbols), timeframe buttons (M15, H1, H4, D1) and a **Reload data** button. Reload keeps the part of the chart you were looking at.
- Candles plus moving average in the top pane, volume in a second pane below.
- A small readout at the top-left showing open/high/low/close and the moving average under the mouse.
- `attributionLogo: true` is set explicitly on the chart, and the footer carries the notice "TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc." with a link to https://www.tradingview.com.
- It remembers your last symbol and timeframe in the browser.

### Step 7: Tests (17 in total, all passing)
- `tests/test_moving_average.py`: the moving average against values worked out by hand, e.g. for 3,1,4,1,5,9,2,6 with period 4: (3+1+4+1)/4 = 2.25, (1+4+1+5)/4 = 2.75, and so on. Also edge cases: too few values, period 1, an invalid period.
- `tests/test_readonly.py`: the safety guard. It checks all project code in two ways:
  1. A word search: `order_send`, `order_check`, `order_calc_*`, `account_info`, `symbol_select`, `market_book_add`, or calls to `Buy(`, `Sell(`, `Close(` or `login(` anywhere means failure.
  2. A structural check of the Python code: MetaTrader5 may only be imported in `mt5_reader.py`, every `mt5.something` must be on the read-only list, and indirect tricks (like `getattr(mt5, ...)` or dynamic imports) are refused.
  The only file not scanned is the guard itself, because it has to name the forbidden functions in order to look for them.
- `tests/test_privacy.py`: feeds made-up deals (including a deposit, a profit of 140, commission and a "secret note" comment) through the real server code and checks that the data for the page contains only allowed fields and none of the words profit, commission, swap, fee, balance, deposit, comment, ticket, login, account or server. It also checks that trades land on the right candle, that unknown symbols are refused, and that the server address is 127.0.0.1.

**Proving the guard works:**
1. I added a function to `mt5_reader.py` that calls `mt5.order_send(request)` (never actually run) → the guard **failed** twice: "Forbidden trading/account function found: mt5_reader.py:48" and "mt5.order_send is not on the read-only list".
2. I replaced it with a disguised version, `getattr(mt5, "order" + "_send")(request)`, which a plain word search can't see → the guard **failed** again: "indirect use of the MetaTrader5 module".
3. I removed the code → all tests **passed**, and a search confirmed nothing was left behind.

### Step 8: Run it and check it from outside
Checks against the running server:
- Symbol list: the traded symbols only. Timeframes: M15, H1, H4, D1.
- Foreign Host name → 403 Forbidden. Unknown timeframe or untraded symbol → 400. A path like `/../server.py` → 404.
- None of the money words appear in any chart response.

### Step 9: Problems found while testing, and fixes

**Problem 1: no trade arrows on short timeframes.** EURUSD on H1 showed 0 markers. The chart loaded a fixed 1,500 candles, which is about 3 months of H1 and 2 weeks of M15, but the trades go back to March 2025.
*Fix:* for each symbol, the server now works out how many candles it needs to reach back to your first trade on that symbol (at least 1,500, at most 60,000). Afterwards every timeframe showed every trade (e.g. BTCUSD: 88 on M15, H1, H4 and D1). The heaviest chart (AUDUSD M15, about 57,000 candles, 10.9 MB) loads in about half a second. This calculation got its own test.

**Problem 2: browser check without the Chrome extension.** The Claude-in-Chrome extension wasn't connected, so I used Microsoft Edge in headless mode (an invisible window) to render the page to a screenshot, with browser messages written to a log.

**Problem 3: the TradingView logo was missing.** The browser log said: "Applying inline style violates the following Content Security Policy directive". My security header was blocking styling that the chart library adds itself, and the attribution logo was the visible casualty.
*Fix:* allow inline *styles* (scripts are still restricted to our own files). After that the logo appeared at the bottom-left of the chart and the browser log was clean.

**Problem 4: arrows hidden on candles of the same colour.** The trade arrows were green/red like the candles, so in a close-up a sell arrow on a red candle was invisible.
*Fix:* trades got their own colours (blue = buy, amber = sell, size 1.5), and the moving average became lavender so it doesn't clash with amber. The footer explains the colours.

**Check: are arrows on the right candle and price?** For several symbols and timeframes I checked that every trade price lies between the low and high of its candle. Everything matched except one EURUSD buy at 1.1148 on a candle whose high was 1.11477. That's expected: buys are filled at the **ask** price, while MT5 candles are drawn from the **bid** price, and the difference is the spread (0.3 pip).

### Step 10: Final state of part 1
- Start: `.\start.cmd`. Tests: `.\run-tests.cmd` (17 tests, all passing).
- Nothing was pushed to GitHub or put online. The folder isn't even a git repository.

---

## Part 2: more timeframes, all assets, indicators, drawing tools

The request: "add extra features such as more timeframes, indicators, more assets, drawing tools". The choices I made (all easy to change):
- **Timeframes:** all nine MT5 timeframes: M1, M5, M15, M30, H1, H4, D1, W1, MN1.
- **Assets:** every symbol the broker offers (grouped by the broker's categories), with the ones I've traded in a "★ Traded by you" group at the top.
- **Indicators:** SMA, EMA, Bollinger Bands, RSI and MACD, each on/off with adjustable periods, all calculated by hand.
- **Drawing tools:** trend line, horizontal line, box (rectangle), eraser, colour picker and "Clear". Drawings are saved per symbol and follow you across timeframes.

### Step 11: Install TradingView's second skill (plugin authoring)
- The TradingView package contains a second skill, `lightweight-charts-plugin-authoring`. Drawing on the chart canvas is what Lightweight Charts calls a "plugin", so I installed it the same way: `npx skills add tradingview/lightweight-charts --skill lightweight-charts-plugin-authoring --agent claude-code -y --copy`. Security summary: "Safe", 0 alerts, "Low Risk". I read it in full (362 lines plus three reference files): documentation only, no scripts.
- Its key advice: a drawing tool is a **series primitive**, a small drawing layer attached to the candle series. It draws in "bitmap coordinates" so lines stay sharp on high-resolution screens, gets its clicks through the chart's own events, and must clean up after itself. The skill also points to TradingView's own examples, so I read their `trend-line` and `rectangle-drawing-tool` examples on GitHub (read only, nothing installed).
- **A choice I made against the skill:** it recommends starting from the `npm create lwc-plugin` scaffold and TradingView's `lwc-toolkit` helpers. Those are aimed at building a separate, publishable plugin package with TypeScript and a build tool (Vite). This project deliberately has no build step, so I wrote the primitive as plain JavaScript following the same contract (`attached`, `detached`, `updateAllViews`, `paneViews`, a renderer that draws in `useBitmapCoordinateSpace` and restores the canvas afterwards).

### Step 12: MetaTrader 5 checks for the new features
- All five new timeframes return candles. W1 and MN1 return fewer than asked (1,389 and 321 for EURUSD), because that's all the history there is. That's fine.
- **Symbols not in Market Watch** (most of them) also return candles, without `symbol_select`, so the read-only rule still holds.
- **Problem: a check that hung.** My first combined check (8 hidden symbols plus 60,000 M1 candles) produced no output for minutes. I stopped it and repeated it in small steps with a timer per step: then everything took under a second, even 60,000 M1 candles. The likely cause: the first time a symbol is requested, the MT5 terminal downloads its history, and Python waits for that. **Practical consequence:** opening a symbol for the very first time can take a while. The status line says so ("the first time for a symbol MT5 may need to download history").

### Step 13: Indicators move to the browser (with tests)
- In part 1 the moving average was calculated in Python. Now that indicators can be switched on and off and periods changed, recalculating them in the page itself (`static/indicators.js`) is instant, with no new data request to MT5. The Python moving average was removed, and its hand-calculated test examples moved unchanged to the new JavaScript tests.
- `indicators.js` contains SMA, EMA (starting from the SMA of the first values), Bollinger Bands (population standard deviation, as MT5 and TradingView use), RSI (Wilder's method) and MACD. Each is explained in plain words in the file.
- `tests/js/indicators.test.js` (14 tests, run with Node.js's built-in test runner) checks each one against numbers worked out by hand, with the working shown in the comments. For example, RSI(2) on 1,2,3,2,3,4 gives 100, 50, 75, 87.5, and MACD(2,3,2) on 1,2,4,8,16 is checked as exact fractions (5/6, 11/9, 239/108).
- **Small problem:** `node --test tests/js` (a folder) fails in Node 24; the test command names the files instead.

### Step 14: Server changes
- `mt5_reader.py`: the nine timeframes, and `read_symbols()` (name, category, decimals) via `symbols_get`, which was already on the read-only list.
- The symbol list in the page now comes from the broker's full list, with a "traded" flag; trade arrows still come only from my own deals.
- **Saving drawings:** `drawings_store.py` keeps drawings in `data/drawings.json` in the project folder. That's a local file, not a change to MT5. Every drawing is checked strictly (type, id, colour code, number of points, times, prices; at most 300 per symbol), unknown fields are dropped, and the file is written all at once (via a temporary file), so it can never be left half-written. A damaged file doesn't crash anything.
- Saving is the server's first "write" action, so it got extra protection: it must come from our own page (the browser's `Origin` header), must be JSON and must be small. Tested from outside: from another website → 403, without a sender → 403, as a form → 415, an invalid drawing → 400.
- `tests/test_drawings_store.py` (6 tests) covers this, including made-up attacks such as a colour containing CSS or a drawing type "script".

### Step 15: Drawing tools
- `static/drawmath.js`: the arithmetic, with no chart library involved, tested in `tests/js/drawmath.test.js` (8 tests).
- **Drawings follow you across timeframes.** TradingView's examples store a candle's exact time and look it up with `timeToCoordinate`. That fails as soon as you switch timeframe: an H1 time like 14:00 doesn't exist on D1. So drawings are stored as real time + price, and converted into a "logical index" for drawing: 0 = first candle, 2.5 = halfway between the third and fourth, and beyond the last candle we keep counting in timeframe steps.
- Horizontal lines use the library's own `createPriceLine`, which also puts a price label on the axis.
- The eraser measures how close a click is to each drawing (within 6 pixels for lines, inside a box).
- "Clear" asks for confirmation with a second click instead of a pop-up window.

### Step 16: Testing in the browser, and the bugs it found
The Chrome extension still wasn't connected. This time I wrote a small test script that controls an invisible Edge window through its built-in remote-control interface (the "DevTools Protocol", which automated browser tests also use). It really clicks with the mouse, takes screenshots and collects browser errors. The script lives outside the project, in a temporary folder.

**Bug A: fast clicks were lost.** I drew a trend line, a box and a horizontal line, but only the trend line was saved. Measured: the chart's click report (`subscribeClick`) passes on **only the first of two clicks made within about half a second**, even when they're 200 pixels apart (150 ms gap: 1 click reported; 350 ms: 1; 600 ms: 2). Anyone drawing a box quickly would lose a corner.
*Fix:* the drawing tools listen to the mouse button directly (`pointerdown`/`pointerup` on the chart) and take the position from the chart's mouse-move report, which is always up to date and includes the pane. A mouse movement of more than 5 pixels between pressing and releasing counts as a drag (scrolling), not a click. Re-tested with 150 ms between clicks: all three drawings saved; dragging adds no point.

**Bug B: trend line in the wrong place after a timeframe switch.** A line drawn on H4 (Oct 18 → Oct 27, rising) appeared on D1 starting far before July and sloping down. The saved data was correct, so I temporarily exposed the chart objects and checked the conversion step by step: `logicalToCoordinate(1489.83)` returned **0**, the left edge of the chart. That function only works with whole candle numbers; with a fraction it silently returns 0. This isn't in the type file, and TradingView's own examples never pass fractions.
*Fix:* compute the screen positions of the two neighbouring whole candles and interpolate between them. After that the line on D1 runs neatly from Oct 18 to between Oct 27 and 28.

**Bug C: trade arrows ~200 candles off after a timeframe switch.** On D1, arrows hung far from their candles: two March trades showed up in September. The prices were right, the dates weren't. Cause: on a switch, the old indicator lines still held H4 data while the new D1 candles were already loaded, so for a moment the chart's time axis was a mix of both. I set the arrows at that moment, and the arrow layer remembers candle positions. After the old lines were removed, every position was shifted.
*Fix:* first remove the old indicator lines, then load the candles, then build the indicators, and only then set the arrows (`applyTradeMarkers`, always last). On D1 every arrow now sits on its own candle.

**Bug D: squeezed panes.** With RSI and MACD on, the volume and RSI panes were only 31 pixels high. Each `setHeight` call took space from the neighbouring pane.
*Fix:* proportions instead of pixels, with the library's `setStretchFactor`: price 6, volume 1, RSI and MACD 1.5 each. Result: 453/76/113/113 pixels, and that holds when the window is resized. Switching RSI/MACD off removes their panes automatically (back to price + volume).

**Bug E: two servers on the same port.** During testing, my requests went to an **old** server that was still running, even though I'd started a new one. Both were listening on 127.0.0.1:8765. Python's standard web server switches on `SO_REUSEADDR` by default, and on Windows that lets a second program claim the same port. I confirmed this with a separate test. That's a weakness too: another program could take over requests.
*Fix:* the server now claims the port exclusively (`SO_EXCLUSIVEADDRUSE`). A second start gives a clear message ("Port 8765 is already in use: the chart is probably already running"). There's a test for it.

**Small things:** the browser asked for a `favicon.ico` (tab icon), which gave a 404 in the browser log, so I added a small candle icon. After finishing a drawing, the tip stayed in the status line; it now goes back to the normal status.

### Step 17: Final state of part 2
- **Tests:** 18 Python tests (read-only guard, privacy, drawing storage) and 22 JavaScript tests (indicators, drawing arithmetic), all passing via `.\run-tests.cmd`.
- **Read-only guard:** it automatically scans the new files too (`drawings_store.py`, `drawings.js`, `indicators.js`, ...).
- **Browser test:** load, indicators on, fast drawing, eraser, timeframe switches, indicators off, page reload (settings and drawings come back) and a never-traded symbol (CHFJPY) all work, with no errors in the browser log.
- **Clean-up:** the drawings left by my tests were removed and the temporary debug hook was taken out of the code.
- Still nothing pushed to GitHub or put online.

---

## Part 3: what TradingView can't do (or charges for)

First a brainstorm: where does this platform fall short of TradingView, and what can it do that TradingView can't? Conclusion: don't compete on breadth (data, community scripts, mobile app), build on what only this platform has: your own MT5 trades, your broker's exact data, Python, no limits. The choice:
1. **Trade journal on the chart:** entry-exit lines, MAE/MFE, R-multiples and statistics on my own behaviour.
2. **Replay of my own trades:** candle by candle, with my trades appearing when they happened.
3. **Ticks and spread:** second charts, a spread pane, and spread and slippage per fill.
4. **No limits:** any number of indicators, several linked charts, CSV export, local alerts.

### Step 18: Two more MT5 read functions, with permission
- R-multiples need the stop-loss of each trade, which lives in the **order history** (`history_orders_get`). Ticks need `copy_ticks_range`. Both only **read** history. I asked for permission first; the user chose the features that need them, which I took as a yes (and said so).
- The safety guard's allowed list got those two names, each with a comment explaining why. Proven again: a temporary file calling `order_check` and `positions_get` made the guard fail three times (forbidden import location, two forbidden functions). After deleting it, everything was green.

### Step 19: What MT5 gives (counts only, no account data)
- Every position had exactly 1 entry and 1 exit; no open positions.
- For almost every position the opening order carries a stop-loss → R works almost everywhere. For the others you can enter the stop yourself in the journal ("set stop"), saved in `data/journal_stops.json`.
- Deals record **why** a position closed: stop-loss, take-profit or by hand.
- **Ticks** exist even around the oldest trade (March 2025).

### Step 20: The journal calculations (Python, `chartlogic.py`)
- **Positions** from deals: entry and exit (volume-weighted when scaling in/out), direction, stop and target from the opening order, exit reason. The key of a position is `symbol|entry time|direction`: **no broker ticket numbers** leave the server.
- **Result:** price movement, percent and R (= movement ÷ distance from entry to stop). Never money.
- **MAE/MFE:** the worst and best point during the trade, from the finest candles available (M1, otherwise M5/M15/H1; older trades often only have M5).
- **Spread and slippage per fill**, and **second candles** from ticks.
- The first time, this took **87 seconds** (MT5 downloading history around each trade). After that it's cached: first in memory, then also in `data/journal_cache.json` (prices and points only), so a restart costs 0.05 s instead of minutes again.

**Problem: 11 trades whose result fell outside their own MAE/MFE.** That's impossible, so I looked at them. Almost all were **short positions closed by a stop-loss**, exceeding the range by exactly the spread (on an index CFD: 86–186 points). Cause: a short is closed at the **ask**, but candles are **bid** prices. *Fix:* a price you actually got filled at always counts within the range (MAE at least the realised loss, MFE at least the realised gain). Afterwards: 0 outliers.

**Problem: slippage of −1650 points on a BTCUSD buy.** I printed the ticks around that fill: the tick with exactly the fill price is timestamped **3 ms after** the fill; in another case the matching tick is **140 ms before** it. Tick and fill timestamps don't line up exactly, so "the tick at that moment" is unreliable in fast markets. *Fix:* slippage is measured against **the price requested on the order** (limit price, stop level, take-profit, or the price when you clicked), which is how MT5 itself defines slippage. Ticks are only used for the spread (closest tick) and as a fallback. Result: 194 of the 240 fills measured against the order price. Finding: **52 of my 61 stop-loss exits were filled worse than the stop level** (median 60 points).

Tests (`tests/test_journal.py`, 18 tests): positions, R, scaling in, MAE/MFE (including the bid/ask case), slippage (order price and tick fallback), second candles, alert/stop storage, and a privacy test proving no ticket, order or position number and no money field ends up in the journal.

**Two flaws in my own tests**, caught before they mattered: my check for "the number 50000 doesn't appear" also matched inside a float (0.010000000…), and the same happened with "800000". Replaced with a check that walks through every value in the data and compares it against the real ticket numbers.

### Step 21: Statistics, alerts, export, replay arithmetic (JavaScript, with tests)
- `static/stats.js`: win rate, average R (expectancy), profit factor in R, average MAE/MFE, how much of the best price winners kept ("move captured"), how often a trade that had been 1R in profit still ended at a loss, results per hour/weekday/symbol/direction/exit, and behaviour: trades opened within an hour of a loss, position size after a loss vs after a win (relative to the usual size per symbol), longest streaks. 7 tests on a small made-up trade list, worked out by hand.
- `static/alerts.js`: an alert fires only on a **crossing** (the condition was false at the previous check and is true now). An alert set "above 1.20" while price is already 1.21 therefore doesn't fire straight away. 5 tests.
- `static/csv.js`: CSV export. Text starting with `=`, `+`, `-` or `@` gets an apostrophe, so Excel can never run it as a formula ("CSV injection"). 3 tests.
- Replay: `completedBarCount` counts only **closed** candles, so replay never shows an unfinished candle from the future. 1 test.
- The **dataviz** skill was used for the bar charts in the statistics panel. Its validator was run on the green/red pair against the dark background: all checks pass, including colour-blindness separation (ΔE 11.6, target ≥ 8). The bars also point up/down from a zero line, so colour is never the only cue.

### Step 22: The page rebuilt around a "chart building block"
- `static/chartview.js`: one complete chart (candles, volume, indicators, trade arrows, drawings, position layer, replay, CSV). The page (`app.js`, the "hub") shows **1, 2 or 4** of them.
- **Linked charts:** changing the symbol changes it in every chart (switchable); the **crosshair is synchronised**. To prevent an endless loop between charts, only real mouse movement is passed on (`sourceEvent` is present only then, verified in the type file).
- **Any number of indicators**, plus a new one: **Spread** (the broker's spread per candle, straight from MT5). Settings from the previous version are carried over automatically.
- `static/tradelines.js`: a series primitive drawing each position: dashed entry→exit line, faint red risk band (entry→stop), green target band (entry→TP) and the R at the exit. Similar to TradingView's long/short tool, but filled in automatically from your real trades.
- `static/journal.js`: side panel with Trades (click = show on the chart), Statistics and Execution.
- **Replay:** click "Replay", click the starting point on a chart, then play/pause/step/back/"next trade". The chart with the **shortest candles drives** it; higher timeframes only move when one of their candles has fully closed. Indicators are computed on all data but only shown up to the replay time; each value only uses the past, so nothing leaks from the future. Replay only adds new candles (`series.update`, as the skill recommends) instead of redrawing everything.
- **Second charts** S5/S15/S30 from ticks (last 4 hours), with seconds on the time axis.
- **Alerts** (price or RSI above/below, once or repeating): checked every 15 seconds while the page is open, as a Windows notification via the browser, a message on the page and a beep. Saved in `data/alerts.json`.
- **Export:** chart data (candles + all visible indicators) and the journal as CSV, without money amounts.

### Step 23: Testing, and what it found
**Problem: "the chart is already running".** My test server wouldn't start: port 8765 was taken by a server that was still running from an earlier round. The exclusive port claim (bug E of part 2) worked exactly as intended. I didn't stop that process, to avoid cutting off the user's session. Instead the port can now be set via `HP_CHART_PORT`, and I tested on port 8766. **Important:** that running server still has the old server code, so it has to be restarted once (Ctrl+C, then `.\start.cmd`).

Browser test (headless Edge via the DevTools Protocol, as in part 2), with no errors in the browser log:
- **Journal:** every position listed; clicking a row shows the trade on the chart.
- **Manual stop:** set it → R appears; remove it → back to no R.
- **Indicators and layout:** RSI, Spread and an extra SMA added (pane heights 422/70/105/106). Four charts BTCUSD H4/H1/M15/M5 with synchronised crosshair.
- **Replay:** driven by M5; after 5 steps H4 stays put (no new H4 candle closed); "next trade" jumps to 16:45; the entry arrow appears on M15/M5 but not yet on H1/H4 (that candle hasn't closed); ending replay restores everything.
- **S15:** 955 candles over 4 hours, with a spread pane that really moves (~107 points, peaks ~220).
- **Alert:** fired exactly once (message + sound), switched itself off, and was saved that way on the server.
- **CSV:** both files contain prices, times, R and points, and no money words.
- **Drawing tools:** they still work inside the new building block (fast drawing, eraser, shared between two charts of the same symbol).

Small fixes from the screenshots: the replay bar stayed visible when replay was off (a CSS `display` rule overrode the `hidden` attribute: one global rule fixes it), the replay time wasn't cleared, second charts needed seconds on the time axis, and "1 trades" became "1 trade".

### Step 24: Final state of part 3
- **Tests:** 36 Python + 38 JavaScript, all passing via `.\run-tests.cmd`.
- **Data:** `data/` contains no test leftovers (empty alerts, drawings and stops); only the journal cache stays.
- **Debug access:** `window.__hub` stays in the page, so state can be inspected in the browser console. It's purely local.
- Still nothing pushed to GitHub or put online.

**Known limits**
- **Alerts** only run while the page is open; there's no server that checks when the PC is off.
- **MAE/MFE** for older trades come from M5/M15 candles (no M1 history) and are slightly coarser.
- **Second charts** cover only the last 4 hours.
- **Reversals** (one deal that closes and opens at once) aren't supported in the journal; there are none in this history.
- **Slippage** against the order price can show large "improvements" for limit orders when the market jumps past the limit. That's how MT5 counts it.
- **Replay** shows your own drawings, even ones made later.

---

## Part 4: the Hello Purple look

The request: "use the Hello Purple design skill to brand the charts in the style of Hello Purple and make it look more attractive. It looks like a TradingView copy now, and we want a unique charting platform of our own."

### Step 25: Where the brand comes from
- The installed **Hello Purple skill** (`hello-purple-publishing`) is mainly about writing and publishing articles. Its references contain no colour codes or fonts, but its **hero-plate renderer** does: the brand draws a small chart as a **dot matrix on a 24 px grid**, with blue-violet `rgb(124,58,237)` for the structure and pastel orange `rgb(255,158,100)` for the "hot" data series. Its code mentions "three brand colours"; the third wasn't in the skill.
- So I didn't guess. I read the **public site hello-purple.com** (read only: HTML and its stylesheets, saved in a scratch folder, nothing executed). Its own design system has a complete set of `--hp-*` variables: cream paper `#FDF8E8` as the page and theme colour, midnight berry `#2A1B4E` as ink, blue-violet `#7C3AED`, pastel orange `#FF9E64`, a cool lavender **graph surface** `#F7F7FE`, square blocks (radius 0), 6 px controls, pill buttons, **no shadows**, 1.5 px borders, a 24 px grid unit, and two typefaces: *Greycliff CF* (sans) and *Castoro* (serif, used as an accent).
- A screenshot of the site showed how it's used: a cream nav bar with a serif wordmark, a midnight-berry band with a faint grid and a violet/orange dot matrix, one headline word in a violet serif, pill buttons, and small uppercase "eyebrow" labels between hairlines.

### Step 26: Colours checked, not eyeballed
The dataviz skill's validator was run against each theme's chart surface:
- The brand's pastel colours **fail** as thin lines on cream (contrast below 3:1) and fall outside the lightness band on the dark background. So the chart uses the nearest **passing** steps from the brand's own ramps (orange-600 `#C85E38`, a deeper indigo `#5D5AD8`, violet-500 `#8B5CF6` on dark).
- Key finding: **the brand has exactly two hues that stay apart for every reader** (indigo/violet and orange). A third violet next to the first is indistinguishable even with normal colour vision (ΔE 7.9, the floor is 15). Following the skill's rule (never invent a hue), indicators alternate those two hues and change **line style** from the third one on (solid, dashed, dotted), with a line sample beside each legend label.
- The journal's positive/negative bars (violet / orange-600) pass on cream and on midnight berry.

### Step 27: The design
- **Paper by default:** a cream page, charts on the lavender-white graph surface, and the grid drawn as **sparse dots** (`LineStyle.SparseDotted`): the brand's dot matrix inside the chart itself.
- **Candles in ink:** rising = hollow, falling = filled, in midnight berry (periwinkle in the dark theme). That's the biggest break from the green/red TradingView look, and direction no longer depends on colour.
- **Your trades in the brand pair:** violet ▲ buys, orange ▼ sells. Positions are drawn as a dotted path with a hollow ring at the entry and a filled dot at the exit, faint violet (target) and orange (risk) bands, and the R in a small cream pill.
- **Typography:** the site's stacks (*Greycliff CF* → system font, *Castoro* → Georgia). The serif is used as an accent, as on the site: the wordmark, the symbol name, stat-tile numbers, panel titles, the replay clock.
- **Controls:** pill buttons with a violet hairline, segmented pill groups for timeframes, theme and journal tabs, uppercase letter-spaced group labels (VIEW · STUDY · DRAW · REVIEW), square panels framed in ink with a violet top edge, no shadows.
- **The plate:** a live dot-matrix band in the top bar draws the selected chart's last 31 closes in the same grammar as the site's hero plates (faint violet grid, violet fill below the line, the line in orange, a larger violet anchor on the latest point), with a spoken description for screen readers.
- **Midnight theme:** the site's berry band instead of TradingView's black, with its own validated colours.
- **Details:** a "breathing" dot matrix while a chart loads (stops when the system asks for reduced motion), a midnight-berry replay band, alert toasts in berry with an orange edge, a new dot-matrix tab icon, and a footer key that explains the hollow/filled candles.
- **Settings:** indicator colours are now *automatic* per theme unless you pick one yourself (↺ goes back to automatic). Colours from the old design are migrated to automatic.

### Step 28: Problems and decisions
- **Fonts:** *Greycliff CF* is a commercial typeface. I did **not** copy it from the site; the page falls back to the system font (Segoe UI), and uses Greycliff automatically if it's installed on this PC. *Castoro* is open source (SIL OFL) and could be stored locally for an exact match; that needs a file download, so it's an option for the user, not something I did unasked.
- **Logo:** the wordmark is set in type like the site's (serif "hello", violet dot, "purple"); the site's logo file was not copied.
- **TradingView attribution:** unchanged and still required: the logo on the chart and the notice in the footer.
- **Layout:** in the first screenshots the top bar and toolbar wrapped onto two lines at 1400 px and the selected trade's target band dominated the chart. I moved Reload to the toolbar, made the plate and spacing more compact, and made the bands quieter.
- **A slow test run:** one test command of mine got stuck, and MT5 sometimes takes over 30 seconds to connect, which made a time-limited test run stop early. Tests now wait until a chart actually has data.

---

## What the TradingView agent skill helped with

The skill is a cheat-sheet written for AI coding agents. It saved several typical mistakes:

1. **Use version 5 syntax, not older copy-paste code.** Most examples online are for v4 (`chart.addCandlestickSeries()`, `series.setMarkers()`). The skill has a replacement table: v5 uses `chart.addSeries(CandlestickSeries, ...)` and `createSeriesMarkers(series, markers)`. All chart code uses the v5 forms.
2. **Volume in its own pane.** The skill's "price + volume" recipe: add the volume series with pane index 1 (this creates the pane), then set its height with `chart.panes()[1].setHeight(...)`.
3. **Marker times must match a candle exactly.** The skill warns that a marker whose time doesn't match an existing candle is *silently dropped*. Real trades happen at e.g. 10:37, not on the hour, so without this warning arrows would have vanished without any error. That's why `snap_trades_to_bars` attaches each trade to the candle it happened in, and the arrow is still drawn at the exact trade price using the `atPriceTop` / `atPriceBottom` positions with a `price`.
4. **Times are in seconds, not milliseconds.** MT5 already gives seconds, so they're passed through unchanged.
5. **"Don't invent API names; check the installed type file."** I checked every option against `node_modules/lightweight-charts/dist/typings.d.ts` before using it.
6. **Loading in a plain HTML page.** The skill explains that without a build tool you use the "standalone" file, which provides `window.LightweightCharts`. That kept the project free of build tools.
7. **No made-up time-zone option.** The skill says there is no `timeScale.timezone` setting. I kept the broker's server time as-is, which matches what the MT5 terminal shows, and said so in the footer.
8. **Create the chart once and use `autoSize: true`** so it follows the window size; only the data is replaced on reload.

Where the skill *didn't* settle things: the type file doesn't say exactly how `atPriceTop` and `atPriceBottom` sit relative to the price. I worked that out by rendering the chart and zooming in.

### What the second skill (plugin authoring) helped with, in part 2
9. **Choosing the right kind of plugin.** Its decision table says straight away: a drawing tool is a *series primitive*, not a "custom series", and pointer handling goes through the chart's events plus the coordinate-conversion functions. That saved a detour into the heavier construct.
10. **Sharp lines.** Draw in `useBitmapCoordinateSpace` and multiply line widths by the pixel ratio, otherwise lines blur on high-resolution screens.
11. **Clean up the canvas.** Use `save`/`restore` around your own drawing: the next layer draws on the same canvas.
12. **A missing coordinate means "skip".** If `priceToCoordinate` returns `null`, skip that point; drawing to "NaN" makes the whole line disappear. The drawing code does this.
13. **Ask for a redraw yourself** (`requestUpdate()`) after every change the chart can't see, such as a new drawing or an eraser click.
14. **Read TradingView's own examples first.** The `trend-line` and `rectangle-drawing-tool` examples gave the interaction pattern (pick a tool → click A → preview → click B).

Where the skills fell short (useful for the article):
- The examples store a candle's exact time, which goes wrong when you switch timeframe. That needed a solution of my own (bug B above).
- Two library behaviours are in neither skill nor the type file, and only surfaced in real browser tests: `logicalToCoordinate` silently returns 0 for a fraction (bug B), and `subscribeClick` passes on only the first of two quick clicks (bug A).
- The plugin skill assumes a build tool (Vite, TypeScript, `lwc-toolkit`). For a project without a build step I applied the same rules by hand.
- The first skill gives `setHeight` for pane sizes. With several panes, `setStretchFactor` (which I found in the type file) worked better (bug D).

### In part 3
15. **Incremental updates for replay:** `series.update(bar)` instead of `setData` on every step: the skill's realtime recipe, reused for replay.
16. **Primitive pattern reused:** the position layer (`tradelines.js`) follows the same contract as the drawing tools; text (the R labels) in `useMediaCoordinateSpace`, lines in bitmap space, exactly as the plugin skill prescribes.
17. **Crosshair sync with public functions only:** `setCrosshairPosition` / `clearCrosshairPosition`, with no DOM hacks (a rule from the first skill).
- The skills don't cover trading data (deals, orders, ticks, bid/ask). The two real problems of part 3 (bid candles vs ask fills, and tick/fill timestamps not lining up) only came out by checking the results against each other.

---

## Files

| File | What it does |
|---|---|
| `start.cmd` | Starts everything (one command) |
| `run-tests.cmd` | Runs all tests |
| `server.py` | Local web server, 127.0.0.1 only, port claimed exclusively (`HP_CHART_PORT` for a different port) |
| `mt5_reader.py` | The only file that talks to MT5 (read-only) |
| `chartlogic.py` | Trades, positions, R, MAE/MFE, slippage, second candles |
| `drawings_store.py` | Checks drawings and saves them in `data/drawings.json` |
| `local_store.py` | Checks and saves alerts and manual stops |
| `data/` | Your drawings, alerts, manual stops and the journal cache |
| `static/index.html`, `style.css` | The page and its layout, in Hello Purple style |
| `static/theme.js` | The two themes (Paper, Midnight): every chart colour in one place |
| `static/app.js` | The "hub": toolbar, layout, replay, alerts, export |
| `static/chartview.js` | One complete chart (the building block) |
| `static/journal.js`, `stats.js` | Journal panel and statistics |
| `static/tradelines.js` | Your positions on the chart (series primitive) |
| `static/alerts.js`, `csv.js` | Alert rules and CSV export |
| `static/indicators.js` | SMA, EMA, Bollinger, RSI, MACD (written by hand) |
| `static/drawings.js` | Drawing tools (series primitive) |
| `static/drawmath.js` | Time ↔ position, eraser distance, replay arithmetic |
| `tests/` | Read-only guard, privacy, drawing storage, journal (Python) |
| `tests/js/` | Indicators, drawing arithmetic, statistics, alerts, CSV (JavaScript) |
| `.venv/`, `node_modules/` | Installed Python and JavaScript packages |

## How to set it up again

See `README.md`.

## Ideas for later
- Live updates (the skill recommends `series.update(bar)` for that, rather than reloading everything).
- Moving and resizing existing drawings (the plugin skill points to the official `vertical-line` plugin for dragging).
- A search box in the symbol list.
- Alerts that keep running with the page closed (a small background service).
- Statistics filtered by period (e.g. "last 3 months") and comparing periods.
