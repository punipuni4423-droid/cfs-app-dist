# Supabase Revision Sync

## 方針

CFSのDraftは端末内に保持し、保存済みRevisionだけを共有対象にします。共有モードでは、ブラウザーや配布フォルダーから直接SupabaseテーブルへService Role Keyで接続せず、`cfs-api` Edge Functionを通して読み書きします。

## データ境界

- Draft: 各PCのブラウザーのIndexedDBへProject・利用者・タブ別に退避する。共有DBへ自動アップロードしない。IndexedDBが使えない場合はProject単位の予備領域を試み、退避の成否を表示する。容量超過を理由に以前の退避を削除しない。
- 放置終了: ユーザー承認済みの動作として、新Revをコメント`自動保存`で明示commitする。保存先の本文照合成功後だけViewerへ戻る。通信・認証・lock喪失では未共有のDraftと復旧導線を維持する。
- Current / New Rev: HTTP応答と保存先のProject ID・operation ID・本文・Rev snapshotを照合する。30秒の送信期限と15秒の確認期限は応答本文読取りも含む。結果不明時は状態確認または同じ要求の明示再送を使い、新しいRevを自動生成しない。
- 共通項目の履歴: Project名・設定・Remarks・Area・Fixtureは非再帰の`commonRevisions`（P1、P2…）へ保持する。RoomType Revの復元から暗黙に共通項目を巻き戻さない。共通履歴の復旧はプレビューと確認後の端末編集とし、共有保存は通常のlock/CAS検査を通す。Full Project backupは履歴を保持し、RoomType Shareは共通履歴と保存operation metadataを含めない。
- Committed Revision: Microsoft Entraでサインインし、CFS membershipで許可されたユーザーだけがEdge Function経由で読み書きする。
- Edit Lock: Editor/Adminだけが取得できる。現行CFSはワークスペース単位の保存形式なので、共有モードではCFS全体の編集ロックを使う。
- Audit: 保存者名、保存時刻、Revision履歴を保持する。

## クライアントに置ける値

```env
CFS_SHARING_MODE=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
CFS_SUPABASE_FUNCTION_NAME=cfs-api
```

## クライアントに置かない値

- `SUPABASE_SERVICE_ROLE_KEY`
- Microsoft Entra client secret
- Supabase database password
- refresh token / access tokenの固定値
- bootstrap Admin secret

これらはSupabase Auth/provider設定またはFunction secretsだけに置きます。

## 認証と権限

1. CFS clientはSupabase AuthのAzure providerでMicrosoft Entraサインインを開始する。
2. Edge FunctionがSupabase JWTを検証する。
3. Azure provider、許可tenant/domain、active membershipを確認する。
4. Viewerは閲覧/Exportのみ、Editorは編集ロックとRevision保存、Adminはmembership管理を行う。
5. 最終active Adminの無効化、降格、メール移行はDB側トランザクションで拒否する。

## 旧Direct REST同期について

過去の実装では`.env.local`のService Role Keyで`/rest/v1/cfs_projects`へ直接同期していました。この方式は配布事故のリスクが高いため非推奨です。

一時的な移行/復旧でどうしても必要な場合だけ、`CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC=1`または`-AllowLegacyServiceRole`を明示して使用します。通常のCFS共有運用では使いません。
