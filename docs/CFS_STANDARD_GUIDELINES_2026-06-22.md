# CFS 標準運用ガイドライン

更新日: 2026-06-25

## 目的

このガイドラインは、CFSアプリをプロジェクトや担当者が変わっても同じ品質で運用するための標準ルールです。特定案件名や個別ホテル名には依存しない一般化版です。

## 基本方針

- 入力は上流タブから順番に整えます。
- 既存プロジェクトデータを更新で失わないことを最優先にします。
- CFSタブは通常は最終確認用として扱い、元データは各入力タブで修正します。
- CFSタブのInspectionModeは検査時のドラフト編集用です。Linkedでは参照元のArea Scene値を調整し、Unlinkではセル単位のOverrideとして調整します。反映はInspectionMode終了時の確認ダイアログで行います。
- CFSタブのLink Mapは、通常作業では非表示です。SettingsのDisplayでAdmin ModeとCFS Link MapをONにした場合だけCFSタブに入口を表示し、アップデート確認時や連動が疑わしい時に使う診断ビューとして扱います。CFS表には常時線を重ねず、必要な時だけOverview、Current Links、All Rules、Warningsで現状リンク、期待ルール、リンク切れ、スナップショット署名を確認します。Overviewは固定レーン型のDependency mapとし、Source Data、Scene Values、System Logic、CFS Output、Inspection Finishの順に連動の流れを確認します。
- アップデート時はアプリ本体と `data` フォルダを分けて管理します。

## 推奨入力順序

1. Projectを作成または選択します。
2. Locations / Areasで部屋・エリアを整えます。
3. Fixturesで器具情報を整えます。
4. Circuitで回路、調光方式、エリア、Detailを整えます。
5. Device Assignで機器、ゾーン、CCI/CCO、DALIアドレスを割り当てます。
6. Scene / Area Sceneでシーン設定を整えます。
7. Switch / PIR / QSM / Command / Backlightを整えます。
8. CFSタブで並び、Area Address、Programming Name、Detailを確認します。検査時に値の調整が必要な場合はInspectionModeでLinkedまたはUnlinkのドラフトを作り、終了時の確認ダイアログで反映します。
9. ExcelまたはJSONで必要な成果物を出力します。

## 命名と番号の標準

- Area Codeは原則としてエリア名の先頭2文字を使用します。
  - Entrance: `EN`
  - Foyer: `FO`
  - Bedroom: `BE`
  - Living: `LI`
  - Dining: `DI`
- Area Addressはエリア単位で重複しない番号を付けます。
- Programming NameはCFSタブで確認し、実際のプログラム名として使える短さと一貫性を保ちます。
- DALIはGroup/AddressまたはLine/Group/Addressの構造を維持します。
- DALIで同じDesigner #に複数灯がある場合、Device Assignの各Address/Detailは個別のDALI回路に対応させます。CFSとSwitch/Sceneの値は、その個別回路単位で連動することを確認します。
- CCI/CCOは照明制御か非照明制御かを区別して確認します。
- CCOの非照明出力はCircuitタブのDry ContactでArea、Circuit、Detailを登録します。Device AssignのCCOではDry ContactのCircuitを選択し、Detailは未入力時にCFS上でCircuitを表示します。CCIは動作の起点なのでDry Contact登録対象にはしません。

## CFSタブの標準確認項目

