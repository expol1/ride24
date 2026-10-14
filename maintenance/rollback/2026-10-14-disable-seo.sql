-- Immediate, reversible shutdown. Retain all drafts, history, OAuth tokens and public pages.
UPDATE public.seo_settings SET enabled=false,auto_generate=false,updated_at=now() WHERE id=1;
-- Existing reservation/file cleanup schedules are unaffected.
