# CFSの独立Git復旧

通常は画面の App Update を使います。アプリ・更新画面・古い更新APIが動かない場合は、アプリと同じフォルダの `UPDATE_CFS_APP.cmd` を実行してください。実行中の更新があれば完了を待ち、その更新窓は閉じないでください。実行前に未保存の編集を保存し、他の起動窓を閉じます。更新はアプリを停止するため、結果が出るまで窓を閉じないでください。

標準ポートは3014です。別ポートで使っている場合は、そのフォルダでコマンドプロンプトを開き、例えば次を実行します。

```bat
set PORT=3015
UPDATE_CFS_APP.cmd
```

別のアプリや別フォルダのCFSを停止してポートを奪うことはしません。利用中の正しいフォルダとポートを指定してください。アプリ未起動の場合もこの入口を使えます。

## まだ独立入口のないGit管理版

配布担当者から、公開済みの固定コミットに対応した `scripts/cfs-update-bootstrap.ps1` 単体とSHA256を受け取り、ハッシュを照合してアプリ外の作業フォルダへ保存します。例えば `C:\CFS-Recovery\cfs-update-bootstrap.ps1` から、既存インストール先を明示して実行します。PowerShellの実行ポリシー変更をPC全体に保存する必要はありません。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\CFS-Recovery\cfs-update-bootstrap.ps1'
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:\CFS-Recovery\cfs-update-bootstrap.ps1' -AppDir 'C:\CFS App' -Port 3014 -RepairBuild
```

この単体スクリプトはアプリや古いworkerを必要とせず、OSのPowerShellと同梱Gitを使います。公式公開リポジトリから同一コミットの新workerとhelperを取得して実行します。初回成功後はインストール先の `UPDATE_CFS_APP.cmd` を使います。配布担当者の最終検証を終えていない候補スクリプトは使わないでください。

## 停止した場合

- Git追跡ファイルの編集、独自コミット、異なるremoteは自動修正しません。変更を保全し配布担当者へ相談してください。
- `.next/standalone/data` または `runtime/data` などに旧データが残る場合は削除せず停止します。`docs/LOCAL_DATA_UPDATE_GUIDE_JA.md` に従って原本を保全・照合し、必要な明示移送を完了させます。複数保存先の自動統合は行いません。
- Node.js 20以上とnpmが使えなければ、同梱 `.cfs-runtime` の復元または対応Nodeの導入後に同じ入口を再実行します。
- buildや起動確認の失敗は `artifacts/self-update/status.json` と更新ログへ記録します。原因を直した公開版が出たら同じ入口から取り込めます。古いruntimeが存在するだけでは自動起動しません。
- 別の更新・起動処理が実行中なら待ちます。`.cfs-updater/maintenance.lock` はファイルの存在でなくOSの排他ハンドルで判定するので、残ったファイルを削除する必要はありません。

`.cfs-updater/bootstrap-v1.ps1` は保全する入口、`repository.git` と `stages` は取得用キャッシュです。キャッシュ異常で停止した場合は、すべての起動・更新プロセスが終了したことを確認してから配布担当者と復旧してください。`data`、公開設定、同梱runtime、保全入口を削除する `git clean` やフォルダの丸ごと上書きは行わないでください。

この仕組みは `.git` を含む公式Git管理版が対象です。通信不能・ディスク故障・OSやGit自体の破損まではアプリ更新で修復できません。失敗後も旧版で編集できることを約束するものではありません。
