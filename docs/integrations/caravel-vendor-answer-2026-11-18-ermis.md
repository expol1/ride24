# Caravel answer (Ermis, 18 Nov 2026) — what it changes in Ride24

| Topic | Caravel statement | Ride24 implementation |
|---|---|---|
| Certification | Run `15adba20…` **PASS** (6/6 core scenarios), HMAC self-test in order | Next: owner clicks **Request production** (legal name) |
| Terms | Current = **EN v5** (18 Nov 2026), new `document_id`, v4 withdrawn; full clauses/v1, no PDF dependency | Ingest only the current document via API with the production key; SHA-256 re-hash (§3.9); v4 consent never reused |
| Exclusions | Clause **5.4** (all packages): glass, tyres/wheels, undercarriage, mirrors, interior, roof, engine, locks, keys; void conditions; terms prevail over codes | Panel: exclusion clause `5.4`, codes = exact Premium `excludes`; full text shown before Stripe |
| Admin fee | Clause **7.1**: EUR 100.00 **per rental**, damage or theft, every package incl. Premium | Fee clause `7.1`, statement "per rental, not per incident, also on Premium" |
| Fines | Clause **7.4**: fines, parking, tolls + handling fee | Consent statement (key clause `fines`) |
| Card | Clause **17**: no card required on Premium; pay at desk cash / Visa / MasterCard, card in main renter's name | `no_card_required` set only if clause 17 text says "No card is required"; card badges only then |
| After return | Clause **27.1**: pay at return; later amounts invoiced, due on receipt | Consent statement (key clause `post_return`) |
| Cancellation | Clause **13** broker terms; production: free cancellation up to pickup | Read from supplier policy (`free` / `free_until` 0 h); statement only when true; cancellation via existing Ride24 flows → `POST /v1/bookings/{id}/cancel` |
| Payment | pay_on_arrival only; booking.payment: amount_prepaid 0, on_arrival = grand total, who_collects operator; **totals.pay_now may be non-zero and means nothing** (§6.2) | Schedule from agreement + booking.payment; pay_now kept as audit split; booking verified incl. who_collects |
| API version | Stay pinned to 1.67.0; 1.68.0 optional | No X-API-Version sent; *Test połączenia* refuses any pin ≠ 1.67.0 |
| Settlement | Net rate, **no commission**, no statement to reconcile | Nothing to build; Ride24 earns only its own booking fee |
| Account | Caravel only, Premium only, EUR incl. VAT, pay on arrival | Matches gates (Premium only, EUR, tax-inclusive, pay_on_arrival) |
