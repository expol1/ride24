# Ride24 SEO positioning and automatic drafts

Owner requested automatic PL/EN draft preparation, retaining manual publication, and consistent emphasis on no security deposit, no credit card required and full insurance.

Backup branch: `backup/seo-before-brand-automation-2026-10-14`, commit `09414d6d7ef99c3f210524522c306afc2a010155`.

The shared browser/backend prompt now requires all three benefits in both languages, presenting the owner-confirmed Ride24 positioning while avoiding invented claims about every vehicle, insurance exclusions or zero excess. New location source records carry the same editorial guidance. Existing public articles are not rewritten.

Automation configuration: module enabled, Free confirmation preserved, automatic drafts enabled, existing limit 3 attempts/day preserved. Existing cron runs at minute 17 hourly and can create drafts only. Today's count is already 3; no additional generation request or quota reset is made. Search Console and Business Profile still require owner OAuth consent. No tokens are replaced. To stop automatic drafts, uncheck the automatic draft option in SEO settings; to revert code use the backup commit.

Verification: 16 core/security checks, 16 isolated flow checks, and 12 browser UI checks. The prompt is shared exactly between backend and browser. No booking, Android, payment, partner or storage code changes.
