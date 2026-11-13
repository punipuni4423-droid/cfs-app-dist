# LD / Lutron Designer Export API List - 2026-07-11

## 2026-11-02 隔離された制御（ローカル候補・未配布）

不正なTSTAT参照は元のJSON値を保持して非活性に隔離します。Lutron specの通常Switch出力には隔離制御を含めず、識別warningを返します。forensic raw/previousQuarantineをLD payloadへ追加しません。Project JSONでの保全とLD bridge契約は別です。旧版は隔離を認識しないため、戻す前のバックアップが必要です。実LD consumer確認は未実施です。

## 2026-11-02 Text出力metadata（ローカル候補・未配布）

Lutron specのlevels/directLevels/circuitOverridesは、Text時だけ任意の`valueMode: "text"`を出力します。既存`value`本文は空白・改行ごとそのままで、単位や%を付けません。mode欠落はStandard、schemaVersionは1を維持します。Commandの`switchNumber`は既存machine referenceを保持し、TH表示名への破壊的置換はconsumer契約未確認のため見送っています。LD実クライアントでの追加field受入・実機適用は未検証です。

## 2026-10-27 Text設定の追加（ローカル候補・未配布）

endpoint/target ID/bridgeの変更はありません。CFS内部には任意の`valueMode: "text"`が加わりますが、既存Lutron specの設定値は従来どおりstringの本文を保持します。自由記述を条件式や機器の制御値として解釈する新処理はありません。LD側での自由記述受入・実機適用は未検証です。プロジェクトExcelは閲覧用であり、LD bridge JSONを置換しません。

### TSTAT共通制御の追補（開発local確認済み・未配布）

TH表示番号とArea共通制御のbindingはCFS内部の任意metadataです。機器ID・既HVAC metric target ID・LD bridgeを置換しません。TSTAT/Project ExcelのTH表記は表示の追加であり、LD側で人感イベント動作が登録・検証された意味ではありません。画像固有preset・LD実クライアント・実機動作は未確認です。保存互換性の詳細は[互換メモ](EXTERNAL_EXPORT_API_SYNC_MEMO_2026-07-11.md)のTSTAT共通制御の追補を参照してください。

## Status

2026-10-28開発候補ではSlaveの物理Master参照は任意`HvacAssignment.masterAssignmentId`で保持し、TH表示やArea占有bindingと分離します。既LD bridge/target IDは不変更です。Programming Nameは本人指定の50文字を超える場合にCFS/Excelで赤太字警告を表示しますが、値の切捨てや出力禁止は行いません。code point数での表示警告であり、LD実consumer/実機での入力検証や制御登録を実施した意味ではありません。

This is the current official API/reference list for CFS output used by Lutron Designer automation.

The LD bridge export is read-only from CFS. It creates JSON that is validated and consumed by the Lutron Designer side tooling. CFS must not directly write to Lutron Designer databases.

### 2026-10-02 Programming Nameの生成規則

通常の`/api/lutron/spec`の`zones[].programmingNames`は、設定でAreaの直後にAddressがある場合、一つのArea Addressとして括弧・区切りを付けます（例：`[BM1]`、括弧なしなら`BM1`）。Areaコードの重複回避後の実Area Addressを使用し、単独・逆順・非隣接の設定、OtherのLocation Number/99規則は保持します。CFS画面・Excelと同じ規則です。保存schema・target ID・`format=bridge`のJSON契約は変更しません。

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
