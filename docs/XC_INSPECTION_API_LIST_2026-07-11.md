# XC Inspection Tool API List - 2026-07-11

## 2026-11-02 不正参照の隔離（ローカル候補・未配布）

Project JSONの`tstatBindingQuarantine`は原値を保全する任意metadataです。未知wrapperも存在する限り非活性とし、XC制御値/targetや通常表示へrawを転用しません。raw内IDを修復/再接続せず、今版に自動解除を追加しません。既XC endpoint/target ID/CAS契約を変更せず、外部XC実機は未検証です。旧版の非活性保証はないため、戻す前にバックアップしてください。

## 2026-11-02 Text互換性の補足（ローカル候補・未配布）

XCのProject payloadでは`percentage`本文と任意の`valueMode`を一体で保持します。別契約のLutron specではText時だけ`valueMode: "text"`を付け、`value`本文へ単位/%を加えません。XCのtarget ID/CAS契約は変更しません。管理TSTAT参照IDを表示TH番号へ置換する変更は行いません。外部consumer実機でのText読書き・追加field受入は未検証です。

## 2026-10-27 Text設定の追加（ローカル候補・未配布）

endpoint/target ID/CAS契約の変更はありません。設定の`percentage`はstringのままで、任意の`valueMode: "text"`は本文を数値化せず扱うことを示します。InspectionMarkには任意の`valueMode`/`previousValueMode`が加わります。欠落は従来のStandardです。CFS内の書戻し・Undo/Cancelは本文とmodeを保持します。XC実クライアントのText読書きは未検証です。

### TSTAT共通制御の追補（開発local確認済み・未配布）

TH表示番号は任意の`HvacAssignment.thermostatNumber`と`RoomType.nextThermostatNumber`で管理し、既HVAC target IDは変更しません。任意の`SwitchEntry.tstatBinding: { areaId, assignmentIds }`で同Areaの登録TSTATと既Switch設定を結びます。旧データは表示だけで書込生成せず、未Area・孤立/競合設定の適用状態を区別します。外部consumerで任意metadataを欠落させない互換確認が必要で、XC実クライアントからの読書き・実機制御は未検証です。詳細は[互換メモ](EXTERNAL_EXPORT_API_SYNC_MEMO_2026-07-11.md)のTSTAT共通制御の追補を参照してください。

## Status

2026-10-28開発候補では任意`HvacAssignment.masterAssignmentId`で同RoomTypeの物理Master参照を保持します。既HVAC target ID/CASとArea占有bindingは不変更です。欠落/無効参照を別Masterへ自動変更せず、consumer更新で任意参照を落とさない確認が必要です。Programming Nameの50文字超警告はUI/Excel書式だけで、本文やAPI値へ警告文を混ぜません。実XC読書きは未検証です。

This is the current official API/reference list for an external XC inspection tool that reads CFS data.

There is no dedicated XC inspection endpoint yet. Until one is added, the XC tool should treat CFS project data as the source of truth and read it through `/api/projects`.

## Required API

### `GET /api/projects`

Purpose:

- Read all CFS projects available to the local/server instance.
- Extract RoomType, CFS source data, revision state, and inspection marks for external inspection.

Response:

```json
{
  "projects": [
    {
      "id": "project-id",
      "name": "Project name",
      "updatedAt": "2026-07-11T00:00:00.000Z",
      "lastUpdatedBy": {
        "userId": "user-id",
        "displayName": "Display Name",
        "updatedAt": "2026-07-11T00:00:00.000Z"
      },
      "locations": [],
      "fixtures": [],
      "circuits": [],
      "roomTypes": []
    }
  ]
}
```

External use:

- Read only by default.
- Use `project.id` and `roomType.id` as stable keys for reports.
- Treat `project.lastUpdatedBy` as optional metadata for the last saved editor. Older exports may omit it.
- Use `roomType.revision` and `roomType.revisions[]` to identify the inspected revision.
- Use `roomType.inspectionMarks[]` to identify cells already marked by InspectionMode.
- In shared edit mode, treat a revision as published only after `Save Revision & Finish` or `Save as New Revision` completes. An editor with unpublished RoomType changes keeps the edit lease until the revision is saved or editing continues.

