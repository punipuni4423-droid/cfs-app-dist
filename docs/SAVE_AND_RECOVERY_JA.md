# 保存・破棄・復元（T-149、2026-09-24）

共有保存には編集権が必要です。入力中のローカル下書きは、共有先へ保存できたことを意味しません。Save Currentは現在の編集内容を保存し、Save Revisionは名前付きRevisionも追加します。保存結果を確認できない場合はSave and RecoveryのCheck Save Statusで確認し、自動再送しません。

## 編集の終了と破棄

未保存の変更がある場合、終了ダイアログにはContinue EditingとDiscard my unsaved changesを表示します。終了時・アイドル時の自動保存はありません。保存する場合はContinue Editingで戻り、通常の保存ボタンを使います。

Discard my unsaved changesは、この利用者・このタブの未保存下書きを削除して、サーバーの最新データを読み込みます。過去のRevisionを書き戻す操作ではなく、プロジェクト保存のPOSTは発生しません。他のタブの下書きやRecoveryの退避は残ります。結果不明の保存・importがある場合、先に確認が必要です。通信に失敗した場合や読み込み中に編集内容が変わった場合は破棄せず、画面に変更を残します。編集終了に伴うロック解放の通信は別途発生します。

## 保存が409・423で拒否された場合

- STALE_BASE（409）：読み込んだ版番号・本文ハッシュ・更新日時が現在の共有版と一致しません。
- ROLLBACK_SUSPECTED（409）：過去の内容への巻き戻りが疑われます。意図した復元はRestore Revisionから行います。
- ROOM_HISTORY_PROTECTED / COMMON_HISTORY_PROTECTED（409）：既存Revisionの削除・本文改変を含みます。RoomTypeごとの履歴があるRoomType自体の削除も拒否されます。
- 編集権の喪失（423）：下書きを残し、編集権を取得し直してから確認します。

409の際は変更をRecoveryへ退避し、最新の保存者・日時を表示します。最新を読み直すか、中止して編集を続けます。古い本文に新しい基準版を付け直して上書きする選択肢はありません。退避中にも編集した場合は読み直しを中止します。基準版を確認できない古いRecoveryはExport Original Draftで取り出して比較してください。

## Revisionを復元する

RoomTypeのRevision操作、またはCommon HistoryのRestore Revision…からプレビューを開きます。対象内容を確認してConfirm Restore as New Versionを押すと、通常の保存経路で新しい版を作ります。確認中に他者が保存した場合やロックが失効した場合は拒否されます。確認前の自分の変更はRecoveryに残ります。現在の名前付きRevisionは保持されます。

共有モードの管理者は、Save and Recovery内のServer HistoryからLoad Server Historyを選べます。一覧には版・退避操作・その操作者・日時だけを読み込みます。Preview Restore…で選択した本文を取得し、確認して新しい版として復元します。表示される操作者は「その版を履歴に退避させた操作」の人です。

自動履歴は「90日以内の全版」と「直近50版」の両方を残します。名前付きRevisionは無期限です。導入前に失われた版は自動生成できません。古い自動履歴に現在のRevisionを持つRoomTypeが含まれない場合や、古いRevisionに安全な復元に必要な項目がない場合は復元を拒否し、原本の比較を必要とします。ローカルモードでは名前付きRevisionの復元を利用できますが、共有DBの自動履歴一覧はありません。

## 導入時

SQL・Edge・アプリを同時に整備します。古いクライアントは版・ハッシュを送れないため保存が拒否されます。管理者の適用・確認が済むまで共有書き込みを再開しません。詳細はT149_SERVER_HISTORY_DEPLOY_JA.mdを参照してください。
