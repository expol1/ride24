# Gemini availability repair

Backup: `backup/seo-before-gemini-availability-fix-2026-10-14` at `7708fdb8ef470555b618a9ae3174fb4330fde23a`.

The owner's first live generation failed. A server-side models-list request verified the stored key (HTTP 200), including the selected model. A minimal request using the same generation parameters returned HTTP 503 / UNAVAILABLE: the Gemini 3.8 Flash model was experiencing high demand. No API key was printed or exported; no billing settings were changed.

The SEO generator now uses Gemini 3.5 Flash-Lite with minimal thinking. Google's published pricing lists free input/output tokens for its Free tier; the owner's screenshot and saved setting confirmed Free. There is no paid fallback. Provider 503/500 failures now report temporary overload instead of incorrectly suggesting a bad API key. 429, authorization and unavailable-model responses have distinct messages.

A dedicated secret-authenticated maintenance request can prepare a single explicitly selected empty queued draft. It rejects existing drafts and any published document, observes the same enabled/Free confirmation/daily quota, and cannot publish. This was used to complete the owner's requested Tirana airport draft without enabling background automation. HTTP 200 confirmed saved PL/EN content, revision 2, draft state, no public publication. The default three daily attempts were used by the initial failed request, the small diagnostic probe and successful draft generation. Existing Google/GitHub tokens and business data were untouched.

Scoped regression tests passed, including accurate overload messaging, unchanged content on failed requests, rejection of published-document maintenance writes, and one-draft maintenance under the same quota with automation disabled. The full module has 51 isolated checks (15 core/security, 16 flow, 8 PostgreSQL, 12 UI). Real Gemini generation is now verified for the owner's configured Free project; Google Search Console and Business Profile still require the owner's connection.

Editorial review saved revisions 3 and 4 through the existing revision-guarded save function. Revision 4 is the final reviewed draft; earlier versions remain in history. The review removed unsupported terminal pickup and provider-count claims and converted literal newline escapes into paragraphs. Future generation normalizes those escapes and explicitly prohibits the unsupported claims in its prompt. The document remains an unpublished draft. Admin SEO Edge Function version 5 contains this repair.

References:
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/generate-content/thinking
