# CFS 構造見直し Phase 0

更新日: 2026-06-25

## 目的

CFSタブ、InspectionMode、Link Map、Excel出力、各入力タブの連動が個別実装でずれないように、値解決と更新経路の共通土台を先に整える。

## Phase 0で確認した問題

- CFS表示、InspectionMode、Link Mapが同じ「Scene / Area Scene / Switch値の読み方」を別々に持っていた。
- InspectionModeはドラフト方式へ変更されたが、Link Map側の表記には旧来の `writeback` 前提が残っていた。
- 大きなCfsView分割をいきなり行うと、CFS行生成、固定列、結合セル、Backlight Logic、HVAC、Exportが同時に動き、回帰リスクが高い。
- 旧エクスポート/インポート互換、ストレージ移行、Link Mapスナップショット差分は、CFS構造見直しと並行して保護する必要がある。

## 今回実施したPhase 0更新

- `app/lib/cfsValueResolver.ts` を追加し、CFS値解決の純粋関数を共通化した。
- `CfsView.tsx` は共通libを参照する形に変更し、表示値、Area Scene参照、Switch Scene参照、Inspection Draftの正規化を同じ前提へ寄せた。
- `cfsLinkageGraph.ts` のSwitch Scene選択を共通libへ寄せた。
- Link MapのInspectionエッジ表記を `InspectionMode draft finish` へ更新し、InspectionMode終了時にドラフトを反映する流れとして整理した。

## Phase 0でまだ残すもの

- Link Mapの全ターゲット生成とCFS表示を完全に同一resolverへ統合する。
- Excel可視出力がDOM依存のため、将来的に「表示resolver -> table model -> DOM/Excel」の順に共通化する。
- Storage import/export互換の追加検証、特に旧JSONの`rows`欠損救済とschemaVersion方針を整理する。
- CfsView本体はまだ大きい。Phase 1以降で `useCfsZoneRows`、`useCfsViewPrefs`、`CfsMatrixTable` などに分割する。

## 次フェーズの推奨順序

1. Link MapとCFS表示のターゲット生成を共通resolverへ寄せる。
2. CFS visible Excel exportをDOMスクレイピングからtable model経由に寄せる。
3. CfsViewのUI分割を行う。行生成、列設定、表レンダリング、Exportを分ける。
4. 旧エクスポートデータのimport互換とschemaVersionを補強する。
5. PlaywrightでScene、Switch、DALI、CCI/CCO、HVAC、Backlight、Inspection Draftを横断する小さな回帰セットを作る。

## 守ること

- `Uneffected` の表記と空値意味は変更しない。
- Area Scene値をIndividual Overrideへ自動コピーしない。
- Backlight LogicはCFS上でHVACより下に置く。
- CFS visible Excel exportは現時点ではWYSIWYGを維持する。
- 更新前後で既存プロジェクト、特に `Test` の存在と主要件数を必ず確認する。
