// Burst-and-ladder pump.fun replay bot (agent-fun/replay/v2).
//
// Reads the harness protocol on stdin (hello, then one batch per slot, then
// done) and answers each batch with buy/sell orders on stdout. The strategy
// lives in strategy.ts: it buys a curve only while a short burst of real
// buying is happening (28+ buys in the last 40 trades, buy SOL at least 2x
// sell SOL, 5+ distinct buyers, price up 20-30% over the window and within
// 10% of the window high, real SOL reserves 5-50), then exits in stages —
// half off at +120%, the rest on a trailing stop, a hard stop at -20%, a
// sell-burst dump exit, or a hold-time cap — so each coin costs at most one
// fixed 0.4 SOL stake and a freed slot can be reused the same batch. A pace
// guardrail relaxes the entry while the bot falls behind one distinct mint
// per 3000 slots, so it still clears the 20-mint bar on a short window.
// Dev-window grade (kit grade-local, process driver): +0.048 SOL net,
// 107 coins, 120 round trips, max drawdown 2.8%. The same configuration is
// positive across four other fail-draw seeds (+0.22/+0.22/+0.24/+0.26 SOL),
// so the edge does not hinge on one draw. See strategy.ts for the full design.
//
// Deterministic: no clock, no randomness, no network, no files read at
// runtime. The only input is the harness stream.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
