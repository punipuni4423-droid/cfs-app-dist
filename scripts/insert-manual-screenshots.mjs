import fs from "node:fs";
import path from "node:path";

const manualPath = path.resolve(process.cwd(), "docs/CFS_USAGE_GUIDE_COMMON_20260715.html");
let html = fs.readFileSync(manualPath, "utf8");

const screenshotCss = `
    .screenshot-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin: 18px 0 22px;
    }
    figure.manual-shot {
      margin: 18px 0 22px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 6px 18px rgba(30, 45, 60, 0.05);
    }
    figure.manual-shot img {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid #e4ebf0;
      border-radius: 8px;
      background: #f8fafc;
    }
    figure.manual-shot figcaption {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.6;
    }
`;

if (!html.includes(".screenshot-grid {")) {
  html = html.replace(
    "    .small { color: var(--muted); font-size: 0.88rem; }",
    `${screenshotCss}    .small { color: var(--muted); font-size: 0.88rem; }`,
  );
}

if (!html.includes("figure.manual-shot { break-inside: avoid; }")) {
  html = html.replace(
    "      h2 { break-before: page; }",
    "      h2 { break-before: page; }\n      figure.manual-shot { break-inside: avoid; }",
  );
}

html = html.replace(
  "nav.toc ol, .checklist { columns: 1; grid-template-columns: 1fr; }",
  "nav.toc ol, .checklist, .screenshot-grid { columns: 1; grid-template-columns: 1fr; }",
);

function figure(fileName, caption, alt = caption) {
  return `
      <figure class="manual-shot">
        <img src="assets/cfs_usage_common_20260715/${fileName}" alt="${alt}">
        <figcaption>${caption}</figcaption>
      </figure>
`;
}

function grid(...figures) {
  return `
      <div class="screenshot-grid">
${figures.join("")}      </div>
`;
}

function insertAfterSectionHeading(sectionId, content) {
  const marker = new RegExp(`(<section id="${sectionId}">\\s*<h2>[^<]+</h2>)`);
  if (!marker.test(html)) throw new Error(`Section marker not found: ${sectionId}`);
  if (html.includes(`data-shot-section="${sectionId}"`)) return;
  html = html.replace(marker, `$1\n      <div data-shot-section="${sectionId}">${content}      </div>`);
}

function insertAfterH3(text, key, content) {
  const marker = `<h3>${text}</h3>`;
  if (!html.includes(marker)) throw new Error(`Heading marker not found: ${text}`);
  if (html.includes(`data-shot-heading="${key}"`)) return;
  html = html.replace(marker, `${marker}\n      <div data-shot-heading="${key}">${content}      </div>`);
}

insertAfterSectionHeading(
  "project-list",
  grid(
    figure("01-project-selection.png", "Project Selectionでは、新規作成、Import、Export、Trash、共有状態、Tablet URLを確認します。", "Project Selection画面"),
    figure("18-mobile-project-selection.png", "スマートフォン幅でも同じProject Selectionを確認できます。現場の狭い画面では縦スクロールで操作します。", "モバイル幅のProject Selection画面"),
  ),
);

insertAfterSectionHeading(
  "settings",
  figure("17-settings-devices.png", "Device MasterとPDU Settingsは全プロジェクト共通です。PDU、VA、Address Mode、Low End / High Endをここで管理します。", "Device Master画面"),
);

insertAfterSectionHeading(
  "project-screen",
  grid(
    figure("02-project-overview.png", "Project画面では上部に編集ロック、Save Revision、Revision Management、Highlight Updates、設定ボタンが並びます。", "Project画面の上部操作"),
    figure("16-revision-management.png", "Revision Managementでは保存済みRevision、更新履歴、復元対象を確認します。", "Revision Management画面"),
  ),
);

insertAfterH3("Area", "area", figure("03-area-master.png", "Areaでは部屋・エリア名、番号、Codeを管理します。ここでのCodeはCFSのArea Addressなどの元になります。", "Areaタブ"));
insertAfterH3("Fixture", "fixture", figure("04-fixture-master.png", "Fixtureでは照明器具、Fixture Type、電力、PDU対象、備考を管理します。Circuit作成前に整えます。", "Fixtureタブ"));

insertAfterSectionHeading("room-type", figure("05-room-type-workspace.png", "Room Typeを選ぶと、PDUからCFSまでの2段目タブが表示されます。各Room Typeごとに設定を作ります。", "Room Typeワークスペース"));
insertAfterSectionHeading("pdu", figure("06-pdu-tab.png", "PDUタブではRoom Type内の機器別PDU数量とVA計算を確認します。共通VA/PDUはSettings側で管理します。", "PDUタブ"));
insertAfterSectionHeading("circuit", figure("07-circuit-tab.png", "CircuitではDesigner #、Area、Fixture、制御方式などを入力し、後続のDevice AssignやCFSの元データにします。", "Circuitタブ"));
insertAfterSectionHeading("device-assign", figure("08-device-assign-tab.png", "Device Assignでは回路にデバイス、台数、Zone / Address、Groupを割り当てます。HVAC設定も同じ章で確認します。", "Device Assignタブ"));
insertAfterSectionHeading("area-scene", figure("09-area-scene-tab.png", "Area SceneではArea単位のSceneと回路値を設定します。Scene、Switch、CFSの参照元になります。", "Area Sceneタブ"));
insertAfterSectionHeading("scene", figure("10-scene-tab.png", "SceneではFrom PMS SceneとDoor Magnet Sceneを管理し、SettingとBacklight Settingを開いて詳細を設定します。", "Sceneタブ"));
insertAfterSectionHeading("switch", figure("11-switch-tab.png", "SwitchタブではCCI、Palladiom、Pico、PIR、QSMなどの入力機器を登録し、Function SettingでSceneや回路値に接続します。", "Switchタブ"));
insertAfterSectionHeading("command", figure("12-command-tab.png", "CommandではScene外のコマンドや制御行を登録します。CFS上のCommand系出力の確認元です。", "Commandタブ"));
insertAfterSectionHeading("backlight", figure("13-backlight-tab.png", "BacklightではBacklight SceneとPalladiom Backlight Logicを管理します。By Scene / Baseの整合性に注意します。", "Backlightタブ"));
insertAfterSectionHeading("cfs", figure("14-cfs-tab.png", "CFSタブは最終確認画面です。Areas、Devices、Base Columns、Function Columns、Display、Highlights、InspectionMode、Excel Exportを操作します。", "CFS確認タブ"));
insertAfterSectionHeading("inspection", figure("15-inspection-start-dialog.png", "InspectionMode開始時は、新しいRevisionを保存して開始するか、現在Revisionで開始するかを選びます。", "InspectionMode開始ダイアログ"));

fs.writeFileSync(manualPath, html, "utf8");
console.log(`updated ${manualPath}`);
