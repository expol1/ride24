-- Caravel ONLY, additive (table is empty in production). Operator-reviewed key facts
-- of the binding terms (Caravel 18 Nov 2026, EN v5): 17 no card on Premium,
-- 27.1 amounts after return, 7.4 fines/tolls with handling fee, 13 broker
-- cancellation (free until pickup), 5.2/5.3 package descriptions.
-- Each referenced clause is checked to exist in the stored document at ingest.
BEGIN;
ALTER TABLE public.caravel_reviewed_terms
  ADD COLUMN IF NOT EXISTS key_clause_refs jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(key_clause_refs) = 'object'),
  ADD COLUMN IF NOT EXISTS no_card_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS free_cancellation_until_pickup boolean NOT NULL DEFAULT false;
COMMIT;
