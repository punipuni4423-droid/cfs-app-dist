# CFS構造見直し Phase 4

更新日: 2026-06-25

## 目的

Phase 4では、CFSのArea/Deviceフィルタ候補を、Device AssignやHVACから別々に作るのではなく、生成済みCFS行から作る構造に変更しました。これにより、表示行とフィルタ候補のずれを減らします。

## 今回の更新

- `CfsView.tsx` にフィルタ用の未選択・未非表示のCFS行一覧 `allZoneRowsForFilters` を追加しました。
- Areaフィルタは `allZoneRowsForFilters` の行の `locationId/location` から作ります。
- Deviceフィルタは `allZoneRowsForFilters` の `device/deviceNum` から作ります。
- Backlight LogicはDeviceフィルタ対象として維持し、Areaフィルタからは除外しています。

## 守った挙動

- CFSの実際の行表示、列表示、InspectionMode、Excel visible exportは変更しません。
- フィルタ候補は、現在の非表示設定や選択中Areaに引きずられないよう、未選択・未非表示のCFS行から作ります。
- Other、HVAC、Backlight Logicの扱いは既存UIの意味を維持します。

## 次フェーズ候補

1. visible Excel exportをDOM依存からtable model依存へ移す。
2. 旧JSON importの `migrateCfsCircuit` とschemaVersion運用を補強する。
3. Link Map snapshot差分をアップデート確認の自動ゲートに入れる。
