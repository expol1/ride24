# Uploading travel guides from the admin panel

The Autoprzewodniki section accepts a complete UTF-8 HTML file (up to 2 MiB),
a display title and a lowercase filename. It publishes only to
`expol1/ride24`, branch `main`, path `travel-guides/<filename>.html`, then
registers the existing `travel_guides` schema. Location assignment is unchanged.
Only the selected HTML file is uploaded: additional images/scripts must be
embedded or available at working URLs (existing site assets can still be used).

## One-time connection

An administrator creates a fine-grained GitHub PAT restricted to **ride24** with
**Contents: Read and write**, then pastes it into the connection form in the
Autoprzewodniki section. The function validates access to the fixed repository
and stores the token encrypted in Supabase Vault. It never returns the token.
Renew the token using this form before its chosen expiration date.

The ChatGPT GitHub connection is separate and cannot serve as a persistent
credential for the live application. Uploads remain disabled until the dedicated
connection has been configured.

## Safety and failure handling

- Supabase Auth verifies the caller; the role is read from protected `profiles`.
- The dedicated Vault RPC is executable only by `service_role` and checks the
  invoking database role. Ordinary users cannot read or change the token.
- Non-admin inserts into `travel_guides` are denied; existing reads are preserved.
- Filenames are validated on the server; client-supplied repository, branch and
  paths cannot redirect publishing outside the fixed directory.
- Existing files are never overwritten. GitHub PUT omits the update SHA.
- A retry may finish registration of a byte-identical file after a database
  failure, without creating another file or deleting anything.
- Uploaded HTML is published as supplied, including its scripts. Administrators
  should upload trusted guides. The admin form never executes an HTML preview.
- The website hosting deployment may take a few minutes after a GitHub commit.
  Successful saving is confirmation of GitHub and database writes, not a claim
  that the hosting deployment has already finished.

Deploy the SQL migration and `admin-travel-guides` function before the frontend.
The source before this change is commit `3caacc62ec0d5714d2ddb078e606ccde5ae9cbfd`.
For frontend rollback restore only `admin/index.html` from that commit. The new
function and narrower insert policy can remain in place; reservations, Android
code and existing guide/location IDs do not need restoring.
