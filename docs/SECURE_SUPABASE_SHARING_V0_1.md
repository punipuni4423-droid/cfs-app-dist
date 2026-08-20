# CFS Secure Supabase Sharing v0.1

## Purpose

This mode lets multiple PCs view the same committed CFS revisions without putting a Supabase Service Role Key in CFS, Git, a ZIP file, browser storage, or logs.

- Drafts remain on the editing PC in browser storage.
- A completed Revision is saved to Supabase through the `cfs-api` Edge Function.
- Microsoft Entra sign-in through the Supabase Azure OAuth provider identifies the user.
- CFS authorizes access by matching the verified Entra email address to an active Admin-managed `cfs_memberships` record.
- Roles are `Viewer`, `Editor`, and `Admin`.
- The initial implementation uses one CFS-wide edit lease. This prevents loss caused by the existing whole-project-list save format. Project-level parallel editing is the next migration step and must split the save payload first.

## Security Model

| Item | Rule |
| --- | --- |
| Browser and distributed CFS folder | Contains only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the Function name. |
| Supabase Auth provider secrets | Holds the Microsoft Entra client secret for the Azure provider. |
| Supabase Function secrets | Holds `SUPABASE_SERVICE_ROLE_KEY`, `CFS_REQUIRED_AUTH_PROVIDER=azure`, optional tenant/domain allow-lists, and the one-time bootstrap Admin email. |
| Database tables | RLS is enabled and direct `anon`/`authenticated` table access is revoked. |
| Reads and writes | Require a Supabase JWT created by Microsoft Entra sign-in and an active matching email in `cfs_memberships`. |
| Save | Requires an Editor/Admin lease and runs atomically in Postgres. |
| Deleted project data | Is soft-deleted in `cfs_projects`; the shared trash is stored separately. |

## Local Development Configuration

Keep the current local mode until the hosted migration is approved.

```env
CFS_SHARING_MODE=local
```

After the approved migration and Function deployment, a distributed CFS PC uses only:

```env
CFS_SHARING_MODE=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
CFS_SUPABASE_FUNCTION_NAME=cfs-api
```

Do not add `SUPABASE_SERVICE_ROLE_KEY` to this file.

## Hosted Supabase Deployment Gate

Do not run these steps until an owner explicitly approves the database change and has reviewed the backup.

1. Save the current `/api/projects` and `/api/trash` responses. The implementation backup for this change is under `artifacts/secure-sharing/backup-20260713-1955`.
2. Export a Supabase database backup from the dashboard and record its timestamp.
3. Review `supabase/migrations/20260713195500_add_cfs_secure_sharing.sql`.
4. Apply the migration to a disposable or development Supabase project first.
5. Enable the Supabase Auth Azure provider for Microsoft Entra, register every CFS URL used for OAuth redirects, and keep the Entra client secret only in Supabase/provider settings.
6. Deploy `supabase/functions/cfs-api`.
7. Set Function secrets: `CFS_REQUIRED_AUTH_PROVIDER=azure`, the approved tenant/domain allow-list such as `CFS_ENTRA_TENANT_ID` or `CFS_ALLOWED_EMAIL_DOMAINS`, and `CFS_BOOTSTRAP_ADMIN_EMAIL` for the first administrator. Do not set these secrets in any distributed CFS `.env` file.
8. Set the three public values above on one test PC, sign in with the bootstrap Microsoft work account, then use **Manage Users** to add other email addresses and roles.
9. Test Viewer read-only access, Editor save, Admin membership changes, wrong provider rejection, wrong tenant/domain rejection, expired lock behavior, and a second PC.
10. Remove or rotate the bootstrap email secret after the first active Admin has been confirmed, then keep the prior Service Role Key active only until all old PCs are migrated.

## Roles

- **Viewer**: signed-in read-only access and export.
- **Editor**: Viewer access plus shared edit lease and Revision save.
- **Admin**: Editor access plus user registration, activation, and role changes.

An Admin must add an email address before that person can access project data. The person then signs in with the matching Microsoft work account. The last active Admin cannot be disabled or downgraded.

## Microsoft Entra Sign-in

- The CFS client starts Supabase OAuth with `provider: "azure"` and may pass the typed email as a Microsoft `login_hint`.
- The Edge Function verifies the Supabase session server-side with `admin.auth.getUser(token)`.
- The Edge Function rejects sessions that were not created by the Azure provider. If tenant allow-list secrets are configured, the Entra tenant claim must also match.
- Email addresses are normalized before membership lookup. A matching active membership can bind to the Supabase `auth_user_id` on first successful sign-in.
- Secrets stay in Supabase Auth/provider settings or Function secrets. They are not copied into CFS, release ZIPs, browser storage, Git, logs, or documentation.

## Rollback

1. Set `CFS_SHARING_MODE=local` on affected PCs and restart CFS.
2. Restore `data/projects.json` and `data/trash/trash.json` from the recorded local backup if required.
3. Restore the Supabase database backup only after comparing project IDs/names with `scripts/compare-project-state.mjs`.
4. Do not revoke the old Service Role Key until all PCs have been verified against the new mode.

## Validation Commands

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-release-secrets.ps1 -Path <release-folder>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-release-archive.ps1 -ArchivePath <release.zip>
node scripts\compare-project-state.mjs <before.json> <after.json>
```

The RLS, OAuth provider, tenant rejection, and cross-PC matrix cannot pass until the hosted migration is approved and a second PC is available.
