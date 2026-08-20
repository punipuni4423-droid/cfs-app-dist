# CFS Git自動更新運用

CFSのApp Updateは、GitHubなどのGit remoteから本番PCのCFSを半自動更新するための機能です。Engravingプロジェクトと同じく、Git cloneで導入した本番PC向けの更新経路として扱います。共通版Zip単体には`.git`メタデータを含めないため、Zipだけで直接Git更新することはできません。

## 対象

- Git for Windowsが入っているPC、またはPortableGit同梱のGit管理ZIPで導入したPC
- CFSアプリをGit cloneで配置している環境
- `origin/main`または`origin/master`などのupstream branchを設定済みの環境
- GitHubのPrivate repositoryを使う場合は、そのPCのGit認証がrepositoryを読み取れる環境
- CFSアプリのフォルダーへ通常ユーザーで書き込みできる環境

## CFSアカウント権限との関係

App UpdateはCFSのViewer、Editor、Admin権限には依存しません。Supabase共有環境でサインインしていない状態でも、同じPCでCFSを起動でき、Git remoteを読み取れ、アプリフォルダーへ書き込めるなら更新確認と適用ができます。

CFSのRoleはプロジェクトデータの閲覧、編集、ユーザー管理に使います。アプリ本体の更新可否はCFS Roleではなく、Windows上の実行権限、GitHub読み取り権限、Git作業コピーの状態で決まります。

## 共通Zipとの違い

共通版Zipは、新規PCへCFSを配布するためのクリーンなパッケージです。秘密鍵、ローカルデータ、ログ、`.git`フォルダーは含めません。Zip運用で更新する場合は、新しいZipを展開し、旧環境から`Export Project`または`Export All`したデータを新環境へ`Import Data`します。

継続的にApp Updateを使いたい本番PCでは、Git clone版、または`.git`メタデータとPortableGitを含むGit管理ZIPとして配置してください。

## 導入手順

1. GitHubなどにCFSリポジトリを用意します。
2. 本番PCでCFSをGit cloneします。Git管理ZIPで配布する場合は、配布元PCでGit管理ZIPを作成し、本番PCでローカルフォルダへ解凍します。
3. CFSのbranchにupstreamを設定します。
   - 例: `git remote add origin <repo-url>`
   - 例: `git branch --set-upstream-to=origin/master master`
4. 必要な公開設定だけを`.env.local`へ入れます。
   - `CFS_SHARING_MODE`
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `CFS_SUPABASE_FUNCTION_NAME`
5. Service Role Key、Microsoft Entra client secret、Supabase Function secretsはCFSフォルダーへ置かず、Supabase側または管理されたシークレットに置きます。
6. CFSを起動し、Project Selection上部のApp Updateボタンで状態を確認します。

Git管理ZIPの場合、利用者PCにGit for Windowsが無くても、同梱の`.cfs-runtime\git`を使って更新確認します。`Git was not found`が出る場合は、古いZIPまたは古いショートカットから起動している可能性があります。

## 更新時の処理

App Updateを実行すると、バックグラウンドのPowerShellワーカーが次の順番で処理します。

1. Git repository、tracked file、upstream branchを確認します。
2. 追跡済みファイルにローカル変更がある場合は停止します。
3. `data/projects.json`がある場合は`artifacts/data-recovery`へバックアップします。
4. `git fetch --prune`を実行します。
5. localとupstreamの履歴が分岐している場合は停止します。
6. `git pull --ff-only`で早送り更新だけを適用します。
7. `package.json`またはlockfileに差分がある場合だけ`npm ci --no-audit --no-fund`を実行します。
8. `npm run build`を実行します。
9. 既存のCFSサーバーを停止し、同じポートで再起動します。
10. ブラウザは完了後に自動リロードされます。

実行状態とログは`artifacts/self-update`へ保存します。

起動済みCFSの再利用時は、`/api/app-update/status?fetchRemote=0` の `appDir` が現在の解凍フォルダと一致する場合だけ同じサーバーを開きます。別フォルダの古いCFSが同じポートで起動している場合は、自動で別ポートを探して新しいフォルダのCFSを起動します。

## ブロック条件

- Git repositoryがない、またはCFS app folderがGit追跡対象ではない
- Git for Windowsまたは同梱PortableGitが見つからない
- upstream branchが未設定
- GitHub Private repositoryの読み取り認証がない
  - この場合、更新チェックは「Update repository sign-in failed (private repository or missing Git credentials on this PC).」を表示します。配布元に読み取り権限の付与を依頼するか、そのPCでGitHubへの読み取り認証を設定してからRetry Checkを押してください。
- アプリフォルダーへ書き込みできない
- 追跡済みファイルにローカル変更がある
- localとupstreamの履歴が分岐している
- 更新スクリプトが見つからない
- buildまたは依存関係更新に失敗した

## GitHubへアップロードするとき

現在のCFS作業コピーのremoteがローカルbare repositoryを指している場合は、GitHub repositoryへ切り替えてpushします。

```powershell
git remote set-url origin <github-repo-url>
git push -u origin <branch-name>
```

Private repositoryを使う場合、本番PCのGit認証はGitHub credential manager、deploy key、または組織の標準手順で読み取り権限を付与してください。秘密鍵やPersonal Access TokenをCFSのZip、Git、説明書、ログへ入れないでください。

同梱PortableGitの`etc/gitconfig`は、パッケージ作成時に`credential.helper = manager`(パス非依存の形式)へ自動修正されます。ビルド機の絶対パス入りcredential helper設定が混入すると配布先でGit認証が壊れるため、`audit-release-secrets.ps1`もこの形式を検査します。
