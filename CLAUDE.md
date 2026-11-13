# Ride24 — autonomous coding agent rules

## Scope and safety
This repository powers the Ride24 car-rental booking platform. Customer bookings, pricing, payments, partner contracts, and notification delivery are sensitive production workflows. These instructions apply to coding assistants working in this repository.

- Work only on a dedicated feature branch, never commit directly to `main`.
- Submit a **draft pull request** for all proposed changes. Do not merge or deploy automatically.
- Run the relevant local tests and record the commands and outcomes in the PR. Do not describe tests as passed unless they actually ran successfully.
- Read and preserve the existing logic and integrations for local partners, AVIA/Renteon, Caravel, Arvent, and other API providers. Never silently change an unrelated integration.
- Prefer narrowly scoped changes with regression coverage. Re-check the branch head before writing to avoid overwriting work by other agents or developers.

## Production and data protection
- Do not run SQL or migrations against production Supabase, modify production rows, alter RLS policies, modify credentials or secrets, or deploy Edge Functions as part of autonomous tasks.
- Do not make live supplier bookings, cancel production reservations, charge customers, issue refunds, send real customer emails or push notifications, or modify payment settings.
- Do not read, export, or log customer personally identifiable information unless expressly required and authorized for a narrowly defined task. Use synthetic fixtures in tests.
- Never expose API keys, service-role tokens, database credentials, Stripe secrets, or authentication tokens in code, PRs, logs, or messages.
- If production verification is needed, explain precisely what remains unverified and request a separately authorized, scoped procedure.

## Booking and API contract
- Ride24 charges its own online booking fee; the customer pays the partner's rental amount directly to the rental company unless a separately approved partner-specific flow applies.
- Partner prices, optional extras, and mandatory fees must be verified against the supplier's authoritative quote; never invent tariffs, double count services, or assume that a zero price means a free service.
- Preserve common price and vehicle presentation, shared location/vehicle normalization, booking protections, and WWW/API consistency.
- For AVIA/Renteon, preserve the supplier-calculated fee structure, quantity and rental-duration caps, time-zone handling, and protection against stale or changed quotes.
- For Caravel, use sandbox-only test bookings with synthetic customer data and Premium-only zero-deposit/zero-excess protections until separately approved for production.
- Unknown provider fields or contradictory partner terms must fail safely rather than being guessed.

## Definition of done
A task is complete only when the implementation is committed on its branch, targeted regression tests have passed, and a draft PR summarizes code changes, test evidence, constraints, and remaining unverified production behavior. Do not claim native Android, Stripe payment, real email, push-notification or production supplier end-to-end coverage unless those paths were actually tested.

## Stop conditions
Stop and report instead of proceeding when a task would require production write access, unapproved external side effects, missing credentials, undocumented price assumptions, protected-data exposure, or a destructive Git operation. Do not endlessly retry failing tests: diagnose, repair in the branch, and cap repeated automated attempts.

## Prioritization
Finish one integration or bounded issue at a time. Do not mix AVIA, Caravel, partner legal agreements, or unrelated search functionality in the same PR unless the changes are inseparable and explicitly scoped.
