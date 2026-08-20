# CFS Linkage Target Catalog Update

更新日: 2026-06-26

## 目的

CFSのLink Mapと赤セル診断で、次の3種類を混同しないようにしました。

- CFSに実際に表示される対象
- Scene / Switch / Commandなどの設定UIで選べる対象
- Link Mapで診断だけに使う対象

## 更新内容

- `buildCfsTargetCatalog`を追加し、Circuit / HVAC / CCO / CCI / CFS表示対象の判定を共通化しました。
- Circuitが存在していてもCFS行として表示されない場合、Individual Overrideや直接設定として有効な参照であればErrorにしません。
- CommandをSwitchとは別の参照元グループとしてLink Mapに表示します。
- Backlightは、対象グループが存在しない場合をError、対象グループは存在するがBy Scene対象ではない場合をWarningとして分けます。
- CFS上の赤セル強調はError中心にし、Warningはタブ表示と診断リストで確認できるようにしました。

## 今後の更新ルール

- CFS表示、InspectionMode、Link Map、Exportで対象IDを扱う場合はTarget Catalogを先に確認します。
- CCIを編集対象へ広げる場合は、仕様変更としてテストを追加してから実装します。
- Backlight LogicはHVACより下に置き、By Scene対象でないBacklight参照をMissing target扱いに戻さないでください。
- `next build`後は既存のNext dev serverが`.next`差し替えで500になる場合があります。ビルド後はlocalhostを確認し、必要に応じてdev serverを再起動してください。

## 検証

- `npm run typecheck`
- `npm run build`
- `npx playwright test tests/e2e/_audit_11_linkage_graph.spec.ts --config=playwright.config.ts`
- TestプロジェクトのCFS / Link Mapブラウザ確認
