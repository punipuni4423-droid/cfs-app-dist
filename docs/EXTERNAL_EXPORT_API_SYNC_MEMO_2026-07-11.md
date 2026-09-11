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

## 2026-09-07 T-92 Low/High End と InspectionMode の共存

- XC API list: no change。Low/High End は既存 DeviceAssignment.lowEnd/highEnd へ独立して確定し、InspectionMark・シーン値の書き戻し契約は変更しない。
- LD API list: no change。target ID・bridge payload は変更しない。
- Project export: no change。保存形式・storage v14・既存の import/export 経路は変更しない。InspectionMode の開始/終了/Revert と Low/High draft の相互非干渉を対象 E2E で確認する。

## 2026-09-07 T-93 統合 Edit と名前セルの設定入口

- XC API list: no change。EditはCFSのUI状態のみ。InspectionMode/LowHighの書き戻しフィールドは既存どおり。
- LD API list: no change。条件メニューは既存source.idを選び、データやtarget IDの形を変更しない。
- Project export: no change。名前セル結合、設定伝播、storage v14、Excel用の列モデルは変更しない。Edit状態やメニュー選択はProject JSONに保存しない。

## 2026-09-08 T-97 All Rooms Excel の Remarks 同梱

- XC API list: no change。Inspection API・データ契約は変更しない。
- LD API list: no change。bridge payload・対象RoomType・logical IDは変更しない。
- Project export: updated (All Rooms Excelのみ)。既存RoomTypeシートの末尾にRemarksを追加する。0件時は省略、同名RoomTypeとの衝突はRemarks側を連番名にする。単一RoomType Excel・Project JSON・Share JSON・storage v14・永続データは不変。
- 内部のread-only CFSウィンドウsnapshotへoptional `projectRemarks`を追加。Sub Window/Fixed WindowのAll Roomsでも同じプロジェクトのRemarksを出力する。旧snapshotの項目欠落は空扱いとし、外部APIには追加しない。

`External sync: XC API list no change, LD API list no change, Project export updated.`

## 2026-09-08 T-102 Remarks単体Excel

- XC API list / LD API list: no change。データ契約・Inspection・target IDは不変。
- Project export: updated (Remarksタブの単体Excel追加のみ)。既存appendRemarksSheetを再利用し `{Project}_Remarks.xlsx` を出力する。All Rooms/単一RoomType Excel・Project/Share JSON・storage v14・内部ウィンドウsnapshotは不変。Remarks Edit/Previewの幅切替はCSSだけで保存値を変更しない。

## 2026-09-08 T-103 Remarksの内容比例幅

- XC API list / LD API list: no change。API・保存データ・logical ID・内部ウィンドウsnapshotは不変。
- Project export: updated (単体/All RoomsのRemarks列幅のみ)。列ごとの48上限を表全体180の幅予算へ変更し、最小8を確保した残り幅を内容量に比例配分する。23列以上は最小幅を優先する。シート共通の列幅であり、レスポンシブなPreviewとのピクセル一致は意図しない。罫線・行高算定・シート構成・単一RoomType Excel・Project/Share JSON・storage v14は不変。

## 2026-09-09 T-107 ストレージ移行保護（実装中・仕様確認待ち）
- XC API list / LD API list / Project・Share JSON / Excel: 形式変更なし。正常実データの移行結果SHA256は旧実装と一致。
- Projects API: GETにmigrationReport追加。POSTの縮小を409 MIGRATION_CONFIRMATION_REQUIREDで拒否し、確認後に同じ本文+返されたmigrationConfirmationで再送。既存の競合チェックは維持。詳細: MIGRATION_SAFETY_JA.md。
- 全件不正roomScenesの再読込時の扱いはユーザー判断待ち。未完了・未コミット・未配布。

- 2026-09-09 T-107追記: 上記の仕様確認待ちはMaster裁定で解消。当該読込中の除外後空Sceneだけ保持し、正常空配列の既定生成は維持。形式変更なし、最終34spec PASS。独立V-71未実施・未配布。

## 2026-09-09 T-108 全APIの接続認証
- XC/LDを含む全APIクライアントはCFS接続cookieまたはx-cfs-access-tokenが必要。localhostも免除なし。Supabase Authorizationは引き続き併用する。自己更新/強制ロック解除/タブレット招待発行はPC管理者セッションに限定。
- ランチャーは資格情報を初期リンクからcookieへ交換する。詳細とCLI連携はAPI_ACCESS_JA.md。既存のExcel/Project・Share JSON/XC/LD出力のデータ形式は不変。
- ローカルTrash GETのupdatedAtをPOSTのexpectedUpdatedAtで返す。古い/欠けた世代は409/TRASH_CONFLICT。Supabase Trashは既存Edge Functionに委譲。

## 2026-09-10 T-116 改名・一覧保存の安全化
- Projects API: POST /api/projects/renameはprojectId・name・expectedUpdatedAtで対象IDのみ改名。POST /api/projectsの一覧保存はexpectedUpdatedAts（既存IDは取得時token、新規/復元は明示null）を必須とし、送信外IDは保持。確定後の更新tokenを応答する。削除はT-115専用APIのみ。
- Edge: project.rename / projects.mergeを追加、旧projects.saveとsave_cfs_project_set RPCを拒否。SQL migration→Edge→appの適用順。新Edge未適用時は新appの改名/一覧保存は失敗し、旧RPCへのfallbackなし。
- XC API list / LD API list / Project・Share JSON / Excel / storage v14: データ形式は不変。外部クライアントが一覧書込みを利用する場合だけ新CAS契約への対応が必要。
