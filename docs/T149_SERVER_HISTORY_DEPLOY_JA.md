# T-149 SQL 適用・停止復旧手順（Master用、未配備）

本書はMaster向けの適用手順です。本番への適用・公開は未実施です。SQLはsupabase/migrations/20260925022000_project_history_and_strict_save.sql、検証・緊急停止SQLはscripts/t149/にあります。

## 契約

- `save_cfs_project(text, uuid, text, text, jsonb, text)`の6引数、`merge_cfs_projects(text, uuid, text, text, jsonb, jsonb, jsonb)`の7引数を維持。
- 保存本文の一時キー `_cfsBaseVersion`（JSON number）・`_cfsBaseHash`（opaque string）・`_cfsOperation`・`_cfsRestoreSource` と `_cfsWriteProtocol` は永続payload／receipt／hashから除外。通常の既存案件保存はversion、hash、従来updatedAtの全一致が必要。protocol=2でもbaseなしの旧クライアントは保存不可。サーバーで最新版baseを自動補完しない。
- hashはPostgreSQL JSONB textをUTF-8にしたSHA256。ブラウザのJSON.stringifyや独自canonical JSONで計算し直さず、`read_cfs_projects(uuid)`の同一SQL statementで返す `{projects,bases}` を保持する。
- readはactiveかつnot rebind_requiredのviewer/editor/admin。案件ごとの独自ACLは既存schemaに無く、既存と同じworkspace membership境界。
- listは `list_cfs_project_history(uuid,text,int default 50,bigint default null)` → `{items,nextBeforeVersion}`。getは `get_cfs_project_history(uuid,text,uuid)` → `{item,snapshot,project,base,restoreSource,restoreBlockedReason?}`。両方adminのみ。本文を一覧に含めない。
- previewは `preview_cfs_project_restore(uuid,text,jsonb)` → `{project,base,restoreSource}`。sourceは `{kind:'history',id}`（admin）、`{kind:'room-type-revision',roomTypeId,revisionId}`／`{kind:'common-revision',id}`（editor/admin）。保存時にもsourceを現在のロック済みheadから再構築し、候補と本文の業務内容一致を検査する。復元フラグだけで迂回できない。
- 履歴復元は現在のcommonRevision／RoomType Revision配列を保持する。古い履歴に含まれない現在RoomTypeがRevisionを持つ場合、`project:null`と理由を返し復元拒否。段階2前に履歴を捨てて通さない。
- RoomType復元は13 business fields＋scope circuitを対象とし、他Roomの回路を上書きするID衝突を拒否。既存snapshot文字列を一切書換えない。旧UIが推論する4項目（dryContacts、curtainAssignments、cfsRowDisplay、backlightLevels）が欠損した古いsourceの明示previewは保守的に拒否し、JSON退避／手動比較を必要とする。
- RoomType既存id／Revision id／snapshotの文字列は削除・変更不可。revision/note/savedAt/savedByの既存metadata編集は許可。commonRevisionは従来どおりオブジェクト全体不変。
- 通常保存の巻戻り検知は直近50履歴の業務内容一致＋他者による途中遷移、およびRoomType13項目＋scoped circuits／共通Revision投影一致。旧RevisionのsavedAt/savedByは編集可能で信頼できないため、Revision一致は同一actorでも保守的に拒否し明示復元を要求する。恣意的な小変更を加えた巻戻りまで一般的に識別する仕組みではない。
- 新規作成のみ従来のleaseなし例外を維持。既存IDの再試行はlease必要。Trashはworkspace lease＋原本照合を維持。rename/deleteはサーバーがheadに狭い変更だけを行うため従来updatedAt CASを維持し、二重baseを自動生成する置換保存へ変換しない。
- receiptは従来の現在headのoperationIdだけ。完全再試行は権限／lease／deleted確認後、stale判定より先に返し、履歴・versionを増やさない。後続保存後の古いoperation receipt保持は段階2の外部operation表が必要。

## 履歴と保持

