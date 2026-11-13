# External Export / API Sync Memo - 2026-07-11

## 2026-11-02 不正TSTAT参照の保全（ローカル候補・未配布）

- 不正な`tstatBinding`は行と設定を残し、`{areaId:"",assignmentIds:[]}`と任意`tstatBindingQuarantine:{version:1,reason:"invalid-binding",raw:元JSON値}`へ隔離する。既quarantineもある場合、今回bindingをraw、元quarantine全体を任意`previousQuarantine`に一度保持する。未知/不正wrapperも存在自体を非活性の根拠とし、正常bindingやlegacy missingを勝手に修復しない。
- Project/Share JSONとRoomType copyはforensic内容を保持する。raw/previous内IDを再帰remapせず、通常UI/Excel/LD/XCへrawを新たに露出しない。Lutron specは隔離制御を通常switch出力から除外し、英語warningだけを返す。Project Excelでは隔離・非活性を識別する。
- 初回の行単位隔離はrepaired1/excluded0を報告し、明示保存のreviewを経る。正規sentinel+wrapperの再読は再包装/reportを追加しない。他の必須型不正・配列損失・CAS・空serverの規則は維持する。今版は自動修復/再接続/解除/削除操作を追加しない。
- 旧26.10.7は隔離の非活性概念を認識しない。旧版roundtripでJSON情報が残っても旧版の制御安全性を保証しない。戻す前に必ずバックアップする。外部consumer実機確認は未実施。

## 2026-11-02 出力のText metadata（ローカル候補・未配布）

- Lutron specのArea Scene levels / Room Scene directLevels / Switch circuitOverridesは、Text時だけ任意の`valueMode: "text"`を出力する。欠落はStandard。`value`は既存の本文stringをそのまま転記し、前後空白・改行を保持し、単位や%を付けない。schemaVersion 1と既存fieldを維持する。外部consumerが追加fieldを受け入れる実機検証は未実施。
- Commandの`switchNumber`は既存machine referenceを保持する。管理TSTATのTH表示ラベルへの破壊的置換は、外部consumer契約が未確認のため見送り。UI用ラベル解決と保存参照IDを混同しない。
- 26.10.7へ戻す場合は先にバックアップする。旧版で保存すると`thermostatNumber` / `masterAssignmentId` / `nextThermostatNumber` / `InspectionMark.valueMode`等の新しい情報を保持できない場合がある。新版の修正で旧版の読込処理が変わるわけではない。

## 2026-10-27 Scene Text互換性（ローカル候補・未配布）

- `SceneCircuitSetting`へ任意の`valueMode: "text"`を追加。欠落は従来のStandard。`percentage`はstringのまま、Textは条件別値の文字併記であり実機制御式ではない。InspectionMarkは任意の`valueMode`/`previousValueMode`を保持する。
- Project/Share JSONは既存保存経路で任意modeと複数行本文を保持する。旧データを移行書込みする必要はない。設定リンク/コピー/回路グループ同期は本文とmodeを一体で運ぶ。
- XC APIのendpoint/target ID/CAS契約は不変更。設定を編集する外部consumerは、TextをparseFloatや単位削除で変換しないこと。XC実クライアントのText対応は未検証。
- LD/Lutron specは既存string値の転送を維持する。Textを条件式/機器値へ変換する新処理はない。LD側の自由記述受入は未検証であり、自動適用の成功とは扱わない。
- Excelは文字列/richTextとしてTextと改行を保持し、式として解釈しない。PMS/DoorMagnetの見出し分離、TSTAT、Project (All Tabs)はExcel表示/構成の追加で、復元用JSONを置換しない。
- Project (All Tabs)は開始時のプロジェクトsnapshotを出力し、未確定Inspection/LowHighドラフトは含めない。必要な値は先に確定する。出力操作による自動保存・Revision作成はない。Mixed Inspectionのモードのみ変更では各本文を保持し、本文の空入力とは別操作にする。

## 2026-10-27 TSTAT Area共通制御の互換性（開発local確認済み・未配布）

- `HvacAssignment.thermostatNumber`、`RoomType.nextThermostatNumber`、`SwitchEntry.tstatBinding: { areaId, assignmentIds }`を任意metadataとして追加。TH表示番号は保存IDや`hvac:<id>:metric` target IDの代用ではない。既endpoint/target ID/CAS契約は変えない。
- Master/Slaveとも登録連動の対象とし、同Areaは既`kind:tstat`のswitchGroupと設定1組を共有する。Area未設定・所属機器のない保存設定・競合グループは適用状態を区別し、移動/削除で元設定を消さない。旧データの表示だけで空設定を書込生成しない。
- CFSの保存/再読込・Room copy・Undo/Revision復元は番号予約とbindingを保持する。外部consumerの読書きは未検証のため、これら任意metadataを落とす更新を安全とみなさない。XC/LD実クライアントの対応や物理制御の成功を表すものではない。
- TSTAT/Project ExcelのNoと既知Command参照はTH表示へ解決する。Excelは閲覧用で復元用JSONを置換しない。参照画像のpresetは未確認のため、初期枠は空の設定を基準にし、画像固有のFunction/Trigger/時間・値を推測しない。通常利用環境への反映・公開は未実施。

