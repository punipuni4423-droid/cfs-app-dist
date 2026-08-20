# CFS Link Error Highlight Update

更新日: 2026-06-25

## 2026-07-06 追記

通常作業時のCFSタブとサブタブでは、リンク未接続・旧参照の赤いタブ表示、赤い行表示、赤いセル表示を出さない方針に変更しました。Link Mapの診断ロジックとWarnings/Repair確認は維持します。最新の表示方針は `docs/CFS_LINK_DISPLAY_UPDATE_2026-07-06.md` を参照してください。

## 対象

- CFSタブのリンク診断
- Link Mapで検出されるMissing target、Missing Area Scene、Missing Switch Scene、Stale HVAC target、Duplicate switch columnなど
- CFSサブタブのリンク異常表示

## 表示ルール

- リンク関係が崩れている箇所は、枠線だけではなく赤い背景で塗りつぶします。
- 赤いリンクエラー表示は、Area Color、FFE、Energy Saving、Revision変更、Area Scene値、Linked Values、Repaired Links、Inspection draftより優先します。
- CFS上で対象Target IDが存在する場合は、そのCFS行または機能セルを赤く表示します。
- Scene/Switch/Command/Backlightなどのリンク元が分かる場合は、その機能列セルとCondition見出しを赤く表示します。
- CFS上に対象セルが存在しない古い参照やMissing targetでも、関連するサブタブ自体を赤く表示します。
- リンクIssueがある場合、CFSタブも赤く表示し、CFS確認対象であることを明示します。
- CFSタブ上部にリンク診断リストを表示し、Issue種別、場所、対象、対応目安を一覧で確認できるようにします。

## タブ赤表示の割り当て

- Circuit: Designer#不一致、DALI曖昧、通常Target missingの確認先
- Device Assign: Device Assign、HVAC、CCI/CCO、Stale HVAC targetの確認先
- Area Scene: Missing Area Scene、Switch Scene参照切れの確認先
- Scene: Room Scene側の参照切れや直接設定の確認先
- Switch / Command / Backlight: IssueのsourceIdから該当するSwitch種別へ割り当てます
- CFS: Link Map issueが1件でもある場合は赤表示します

## 診断リスト

- `Link Issues` リストはCFSタブの上部に表示します。
- `Error` / `Warning`、日本語のIssue説明、元のIssue名、詳細、場所、対象、対応目安を表示します。
- 場所は、可能な限りCircuit番号、Device Assign、Area Scene名、Scene列、Switch/Command/Backlightの番号や名称へ変換して表示します。
- 対象は、HVAC、CCI、CCO、CFS target IDなどを短縮しつつ確認できる形で表示します。
- 詳細調査やRepairが必要な場合は、同じリストから `Open Link Map` を開きます。

## 注意点

- この表示はデータを自動修復しません。どこが壊れているかを見つけやすくするための診断表示です。
- 修復可能なStale HVAC targetは、Link MapのWarningsとRepair操作で確認します。
- CFSセルが存在しない古い参照は、セルではなくタブ赤表示とLink Map Warningsで確認します。

## 2026-06-26 追記: Individual Overrideの扱い

- Scene / Area Scene / Switch の直接値が、Circuitタブに実在するCircuit IDを参照している場合は、Individual Overrideまたは有効な直接設定として扱います。
- そのCircuitが現在のDevice AssignからCFS行として表示されていない場合でも、参照先が実在する限り `Missing target` の赤塗り対象にはしません。
- `Missing target` は、Circuit / 現行HVAC target / CCOなど、設定対象カタログにも存在しない参照だけをエラー扱いします。
- Link MapのOverviewは固定レーン型に変更し、概要はレーン、実リンクはCurrent Links、仕様上の全ルールはAll Rules、修復候補はWarningsで確認します。