BEFORE UPDATE/DELETE triggerが直前payload全体とversionを同一transactionで記録する。履歴INSERT・一意制約・保持処理が失敗した場合、本文、Trash、eventを含むtransaction全体がrollbackする。新規作成時は存在しなかった前版を捏造しない。

`version`は退避されたOLD.version、`parent_version`はその版の前版番号（v1はnull）。`actor_user_id`／`actor_name`／`created_at`は「そのOLDを退避させた操作」の人と時刻であり、snapshotが最初に作られた人と時刻ではない。元保存者はsnapshot.lastUpdatedBy等に残る。vNの履歴actorはvN→vN+1の人なので、他者遷移判定は一致履歴自身から現head直前までを調べる。DB ownerの直接DELETEはactor=null／Database maintenanceと記録する。

案件・ユーザーへのcascade FKを設けず、親削除でも履歴は残す。保守関数は所有者専用。保持削除は新しい履歴捕捉の際に当該案件だけで実行し、`created_at < clock_timestamp() - interval '90 days'` **かつ** version順の直近50件の外側だけ削除。更新の止まった案件を定期掃除するjobは含めない。名前付きRevisionには触らない。

## 本番適用

1. Masterが保存・作成・import・復元・改名・削除・Trash更新／cleanupを一時停止し、開始済み書込の完了を確認する。対象テーブルの件数・version・hashが継続して変化しないことを確認してから、現SQL関数定義／grant／trigger、`cfs_projects`、`cfs_workspace_trash`、`cfs_revision_events`、既存なら`cfs_project_history`を私有バックアップへ保存する。各backupの件数とSHA256を記録し、顧客本文・メール・秘密値を結果票へ転記しない。
2. 新アプリ／Edgeのbase sidecar・preview・error mappingを先にレビューし、旧クライアントがstrict保存拒否になることを利用者へ案内する。書込停止中にSQL→対応Edge→対応アプリの順で揃える。旧Edgeはbaseを送れないためSQLだけ配備して書込再開しない。
3. Owner `postgres`で `20260925022000_project_history_and_strict_save.sql` を一つのDB queryとして適用する。Supabase CLIを使う場合はMasterが使用中の`supabase db query --help`でファイル入力方式を確認し、承認済みlinked projectへファイル全文を渡す。手作業で文を抜粋しない。SQLはBEGIN/COMMITを含み、再実行可能。
4. `verify-deployment.sql` を読取実行。history/projectのRLS=true、direct_writeは全行false、現行5署名のfunction_exists=true・service_execute=true・anon_execute/authenticated_execute=false、signature維持、trigger enabled、hash_mismatches=0を確認する。overload一覧のread/list/get/previewはservice_execute=true、履歴capture/prune helperは3roleともfalseを維持する。旧set5/merge6/trash5は実行権限が残っていても例外のみのstubであり、隔離検証で書込不可を確認する。
5. Masterが検証環境3064の承認済みTest案件と実認証で「読込→編集lock→保存→履歴OLD一致→新base」「古いbase409」「異session423」「Discard POST0」「admin履歴preview→新version restore」を実走する。本SQL担当は実共有DBで未実施。既存顧客案件の件数・id・主要件数がbackupと一致することを再確認してから書込を再開する。

## 不調時の停止と復旧

- COMMIT前のSQLエラーは全体rollback。原因修正後に全文を再適用する。
- COMMIT後に問題が判明したら `emergency-write-stop.sql` 全文をOwnerとして適用し、以下5署名のservice_role実行を止める。同一transactionのため途中エラーは全体rollbackし、再適用も可能。本文・Trash・新履歴を保持し、`cfs_project_history`やtriggerをDROPしない。

  | 署名 | 停止するアプリ書込 |
  | --- | --- |
  | `save_cfs_project(text,uuid,text,text,jsonb,text)` | 通常Save、新規作成、履歴／Revision復元の確定 |
  | `merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb)` | 一覧統合、import、Trash案件復元 |
  | `rename_cfs_project(text,uuid,text,text,text,text,text)` | 改名 |
  | `delete_cfs_project_to_trash(text,uuid,text,text,text,text)` | 案件削除とTrash退避 |
  | `save_cfs_workspace_trash(text,uuid,text,text,jsonb,text)` | Trash更新、RoomType Trash、復元後cleanup |

