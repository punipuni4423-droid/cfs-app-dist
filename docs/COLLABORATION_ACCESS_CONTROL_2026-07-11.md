# CFS Shared View / Edit Mode - 2026-07-11

## Current Scope

CFS starts in view-only mode when collaboration is enabled.

Users register a lightweight profile with:

- display name
- optional email
- browser-local user id
- browser-session session id

This is for identifying editors and last saved users. It is not strict authentication.
When an unregistered local user chooses `Start Editing`, the profile dialog opens first; after a successful display-name registration, the app immediately acquires the edit lease and enters edit mode.

## Edit Lease

- One CFS editor can hold the global edit lease at a time.
- The lease is for the whole CFS project list because `/api/projects` currently saves all projects as one payload.
- Lease duration defaults to 90 seconds.
- The browser refreshes the lease by heartbeat every 20 seconds while editing.
- If there is no activity for 15 minutes and there is no unpublished RoomType change, the app releases the lease and returns to view-only mode.
- If the active RoomType has unpublished changes, the app keeps the lease and opens the same revision-confirmation dialog used by Finish Editing. The editor must save a new revision or continue editing; it cannot silently leave a shared local draft behind.
- Since 2026-08-18, leases are project-scoped (`project:<id>`). Editing one project does not block other projects. A workspace-scope lease (editing with no project open) still blocks everything, protecting project-list operations.
- Since 2026-08-20, a blocked user can recover from a stuck lease with `Force Unlock` (secure mode: Admin role only; local mode: any registered user). The action removes only the blocking lease after an explicit confirmation; the single-editor guarantee per scope is unchanged. Use it when another machine's session holds the lease but is unreachable (e.g. a browser left open elsewhere).

## Revision Completion Rule

- Finishing an edit session with no unpublished RoomType change releases the lease immediately.
- Finishing an edit session with unpublished RoomType changes opens a confirmation dialog.
- `Save Revision & Finish` saves the new revision to the shared store while the editor still owns the lease, then releases the lease.
- `Continue Editing` closes the dialog without changing the lease.
- Shared edit mode intentionally does not offer `Finish with local draft`. This prevents a later editor's revision from being hidden or overwritten by an older browser-local draft.

## View-Only Mode

Allowed:

- open projects and room types
- navigate tabs
- change display/view settings
- export project, share export, and LD export
- app update controls

Blocked:

- create, rename, delete, duplicate, or restore projects/room types
- edit CFS source data
- save new revisions
- InspectionMode writeback
- trash mutations

## API

Collaboration endpoints:

- `GET /api/collaboration/status?userId=<id>&sessionId=<id>`
- `POST /api/collaboration/users/register`
- `POST /api/collaboration/lock/acquire`
- `POST /api/collaboration/lock/heartbeat`
- `POST /api/collaboration/lock/release`

Shared UI saves send:

- `X-CFS-User-Id`
- `X-CFS-Session-Id`
- `X-CFS-Require-Edit-Lock: 1`

When the required edit lease is missing or owned by another user, `/api/projects` and `/api/trash` return `423 Locked`.

## Storage

Phase 1 stores collaboration users, the active lock, and global last-saved metadata in:

`data/collaboration.json`

Project data may also include optional:

```ts
lastUpdatedBy?: {
  userId: string;
  displayName: string;
  updatedAt: string;
}
```

Older project exports can omit this field.

## Next Step

When project-level concurrent editing is needed, split `/api/projects` from one list payload into project-level records. After that, the edit lock can use `project.id` as the scope instead of the current global `cfs-projects` scope.

For stricter identity or permission control, add Supabase Auth or another external auth layer. The current display-name registration should not be treated as proof of identity.
