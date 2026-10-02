// #region budget
export type BudgetState = 'ok' | 'warn' | 'degrade' | 'stop';

export interface BudgetPolicy {
  monthlyUsd: number;
  /** Fractions of the monthly budget. */
  warnAt: number;
  degradeAt: number;
}

/**
 * Monthly spend per tenant with three thresholds. Projecting from the burn
 * rate warns early in the month, when there is still time to act, instead of
 * on the day the budget runs out.
 */
export function budgetState(spentUsd: number, policy: BudgetPolicy, dayOfMonth: number, daysInMonth: number): {
  state: BudgetState;
  projectedUsd: number;
} {
  const projectedUsd = dayOfMonth > 0 ? (spentUsd / dayOfMonth) * daysInMonth : spentUsd;
  const share = spentUsd / policy.monthlyUsd;
  const state: BudgetState =
    share >= 1 ? 'stop'
    : share >= policy.degradeAt ? 'degrade'
    : share >= policy.warnAt || projectedUsd > policy.monthlyUsd ? 'warn'
    : 'ok';
  return { state, projectedUsd };
}
// #endregion budget
