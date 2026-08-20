# CFS構造見直し Phase 3

更新日: 2026-06-25

## 目的

Phase 3では、CFS表示ターゲットとLink MapのCFS target indexの前提を近づけました。これまでLink MapはCircuit全体をCFS targetとして扱いやすく、CFSに実際には表示されないtargetもOKに見える可能性がありました。

## 今回の更新

- `app/lib/cfsTargets.ts` を追加しました。
- `cfsTargetsForRow(row)` でCFS行からInspectionMode/Link Map用ターゲットを解決します。
- `buildCfsTargetIndex(rows)` で生成済みCFS行からCFS target indexを作ります。
- `CfsView.tsx` の `rowTargetIds` は `cfsTargetsForRow` を使うようにしました。
- `cfsLinkageGraph.ts` は `buildCfsZoneRows` と `buildCfsTargetIndex` を使い、実際のCFS行に基づくtargetLabelsを作るようにしました。

## 守った挙動

- CFSの表示値、InspectionModeのdraft/apply、Backlight Logic、HVAC行の表示順は変更しません。
- Link Mapの診断は、CFSに実際に表示されるtargetを基準に近づけます。
- Circuit自体のノードは維持し、Circuit -> Device Assign -> CFSの流れは継続して表示します。

## 注意点

Link Mapの警告数は、これまでOK扱いだった「CFSに表示されないtarget」を検出する方向に変わる可能性があります。これは表示バグではなく、診断精度を上げるための変更です。
