# CFS UIデザイン契約

既存の `app/globals.css` の `:root` トークンを画面の基準とする。通常UIは英語、リリース/更新履歴は英日併記とする。

- 背景/文字/強調: `--color-page-bg`、`--color-surface`、`--color-text-primary`、`--color-text-secondary`、`--color-accent`を使用する。
- フォント: `--font-cfs-sans`。密度の高い表は既存の `matrix-table` / `cell-input` を維持する。
- 操作: `btn` / `btn-primary` / `btn-secondary` / `btn-sm` を再利用し、focus-visible/disabledの既定挙動を保持する。
- Operation: `OperationActions`を共用し、SwitchはFunction OperationとSwitch Operationの2列で対象を分ける。各行のCopy/Paste/Deleteと機器単位のCopy/Paste/Deleteを区別し、既Copy Buttonと新規Duplicateを保持する。Pasteは共通dialogで毎回未選択から明示指定し、同種のみ・source除外・Palladiom/Picoボタン構成一致を必須とする。機器PasteはFunction内容のみ置換し、登録・Area・配線・PIR/QSM所属・TH bindingを保持する。Commandは実際の1行単位のCommand Operation、QSMは登録専用の5列でFunction/Paste非適用とする。業務handler・権限・保存/削除規則はcallerに残す。
- 選択: 独立チェックはcheckbox、排他選択はselectまたはradioの意味を維持する。外観だけで複数/単一選択の意味を変えない。
- 一括選択: Switch、Command、Scene、Backlightでは件数表示・専用の読み上げを置かず、チェックボックスで各行の選択状態を示す。選択を切り替えても操作バーと表の位置を維持する。
- SwitchのCopy: 元のボタンを再押下するとClearと同じように解除する。選択状態は既存のアクセント色と `aria-pressed` で示す。
- Text入力: `SceneTextValueControl` の入力欄左に123（Standard）/Ab（Text）の直接切替を置き、英語aria/titleとradiogroupの矢印/Tab/disabledを保持する。両paneは同じgrid trackを共有し、mode切替のみでは行/設定paneの高さ・viewport/inner scroll・入力focusを変えない。本文と本人の明示resizeは保持する。Standardの新しい自由文を確定せず、旧本文や変換不能Textを黙って破棄しない。
- 混在値: モードのみの切替と本文編集を別イベントとして扱い、各対象の本文を保持する。Editの確定・取消、Inspectionの確定・Undo/Redo/Revertは本文とmodeを一体で扱う。
- Excel: 既存のExcel Exportスコープメニューを拡張し、Current/All RoomsとProject全タブの出力範囲を明示する。TSTATは既存toolbarのボタンを使用する。
- Project出力の案内: 未確定Inspection/LowHighドラフトを含まないことと、必要な値を先に確定することを英語menu/tooltipで明示する。出力時の自動確定・保存は行わない。
- レイアウト: 既存の角丸/間隔/表スクロールを再利用する。追加コントロールは狭い幅・長い文字・キーボードfocus・readonlyを実アプリで確認する。
- Thermostat: 機器登録/MasterSlave/Area/温度範囲/季節/動作設定をSwitch内のThermostatへ集約する。登録表をmain SwitchViewへReactNodeで渡し、既Function / Trigger Condition / Function Setting / Backlight Settingを同じmain viewで使用する（SwitchViewの再帰ネストを作らない）。TH番号とArea別の共有制御を分離し、未Area・孤立設定の適用状態を明示する。PIR登録 / QSM割当を混ぜない。
- Reference Master: 既cell-inputのselectで同RoomType Masterを一意なTH表示から明示選択。未選択/参照切れ/旧参照の未適用を英語で案内し、UUIDを表示しない。既登録列の順序を維持し、参照欄はNote後。CFSの説明はMaster: TH1程度に簡略化し、Area共通制御と物理参照を混同しない。CFS AreaのrowSpanは物理assignmentの連続表示行だけ。
- Door表示: `Door Magnet Scene`、保存group keyは従来どおり。見出しはword-break/overflow-wrapをnormalにし、単語途中の分割を防ぐ。
- Programming Name: Unicode code point数が50超の場合だけ`--color-danger`と700の太字にする。短縮コメント/専用tooltipを付けない。通常値/保存契約/操作可能性は変えず、Excelに本文と赤太字を保持する。

対象はCFSの既存画面と今回のText/出力/TSTAT共通制御操作であり、既存画面の一括再デザインは行わない。2026-10-27の追加機能は開発local確認済み・未配布。画像固有presetと実機制御は未確認であり、空の設定枠を実動作確認済みと案内しない。
