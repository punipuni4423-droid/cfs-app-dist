# CFS構造見直し Phase 1

更新日: 2026-06-25

## 目的

Phase 1では、巨大化している `CfsView.tsx` から、CFSテーブルの型と列定義を分離しました。表示やデータの連動挙動は変更せず、今後のアップデートで触る場所を小さくするための土台作りです。

## 今回の更新

- `app/lib/cfsTableModel.ts` を追加しました。
- CFSのBase Columns、Function Column幅、Backlight Logicの結合対象列、InspectionModeの選択肢、CFS行/列/マージ情報の型を `cfsTableModel` に移しました。
- `CfsView.tsx` は同じ定義をimportして使う構造に変更しました。
- Link MapのInspectionMode表現を、終了時にドラフトを反映する `draft finish` の考え方に寄せました。
- Link Mapの文字化けしたルール説明とタブ定義の構文崩れを復旧しました。

## 守ること

- CFSの表示順、列名、値解決、InspectionModeの反映先、Excel visible exportの意味は変更しません。
- `Uneffected` の綴りと空値扱いは維持します。
- Backlight LogicはHVACより下に表示する前提を維持します。
- CFS web appを更新した場合、最終報告の文末には必ず実際に使用しているlocalhost URLを記載します。

## 次フェーズ候補

1. `useCfsZoneRows` としてCFS行生成をCfsViewから分離する。
2. CFS表示ターゲット生成とLink Mapターゲット生成を同じresolverに寄せる。
3. visible Excel exportをDOM依存からtable model依存へ段階的に移す。
4. 旧JSON importの `migrateCfsCircuit` とschemaVersion運用を補強する。
5. PlaywrightでScene、Switch、DALI、CCI/CCO、HVAC、Backlight、Inspection Draftを横断する小さな回帰セットを作る。

## Phase 2への引き継ぎ

2026-06-25に `useCfsZoneRows` への分離を実施しました。詳細は `docs/CFS_STRUCTURE_REVIEW_PHASE2_2026-06-25.md` を参照します。
