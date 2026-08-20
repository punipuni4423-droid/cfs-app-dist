# CFS App クリーン再配置ガイド

最新版ZIPを使っているはずなのに更新内容が反映されない場合は、古い解凍フォルダや古いショートカットを起動している可能性があります。

## 推奨手順

1. CFS Appを閉じます。
2. 最新ZIPを新しいローカルフォルダへ展開します。
   - 推奨: `C:\CFS App`
   - 推奨: `C:\Users\<ユーザー名>\Documents\CFS App`
   - OneDrive、ネットワーク共有、ZIP内からの直接起動は避けてください。
3. 新しく展開したフォルダ内の `CLEAN_REINSTALL_CFS_APP.cmd` を実行します。
4. 画面の案内に従い、古いショートカット先フォルダが見つかった場合は必要に応じて退避します。
5. 新しいショートカット、または新しいフォルダ内の `LAUNCH_CFS_APP.cmd` から起動します。
6. Project Selection画面で次を確認します。
   - `Latest version installed. Safe to use.`
   - `Git was not found` が出ていないこと。
   - 追加された機能が画面に反映されていること。

## CLEAN_REINSTALL_CFS_APP.cmd が行うこと

- 古いCFSサーバープロセスを停止します。
- デスクトップ/スタートメニューの `CFS App` ショートカットを現在の新しいフォルダへ作り直します。
- 古いショートカット先フォルダを検出した場合、削除ではなく `_old_yyyyMMdd-HHmmss` へリネーム退避できます。
- 最後に新しいCFS Appを起動します。

## 削除ではなくリネーム退避にしている理由

配布ZIPには通常 `data\projects.json` や `.env.local` は含めていませんが、利用者PCの古いフォルダにはローカルデータ、ログ、診断ファイルが残っている可能性があります。

そのため、ヘルパーは永久削除を行いません。動作確認後に不要と判断できた古い `_old_...` フォルダだけ、手動で削除してください。

## うまくいかない場合

新しいフォルダ内の `START_CFS_APP_CONSOLE.bat` を実行し、次のログを確認または共有してください。

```text
artifacts\startup\latest-status.txt
artifacts\startup\start-*.log
artifacts\startup\server-*.log
artifacts\startup\server-*.err.log
artifacts\startup\clean-reinstall-*.log
```
