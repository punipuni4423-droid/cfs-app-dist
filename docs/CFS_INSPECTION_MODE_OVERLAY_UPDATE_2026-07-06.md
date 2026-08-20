# CFS InspectionMode Overlay Update - 2026-07-06

## 変更メモ

- CFSタブのInspectionModeは、セル内へ直接input/selectを出す方式から、通常CFS表示に近いセルをクリックして編集オーバーレイを出す方式へ変更した。
- DisplayのArea Scene NameがONの場合、InspectionMode中もArea Scene由来のセルにScene名と値を表示する。Area Scene draftはScene名を残し、Override draftは直接値として表示する。
- %系セルのオーバーレイには現在値、入力欄、+/-1、+/-10、Raise/Lower/Uneffectedを表示する。
- On/Off照明とCCOのオーバーレイにはOn / Off / Blinking (Short) / Blinking (Long) / 0.5 sec / Uneffectedを表示する。
- CCIとHVACは引き続きInspectionModeでは編集不可とし、セルクリックの編集オーバーレイを出さない。
- 元値から変わったセルのdraft/changedマークは維持する。
- 2026-07-07: InspectionModeで完了した変更は、RoomTypeのInspection Markとして保存する。淡い青のセル印と凡例でSave as New Revisionや自動保存後も検査指摘箇所を確認できる。InspectionMode内のClearは選択/コピー範囲のクリアであり、保存済みInspection Markの削除操作ではない。
