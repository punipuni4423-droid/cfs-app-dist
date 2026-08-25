# CFS リビジョン差分の誤検出（キー順序）修正案 — Codex 引き継ぎ

作成: 2026-08-25 / 調査: Claude Code / 実装担当: Codex

## 1. 症状

- Supabase ホスト運用のプロジェクトで、**リロード後は常に「Draft」バッジが出る**（未保存の変更が無くても）。
- Update Highlights（黄色 `.revision-changed-cell`）を ON にすると、**変更していないスイッチまで「変更あり」**として光る。
- 同じ原因で、Revision Management の差分パネルに **空振りの差分エントリ**（`Scene/override setting: Configured -> Updated` / `Backlight logic: Configured -> Updated`）が出る。

## 2. 原因

リビジョンの `snapshot` は **JSON 文字列**として payload に格納される（`RoomTypeRevision.snapshot: string`）。
一方、現在のデータは Supabase の **jsonb** を経由して読み戻されるため、**オブジェクトのキー順が正規化**される。

差分判定が `JSON.stringify` の一致比較なので、**中身が同一でもキー順が違えば「差分あり」**になる。

### 実データによる裏付け（JET Project）

`payload::text` で直接確認した実際のバイト列:

```
live（jsonb 経由）: {"key": "base", "mode": "Manual", "name": "Base", "active": "100", "inactive": "20"}
snapshot（文字列）  : {"key":"base","name":"Base","mode":"Manual","active":"100","inactive":"20"}
                                    ^^^^^^^^^^^^^^^^^^^^^ name と mode が入れ替わる
```

ブラウザ側の生成順は `constants.ts` の `createDefaultBacklightLevels()`（`key, name, mode, active, inactive`）。
jsonb はキー長→バイト順で正規化するため `key(3), mode(4), name(4), active(6), inactive(8)` になる。

JET Project（今回の CCO 修正を**適用する前**の v42 payload）で全ルームタイプを検査した結果:

```
RoomType  最新rev  snapshot==現在  キー順のみの差  実値の差
A Type    1.10     NO              9              0
B Type    1.08     NO              9              0
...（全21ルームタイプ同じ）...
U Type    1.07     NO              9              0
```

A Type のスイッチ 17 件を項目単位で調べた結果:

```
差分扱いされたフィールド: backlightLevels 17件 / buttonSetting 17件
キー順のみの差: 34    実値の差: 0
```

つまり **実データの差分はゼロ**で、全てキー順序に起因する誤検出。

## 3. 修正方針

比較時にだけ**キーを再帰的にソートした正規形**で突き合わせる。

- **配列の順序は絶対にソートしない**（行順・シーン順・backlightLevels の並びは意味を持つ）。
- 保存形式（`snapshot` の中身）は**変更しない**。既存の約200件のリビジョンをそのまま扱えるようにするため、比較側だけを直す。
- `JSON.stringify(undefined) === undefined` の挙動を壊さない（既存コードが「両方 undefined なら一致」に依存している）。

### 新規ファイル `app/lib/canonicalJson.ts`

```ts
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);          // 配列順は保持
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
    return result;
  }
  return value;
}

/** JSON.stringify と同じ戻り値仕様（undefined は undefined を返す）でキー順だけ正規化する。 */
export function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(canonicalize(value));
}

/**
 * まず素の JSON.stringify で比較し、違ったときだけ正規形で再判定する。
 * 一致するケースが大半なので、正規化コストはほぼ発生しない。
 */
export function valuesDiffer(a: unknown, b: unknown): boolean {
  if (JSON.stringify(a) === JSON.stringify(b)) return false;
  return canonicalJson(a) !== canonicalJson(b);
}
```

## 4. 変更箇所

### `app/components/ProjectScreen.tsx`（必須）

