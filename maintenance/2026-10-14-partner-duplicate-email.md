# Partner creation duplicate-email response

At 17:34:32 and 17:35:49 UTC, Auth rejected account creation with `A user with this email address has already been registered`. The Edge function wrapped that known conflict as a generic HTTP 500. These attempts stopped before creating an Auth user, profile, partner or welcome email.

The admin-only handler now recognizes Auth codes `email_exists` and `user_already_exists`, with an exact legacy-message fallback, and returns HTTP 409 with a Polish explanation and `EMAIL_ALREADY_REGISTERED`. It does not reuse, change the password/role of, or delete the existing account. Other failures retain the existing handling. No production test account or email was created.

Backup: `backup/before-partner-duplicate-email-fix-2026-10-14` at `63cd8ca22d3b290f32c4ae068fc8607f317dd94b`. Restore the previous function index from this commit to roll back. Preserve the existing function's bundled shared dependencies and JWT verification setting.

Verification: 18 isolated handler/form checks passed, including all three duplicate formats, zero profile/partner writes and zero cleanup deletions on duplicates, local/API partner creation, validation and admin authorization.
