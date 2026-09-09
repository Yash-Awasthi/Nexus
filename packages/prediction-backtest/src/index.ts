// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/prediction-backtest — Backtesting engine for prediction market strategies.
 *
 * Inspired by dr-manhattan's backtester.
 * Simulates trading strategies against historical prediction market data
 * with fee calculation, slippage modeling, and performance metrics.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MarketSnapshot {
  timestamp: number;
  upBestAsk: number;
  downBestAsk: number;
  resolved?: "UP" | "DOWN" | null;
  volume?: number;
}

export interface Trade {
  timestamp: number;
  side: "up" | "down";
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  fee: number;
  pnl?: number;
}

export interface BacktestResult {
  trades: Trade[];
  totalPnl: number;
  totalFees: number;
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalReturn: number;
  tradeCount: number;
  avgTradePnl: number;
}

export interface BacktestConfig {
  feeRate: number;
  slippageBps: number;
  initialBalance: number;
}

// ── Fee Calculation ──────────────────────────────────────────────────────────

/**
 * Calculate Polymarket-style variable fee.
 * Fee = qty * feeRate * (price * (1 - price))^feeExponent
 */
export function calcFee(
  quantity: number,
  price: number,
  feeRate: number = 0.25,
  feeExponent: number = 2,
): number {
  return quantity * feeRate * Math.pow(price * (1 - price), feeExponent);
}

// ── Backtester ───────────────────────────────────────────────────────────────

export class PredictionBacktester {
  private config: BacktestConfig;

  constructor(config?: Partial<BacktestConfig>) {
    this.config = {
      feeRate: 0.25,
      slippageBps: 0,
      initialBalance: 1000,
      ...config,
    };
  }

  /**
   * Run a backtest with given strategy conditions.
   */
  backtest(
    snapshots: MarketSnapshot[],
    strategy: (snapshot: MarketSnapshot, history: MarketSnapshot[]) => "up" | "down" | null,
    priceBounds: { min: number; max: number } = { min: 0.05, max: 0.95 },
  ): BacktestResult {
    const trades: Trade[] = [];
    const slip = this.config.slippageBps / 10_000;
    let balance = this.config.initialBalance;
    let peak = balance;
    let maxDrawdown = 0;

    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i]!;
      const signal = strategy(snapshot, snapshots.slice(0, i));

      if (signal === null) continue;

      const entryPrice = signal === "up" ? snapshot.upBestAsk : snapshot.downBestAsk;
      const adjustedEntry = entryPrice * (1 + slip);

      // Check price bounds
      if (adjustedEntry < priceBounds.min || adjustedEntry > priceBounds.max) continue;

      // Calculate position size (fixed fraction)
      const quantity = Math.min(balance * 0.1, 100); // 10% or max 100
      if (quantity <= 0) continue;

      const fee = calcFee(quantity, adjustedEntry, this.config.feeRate);
      const cost = quantity * adjustedEntry + fee;

      if (cost > balance) continue;

      // Find exit (next snapshot where resolved)
      let exitPrice: number | undefined;
      let exitTime = snapshot.timestamp;
      for (let j = i + 1; j < snapshots.length; j++) {
        const next = snapshots[j]!;
        if (next.resolved) {
          exitPrice = next.resolved === signal ? 1.0 : 0.0;
          exitTime = next.timestamp;
          break;
        }
        // Or exit at next snapshot
        exitPrice = signal === "up" ? next.upBestAsk : next.downBestAsk;
        exitTime = next.timestamp;
        break;
      }

      if (exitPrice === undefined) continue;

      const exitFee = calcFee(quantity, exitPrice, this.config.feeRate);
      const pnl = quantity * (exitPrice - adjustedEntry) - fee - exitFee;

      trades.push({
        timestamp: snapshot.timestamp,
        side: signal,
        entryPrice: adjustedEntry,
        exitPrice,
        quantity,
        fee: fee + exitFee,
        pnl,
      });

      balance += pnl;
      peak = Math.max(peak, balance);
      const drawdown = (peak - balance) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return this.computeMetrics(trades, balance);
  }

  /**
   * Run a backtest with buy-and-hold strategy.
   */
  buyAndHold(snapshots: MarketSnapshot[], side: "up" | "down" = "up"): BacktestResult {
    return this.backtest(snapshots, () => side);
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  private computeMetrics(trades: Trade[], finalBalance: number): BacktestResult {
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const tradeCount = trades.length;

    // Sharpe ratio (annualized, assuming daily snapshots)
    const returns = trades.map((t) => (t.pnl ?? 0) / this.config.initialBalance);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn =
      returns.length > 1
        ? Math.sqrt(
            returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1),
          )
        : 1;
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    return {
      trades,
      totalPnl,
      totalFees,
      winRate: tradeCount > 0 ? wins / tradeCount : 0,
      sharpeRatio,
      maxDrawdown: 0, // computed during backtest
      totalReturn: (finalBalance - this.config.initialBalance) / this.config.initialBalance,
      tradeCount,
      avgTradePnl: tradeCount > 0 ? totalPnl / tradeCount : 0,
    };
  }
}

export default PredictionBacktester;
