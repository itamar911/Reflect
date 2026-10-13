import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function calcRR(entry: number, stopLoss: number, takeProfit: number): number {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk === 0) return 0;
  return Math.round((reward / risk) * 100) / 100;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

// Trading amounts are formatted by lib/money.ts — formatMoney() and friends.
// formatPnlIls() used to live here with a `currency` parameter defaulting to ₪;
// REF-99 made the product dollar-only and there is no parameter to pass.

export function formatPnlPoints(points: number): string {
  return `${Math.round(Math.abs(points))}נק`;
}
