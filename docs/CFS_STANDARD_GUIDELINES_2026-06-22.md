# CFS 標準運用ガイドライン

## 2026-09-09 追加回路とDALI変更

Device Assignの追加回路は機器に適合する候補から選びます。候補外の番号は確定されず、直前の値に戻ります。追加回路として使う回路をDALIへ変更すると、影響するRoomType・機器・ゾーンと解除番号が表示されます。OKで変更と追加割当解除をまとめて適用し、Cancelで保持します。CSV取込も同じ確認を行います。最後の追加回路を外した場合は固定のzoneDetailも解除されます。既存保存データの一括移行は行いません。

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
- CFSのEditで設定をLinkするときは、最初にチェックした列がSourceです。起点のチェック欄を青緑の枠で強調し、ツールバーに列名を表示します（省略された名前はホバーで全文確認）。起点を解除すると残るチェック順の先頭へ移り、全解除で表示が消えます。Switch/Command・RoomSceneとも同じ操作です。Link後の「N columns applied」は、起点と既存グループから吸収された未選択列も含む適用列数です。(2026-09-09 T-109)
- CFS表は、右端の機能列を固定Base列の直後まで、最下行を固定ヘッダー直下までスクロールして確認できる状態を維持します。終端の余白は表示範囲と列幅に応じて調整し、CFSの行順や値解決には影響させません。
- InspectionModeで%を調整する場合は、通常のCFS表示に近いセルをクリックし、オーバーレイで現在値、入力欄、+/-1、+/-10、Raise/Lower/Uneffectedを操作します。On/Off照明とCCOはOn / Off / Blinking / 0.5 sec / Uneffectedをオーバーレイで選びます。Area Scene Nameを表示している場合はInspectionMode中もScene名と値を各セルに表示し、CCIとHVACはInspectionModeでは編集対象にしません。セル編集オーバーレイのOKは入力済みのドラフト値を保持して閉じ、Resetはそのセルを元の値へ戻して閉じます。InspectionMode開始前の値へ戻す場合は、InspectionModeツールバーのRevertでセッション全体を取り消します。
- InspectionMode開始時に現Revisionへ未保存のDraft差分がある場合は、新Revisionとして保存してから開始するか確認します。InspectionMode終了時は完了確認を表示し、Save New Revision & FinishまたはFinish Current Revisionで未反映Draftを含めて保存します。完了後はInspection Mark highlightをONにして検査指摘箇所を追えるようにし、HighlightsのInspection Marksで表示/非表示を切り替えます。通常のSave as New RevisionではInspection Markをリセットします。
- InspectionModeは確認・検査のためのモードです。通常のCFS確認やExcel出力時はOFFに戻して見た目を確認します。
- Individual Overrideの黄色はUpdate Highlights(変更箇所表示)を同時にONにしても維持します。Editオーバーレイと従来のSwitch/Command/Sceneタブで同じ判定を使用し、HighlightsのIndividual OverrideをOFFにすると対象セルは通常の変更箇所色へ戻ります。Area Scene参照値や個別値の保存・Link伝播のルールは変えません。(2026-09-08 T-99)
- CFSのEditは既定OFFです。ONにするとリンク用の列チェック、Setting入口、Low End / High End編集が有効になります。列チェック・Setting用の鉛筆・Link記号は見出し最下行(Trigger/Condition)に揃え、鉛筆はその列のSettingを直接開きます。名前セルのクリックとhover/focusの背景・下線も維持し、複数の設定先がある結合名セルは条件メニューから選択します(Escまたは外側クリックで取消)。Low End / High EndにもEdit中のみ鉛筆を表示します。Link縦線は4px幅で統一し、結合セル内部では途切れます。(2026-09-08 T-98、T-93の入口配置を更新)
- EditがONならLow End / High EndはInspectionMode中も編集できます。Low/High EndバーのUndo / Redo / Discard / Confirmで管理し、Confirm時にDevice Assignへ反映します。シーン値の検査ドラフト・上部Undo / Redo・Inspection Markとは独立しており、InspectionModeの開始・終了・RevertではLow/High Endの未確定値や確定値を取り消しません。未確定値がある状態のDiscard・Edit OFF・部屋/タブ移動・一覧復帰・編集終了では、Confirm（適用して続行）/Discard（破棄して続行）/Cancel（その場に留まる）を選びます。変更がなくRedo履歴だけのときはEdit OFFでも履歴を保持します。InspectionMode中のSetting/LinkとViewでの編集は無効です。(2026-09-09 T-110、T-92/T-93を更新)
- Low/High Endの未確定値は同じブラウザータブ内で部屋ごとに退避し、再読み込み後も未適用値として復元します。ブラウザー終了/再読み込みにはブラウザー標準の離脱確認を表示します。権限喪失時も未確定値を消さず、再び編集可能になるまでConfirmは無効です。対象の機器がなくなった場合も、Cancelで値を保持できます。退避に失敗した表示が出た場合は、ConfirmまたはDiscardまでページを開いたままにしてください。(2026-09-09 T-110)
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

## 2026-09-10 操作と出力名