| 行 | 関数 | 現在 | 変更後 |
|---|---|---|---|
| 714 | `revisionSnapshotsEqual` | `JSON.stringify(before) === JSON.stringify(after)` | `!valuesDiffer(before, after)` |
| 718–719 | `changedIds` | `Map(... [item.id, JSON.stringify(item)])` で比較 | `canonicalJson(item)` を値にする |
| 768 | `changedFields` | `JSON.stringify(beforeItem?.[key]) !== JSON.stringify(afterItem?.[key])` | `valuesDiffer(beforeItem?.[key], afterItem?.[key])` |
| 848–849 | `uniqueChangedSwitchGroups` | 同上パターン | `valuesDiffer(...)` |
| 860 / 868 | `hasBacklightLogicChange` | `JSON.stringify(a) !== JSON.stringify(b)` | `valuesDiffer(a, b)` |
| 926–927 | `revisionSectionChanges`（cfsRowDisplay） | 同上 | `valuesDiffer(...)` |
| 1066–1067 | `revisionDiff`（cfsRowDisplay） | 同上 | `valuesDiffer(...)` |
| 1437 | `roomTypeHasRevisionDraftInProject` | `JSON.stringify(current) !== JSON.stringify(latest)` | `valuesDiffer(current, latest)` |

### `app/lib/revisionChanges.ts`（必須 / 現在 Claude Code の未コミット作業）

| 行 | 関数 | 変更 |
|---|---|---|
| 406 | `changedFieldsById` | `valuesDiffer(beforeItem?.[key], afterItem?.[key])` |
| 563 | inspectionMarks 比較 | `valuesDiffer(previous, next)` |
| 642 / 651 | `cfsRowDisplay` の order / hidden | `valuesDiffer(...)`（文字列配列なので実害は無いが統一） |

### 触ってはいけない箇所

- 133 行 `sessionStorage.setItem(..., JSON.stringify(navigation))` — 保存用
- 382 行 `JSON.parse(JSON.stringify(source))` — ディープクローン
- 1424 行 `snapshot: JSON.stringify(snapshot)` — **保存形式。変更すると既存リビジョンとの整合が崩れる**
- 268 行 `inspectionPayloadsEqual` — 双方ともセッション内オブジェクトなのでキー順は一致する。変えても害はないが必須ではない

## 5. 検証

### 単体レベル

- `canonicalJson({a:1,b:2}) === canonicalJson({b:2,a:1})` が true
- `canonicalJson([1,2]) !== canonicalJson([2,1])`（**配列順は保持されること**）
- `canonicalJson(undefined) === undefined`
- ネストしたオブジェクト（`buttonSetting.circuitSettings[]`）でも成立すること

### E2E

1. **新規スペック**: リビジョン snapshot のキー順を意図的に入れ替えたプロジェクトを `installLocalEditingMocks` でシードし、
   - Draft バッジが**出ない**こと
   - Update Highlights を ON にしても `.revision-changed-cell` が **0 件**であること
   - Revision Management の差分パネルが `No data changes from the previous revision.` になること
2. **既存リグレッション**（いずれも green を維持）
   - `tests/e2e/protected-behavior.spec.ts`（`--grep "revision"` を含む全体）
   - `tests/e2e/revision_diff_panel.spec.ts`
   - `tests/e2e/cfs-smoke.spec.ts`
3. `npm run typecheck` / `npm run lint` / `npm run build`

### 実データ確認（読み取りのみ）

修正後のビルドで JET Project を開き、**21ルームタイプすべてで Draft バッジが消えること**を確認する。
Supabase への書き込みは不要。比較ロジックだけの修正なのでデータ変更は発生しない。

## 6. 注意 / 調整事項

- **`app/lib/revisionChanges.ts` と `ProjectScreen.tsx` のリビジョン差分セクションは、2026-08-25 時点で Claude Code の未コミット作業**（Revision メモ＋差分パネル、`docs/CFS_UPDATE_HISTORY.md` 追記7）。
  同じファイルを触るので、着手前に作業ツリーの状態を確認し、必要なら先にコミットしてもらうこと。
- 修正後は JET など既存プロジェクトの比較基準が「最新リビジョン vs 現在」から「前リビジョン vs 最新リビジョン」に切り替わる（Draft でなくなるため）。これは意図した挙動。
- 根本対策として「保存時に snapshot を正規形で書く」案もあるが、**既存の約200件のリビジョンは救えない**ため、比較側の修正を主とする。保存側の正規化は任意（やる場合も比較側の修正は必須）。
- アプリコードのみの変更で、Supabase データ・エクスポート・スキーマへの影響は無い。
