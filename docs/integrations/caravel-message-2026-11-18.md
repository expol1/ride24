# Draft message to Caravel (NOT SENT — for Ride24 to review and send)

**To:** Caravel partner integrations
**Subject:** Ride24 — sandbox certification run 15adba20 completed; production access and terms questions

Hello,

Ride24 has completed the following on our self-serve sandbox account today (18 Nov 2026):

1. **Webhook HMAC self-test** — `POST /_certification/hmac-self-test` returned
   `verified: true` (request_id `req_LrHmSwCowGN6twkc`, recorded 2026-11-18T15:49:18Z).
2. **Hosted certification run** `15adba20-a018-4398-b460-4e335e846059` — started
   15:52:49Z, all ten phases executed with our client (key on every request, including
   capabilities), finished 15:56:07Z. Could you please confirm the verdict for this run,
   or tell us what to fix if any scenario is FAIL or INCONCLUSIVE?
3. **Terms hash** — we recompute `content_hash` independently using the rule in
   `TermsDocument.content_hash`; it matches for both sandbox documents
   (`…00d1`, `…00d3`).

Before we request production we need the following confirmed for the **production**
account (Greece, EUR):

a) **Terms:** the current EN document (you mentioned v4, 17 Nov) will be served by
   `GET /v1/reference/terms` with the production key — please confirm, and confirm that
   the full clause tree (including the Premium exclusions and the administration fee)
   is inside that document, not only in PDFs.
b) **Premium cover:** that production Premium quotes carry deposit 0, excess 0 and theft
   excess 0, with `covers` / `excludes` populated; and the exact clause numbers that
   exclude glass, tyres/wheels and undercarriage.
c) **Administration fee:** the exact amount and currency (we understood EUR 100) and
   when it applies (damage and/or theft, Premium included), with its clause number.
d) **Card at pickup:** the sandbox EUR policy lists `deposit_payment_methods:
   ["credit_card"]` and `deposit_card_rules`. With deposit 0 under Premium, is any card
   required at the desk (and the meaning of rules §5.1 about charging a card at pickup)?
   Ride24 advertises the rental as paid at pickup; we must state the card rule exactly.
e) **Payment model:** production supplier(s) support `pay_on_arrival` with
   `pay_now = 0`; Ride24 collects only its own separate booking fee and never takes the
   rental amount.
f) **API version:** our key is pinned to 1.67.0 while 1.68.0 is latest — is an upgrade
   required before production?
g) **Settlement:** whether a commission statement reconciliation applies to our
   agreement before sign-off.

We will not sell Caravel offers until (a)–(e) are confirmed in the production API.

Kind regards,
Ride24