### `POST /api/projects`

Purpose:

- Save the complete project list.

XC use policy:

- The XC inspection tool should not call this endpoint unless a future task explicitly defines a writeback workflow.
- This endpoint replaces the saved project list with the submitted `projects[]` after migration validation.
- If used, the caller must preserve every unrelated project and every unchanged field.

Request:

```json
{
  "projects": []
}
```

Response:

```json
{
  "ok": true,
  "projects": [],
  "lastUpdatedBy": {
    "userId": "user-id",
    "displayName": "Display Name",
    "updatedAt": "2026-07-11T00:00:00.000Z"
  }
}
```

When CFS UI saves shared data in edit mode, it sends these headers:

- `X-CFS-User-Id`
- `X-CFS-Session-Id`
- `X-CFS-Require-Edit-Lock: 1`

If the edit lease is missing or owned by another user, CFS returns `423 Locked`.

### Collaboration endpoints

These endpoints support the CFS shared view/edit workflow. They are not inspection data endpoints, but an XC tool may read them to show current editing status.

- `GET /api/collaboration/status?userId=<id>&sessionId=<id>`
- `POST /api/collaboration/users/register`
- `POST /api/collaboration/lock/acquire`
- `POST /api/collaboration/lock/heartbeat`
- `POST /api/collaboration/lock/release`

## Inspection Data Fields

### `RoomType.inspectionMarks[]`

Each saved inspection mark currently uses:

```ts
{
  id: string;
  sourceType: "areaScene" | "roomScene" | "switch";
  sourceId: string;
  targetId: string;
  scope: "areaScene" | "override";
  label: string;
  previousValue: string;
  value: string;
  markedAt: string;
}
```

Interpretation:

- `sourceType` and `sourceId` point to the source record changed during InspectionMode.
- `targetId` identifies the CFS target/cell affected by the inspection edit.
- `previousValue` is the value before the inspection change.
- `value` is the saved inspection value.
- `scope` shows whether the edit remained linked to Area Scene or became an override/direct value.

## Related CFS Source Data

The XC inspection tool should expect these linked source records:

- `ProjectData.locations[]`: area/location master records.
- `ProjectData.circuits[]`: circuit rows, detail, area, designer number, fixture, and flags.
- `RoomType.deviceAssignments[]`: device/zone/address assignments.
- `RoomType.scenes[]`: Area Scene settings.
- `RoomType.roomScenes[]`: Room Scene settings and Area Scene selections.
- `RoomType.switches[]`: Switch, CCI, CCO, Palladiom, Pico, PIR, QSM, Command, and Backlight references.
- `RoomType.hvacAssignments[]` and `RoomType.hvacSeasons[]`: HVAC source data.
- `RoomType.pduDeviceCounts[]`: PDU source data.

## Sync Rule

Update this file whenever any of these change:

- InspectionMode target IDs, source types, scopes, or saved mark behavior.
- CFS target catalog, Link Map, CFS row generation, or CFS display/writeback rules.
- `ProjectData` or `RoomType` shapes used by inspection.
- `/api/projects` read/write behavior.
- Project export/import format if the XC tool consumes exported JSON instead of the API.

Task summary line:

`External sync: XC API list updated, LD API list <updated/no change>, Project export <updated/no change>.`

## 2026-07-13 Secure Sharing Update

When `CFS_SHARING_MODE=supabase`, XC must send a Supabase Auth access token on every CFS API call:

```http
Authorization: Bearer <Supabase user JWT>
```

- Unauthenticated callers receive `401` and must not receive project or trash data.
- The user email must be an active `Viewer`, `Editor`, or `Admin` membership.
- `GET /api/projects` reads the committed shared Revision state through the CFS Edge Function, not a local JSON file.
- `POST /api/projects` requires an `Editor` or `Admin` plus the active CFS edit lease. Browser-supplied `X-CFS-User-Id` headers are ignored for secure sharing.
- Existing XC payload fields remain unchanged. Access control is the only contract addition in this version.
