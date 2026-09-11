# Playwright検証の実行方法

全設定で `PLAYWRIGHT_BASE_URL` が必須です。接続先は `http://localhost:3086`〜`:3095` または同じポートの `127.0.0.1` のみです。未指定・3014・3064・外部ホストはテスト収集前にエラーになります。実働・配布先では実行しないでください。

## 回帰ゲート

作業フォルダ `cfs-app` のPowerShellで、空きポートとタスク専用distを指定します。

```powershell
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:3087'
$env:NEXT_DIST_DIR = '.next-T-113'
npm run release-check
```

typecheck、lint、回帰テストを順に実行します。回帰設定は同じURLから起動ポートを取得します。既存サーバーの再利用は既定で禁止です。自分が起動した隔離サーバーを再利用する場合だけ `CFS_TEST_REUSE_SERVER=1` を指定し、`CFS_AUTH_DIR` をそのサーバーと一致させてください。出力先は `CFS_PLAYWRIGHT_OUTPUT_DIR` で指定できます。認証用の一時ディレクトリは出力先内に作成され、秘密鍵を含むため配布しません。

通常の個別specも、`playwright.config.ts` と同じ隔離URLを使います。認証付き実UI検証では `CFS_TEST_AUTH=1` と隔離サーバーの `CFS_AUTH_DIR` を指定します。

## モックと専用テスト

通常specは `tests/e2e/support/safe-test` からtest/expectをimportします。未モックのAPI/外部通信はcontextで遮断し、テストを失敗させます。popupの初回通信も対象です。モックは `page.context().route()` に登録し、必要な応答を明示してください。`installLocalEditingMocks` はプロジェクト等をメモリ上で保持します。Service Workerは無効です。

HTTPルーティングを迂回する `request` / `context.request` の通信メソッドと `browser.newContext()` / `browser.newPage()` は通常fixtureで拒否します。`page` / `context` fixtureから画面を操作してください。実APIの統合検証は専用設定へ分離します。

手動撮影（通常/Inspection/ツールバー）、既存プロジェクトのLD出力（Room Type/Project）、verify-fill、実API認証/移行/trash統合specの計10ファイルは通常収集から除外しています。専用の `playwright.special.config.ts` と `CFS_ISOLATED_SPECIAL_TESTS=1` を使います。使い捨てのデータ・認証環境を別途用意し、実データには接続しません。この専用設定も許可ポート以外は拒否します。モック済みのツールバー撮影specは通信ガードを維持しています。

安全性自体の検査は `node scripts/test-playwright-config-safety.mjs`、通信ガードは許可URLを指定して `node scripts/test-playwright-network-guard.mjs` で実行できます。後者は意図的な失敗を子プロセスで検証するため、内部ログの失敗表示と最後のPASSを区別してください。

検証前後で `data/projects.json` のSHA256を照合し、所有サーバーを停止します。Nextがtsconfigへ隔離distを自動追記した場合は、その自動変更だけを復元してください。ログ・失敗スクリーンショット・結果JSONをタスク証跡へ保存します。

既知のfixmeは2ケースのみ: B-008のCircuit継続行列位置の古い期待値、T-85記録のPalladiom project-card timeout。その他の失敗をこの理由で除外してはいけません。
