# CFS 起動トラブルシュート

## 症状

次のような状態になる場合があります。

- `Launch CFS App` が開かない
- `.vbs` をダブルクリックしても反応しない
- 起動中のまま止まる
- ブラウザで `ERR_CONNECTION_REFUSED` が出る
- Microsoftログイン後に `127.0.0.1:3000` で接続拒否になる
- 新しいZIPを入れたのにCFSのRowボタンや修正内容が反映されない

## 推奨起動ファイル

最新版の配布ZIPでは、環境差異を減らすためにビルド済みruntimeとNode.js runtimeを同梱しています。

通常は次を使ってください。

```text
LAUNCH_CFS_APP.cmd
```

これはWindows Script Hostを使わない起動方法です。会社PCで `.vbs` がブロックされている場合でも動く可能性が高いです。

## 診断用起動ファイル

推奨起動ファイルで開かない場合は、次を実行してください。

```text
START_CFS_APP_CONSOLE.bat
```

黒いコンソール画面に起動状況が表示されます。失敗時の原因確認に使います。

## 展開場所

ZIP内から直接起動しないでください。必ずローカルフォルダへ展開してから実行します。

推奨例:

```text
C:\CFS App
C:\Users\<ユーザー名>\Documents\CFS App
```

OneDrive、ネットワーク共有、アクセス権が厳しいフォルダでは、ファイルロックや同期の影響で不安定になることがあります。

## 最新ZIPで改善していること

- 利用者PCで `npm ci` を実行しない
- 利用者PCで `next build` を実行しない
- Node.js未インストールPCでも起動できるように `.cfs-runtime` を同梱
- Git管理ZIPでは、Git未インストールPCでもApp Updateを確認できるようにPortableGitを同梱
- 3014番ポートが使用中なら、空きポートへ自動退避
- 3014番ポートに古い別フォルダのCFSが起動していても、その古いCFSを再利用せず、現在の解凍フォルダのCFSだけを開く
- Microsoftログイン後の3000番ポート戻りを、実際の起動ポートへリダイレクト

## 新しいZIPの内容が反映されない場合

PCを再起動しても古い画面が出る場合は、古いデスクトップショートカットまたはスタートメニューショートカットが、以前の解凍フォルダを起動している可能性が高いです。

1. デスクトップとスタートメニューの古い `CFS App` ショートカットを削除します。
2. 新しく解凍したCFSフォルダを開きます。
3. `CREATE_DESKTOP_SHORTCUT.vbs` を実行します。
4. 表示される `Shortcut target folder` が新しい解凍フォルダであることを確認します。
5. 作り直したショートカットから起動します。

現在起動しているCFSのフォルダとGit状態は、CFSを開いた状態で次のURLから確認できます。

```text
http://localhost:3014/api/app-update/status
```

画面のURLが3014以外の場合は、そのポート番号に置き換えてください。`appDir` が古い解凍フォルダを指している場合は、ショートカットの参照先が原因です。

## Git was not found が出る場合

Git管理ZIPのApp UpdateはGitを使って最新版を確認します。最新版のGit管理ZIPでは `.cfs-runtime\git` にPortableGitを同梱するため、利用者PCにGit for Windowsをインストールしていなくても確認できます。

`Git was not found` が出る場合は、次を確認してください。

- 古いZIPを起動していないか
- ショートカットが古い解凍フォルダを指していないか
- `.cfs-runtime\git\cmd\git.exe` が新しい解凍フォルダ内に存在するか
- 会社PCのセキュリティで `.cfs-runtime` 内の実行ファイルが隔離されていないか

## それでも起動しない場合に共有するもの

次のファイルを共有してください。

```text
artifacts\startup\latest-status.txt
artifacts\startup\start-*.log
artifacts\startup\server-*.log
artifacts\startup\server-*.err.log
```

`latest-status.txt` に最後の状態が残ります。`start-*.log` には起動準備、`server-*.log` にはCFS本体の標準出力、`server-*.err.log` にはCFS本体のエラー出力が残ります。