## 2026-10-28 Master参照・表示追補（開発候補・未配布）

- 任意`HvacAssignment.masterAssignmentId?: string`は同RoomTypeのMaster機器IDを保存する。TH表示番号やArea共通occupancy bindingとは別。旧欠落を自動連結せず、既無効参照は保持/警告する。新選択は自己/Slave/不明/重複IDを拒否し、protocol/Areaの独自制限は加えない。
- storage/Project/Share JSONとRevisionは任意参照を保持し、RoomType copyで既知assignment IDをremapする。既endpoint/target ID/CASは変えず、外部consumerが任意参照を落とす更新の互換性は未検証。
- TSTAT/Project Excelは既列を保持してReference Master列を追加しTHだけへ解決する。CFSのDevice表示はThermostat、Slave説明はMaster: TH1程度とし、物理assignment単位でAreaを結合する。登録/役割/Area/動作設定のUIはSwitch > Thermostatへ集約するが、保存型/内部ID/metric targetは変更しない。Door表示は`Door Magnet Scene`へ統一するが保存group keyは変更しない。
- Programming Nameの50文字超警告は解決済み本文のcode point数に対する表示だけ。名前/テンプレ/target/保存契約/操作権限は不変更、Excelは本文と赤太字だけを出力し警告文は含めない。XC/LD実consumer、実機、通常利用環境への反映/公開は未実施。

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

### 2026-10-02 Programming NameのArea Address

- XC API list: no change。保存schema・target ID・Inspection書戻しは不変。
- LD API list: updated。通常のLutron specの`zones[].programmingNames`は、隣接するArea→Addressを一要素として出力（`[BM][1]`から`[BM1]`）。単独・逆順・非隣接の設定とOtherのLocation Number/99規則を保持。bridge JSONの形とRoomType対応は不変。
- Project export: updated（CFS/All Rooms/Area Scene一覧のExcelの導出Programming Nameのみ）。Project/Share JSON、保存token配列、storage v14に変更なし。実共有DBには接続せず合成入力で検証する。

`External sync: XC API list no change, LD API list updated, Project export updated.`

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
- XC/LDを含む全APIクライアントはCFS接続cookie（T-144: `cfs-access-v2-p<port>`、旧名読取は固定期限まで）またはx-cfs-access-tokenが必要。localhostも免除なし。Supabase Authorizationは引き続き併用する。自己更新/強制ロック解除/タブレット招待発行はPC管理者セッションに限定。
- ランチャーは資格情報を初期リンクからcookieへ交換する。詳細とCLI連携はAPI_ACCESS_JA.md。既存のExcel/Project・Share JSON/XC/LD出力のデータ形式は不変。
- ローカルTrash GETのupdatedAtをPOSTのexpectedUpdatedAtで返す。古い/欠けた世代は409/TRASH_CONFLICT。Supabase Trashは既存Edge Functionに委譲。

## 2026-09-10 T-116 改名・一覧保存の安全化
- Projects API: POST /api/projects/renameはprojectId・name・expectedUpdatedAtで対象IDのみ改名。POST /api/projectsの一覧保存はexpectedUpdatedAts（既存IDは取得時token、新規/復元は明示null）を必須とし、送信外IDは保持。確定後の更新tokenを応答する。削除はT-115専用APIのみ。
- Edge: project.rename / projects.mergeを追加、旧projects.saveとsave_cfs_project_set RPCを拒否。SQL migration→Edge→appの適用順。新Edge未適用時は新appの改名/一覧保存は失敗し、旧RPCへのfallbackなし。
- XC API list / LD API list / Project・Share JSON / Excel / storage v14: データ形式は不変。外部クライアントが一覧書込みを利用する場合だけ新CAS契約への対応が必要。

## 2026-09-14 CCO照明割付（実装・検証中、未配布）

- Project/Share JSON: DeviceAssignmentへ任意の`ccoLighting: true`を追加。欠落・falseは従来のDry Contact。既存`circuitNumber`と`additionalCircuitNumbers`/`zoneDetail`を再使用し、Circuit IDや設定値を移設時に作り直さない。旧schemaのJSON読込・コピーで任意フィールドが保持されることを合成データで確認。
- CFS/XCの照明設定対象は既存Circuit IDを使用。照明CCOに`cco:{assignmentId}`を重ねて生成しない。従来の接点CCO/CCI targetとInspectionの書戻し契約は維持。XC実クライアントの動作確認は未実施。
- LD/Lutron spec: 新しい照明CCOだけ`kind: lighting`、物理Zone/AddressはCCOのまま、On/Off・回路番号・照明名・束ねた回路IDを出力する。旧Dry Contactは`kind: input`を維持。LD側の実物理CCO割付対応は未検証で、通常Zn出力への自動置換をしてはならない。
- CFS Excel: 現在表示と同じモデルからCCOの照明名、On/Off、回路番号、合計VAを出力する。別の積算Excel様式やリレーマスターは導入しない。
- リレーは外部機器。CCOが外部DC24Vのコイル回路を接点開閉し、外部リレーがAC負荷を開閉する。CCO自体をDC電源として扱わない。1/3/15Aの自動選定・登録は追加しない。
