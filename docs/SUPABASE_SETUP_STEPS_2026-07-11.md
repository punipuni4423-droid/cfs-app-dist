# Supabase setup steps - 2026-07-11

## Status

This document is retained as a legacy setup memo. The supported CFS sharing path is now the secure Supabase Function flow documented in `docs/SECURE_SUPABASE_SHARING_V0_1.md`.

Do not place a Supabase Service Role key in `.env.local`, release ZIPs, Git, browser configuration, or user-distributed folders.

## Supported Configuration

Distributed CFS clients may contain only public values:

```env
CFS_SHARING_MODE=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
CFS_SUPABASE_FUNCTION_NAME=cfs-api
```

Privileged values belong only in hosted Supabase Auth/provider settings or Function secrets:

- Microsoft Entra client secret
- `SUPABASE_SERVICE_ROLE_KEY`
- `CFS_REQUIRED_AUTH_PROVIDER=azure`
- `CFS_ENTRA_TENANT_ID` or `CFS_ALLOWED_ENTRA_TENANT_IDS`
- `CFS_ALLOWED_EMAIL_DOMAINS`
- `CFS_BOOTSTRAP_ADMIN_EMAIL`

## Hosted Setup Gate

Do not run hosted SQL, change Supabase Auth settings, deploy Functions, set secrets, rotate keys, or change production memberships without explicit owner approval and a recorded backup.

Minimum hosted steps after approval:

1. Back up current `/api/projects`, `/api/trash`, and the Supabase database.
2. Review `supabase/migrations/20260713195500_add_cfs_secure_sharing.sql`.
3. Enable the Supabase Azure provider for Microsoft Entra.
4. Register every required redirect URL, including exact local/LAN URLs used by CFS.
5. Deploy `supabase/functions/cfs-api`.
6. Set Function secrets listed above.
7. Sign in with the bootstrap Admin Microsoft work account.
8. Add Viewer, Editor, and Admin memberships through CFS **Manage Users**.
9. Run the real two-account/two-PC validation matrix.
10. Remove or rotate bootstrap/legacy credentials after all PCs are migrated and rollback is no longer needed.

## Legacy Direct REST Setup

The older direct REST setup used a Service Role key from `.env.local`. That path is deprecated because it conflicts with the no-secret-distribution contract.

The old helper script now requires an explicit risk acknowledgement:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-supabase-cfs.ps1 -Check -SeedCurrentProjects -AllowLegacyServiceRole
```

Use that only for a disposable legacy migration or one-time recovery after reviewing the risk. It is not the supported production or shared-PC configuration.
