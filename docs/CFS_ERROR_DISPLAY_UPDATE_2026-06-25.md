# CFS Error Display Update

更新日: 2026-06-25

## 対象

- CFSタブの描画エラー
- CFS内のLink Map、InspectionMode、テーブル表示、値解決経路

## 仕様

- CFSタブは専用のエラー境界で囲みます。
- CFS内でReact描画エラーが発生した場合、アプリ全体ではなくCFSタブだけを赤い診断パネルに切り替えます。
- 診断パネルにはProject、Room Type、Error、Estimated Location、Error IDを表示します。
- 詳細にはRuntime stackとComponent stackを表示し、Codexで原因箇所を追えるようにします。
- `Retry CFS` でCFSタブの再描画を試せます。
- `Copy Diagnostic` で診断情報をクリップボードへコピーできます。

## 注意点

- この表示が捕捉するのは、CFSタブのReact描画中に発生したランタイムエラーです。
- TypeScript構文エラー、Next.jsビルドエラー、開発サーバーのmanifest破損など、アプリ起動前またはコンパイル段階のエラーはこのパネルでは表示できません。
- エラー表示を追加しても、CFSの表示値、リンク、InspectionMode、Excel Exportのデータ処理は変更しません。
