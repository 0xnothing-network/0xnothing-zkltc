/**
 * Hide balances (a Home setting). Only Home's total and its list pass through
 * here: review and confirmation screens never mask, or the user would confirm
 * an amount they cannot see.
 */
export const MASKED_BALANCE = "••••";

export function maskBalance(hidden: boolean, shown: string): string {
  return hidden ? MASKED_BALANCE : shown;
}