- 停止対象は**アプリの共有案件・履歴・Trash本文を書き込むRPC**。停止前から実行中のRPCを取消す仕組みや、全DB／全アプリを読取専用にする仕組みではない。新しい書込要求を止め、開始済み操作の完了と対象テーブルの安定を確認してからsnapshot／backupを確定する。読取・履歴一覧／取得／復元preview、認証・membership・lease操作、Ownerの直接保守は維持される。ローカルDraftも停止対象外。Owner保守を同時実行しない。
- 停止後は `verify-deployment.sql` の現行5署名すべてでfunction_exists=true・service_execute=falseを確認する。anon/authenticatedの権限、直接DML、履歴helper境界は適用前から変わらないこと、読取／previewが利用可能なことを確認する。旧set5/merge6/trash5は以前と同じ例外stubを維持し、緊急時に代替書込として使わない。
- 過去のunsafe save関数だけに戻すと履歴保全やstrict CASが失われるため、自動rollbackとして行わない。新schemaを保持したforward fixを基本とする。機能復旧前にbackupとの差分、履歴hash、source候補、ACLを再検査し、このmigration全文を再適用する（既存Trash6引数を含む5署名のservice_role grantを復帰）。**再適用COMMITでRPC実行権限が戻る**ため、アプリ側の書込停止は継続し、対応Edge／アプリを揃えて独立検証後に利用者の操作を再開する。隔離環境で停止→再適用を2巡し、5署名のACLと実保存／Trash6保存、CAS／lease／履歴維持を確認する。
- どうしても旧関数へ戻す場合はMasterの別途判断と書込停止を前提とし、事前退避した関数／ACLを比較し、履歴triggerと直接書込剥奪を残す互換修正を作成してから行う。本票は履歴削除や全DB巻戻しを承認しない。

## 実施済みの隔離検証

PostgreSQL 15.19、loopback専用55491、DB `t149`、合成ユーザー／案件のみ。初期schemaから既存migration8本＋既存直接書込剥奪＋新migrationを順次適用し、新migrationは毎回2回適用して冪等性を確認。

既存20260910210000の`has_table_privilege`文字列にPG15に無い`MAINTAIN`があるため、**fixture専用コピーのみ**その権限名を除外した。製品の旧migrationは未編集。他のINSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/column検査は維持。

最終自己試験は `run-sql-tests.ps1` と `node concurrency-tests.mjs`。SQL90assertions＋2process試験2件がPASS。追加変更後は必ず最終log/hashを結果票に更新する。二重base、snapshot文字列、common保護、履歴復元時の新Revision保持、source偽装／cross-project／古いpreview、role実権限、expired/wrongsession、history INSERT失敗rollback、90日／50件保持、全update/delete経路を含む。

独立reviewの指摘で、JSON nullの復元sourceを未指定へ正規化し、実Edge型のnull envelopeでcreate/save/trashを確認した。巻戻り探索では不正JSON／過去scope衝突の比較不能Revisionだけをskipして通常編集を妨げず、同じsourceの明示preview/restoreは引き続き拒否する。元snapshot文字列は保存前後で一致する。

並列harness初回は補助ロックをproject→workspaceの逆順に取ったため人工的なdeadlockでFAIL。原本JSONを保全。実RPCと同じworkspace→project順へ修正後、同baseは一方成功・一方STALE_BASE、履歴1件。別試験でadvisory待機中lease失効を再現し、CFS_LOCK_REQUIRED・本文／履歴変更0を確認した。

本番Supabase／Edge／実ブラウザー、576KB×多数履歴のp95、stage2 migration、operation表、共有環境の最終受入は未実施。
