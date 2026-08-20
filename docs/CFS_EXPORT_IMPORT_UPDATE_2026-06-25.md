# CFS Export / Import Update

更新日: 2026-06-25

## 対象

- CFSタブの `Excel Export`
- Project画面の `Import Data` / `Export All`
- 旧JSON/QJSONバックアップの読み込み互換

## 運用ルール

- CFSタブのExcel出力は、画面DOMを読み取らず、CFSのテーブルモデルから生成します。
- 出力対象は現在CFSタブで表示されているBase Columns / Function Columns / 行です。
- ヘッダー結合、行結合、ハイライト、変更セルの塗りつぶしは、CFS表示ロジックと同じモデルを参照します。
- Projectバックアップの `schemaVersion` は現在の保存仕様を示します。古いバックアップは読み込み時に不足列を補完します。
- 旧JSON/QJSONでCFS行の列が不足している場合は、プロジェクトやRoom Type全体を破棄せず、不足列を空文字として補完します。
- インポート前後は、既存プロジェクト数、プロジェクト名、Room Type数、主要データ件数を確認します。

## 確認ポイント

- `Test` など既存プロジェクトがインポート/エクスポート検証で消えていないこと。
- CFS Excel出力で、表示中のBase Columns / Function Columnsと同じ列構成になっていること。
- 旧バックアップを読み込んでも、CFSの `rows` に新規追加された列が空文字で補完されること。
- データ形式変更を伴うアップデートでは、`npm run typecheck`、CFS Excel出力、旧JSON/QJSON互換読み込み、`/api/projects` 前後比較を必ず行うこと。
