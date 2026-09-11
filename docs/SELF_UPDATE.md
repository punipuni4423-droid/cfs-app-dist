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

1. Git repository、tracked file、upstream branch、空き容量を確認します。追跡済みファイルにローカル変更がある場合は停止します。
2. `git fetch --prune`を実行し、localとupstreamの履歴が分岐している場合は停止します。
3. 現在版と取り込み先の両方で`data`がGit追跡対象外であることを確認します。追跡されていれば停止します。
4. `git merge --ff-only @{u}`で早送り更新だけを適用します。追加ファイルと衝突する未追跡ファイルは削除せず退避します。
5. 文書だけの変更ならbuild情報を更新して完了し、依存関係の更新・ビルド・再起動は行いません。
6. コード更新では対象CFSの全書込プロセスを停止し、`data`全体を`artifacts/data-recovery`へ原文でバックアップ・照合します。停止やロック状態、保全を確認できなければ進めません。
7. 依存関係が変更された、または不足している場合は`npm ci --include=dev --no-audit --no-fund`を実行します。Windowsのファイルロック等で失敗した場合は`npm install`で再試行します。
8. 書込停止を再確認してビルド出力を消去し、`npm run build`とstandalone静的ファイルの同期を行います。
9. 書込停止を再確認し、同じポートでCFSを再起動します。
10. 完了状態を記録し、ブラウザは完了後に自動リロードされます。

これは新版ワーカーの手順です。既に動き始めた旧版ワーカーは、Git更新で新スクリプトを取り込んでも上の手順へ切り替わりません。旧ローカル版の初回更新では [ローカル保存の更新・旧版移行手順](LOCAL_DATA_UPDATE_GUIDE_JA.md) に従い、停止・原本退避・保存先確認・必要な明示移送を先に行ってください。

実行状態とログは`artifacts/self-update`へ保存します。

### 配布PCでの起動・更新開始

ランチャーは `.cfs-runtime` にあるNode.js実行ファイルを優先して直接指定します。子の起動バッチ内で変更したPATHは親ランチャーへ戻らないため、親の認証リンク生成も同梱Node.jsで行います。Node.jsが無い、または画面を開けない場合は、起動状態ファイルとエラーメッセージで通知します。認証リンクはログへ出しません。

更新開始時は、PowerShellのEncodedCommandでワーカーへの引数境界を保持します。空白・日本語・単引用符のあるフォルダを `Start-Process -ArgumentList` の単純な配列結合で分割しないための処理です。ワーカーの読み込みなど開始前の例外は `status.json` の `failed` / `launch` として返します。

更新ワーカーはGitの標準出力をUTF-8として読み取ります。Windows PowerShell 5の既定コードページがCP932でも、Gitが返した日本語のリポジトリパスを次のGit操作へ正しく渡します。旧ワーカーがこの段階で失敗する場合は、修正済みZIPを別フォルダへ展開して起動してください。

進捗JSONは同じフォルダの一時ファイルへ完全に書いてから置き換え、状態確認中の読み取りと競合して途中のJSONを返すことを防ぎます。一時的なファイル共有・ロック違反では進捗の公開だけを最大20回、待ち時間の合計950ミリ秒まで再試行します。更新そのものを再実行せず、継続する書き込みエラーは失敗として扱います。

失敗状態のJSONも公開できない場合は更新ログへ記録し、サーバーの復旧判定を続けます。元の更新失敗は成功に変えず、既存サーバーが稼働中なら重複起動しません。

旧版で進捗が止まった場合は、`status.json` と更新ログを確認して配布担当者へ渡してください。旧版が更新ワーカーを開始できなければ、この修正をGit更新だけで取り込めないため、新ZIPを別フォルダに展開して起動します。旧ローカル保存の保全・移送は [ローカル保存の更新・旧版移行手順](LOCAL_DATA_UPDATE_GUIDE_JA.md) に従ってください。更新中か不明な状態で既存フォルダを上書きしないでください。

### 進捗と時間表示

進捗率は最後に確認したサーバーの処理段階を示し、経過時間だけで増やしません。開始待ち・段階不明でも経過時間を常時表示します。処理段階が分かる場合は更新全体の残り時間を「完了までの目安」として範囲表示し、未確認・通信断・通常より長い処理では算出待ちを表示します。目安には既定値、または同PCで成功した更新中に確認できた段階の所要時間を使います。通信断を挟んだ不確かな観測や失敗した更新を学習値へ保存しません。

状態確認APIはHTTP成功とJSON形式を確認し、認証エラーや不正な応答を進捗として扱いません。GETが20秒で応答しない場合はその確認要求を中断し、次のGETで確認します。POSTの応答不明やサーバーエラーでは二重実行を避けるため更新中表示を保ち、自動POST再試行は行いません。前回実行の完了・失敗を今回の終端と混同せず、今回開始時刻を持つ状態を確認します。

開始確認が60秒以上ない場合は状態ファイル・ログの診断案内を表示します。この表示はワーカーの停止・失敗を意味せず、更新処理を勝手に再実行するものではありません。更新あり・再ビルド待ちのボタンは琥珀色で、Latestと見分けられます。

起動済みCFSの再利用時は、`/api/app-update/status?fetchRemote=0` の `appDir` が現在の解凍フォルダと一致する場合だけ同じサーバーを開きます。別フォルダの古いCFSが同じポートで起動している場合は、自動で別ポートを探して新しいフォルダのCFSを起動します。

起動確認では、状態APIのJSONを元の応答バイトからUTF-8として読み取ります。Windows PowerShell 5でも、charset指定のない応答に含まれる日本語フォルダ名を正しく照合します。認証エラーや別フォルダの応答を起動成功として受理することはありません。

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

## 公開配布リポジトリ(cfs-app-dist)運用

2026-08-20以降、配布パッケージの更新元は公開リポジトリ `punipuni4423-droid/cfs-app-dist` です。受領者はGitHubアカウント不要で更新できます。本体`cfs-app`はprivateのまま維持し、非公開履歴はdistへ出しません。

顧客名を含む一回限りのデータ修正スクリプトは2026-08-20にGit管理から削除済みです(必要なら本体privateリポジトリの履歴から復元可能)。**今後、顧客名や案件識別子を含む一時スクリプトはGit管理外の `scripts-local/` に置くこと**(.gitignore登録済み)。`scripts/sync-cfs-dist-repo.ps1` の除外リストと内容監査(顧客名・Supabase ref検査)は再発防止の保険として維持します。

リリース手順:

```powershell
# 1. cfs-appをコミットしてから、distへ1コミット追記(除外+内容監査つき)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-cfs-dist-repo.ps1

# 2. distをcloneソースにしてパッケージ作成(package originはdistのURLになる)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-cfs-git-managed-share-package.ps1 `
  -PackageName "CFS-Database-Latest-GitManaged" -IncludeSharedDatabaseConfig `
  -CloneSourceDirectory "C:\dev\AI\CFS\_cfs-app-dist"
```

distの履歴は線形(fast-forward)を維持すること。ZIP内の`.git`はdistのクリーン履歴のみを含み、cfs-appのprivate履歴を含まないことをリリース前に確認する。

Git管理ZIPの作成時は `--no-local --single-branch --no-tags` で選択した配布ブランチだけを転送します。ローカルmirrorの物理的なobject storeはコピーしません。パッケージ内の全Git objectがHEADから到達可能であること、Git整合性、ZIP内のGitファイルと監査済みstageのSHA256一致を検査し、不一致なら配布を拒否します。

更新経路の動作確認: 2026-08-21 配布リポジトリ経由のアップデート配信テスト。