- Area Highlightはエリアの行まとまりを確認するために使用します。
- Area Addressが空欄または重複していないか確認します。
- Programming Nameが意図した形式になっているか確認します。
- DALIの個別灯にSwitch/Scene値が設定されている場合、CFSの同じDetail行に値が出ていることを確認します。
- Base Columns / Function Columnsは、列見出し上の小ボタンまたは列メニューで表示/非表示を切り替えます。
- CFS表は、右端の機能列を固定Base列の直後まで、最下行を固定ヘッダー直下までスクロールして確認できる状態を維持します。終端の余白は表示範囲と列幅に応じて調整し、CFSの行順や値解決には影響させません。
- InspectionModeで%を調整する場合は、通常のCFS表示に近いセルをクリックし、オーバーレイで現在値、入力欄、+/-1、+/-10、Raise/Lower/Uneffectedを操作します。On/Off照明とCCOはOn / Off / Blinking / 0.5 sec / Uneffectedをオーバーレイで選びます。Area Scene Nameを表示している場合はInspectionMode中もScene名と値を各セルに表示し、CCIとHVACはInspectionModeでは編集対象にしません。セル編集オーバーレイのOKは入力済みのドラフト値を保持して閉じ、Resetはそのセルを元の値へ戻して閉じます。InspectionMode開始前の値へ戻す場合は、InspectionModeツールバーのRevertでセッション全体を取り消します。
- InspectionMode開始時に現Revisionへ未保存のDraft差分がある場合は、新Revisionとして保存してから開始するか確認します。InspectionMode終了時は完了確認を表示し、Save New Revision & FinishまたはFinish Current Revisionで未反映Draftを含めて保存します。完了後はInspection Mark highlightをONにして検査指摘箇所を追えるようにし、HighlightsのInspection Marksで表示/非表示を切り替えます。通常のSave as New RevisionではInspection Markをリセットします。
- InspectionModeは確認・検査のためのモードです。通常のCFS確認やExcel出力時はOFFに戻して見た目を確認します。
- Highlights の Linked Values（連動セルの薄いシアン塗りつぶし）は 2026-08-25 に廃止した。値の入った機能セルがほぼすべて枠付きになり実用に耐えなかったため、機能ごと削除している。連動関係の確認は Link Map を使う。
- Link MapのCurrent Linksは現在のプロジェクトデータから実際に成立しているリンク、All Rulesはデータ有無に関係なくCFSで守るべき連動ルールを表示します。Overviewでは固定レーン型のDependency mapで、タブ群ごとの役割、代表ノード、連動ルートの件数、警告状態を確認します。
- Link Mapで警告やエラーが出た場合、WarningsでIssue内容とRepair hintを確認します。通常のCFSタブやサブタブにはリンク未接続の赤い警告表示を出さず、必要時だけLink Mapで診断します。意図したアップデートによる差分でない場合は、Scene / Switch / Device Assign / HVACの参照元を確認してから修正します。
- Backlight Logicの対象側はBy SceneまたはBaseを有効な対象として扱います。Palladiom Backlight Assignmentは未設定時にBy Sceneを既定として扱い、Uneffectedは選択肢に出しません。By Sceneは対象指定用の状態であり、CFSには表示値として出さず、BaseやMaster Onなど実際のBacklight Scene名だけを表示します。Switch番号、名称、CCI割当、Functionなどが空の未入力行はBacklight警告対象にしません。
- 各タブのCopy/Deleteは、文字ボタンではなくアイコンボタンを基本とします。誤操作を避けるため、ホバー説明とアクセシビリティラベルは残します。
- Switch / CCI / Palladiom / Pico / PIRでは、Function行だけを消す操作とスイッチ全体を消す操作を列で分けます。Row列のマイナスは該当Function行の削除、Switch列のゴミ箱はスイッチ/CCI/Palladiom/Pico/PIR全体の削除、コピーはCopy Switchです。Switch列はスイッチ単位で行結合して中央配置します。最後の1行は行削除ではなく全体削除で扱います。
- Switchで同一ボタンに複数Functionを持たせる場合、Priorityは任意選択です。同一ボタン内で複数選択できますが、少なくとも1つのFunctionは未チェックのままにします。選択したFunctionはCFSのTrigger Conditionセルが自動でハイライトされます。このハイライトはCFSのHighlightsメニュー項目ではありません。
- UI更新のPlan時は、変更対象ごとに検査項目を先に列挙します。最低限、表示、操作意味、既存データ保護、CFS/Link Map/Export影響、アクセシビリティラベル、ブラウザコンソール、該当タブのスクロール/固定見出しを評価対象に含めます。
- Circuit / Device Assign / Switchのような行数が増える表は、大きめのリサイズ可能な作業領域を使い、表内スクロール時も見出し行を固定して確認できる状態を維持します。CFSのように横方向の固定Base列が必要な巨大表は、個別の固定列設計を優先します。
- WarningsにStale HVAC targetが出て、復旧候補が一意に判定できる場合は、Repair Stale HVACで現行HVAC targetへ置換します。復旧直後はRepaired LinksとしてCFS上の該当セルだけをハイライトし、想定通り値が出ているか確認します。
- CCI/CCOのDetailが、非照明制御時にCircuit/InputとDetailを正しく表しているか確認します。
- CCOのDetailが空欄の場合でも、CFS上ではCircuit/Inputに登録したDry Contact名をDetailとして表示し、見た目で空欄にならないことを確認します。
- HVACとBacklight Logicは照明系の並びに巻き込まれないことを確認します。
- CFS構造見直しを行う場合は、`docs/CFS_STRUCTURE_REVIEW_PHASE0_2026-06-25.md` を参照し、値解決・Inspection Draft・Link Map・Exportを同じ前提へ段階的に寄せます。

## 表示言語の方針

- 日本語/英語切替を追加する場合、まずはボタン、説明文、診断メッセージなどのUI表示だけを対象にします。
- 保存データ、Lutron/GRMS用語、型番、Scene名、Check In / Check Out、Active / Inactive、CFS/Excel提出物の正式項目名は、英語を基準として扱います。
- 翻訳によりインポート、エクスポート、CFS列識別、Link Map署名が変わらないことを検証してから展開します。

## データ保護ルール

- 初回共有はフルZIPを使用します。
- 既存環境の更新は、必ずデータを含まないアップデートパッチZIPを使用します。
- `data/projects.json` と `data/trash/trash.json` はプロジェクトデータです。
- アップデート前に `data` フォルダ、または `/api/projects` のバックアップを保存します。
- アップデート後にプロジェクト数、主要プロジェクト名、Room Type数を確認します。
- データ形式を変えるアップデートでは、旧データ読込、JSONインポート、Excel出力を確認します。

## 配布時の標準

- 外部へ渡すZIPに実プロジェクトデータが含まれるか確認します。
- データを渡したくない場合は、`data` フォルダなしのクリーンパッケージを使用します。
- パッチZIPでは `data` フォルダを含めません。
- ZIP内には `node_modules`、`.next`、テスト結果、過去ログを含めません。
