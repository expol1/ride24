# Address on admin partner creation

The admin create-partner modal now includes an optional `Adres siedziby` input
under the company name. It sends `address` to admin-create-partner and clears the
field after successful creation.

The Edge handler trims/validates the optional string (500 characters maximum,
no control characters) and inserts it into the existing `partners.address`
column. Missing/blank addresses remain null, preserving older clients and
technical-profile creation. Local and API partner paths are supported.

No schema, RLS, account, document, reservation or Android changes were made.
The partner profile already loads address from that column and uses it in the
agreement. Existing stored addresses remain untouched.

Validation: `node tests/backend-hardening/test-admin-partner-address.mjs` passed
15 isolated cases, including the actual admin submit -> Edge handler -> insert
payload, whitespace/Unicode, blank/omitted fields, maximum length, invalid type
and control characters, authorization rejection and the API partner path.
All auth/database/email actions in that test are mocked; no production account
or welcome email was created for testing.

Production: admin-create-partner deployed as ACTIVE version 77, retaining
verify_jwt=true. Retrieved deployment files matched the tested source; shared
security/API helpers and the import map were unchanged from version 76.

Rollback: backup branch `backup/admin-partner-before-address-2026-10-13` at
`3574feaf12eb40cc31df5ecab8625be3ffe83be9` preserves the old modal, handler and
dependencies. Restore only this change or revert its commit; redeploy the old
admin-create-partner bundle with JWT verification enabled. Do not reset main
to the backup branch. Keep addresses already entered in partners; rollback
does not require clearing or deleting them.
