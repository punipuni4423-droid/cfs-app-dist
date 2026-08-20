# CFS to Lutron Automation Roadmap - 2026-07-10

## 目的

CFSをLutronプログラム作成の上流データとして使い、プログラマーの入力作業を減らす。現場向けには、GCUのアクティベートとFirmware Updateを安全に支援する。

## 推奨ルート

1. CFSから `cfs-lutron-automation-spec` JSONを生成する。
2. JSONをDry Runで検証し、Area / Device / Zone / Scene / Switch / HVAC / GCU数量の不足を先に出す。
3. Lutron DesignerはDB直書きではなく、テンプレート作成とUI/WebView automationを入口にする。
4. 生成後はLutron LocalDBとTransferOutput SQLiteを読み取り専用で比較する。
5. 既存プロジェクトからホテル別Defaults/Profileを抽出し、CFSの簡易設定へ戻す。
6. GCU現場機能は、最初はDiscovery/Read-only診断、次にOperator確認付きActivation/FW Updateへ進める。

## Phase 0: Read-only Spec Export

実装済み入口:

- `app/lib/lutronSpec.ts`
- `GET /api/lutron/spec?projectId=<id>&roomTypeId=<id>`
- `POST /api/lutron/spec`

この段階ではLutron DesignerやGCUへ書き込みをしない。CFS保存データから、Lutron生成に必要な中間JSONを作る。

## Phase 1: CFS UI Preview

追加する画面:

- Room Type内に `Lutron` タブ、またはCFSタブのAdmin機能として `Lutron Spec Preview`
- Dry Run結果、警告、未設定項目、生成対象カウント
- JSONダウンロード
- Lutron Designer起動前の確認チェックリスト

## Phase 2: Lutron Designer Automation

最初の自動化ルート:

- Skeleton Templateまたは既存テンプレートから新規テンプレートを作成
- Lutron Designerのログで確認した `CreateNewTemplateRequest` 相当のUI/WebView経路を使う
- 生成後にLocalDB/TransferOutput SQLiteを読み取り専用で検証

禁止・保留:

- 稼働中MDF/LDFへの直接書き込み
- ConnectSyncServiceやCloud同期中のDB差し替え
- APIキー、トークン、平文Credentialのログ出力

## Phase 3: Existing Project Learning

既存プロジェクトから抽出するDefaults:

- 標準Area構成
- GCU/Processor構成
- Device modelとAddress/Zone割付
- DALI Line/Group/Address命名
- Area Scene / Room Scene / PMS条件
- Palladiom/Pico/PIR/QSM/Button割付
- Backlight Logic
- HVAC/CCI/CCO命名と動作

成果物:

- `hotelProfile`
- `roomTypeTemplate`
- `deviceAllocationRules`
- `scenePresetRules`
- `validationRules`

## Phase 4: GCU Field Assistant

現場向けは段階的に進める。

1. GCU候補のDiscoveryと状態表示
2. 現在FW、Activation状態、疎通、ネットワーク情報のRead-only収集
3. Dry Run計画
4. Operator確認付きActivation
5. Operator確認付きFW Update
6. 実行ログ、失敗時復旧メモ、Before/After証跡出力

ホテルネットワークを跨ぐ操作は、認証、ネットワーク分離、作業許可、Rollback可否が確認できるまで自動実行しない。

## 検証

最低限:

- `npm run typecheck`
- `GET /api/lutron/spec` が現在の `data/projects.json` からJSONを返す
- 生成JSONのwarningを確認
- CFS既存Excel exportやLink Mapに影響がないこと

Lutron連携段階:

- Lutron Designerログ
- LocalDB read-only差分
- TransferOutput SQLite read-only差分
- 実機なしDry Run
- テストGCUでの現場リハーサル
