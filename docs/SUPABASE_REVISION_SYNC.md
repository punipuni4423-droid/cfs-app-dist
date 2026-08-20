# Supabase Revision Sync

## 方針

CFSのDraftは端末内に保持し、保存済みRevisionだけを共有対象にします。共有モードでは、ブラウザーや配布フォルダーから直接SupabaseテーブルへService Role Keyで接続せず、`cfs-api` Edge Functionを通して読み書きします。

## データ境界

- Draft: 各PCのブラウザー保存。共有DBへ自動アップロードしない。
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
