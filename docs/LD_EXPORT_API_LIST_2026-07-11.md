# LD / Lutron Designer Export API List - 2026-07-11

## Status

This is the current official API/reference list for CFS output used by Lutron Designer automation.

The LD bridge export is read-only from CFS. It creates JSON that is validated and consumed by the Lutron Designer side tooling. CFS must not directly write to Lutron Designer databases.

## Required API

### `GET /api/lutron/spec?format=bridge`

Aliases:

- `format=ld`
- `format=lutron-designer`

Purpose:

- Generate LD bridge JSON from saved CFS project data.
- Use this for Lutron Designer import/automation preparation.

Query parameters:

| Name | Required | Description |
| --- | --- | --- |
| `format` | yes | Use `bridge`, `ld`, or `lutron-designer`. |
| `projectId` | no | Project to export. If omitted, the first saved project is used. |
| `roomTypeId` | no | RoomType to export. If omitted, all room types are exported. |

Response:

```json
{
  "bridge": {
    "schemaVersion": "1.0",
    "exportedAt": "2026-07-11T00:00:00.000Z",
    "exportedBy": "CFS",
    "sourceProjectId": "project-id",
    "sourceProjectName": "Project name",
    "sourceRoomTypeIds": ["room-type-id"],
    "mode": "additive",
    "unknownTemplatePolicy": "error",
    "placeName": "Project name",
    "reassignTemplates": false,
    "templateMappings": {
      "_default": "A",
      "a": "A"
    },
    "rooms": [
      {
        "floorName": "CFS Room Types",
        "name": "A",
        "roomType": "a",
        "sourceRoomTypeId": "room-type-id",
        "sourceRoomTypeName": "A",
        "sourceRoomTypeRevision": "1.08"
      }
    ],
    "summary": {
      "rooms": 1,
      "roomTypes": 1,
      "templateMappings": 2,
      "warnings": 1
    },
    "warnings": []
  }
}
```

### `POST /api/lutron/spec`

Purpose:

- Generate LD bridge JSON from a supplied project payload without first saving the project.

Request:

```json
{
  "format": "bridge",
  "project": {},
  "roomTypeId": "room-type-id"
}
```

Response:

```json
{
  "bridge": {}
}
```

Notes:

- `roomTypeIds: string[]` is accepted for POST when exporting multiple room types.
- `roomTypeId` takes precedence when present.

## Bridge Schema Contract

The CFS bridge payload must stay aligned with:

`C:\dev\AI\Lutron Designer\schemas\cfs-lutron-bridge.schema.json`

Required values:

- `schemaVersion: "1.0"`
- `mode: "additive"`
- `unknownTemplatePolicy: "error"`
- `reassignTemplates: false`
- `templateMappings._default`
- `placeId` or `placeName`
- `rooms[]` or `floors[]`

Current CFS output uses flat `rooms[]`.

## Room Number Policy

CFS intentionally stores logical RoomTypes, not actual floor/room-number schedules.

Reason:

- A CFS RoomType is a logic/programming template.
- It does not always match the number of real room types needed for Lutron Designer or project delivery.
- Some real room types can share the same logic template, and some LD-side room/template assignments may need to be grouped or split outside CFS.

Therefore, selected CFS RoomTypes are exported as flat logical template entries under:

`floorName: "CFS Room Types"`

CFS should not add actual room numbers only for LD export. Actual room-number expansion, room list imports, and room-to-template assignment should be handled by the Lutron Designer-side tool or another external schedule/mapping layer.

## Validation

Preferred validation after LD export changes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\dev\AI\Lutron Designer\tools\lutron-designer-poc\Test-CfsLutronBridgeJson.ps1" -InputJson "<generated-json-path>"
```

Expected result:

- `ok: true`
- `errorCount: 0`
- Warnings are acceptable only when documented, such as `place_name_matching` while `placeId` is not configured.

## Sync Rule

Update this file whenever any of these change:

- `/api/lutron/spec` query/body/response format.
- `app/lib/lutronBridgeExport.ts` output fields.
- Lutron Designer bridge schema.
- Room schedule support, template mapping behavior, placeId/placeName behavior, or warning/error policy.
- Project export/import if LD bridge data is expected to survive backup/share workflows.

Task summary line:

`External sync: XC API list <updated/no change>, LD API list updated, Project export <updated/no change>.`

## 2026-07-13 Secure Sharing Update

When `CFS_SHARING_MODE=supabase`, both `GET /api/lutron/spec` and `POST /api/lutron/spec` require:

```http
Authorization: Bearer <Supabase user JWT>
```

- `GET` reads the authenticated user's committed CFS projects through the shared CFS Function; it does not read `data/projects.json` in secure mode.
- `POST` validates the caller before generating a bridge from a supplied payload.
- The LD bridge JSON schema and logical RoomType policy are unchanged.
- Exported JSON never contains Supabase access tokens, public keys, or server secrets.