- Device Assign の機器追加後は Reserved 行も表示します。Hide Reserved で表示が0件になった場合は、未登録と区別してフィルタ解除を案内します。通常のタブ移動では表示設定を保持します。
- Select Device は最初の機器へフォーカスし、Tab／Shift+Tab はダイアログ内を循環します。Escape、Cancel、背景クリック、選択後は追加ボタンへ戻ります。
- Remarks 等の複数行セルは通常の矢印、Home／End、PageUp／PageDown を文章編集に使います。セル間は Ctrl+矢印で移動します。単一行入力、選択欄、チェック欄の操作は従来どおりです。
- View 権限では Remarks の入力欄は読み取り専用、追加・削除・複製・表変更・並べ替えは無効です。Preview と Excel Export は使用できます。
- 全室 Excel のシート名は Excel の禁止文字・前後の引用符・予約語 History・31文字制限・大小を区別しない重複を調整します。RoomType 名と保存データは変更しません。

## 2026-09-09 CFS・Remarks の Excel 出力

- CFS の画面・This Room Type・All Rooms は同じセル値計算を使用します。All Rooms は各部屋の確定値を使い、画面限定の Inspection／Low End・High End の未確定値やリビジョン差分表示を持ち込みません。
- Individual Override の黄色、FFE／Energy Saving／Reserved の除外列、重複したハイライトの塗り優先順位は画面に合わせます。Inspection の青枠・青丸は画面用の装飾で、Excel の既存境界罫線は維持します。
- Remarks の列幅は表ごとに内容から計算します。長い表と短い表が混在しても隣の表に幅が引っ張られません。Excel では横方向の結合セルで各表の幅を表現し、長文の折返し・縦結合・罫線を保ちます。

## データ保護ルール

- 初回共有はフルZIPを使用します。
- 既存環境の更新は、必ずデータを含まないアップデートパッチZIPを使用します。
- `data/projects.json` と `data/trash/trash.json` はプロジェクトデータです。
- アップデート前に `data` フォルダ、または `/api/projects` のバックアップを保存します。
- アップデート後にプロジェクト数、主要プロジェクト名、Room Type数を確認します。
- データ形式を変えるアップデートでは、旧データ読込、JSONインポート、Excel出力を確認します。

## 配布時の標準

読込時に修復・除外の通知が出た場合は、[読込時の修復・除外と保存の確認](MIGRATION_SAFETY_JA.md)に従い、内容を確認してから明示保存してください。通知中はブラウザの自動ドラフト保存を停止します。件数が減るサーバー保存にも確認が入ります。

- 外部へ渡すZIPに実プロジェクトデータが含まれるか確認します。
- データを渡したくない場合は、`data` フォルダなしのクリーンパッケージを使用します。
- パッチZIPでは `data` フォルダを含めません。
- ZIP内には `node_modules`、`.next`、テスト結果、過去ログを含めません。

## 2026-09-09 接続認証とごみ箱の競合防止

PCはランチャーから認証し、タブレットはPCが発行する接続リンクを使います。localhostを含む全APIに認証が必要です。既存のログイン済みブラウザでは通常のブックマークも使えます。ごみ箱の並行保存は古い世代の上書きを拒否します。起動・復帰方法とAPI仕様は [接続認証](API_ACCESS_JA.md) を参照してください。

## プロジェクト削除の保存保護（2026-09-09 T-115）

プロジェクトの Delete は、保存済み原本のごみ箱退避と一覧からの削除を一体で確定します。完了するまで一覧の原本を表示し、重複削除を受け付けません。ごみ箱が10MiBに達する場合は削除も中止します（UTF-8・JSON区切り空白を含む保守的な容量判定）。

通信失敗時は処理結果が不明な場合があります。画面の案内に従って再読込し、一覧とTrashを確認してから再操作してください。復元には Restore Project、不要な退避データの完全削除には Empty Trash を使用します。

ローカルでは2つの既存JSONと復旧用トランザクション記録を使用し、次回の読書き前に確定済み処理を回復します。生存中プロセスのロックは時間だけで奪いません。共有モードでは対応するDB migration・Edge Function・アプリの整合が必要で、実DBへの適用はバックアップを伴う別の適用ゲートに従います。

## プロジェクト名と一覧保存の競合保護（2026-09-10 T-116）

Rename Projectは対象IDの名前だけを更新します。一覧を開いた後に他の利用者が作成したプロジェクトは保持されます。名前変更が失敗した場合は元の名前を表示し、再読込の案内を出します。

インポート・復元の一覧保存は送信したIDだけを更新します。送信にないIDを削除しません。既存IDの更新には取得時の更新トークンが必要で、古い画面からの競合保存は拒否します。削除にはDelete Projectを使ってください。

共有モードの適用順は、バックアップと書込み停止の確認後にT-115/T-116のDB migration、対応Edge Function、対応アプリです。旧一覧RPCはmigrationで無効化されるため、途中の旧アプリや旧Edgeでは一覧保存に失敗します。新アプリも対応Edgeが未適用なら改名・一覧保存に失敗します。失敗時に旧RPCへ戻す運用は行わず、対応版を揃えて再読込してください。実DBへの適用は別の適用ゲートで行います。
