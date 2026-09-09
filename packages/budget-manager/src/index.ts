// SPDX-License-Identifier: Apache-2.0
/**
 * Time-based Budget Manager — per-user budget tracking with daily/weekly/monthly/yearly limits.
 *
 * Extracted from LiteLLM's budget_manager: enforces spending limits per user
 * with configurable time windows and automatic reset on period boundary.
 */

export type BudgetDuration = "daily" | "weekly" | "monthly" | "yearly";

export interface UserBudget {
  totalBudget: number;
  spent: number;
  duration?: BudgetDuration;
  createdAt: number;
  lastReset: number;
}

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
  total: number;
  spent: number;
  resetIn?: number; // ms until next reset
}

export interface BudgetConfig {
  storagePath?: string;
  onBudgetExceeded?: (userId: string, budget: UserBudget) => void;
}

const MS_PER = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

export class BudgetManager {
  private budgets: Map<string, UserBudget> = new Map();
  private config: BudgetConfig;

  constructor(config: BudgetConfig = {}) {
    this.config = config;
  }

  /**
   * Create or update a budget for a user.
   */
  createBudget(userId: string, totalBudget: number, duration?: BudgetDuration): void {
    const now = Date.now();
    this.budgets.set(userId, {
      totalBudget,
      spent: 0,
      duration,
      createdAt: now,
      lastReset: now,
    });
  }

  /**
   * Check if a user can spend a given amount.
   */
  checkBudget(userId: string, cost: number = 0): BudgetCheck {
    const budget = this.budgets.get(userId);
    if (!budget) {
      // No budget set — unlimited
      return { allowed: true, remaining: Infinity, total: 0, spent: 0 };
    }

    // Check if we need to reset
    this.maybeReset(budget);

    const remaining = budget.totalBudget - budget.spent;
    const allowed = cost === 0 ? remaining > 0 : remaining >= cost;

    let resetIn: number | undefined;
    if (budget.duration) {
      const elapsed = Date.now() - budget.lastReset;
      resetIn = MS_PER[budget.duration] - elapsed;
    }

    return {
      allowed,
      remaining,
      total: budget.totalBudget,
      spent: budget.spent,
      resetIn,
    };
  }

  /**
   * Record a spend against a user's budget.
   * Returns the budget check before spending.
   */
  recordSpend(userId: string, cost: number): BudgetCheck {
    const check = this.checkBudget(userId, cost);
    if (!check.allowed) {
      this.config.onBudgetExceeded?.(userId, this.budgets.get(userId)!);
      return check;
    }

    const budget = this.budgets.get(userId);
    if (budget) {
      budget.spent += cost;
    }

    return check;
  }

  /**
   * Get all budgets (for admin dashboard).
   */
  getAll(): Map<string, UserBudget> {
    return new Map(this.budgets);
  }

  /**
   * Manually reset a user's budget.
   */
  reset(userId: string): void {
    const budget = this.budgets.get(userId);
    if (budget) {
      budget.spent = 0;
      budget.lastReset = Date.now();
    }
  }

  private maybeReset(budget: UserBudget): void {
    if (!budget.duration) return;

    const now = Date.now();
    const windowMs = MS_PER[budget.duration];
    if (now - budget.lastReset >= windowMs) {
      budget.spent = 0;
      budget.lastReset = now;
    }
  }
}
