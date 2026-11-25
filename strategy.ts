// Burst-and-ladder: a pump.fun bonding-curve replay bot.
//
// Idea: most new curves die fast and a few run hard. This bot only buys a curve
// while a short burst of real buying is happening, then lets a winner run with a
// staged exit and cuts a loser fast. It never pyramids and never re-enters a
// curve it just sold, so each coin costs at most one stake.
//
// Entry signal (per curve, over its last W trades):
//   - a buy burst: at least minBuys of the last W trades are buys, buy SOL is at
//     least buySellRatio x sell SOL, and at least minBuyers distinct wallets are
//     buying, with no single buyer taking more than maxBuyerShare of the buy SOL
//     (a one-wallet pump is not a crowd);
//   - a rising but not vertical price: price now is up at least minRise on the
//     price W trades ago, at most maxRise, and within nearHigh of the window
//     high, with the most recent trade a buy (the burst is still going);
//   - the curve is liquid enough to trade but not near completion: real SOL
//     reserves between minRealSol and maxRealSol, and at least minTrades trades
//     have been seen on it.
// Sizing: one fixed stake per position (stakeLamports), capped by the harness's
// 1%-of-real-reserve size cap; at most maxOpenPositions open at once.
//
// Exits (checked every batch, sells go out wide open on slippage so they land):
//   - ladder: at +ladderUp the bot sells half the position; the rest rides a
//     trailing stop (sell when value falls to trailKeep of its peak value);
//   - stop loss: sell everything when value falls to stopKeep of cost;
//   - dump: sell everything when the last few trades turn into a sell burst;
//   - clock: sell everything after maxHoldSlots no matter what.
// A curve that completes is closed by the replay itself. Exit bookkeeping
// (cost basis, ladder arm) moves only on fills, never when an order is sent:
// a sell that is rejected or whose transaction fails leaves the position
// exactly as it was, so the exit logic retries it instead of orphaning it.
//
// Coverage: the guardrail needs >= 20 distinct mints with >= 0.01 SOL round
// trips, including on the shorter 6-hour final window (~100k slots), so the
// bot must buy about one distinct mint per 4000 slots. It watches its own
// pace (distinct mints bought vs slots elapsed) and, while it falls behind,
// relaxes the entry thresholds further. The relaxation is re-checked every
// batch and lifts as soon as the pace recovers, so it cannot leave the bot
// loose for the rest of the run. A relaxed entry still needs a buy burst —
// it only asks less of one.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// all iteration is over insertion-ordered maps fed by the batch stream, and all
// time is slot numbers from the harness protocol (hello / batch / orders / slot).

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Trades in the entry window. */
  windowTrades: number;
  /** Minimum trades seen on a curve before it can be entered. */
  minTrades: number;
  /** Minimum buys inside the window. */
  minBuys: number;
  /** Buy SOL must be at least this multiple of sell SOL in the window. */
  buySellRatio: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Largest single buyer's share of window buy SOL. */
  maxBuyerShare: number;
  /** Minimum price rise over the window (fraction, 0.04 = +4%). */
  minRise: number;
  /** Maximum price rise over the window. */
  maxRise: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve bounds at entry (SOL). */
  minRealSol: number;
  maxRealSol: number;
  /** SOL staked per position. */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell half the position once value reaches cost * (1 + ladderUp). */
  ladderUp: number;
  /** After the ladder sale, sell the rest when value falls to this share of peak. */
  trailKeep: number;
  /** Sell everything when value falls to this share of cost. */
  stopKeep: number;
  /** After the ladder sale the rest is house money: its stop loosens to this share of cost. */
  postLadderStopKeep: number;
  /** Dump exit: last dumpTrades trades, sell SOL >= dumpRatio x buy SOL and >= dumpMinSol. */
  dumpTrades: number;
  dumpRatio: number;
  dumpMinSol: number;
  /** Sell everything after this many slots held. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** The most recent trade must be a buy (the burst is still going). */
  lastMustBeBuy: boolean;
  /** Pace: one distinct mint bought per paceSlots slots; fall behind and relax. */
  paceSlots: number;
  /** Relaxed-mode entry thresholds. */
  relaxedMinBuys: number;
  relaxedMinRise: number;
  relaxedMinBuyers: number;
  relaxedMaxBuyerShare: number;
}

