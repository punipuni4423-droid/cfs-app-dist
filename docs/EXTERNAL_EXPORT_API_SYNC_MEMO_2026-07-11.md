# External Export / API Sync Memo - 2026-07-11

## Purpose

CFS updates often change project data, CFS output cells, inspection targets, or export payloads. When that happens, external consumers must be updated together so XC inspection, Lutron Designer export, and project backup/export stay consistent.

## Always Update Together

When an update changes any of the following:

- `ProjectData`, `RoomType`, `CircuitEntry`, `DeviceAssignment`, `Scene`, `RoomScene`, `SwitchEntry`, HVAC, Backlight, or `InspectionMark` shape
- CFS table target IDs, display columns, hidden column rules, or InspectionMode writeback rules
- `/api/projects`, `/api/lutron/spec`, import/export JSON, share export, or Excel export behavior
- LD export schema or payload generation

then update and verify these three areas in the same task:

1. XC inspection tool API list
   - Current file: `docs/XC_INSPECTION_API_LIST_2026-07-11.md`.
   - Record any changed endpoint, payload field, enum, target ID, or response shape used by the XC inspection tool.
   - Include CFS InspectionMode values, inspection marks, source target IDs, and revision behavior when touched.
   - If no API change is needed, explicitly note "XC API list: no change" in the task summary.

2. LD / Lutron Designer export API list
   - Current file: `docs/LD_EXPORT_API_LIST_2026-07-11.md`.
   - Keep the LD bridge JSON contract aligned with `C:\dev\AI\Lutron Designer\schemas\cfs-lutron-bridge.schema.json`.
   - Update `app/lib/lutronBridgeExport.ts`, `/api/lutron/spec?format=bridge`, and related tests together.
   - Validate generated JSON with `C:\dev\AI\Lutron Designer\tools\lutron-designer-poc\Test-CfsLutronBridgeJson.ps1` when practical.

3. Project export / share export
   - Confirm project-level Export, Export All, Import Data, and RoomType Share Export still preserve the changed data.
   - If the saved data shape changed, update migration logic and old backup compatibility.
   - Confirm `/api/projects` before/after project count and key project IDs/names are unchanged unless the task intentionally migrates data.

## Required Summary Line

For future CFS changes that touch data, API, or export behavior, include this line in the final report:

`External sync: XC API list <updated/no change>, LD API list <updated/no change>, Project export <updated/no change>.`

## Current State

- LD bridge export exists via `app/lib/lutronBridgeExport.ts`.
- LD bridge API exists via `/api/lutron/spec?format=bridge` and aliases `format=ld` / `format=lutron-designer`.
- Current LD bridge output is read-only, additive, and uses `reassignTemplates: false`.
- CFS intentionally does not store actual floor/room-number schedules. LD bridge export emits selected logical RoomTypes under `CFS Room Types`; actual room-number expansion and room-to-template assignment must be handled outside CFS.
- Shared view/edit mode adds optional `ProjectData.lastUpdatedBy` metadata and `/api/collaboration/*` endpoints. Project export/share export should preserve `lastUpdatedBy`; LD bridge export does not consume it.
- XC inspection API list is represented in `docs/XC_INSPECTION_API_LIST_2026-07-11.md`.
- LD / Lutron Designer API list is represented in `docs/LD_EXPORT_API_LIST_2026-07-11.md`.

## 2026-07-11 Shared View/Edit Update

- XC API list: updated for optional `ProjectData.lastUpdatedBy`, `POST /api/projects` `lastUpdatedBy` response metadata, and collaboration status/lock endpoints.
- LD API list: no change. LD bridge JSON remains logical RoomType export only.
- Project export: updated by preserving optional `ProjectData.lastUpdatedBy` through storage migration and JSON backup/share export.

## 2026-07-13 Revision Completion and History Readability Update

- XC API list: updated. No endpoint or payload shape changed; the shared edit completion rule now requires a saved RoomType revision before releasing an edit lease with unpublished changes.
- LD API list: no change. LD bridge JSON does not consume collaboration state or revision memo text.
- Project export: no change. Revision snapshots and their existing stored fields remain export-compatible; only the UI presentation of update history changed.

## 2026-07-13 Secure Supabase Sharing Update

- XC API list: updated. In secure sharing mode, `/api/projects` requires `Authorization: Bearer <Supabase user JWT>`; unauthenticated reads are denied and write identity comes from Supabase Auth rather than browser-supplied headers.
- LD API list: updated. `/api/lutron/spec` requires the same JWT in secure sharing mode and reads committed shared projects instead of the local JSON file.
- Project export: updated. The distribution template contains only public Supabase configuration; release packaging audits for Service Role keys. Project JSON shape remains compatible and does not contain authentication tokens.

`External sync: XC API list updated, LD API list updated, Project export updated.`
