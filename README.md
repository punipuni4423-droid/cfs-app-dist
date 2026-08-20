# CFS App

CFSアプリは、Fixture / Circuit / Device Assign / Scene / Switch / Command / Backlight / PDUなどを連動管理し、CFS表とプロジェクトバックアップを出力するNext.jsアプリです。

## 主な機能

- プロジェクト、Room Type、エリア、器具、回路、デバイス割当の管理
- Scene / Area Scene / Switch / Command / Backlight Logicの連動確認
- CFS表の表示、InspectionMode、Link Map、ハイライト確認
- CFSタブの表示状態をExcelへ出力
- JSONバックアップ/リストアとローカルサーバー保存

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いて利用してください。タブレットから開く場合は、Project Selection画面上部に表示されるTablet URLを同じネットワーク内の端末で開きます。

## Excel出力

- CFSタブの`Excel Export`は、表示中のCFS表を`<Project>_<Room>_CFS_view.xlsx`として出力します。
- 旧Room Type出力経路は`<Project>_<RoomType>_CFS.xlsx`形式です。
- Excel出力は`exceljs`を使用します。`xlsx`パッケージは現行依存ではありません。

## 開発メモ

- 変更前に`data/projects.json`のバックアップを取ってください。
- CFSのリンク関係を変更する場合は、`Circuit -> Device Assign -> CFS`、`Area Scene -> Scene/RoomScene -> CFS`、`Switch/Command -> Area Sceneまたは直接値 -> CFS`、`CCO -> cco:{assignmentId}`の関係を確認してください。
- 検証は`npm run typecheck`、必要に応じてPlaywright監査とブラウザ確認を行います。
