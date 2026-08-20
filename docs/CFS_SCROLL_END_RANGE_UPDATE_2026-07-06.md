# CFS Scroll End Range Update - 2026-07-06

## 変更メモ

- CFS Matrixの横方向スクロール終端に、表示領域と固定Base列幅から計算した余白列を追加した。
- 右端の機能列が、最大横スクロール時に固定Base列の直後まで移動できるようにした。
- CFS Matrixの縦方向スクロール終端に、表示領域、固定ヘッダー高さ、最終行高さから計算した余白を追加した。
- Backlight Logicなど最後の行が、最大縦スクロール時に固定ヘッダー直下まで移動できるようにした。
- 追加した余白は表示とスクロール範囲だけに使い、CFS行順、値解決、Excel Export、InspectionMode draftには影響させない。
