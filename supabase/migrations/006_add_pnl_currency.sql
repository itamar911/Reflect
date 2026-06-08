-- Migration: add currency column for ₪/$ P&L (₪) display
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS pnl_currency TEXT DEFAULT '₪';
