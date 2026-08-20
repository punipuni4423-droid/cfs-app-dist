# CFS構造見直し Phase 2

更新日: 2026-06-25

## 目的

Phase 2では、CFSの行生成を `CfsView.tsx` から切り出し、Device Assign / Circuit / HVAC / Backlight Logic からCFS行を作る入口を `app/lib/useCfsZoneRows.ts` に集約しました。

## 今回の更新

- `app/lib/useCfsZoneRows.ts` を追加しました。
- Device Assignから通常照明、DALI、CCI/CCO、Reserved行を作る処理を移しました。
- HVAC行とBacklight Logic行を作る処理を移しました。
- CFS行のデバイス順、エリア順、内部番号順のソート処理を移しました。
- CfsView側は生成済みの `zoneRows` を受け取り、描画、InspectionMode、Excel visible export、Link Map連携へ使う構造にしました。

## 守った挙動

- Backlight LogicはHVACより下に表示する前提を維持します。
- CCI/CCO、DALI、Reserved、HVAC、Backlight Logicの行生成ルールは変更しません。
- CFSの表示列、InspectionMode draft/apply、Excel visible export、Link Mapの表示入口は変更しません。
- 既存プロジェクトデータは更新前後で必ず比較します。

## 次フェーズ候補

1. CFS表示ターゲット生成とLink Mapターゲット生成を同じresolverへ寄せる。
2. `availableAreaFilters` と `availableDeviceFilters` をCFS行生成結果から作るようにし、フィルタと表示行のずれを減らす。
3. visible Excel exportをDOM依存からtable model依存へ段階的に移す。
4. 旧JSON importの `migrateCfsCircuit` とschemaVersion運用を補強する。

## Phase 3/4への引き継ぎ

2026-06-25にPhase 3としてCFS target resolverを追加し、Phase 4としてArea/Deviceフィルタを生成済みCFS行由来へ変更しました。詳細は `docs/CFS_STRUCTURE_REVIEW_PHASE3_2026-06-25.md` と `docs/CFS_STRUCTURE_REVIEW_PHASE4_2026-06-25.md` を参照します。
