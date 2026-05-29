-- Fix: replace FOR ALL policy with explicit per-operation policies on personal_strategies

DROP POLICY IF EXISTS "Users can manage own strategies" ON personal_strategies;

CREATE POLICY "personal_strategies_select"
  ON personal_strategies FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "personal_strategies_insert"
  ON personal_strategies FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "personal_strategies_update"
  ON personal_strategies FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "personal_strategies_delete"
  ON personal_strategies FOR DELETE USING (auth.uid() = user_id);
