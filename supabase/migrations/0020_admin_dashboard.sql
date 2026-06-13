-- Admin monitoring dashboard storage (private, owner-only).
--
-- The dashboard build workflow (dashboard/app.py → dashboard/upload.py) renders
-- a static HTML file from the dbt marts in MotherDuck and uploads it here with
-- the service key. The SPA's /admin route downloads it with the signed-in
-- owner's session and renders it in an iframe.
--
-- Access model mirrors the existing "members-only resale intelligence" gates
-- (0008): the data never ships in the public bundle — it lives in this PRIVATE
-- bucket, readable only by the owner via a Storage RLS policy keyed on the JWT
-- email claim. Anyone else (logged out, or a different signed-in user) reads
-- zero objects. The service/secret key used by the workflow bypasses RLS, so no
-- write policy is needed.

-- Private bucket (public = false → no anonymous object access).
insert into storage.buckets (id, name, public)
values ('admin-dashboard', 'admin-dashboard', false)
on conflict (id) do update set public = false;

-- Only the owner (by email claim) can read objects in this bucket. We gate on
-- the email rather than a hardcoded user id so the policy survives a user
-- being recreated, and stays readable.
drop policy if exists "admin dashboard owner read" on storage.objects;
create policy "admin dashboard owner read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'admin-dashboard'
  and (auth.jwt() ->> 'email') = 'swanson.anders@gmail.com'
);