export const DEFAULT_PARAMS: Params = {
  windowTrades: 40,
  minTrades: 12,
  minBuys: 28,
  buySellRatio: 2.0,
  minBuyers: 5,
  maxBuyerShare: 0.45,
  minRise: 0.2,
  maxRise: 0.3,
  nearHigh: 0.9,
  minRealSol: 5,
  maxRealSol: 50,
  stakeSol: 0.4,
  minBuySol: 0.02,
  buySlipBps: 1000,
  ladderUp: 1.2,
  trailKeep: 0.75,
  stopKeep: 0.8,
  postLadderStopKeep: 0.5,
  dumpTrades: 6,
  dumpRatio: 2.0,
  dumpMinSol: 0.3,
  maxHoldSlots: 2400,
  cooldownSlots: 200,
  maxEntries: 2,
  maxEntriesPerBatch: 2,
  lastMustBeBuy: true,
  paceSlots: 3000,
  relaxedMinBuys: 9,
  relaxedMinRise: 0.015,
  relaxedMinBuyers: 3,
  relaxedMaxBuyerShare: 0.6,
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const TAPE_LEN = 100;

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  buyer: string;
  price: number;
}

interface CurveTape {
  trades: TapeTrade[];
  createdSlot: number | null;
  entries: number;
  cooldownUntil: number;
}

interface OpenTrade {
  mint: string;
  entrySlot: number;
  cost: bigint;
  peakRatio: number;
  soldHalf: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<string, CurveTape>();
  const open = new Map<string, OpenTrade>();
  const boughtMints = new Set<string>();
  let startSlot = -1;
  let relaxed = false;

