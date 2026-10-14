# First-login partner configuration verification

Backup: `backup/before-onboarding-error-fix-2026-10-14` at `636a298260351681716199b9225ff5a309cea6d0`.

Read-only production checks confirmed the newly created partner is pending, requires a password change, has an incomplete profile and has not accepted the agreement. Authenticated grants and RLS allow the partner's own profile/partner updates, partner-document uploads/reads/updates, and execution of `partner_accept_agreement`. The live agreement RPC requires authentication, an incomplete acceptance, a completed profile and both document URLs before activating the account. Recent logs contained no onboarding database errors in the checked interval.

Found and fixed a frontend error-path bug: `savePartnerSettings` declared `isEn` inside its try block but referenced it from catch. A database failure could therefore throw ReferenceError and leave the button disabled. Move the existing language declaration to function scope, preserving the success path and stored data.

14 isolated tests execute the actual HTML functions: password validation and mandatory checkbox, Auth failure, required profile fields and PDFs, successful profile save, PL/EN database-error retry, explicit agreement consent, duplicate-click guard, agreement rejection, PDF path and file validation. No production password was changed, no agreement was accepted, and no test message or storage object was created. This verifies code paths and deployed permissions, not a real partner's complete interactive sign-in session.
