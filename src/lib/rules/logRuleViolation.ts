import { createClient } from '@/lib/supabase/client';

export type RuleViolationSource = 'preset' | 'custom';
export type RuleViolationOutcome = 'blocked' | 'warned' | 'overridden';

export interface RuleViolationLogInput {
  userId: string;
  ruleSource: RuleViolationSource;
  customRuleId: string | null;
  ruleKey: string;
  ruleName: string;
  outcome: RuleViolationOutcome;
  tradePlanId: string | null;
}

/**
 * Fire-and-forget insert into rule_violations. Never throws — logging must not
 * block or break the trade-plan submit flow. Returns the new row ids (best-effort,
 * [] on any failure) so callers can later upgrade a 'warned' row to 'overridden'.
 */
export async function logRuleViolations(entries: RuleViolationLogInput[]): Promise<string[]> {
  if (entries.length === 0) return [];
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('rule_violations')
      .insert(entries.map((e) => ({
        user_id: e.userId,
        rule_source: e.ruleSource,
        custom_rule_id: e.customRuleId,
        rule_key: e.ruleKey,
        rule_name: e.ruleName,
        outcome: e.outcome,
        trade_plan_id: e.tradePlanId,
      })))
      .select('id');

    if (error) {
      console.warn('[rule_violations] insert failed:', error.message);
      return [];
    }
    return (data ?? []).map((row: { id: string }) => row.id);
  } catch (err) {
    console.warn('[rule_violations] insert threw:', err);
    return [];
  }
}

/**
 * Fire-and-forget upgrade of previously-logged 'warned' rows to 'overridden' once
 * the trade they warned about actually gets submitted. Never throws.
 */
export async function overrideRuleViolations(ids: string[], tradePlanId: string): Promise<void> {
  if (ids.length === 0) return;
  try {
    const supabase = createClient();
    const { error } = await supabase
      .from('rule_violations')
      .update({ outcome: 'overridden', trade_plan_id: tradePlanId })
      .in('id', ids);

    if (error) console.warn('[rule_violations] override update failed:', error.message);
  } catch (err) {
    console.warn('[rule_violations] override update threw:', err);
  }
}
