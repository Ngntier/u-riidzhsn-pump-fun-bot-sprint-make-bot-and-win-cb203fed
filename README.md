# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ngntier/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ngntier/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic pump.fun bonding-curve replay bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win". It reads the agent-fun/replay/v2 harness protocol on stdin (hello, one batch per slot, done) and answers each batch with buy/sell orders. The strategy is burst-and-ladder: it buys a curve only while a short burst of real buying is happening — 28+ buys in the last 40 trades, buy SOL at least 2x sell SOL, 5+ distinct buyers, price up 20–30% over the window and within 10% of the window high, real SOL reserves 5–50 — then exits in stages: half off at +120%, the rest on a trailing stop, a hard stop at −20%, a sell-burst dump exit, or a hold-time cap. Each coin costs at most one fixed 0.4 SOL stake. A pace guardrail relaxes the entry while the bot falls behind one distinct mint per 3000 slots, so it clears the 20-mint bar even on the short 6-hour final window. No clock, no randomness, no network: two runs on the same data produce byte-identical action logs. Dev-window grade (kit grade-local, process driver): +0.048 SOL net, 107 coins, 120 round trips, max drawdown 2.8%.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1h9wdbp&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