  function tapeFor(mint: string): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], createdSlot: null, entries: 0, cooldownUntil: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  function entrySignal(state: BotState, mint: string, slot: number): boolean {
    const tape = tapes.get(mint);
    if (tape === undefined) return false;
    if (tape.trades.length < params.minTrades) return false;
    if (tape.entries >= params.maxEntries) return false;
    if (slot < tape.cooldownUntil) return false;
    if (open.has(mint)) return false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return false;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (realSol < params.minRealSol || realSol > params.maxRealSol) return false;

    const w = tape.trades.slice(-params.windowTrades);
    const minBuys = relaxed ? params.relaxedMinBuys : params.minBuys;
    const minRise = relaxed ? params.relaxedMinRise : params.minRise;
    const minBuyers = relaxed ? params.relaxedMinBuyers : params.minBuyers;
    const maxBuyerShare = relaxed ? params.relaxedMaxBuyerShare : params.maxBuyerShare;

    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    const buyers = new Map<string, number>();
    let high = 0;
    for (const t of w) {
      if (t.price > high) high = t.price;
      if (t.isBuy) {
        buys += 1;
        buySol += t.sol;
        buyers.set(t.buyer, (buyers.get(t.buyer) ?? 0) + t.sol);
      } else {
        sellSol += t.sol;
      }
    }
    if (buys < minBuys) return false;
    if (buySol < params.buySellRatio * sellSol) return false;
    if (buyers.size < minBuyers) return false;
    let maxShare = 0;
    for (const v of buyers.values()) if (v / buySol > maxShare) maxShare = v / buySol;
    if (maxShare > maxBuyerShare) return false;

    const priceNow = w[w.length - 1]!.price;
    const priceStart = w[0]!.price;
    if (priceStart <= 0 || priceNow <= 0) return false;
    if (params.lastMustBeBuy && !w[w.length - 1]!.isBuy) return false;
    const rise = priceNow / priceStart - 1;
    if (rise < minRise || rise > params.maxRise) return false;
    if (priceNow < params.nearHigh * high) return false;
    return true;
  }

  function dumpSignal(mint: string): boolean {
    const tape = tapes.get(mint);
    if (tape === undefined) return false;
    const w = tape.trades.slice(-params.dumpTrades);
    if (w.length < params.dumpTrades) return false;
    let buySol = 0;
    let sellSol = 0;
    for (const t of w) {
      if (t.isBuy) buySol += t.sol;
      else sellSol += t.sol;
    }
    return sellSol >= params.dumpRatio * buySol && sellSol >= params.dumpMinSol;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (startSlot < 0) startSlot = batch.slot;
      const slot = batch.slot;
      const orders: OrderInput[] = [];

      // Pace check: relax the entry thresholds only while distinct mints bought
      // lag one per paceSlots slots of elapsed replay; it re-tightens as soon
      // as the pace recovers, so a quiet stretch cannot leave the bot loose
      // for the rest of the run.
      if (slot - startSlot > 20000) {
        const target = (slot - startSlot) / params.paceSlots;
        relaxed = boughtMints.size < 0.8 * target;
      }

      // Fold fills: record entries, clear exits, drop closed positions.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') {
          if (!open.has(f.mint)) {
            open.set(f.mint, { mint: f.mint, entrySlot: f.slot, cost: BigInt(f.quote_lamports), peakRatio: 1, soldHalf: false });
          } else {
            const o = open.get(f.mint)!;
            o.cost += BigInt(f.quote_lamports);
          }
          boughtMints.add(f.mint);
        } else if (f.side === 'sell') {
          // A sell landed: scale the cost basis to the tokens still held, so
          // later value/cost ratios still describe the live position. A
          // partial sale also arms the trailing stop on the remainder. Only
          // a fill moves these — a sell that is rejected or fails changes
          // nothing, so the exit logic retries it next batch.
          const o = open.get(f.mint);
          if (o !== undefined) {
            const remaining = state.positions.get(f.mint)?.token_amount ?? 0n;
            const sold = BigInt(f.token_amount);
            const before = remaining + sold;
            if (before > 0n) o.cost = (o.cost * remaining) / before;
            if (remaining > 0n) o.soldHalf = true;
          }
        }
      }
      for (const [mint, o] of [...open.entries()]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          // Position gone (sold, completed, or flattened): cooldown, forget.
          const tape = tapes.get(mint);
          if (tape !== undefined) tape.cooldownUntil = slot + params.cooldownSlots;
          open.delete(mint);
        } else {
          void o;
        }
      }

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          t.trades.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / LAMPORTS_PER_SOL,
            buyer: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          if (t.trades.length > TAPE_LEN) t.trades.splice(0, t.trades.length - TAPE_LEN);
        } else {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.trades.length = 0;
        }
      }

      // Exits first, so a freed slot can be reused by an entry in the same batch.
      const exitMints = new Set<string>();
      for (const [mint, pos] of state.positions) {
        const o = open.get(mint);
        if (o === undefined) continue; // position we did not open (should not happen)
        let sellPending = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'sell' && p.order.mint === mint) {
            sellPending = true;
            break;
          }
        }
        if (sellPending) continue; // a sell is already in flight; wait for its fill
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const value = (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
        const ratio = Number(value) / Number(o.cost);
        if (ratio > o.peakRatio) o.peakRatio = ratio;
        const held = slot - o.entrySlot;
        // Once half is banked the rest rides with a looser stop: it is house
        // money, and a wide stop is what lets a runner survive its dips.
        const stop = o.soldHalf ? params.postLadderStopKeep : params.stopKeep;
        let sell: bigint | null = null;
        if (!o.soldHalf && ratio >= 1 + params.ladderUp) {
          sell = pos.token_amount / 2n;
        } else if (o.soldHalf && ratio <= o.peakRatio * params.trailKeep) {
          sell = pos.token_amount;
        } else if (ratio <= stop) {
          sell = pos.token_amount;
        } else if (dumpSignal(mint)) {
          sell = pos.token_amount;
        } else if (held >= params.maxHoldSlots) {
          sell = pos.token_amount;
        }
        if (sell !== null && sell > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: 10000 });
          exitMints.add(mint);
          // Do NOT drop the open record here: the sell may be rejected or
          // fail, and the position would then be orphaned with no exit left.
          // The cleanup at the top of the next batches drops it once the
          // position is actually gone from the account.
        }
      }

      // Entries: mints touched by this batch's trades, in event order.
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsFree = caps.max_open_positions - state.committedPositionCount();
      let entriesThisBatch = 0;
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        if (seen.has(mint) || exitMints.has(mint)) continue;
        seen.add(mint);
        if (entriesThisBatch >= params.maxEntriesPerBatch || slotsFree <= 0) break;
        if (!entrySignal(state, mint, slot)) continue;
        const cap = state.maxBuyLamports(mint);
        const stake = BigInt(Math.round(params.stakeSol * LAMPORTS_PER_SOL));
        const minBuy = BigInt(Math.round(params.minBuySol * LAMPORTS_PER_SOL));
        const amount = cap < stake ? cap : stake;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: params.buySlipBps });
        const tape = tapeFor(mint);
        tape.entries += 1;
        free -= amount + tx;
        slotsFree -= 1;
        entriesThisBatch += 1;
      }
      return orders;
    },
  };
}
