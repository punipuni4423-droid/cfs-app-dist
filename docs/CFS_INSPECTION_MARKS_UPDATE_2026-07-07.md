# CFS Inspection Marks Update - 2026-07-07

## 変更メモ

- InspectionModeで変更したセルを、完了時にRoomTypeの`inspectionMarks`として保存する。
- 保存済みInspection MarkはCFS表の機能セルに淡い青の印として表示し、InspectionModeをOFFにしても残す。
- Save as New Revision、自動保存、リビジョンsnapshot、復元でInspection Markを保持する。
- 古いプロジェクトやバックアップには`inspectionMarks: []`を補う移行を追加し、既存データを維持する。
- CFSのExcel Exportにも、表示中のInspection Mark highlightを反映する。

## 運用

- InspectionMode終了時に、LinkedのドラフトはArea Sceneへ、UnlinkのドラフトはScene / Switchの直接値へ反映する。
- 完了後はHighlightsのInspection Marksで表示/非表示を切り替える。
- InspectionMode内の`Clear`は選択/コピー範囲をクリアする操作であり、保存済みInspection Markの削除操作ではない。
- 通常のSave as New RevisionではInspection Markをリセットし、過去の検査指摘が新しいRevisionへ不用意に残らないようにする。
