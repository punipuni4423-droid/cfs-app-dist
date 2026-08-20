# CFS App 配布ZIP README

このZIPは、CFS Appを別PCで起動するための配布パッケージです。

プロジェクトのローカル保存データ、ゴミ箱、ローカルログ、`.env.local`、Supabase Service Role Key、Microsoft Entraのクライアントシークレットは含めていません。Database版では、同梱の公開設定を使ってログイン後に共有データベースへ接続します。

## 起動方法

1. ZIPをローカルフォルダへ展開します。
   - 推奨: `C:\CFS App`
   - 推奨: `C:\Users\<ユーザー名>\Documents\CFS App`
   - OneDrive、ネットワーク共有、ZIP内からの直接起動は避けてください。
2. `LAUNCH_CFS_APP.cmd` をダブルクリックします。
3. 起動中ウィンドウが表示され、準備が終わると専用ブラウザ画面が開きます。
4. Microsoftログインが必要な場合は、開いた画面でログインしてください。

## 新しいZIPへ入れ替える場合

古いデスクトップショートカットは、作成した時点の解凍フォルダを指し続けます。新しいZIPを解凍しただけでは、古いショートカットの参照先は変わりません。

まずは新しく解凍したフォルダ内の次を実行してください。

```text
CLEAN_REINSTALL_CFS_APP.cmd
```

このヘルパーは、古いCFSサーバーを停止し、デスクトップ/スタートメニューの `CFS App` ショートカットを新しい解凍フォルダへ作り直します。古いショートカット先フォルダを検出した場合は、削除ではなく `_old_yyyyMMdd-HHmmss` へリネーム退避できます。

手動で行う場合は、次の順番で対応してください。

1. CFS Appを閉じます。
2. 古い `CFS App` ショートカットを削除します。
3. 新しく解凍したフォルダ内の `CREATE_DESKTOP_SHORTCUT.vbs` を実行します。
4. 表示されたメッセージの `Shortcut target folder` が、新しい解凍フォルダになっていることを確認します。

ショートカットを使わず確認する場合は、新しい解凍フォルダ内の `LAUNCH_CFS_APP.cmd` を直接実行してください。

詳しい手順は `CFS_CLEAN_REINSTALL_GUIDE_JA.md` を確認してください。

## 開けない場合

通常は `LAUNCH_CFS_APP.cmd` を使ってください。`.vbs` が会社PCのセキュリティでブロックされても、`.cmd` は使える想定です。

それでも起動しない場合は、診断用として次を実行してください。

```text
START_CFS_APP_CONSOLE.bat
```

失敗した場合は、次のファイルを確認または共有してください。

```text
artifacts\startup\latest-status.txt
artifacts\startup\start-*.log
artifacts\startup\server-*.log
artifacts\startup\server-*.err.log
```

## 環境差異を受けにくくするための同梱内容

この配布ZIPには、起動に必要なビルド済みCFS runtimeとWindows用Node.js runtimeを同梱しています。Git管理ZIPでは、App Update用にPortableGitも同梱します。

- `runtime\server.js`: ビルド済みCFS runtime
- `.cfs-runtime`: アプリ同梱のNode.js runtime
- `.cfs-runtime\git`: Git管理ZIPに同梱されるPortableGit
- `LAUNCH_CFS_APP.cmd`: 推奨起動ファイル
- `CLEAN_REINSTALL_CFS_APP.cmd`: 新しいZIPへ安全に入れ替えるための補助ファイル
- `START_CFS_APP_CONSOLE.bat`: 診断用起動ファイル

そのため、利用者PCにNode.jsやnpmがインストールされていなくても起動できる構成です。
Git管理ZIPでは、利用者PCにGit for Windowsがインストールされていなくても更新確認できます。

## ポートとログイン

通常は `http://localhost:3014/` で起動します。

3014番ポートが使用中の場合、ランチャーは自動で空いているポートを探します。Microsoftログイン後に `127.0.0.1:3000` へ戻ってしまうケースに備えて、起動時に3000番ポートのリダイレクト補助も開始します。

## 保存競合が出た場合

共有DB版で別タブ、別ユーザー、または別セッションが先に保存していると、保存時に競合確認が表示されます。画面を閉じずに、現在のドラフトで上書き、サーバー版の再読込、JSONバックアップ出力のいずれかを選んでください。上書きは、確認画面に表示されたサーバー更新時刻と保存時点の更新時刻が一致する場合だけ実行されます。

## 同梱しないもの

- `data\projects.json`
- `data\trash\trash.json`
- `.env.local`
- `.git`（通常の共通ZIPのみ。Git管理ZIPではApp Update用に含めます）
- 開発用の生 `.next`
- ルートの `node_modules`
- `artifacts`
- Playwrightのテスト結果
- Supabase Service Role Key
- Microsoft Entraのクライアントシークレット

## 取扱説明書

最新のHTML取扱説明書は次にあります。

- `Manual\index.html`
- `Manual\CFS_USAGE_GUIDE_COMMON_20260807.html`

## 更新時の注意

通常の共通ZIPはGit管理アプリそのものではなく、配布用パッケージです。アプリ更新はGit側の最新版から新しいZIPを作成し、展開後に実起動確認してから配布してください。

Git管理ZIPでは、Project Selection画面のApp Updateから更新確認できます。`Git was not found` が出る場合は、古いZIPまたはPortableGitなしのZIPを起動している可能性があります。最新版のGit管理ZIPを使い、ショートカットを作り直してください。

### 更新元リポジトリについて

更新元は公開配布リポジトリ（cfs-app-dist）です。読み取りに認証は不要のため、**GitHubアカウントやサインインなしで**更新確認・更新ができます。`Update repository sign-in failed` が表示される場合は、旧ZIP（非公開リポジトリを参照する版）を使用している可能性があるため、最新のZIPへ入れ替えてください。

Personal Access Tokenや秘密鍵をZip、フォルダ、メモに保存しないでください。

現在起動しているフォルダとGit状態は、次で確認できます。

```text
http://localhost:3014/api/app-update/status
```

ポートが3014以外で開いている場合は、URLのポート番号を実際の画面に合わせてください。
