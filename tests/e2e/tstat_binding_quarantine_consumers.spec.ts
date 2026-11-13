import {test,expect} from '@playwright/test';import ExcelJS from 'exceljs';
import {createNewProject,migrateProjectsWithReport,normalizeProjectSave} from '../../app/lib/storage';
import {createNewRoomType,createEmptySwitchEntry,createEmptyHvacAssignment} from '../../app/lib/constants';
import {collectionLosses} from '../../app/lib/migrationSafety';
import {deriveTstatOccupancy} from '../../app/lib/tstatOccupancy';
import {buildCfsZoneRows} from '../../app/lib/useCfsZoneRows';
import {buildCfsLinkageGraph} from '../../app/lib/cfsLinkageGraph';
import {buildLutronAutomationSpec} from '../../app/lib/lutronSpec';
import {appendProjectExcelSheets} from '../../app/lib/projectExcelExport';
import {copyOperation,operationPasteTargets,pasteOperation} from '../../app/lib/switchOperationClipboard';
import {copySwitchButton,switchButtonCopyTargets} from '../../app/lib/switchButtonCopy';
import {isLosslessTstatQuarantineTransition} from '../../app/lib/tstatBindingQuarantine';
import type {CfsExcelSheetModel} from '../../app/lib/cfsExcelExport';
const wire=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function rawProject(){const p=createNewProject('Anonymous consumer');const room=createNewRoomType('Room');room.id='room';room.hvacAssignments=[{...createEmptyHvacAssignment(),id:'hvac',area:'area'}];const row={...createEmptySwitchEntry('tstat'),id:'tstat-control:room:area:area:function:1',switchGroupId:'tstat-control:room:area:area',switchNumber:'TH1',buttonFunction:'Kept action',condition:'Kept condition',backlightTarget:'target',backlightCondition:'masterOn',tstatBinding:{areaId:'area',assignmentIds:['FORENSIC_RAW_ONLY',7]}};room.switches=[row as never,{...createEmptySwitchEntry('lutronPd'),id:'target',switchGroupId:'target',switchNumber:'TARGET',buttonLabel:'1',buttonCount:'1'}];p.roomTypes=[room];return p;}
test('retained forensic relocation is the only new collection-loss exception',()=>{
 const raw=rawProject();Object.assign(raw.roomTypes[0].switches[0],{tstatBindingQuarantine:{version:9,extra:['prior-id']}});const result=migrateProjectsWithReport([raw]);expect(result.report).toMatchObject({repaired:1,excluded:0});expect(collectionLosses([raw],result.projects)).toEqual([]);
 const tampered=wire(result.projects);(tampered[0].roomTypes[0].switches[0].tstatBindingQuarantine as {raw:unknown}).raw={areaId:'area',assignmentIds:[]};expect(collectionLosses([raw],tampered).length).toBeGreaterThan(0);
 const lostPrevious=wire(result.projects);delete (lostPrevious[0].roomTypes[0].switches[0].tstatBindingQuarantine as {previousQuarantine?:unknown}).previousQuarantine;expect(collectionLosses([raw],lostPrevious).length).toBeGreaterThan(0);
 const shrunk=wire(result.projects);shrunk[0].roomTypes[0].switches.pop();expect(collectionLosses(result.projects,shrunk)).toContainEqual({path:'projects[0].roomTypes[0].switches',action:'excluded',count:1});expect(collectionLosses(result.projects,[])[0]).toMatchObject({action:'excluded',count:1});
});
test('one binding repair covers optional mode repair while required strict fields remain protected',()=>{
 const raw=rawProject();raw.roomTypes[0].switches[0].buttonSetting.circuitSettings=[{circuitId:'load',percentage:'literal',valueMode:'future'} as never];const result=migrateProjectsWithReport([raw]);expect(result.report).toMatchObject({repaired:1,excluded:0});expect(result.projects[0].roomTypes[0].switches[0].buttonSetting.circuitSettings[0]).toEqual({circuitId:'load',percentage:'literal'});
 const invalid=wire(raw);invalid.roomTypes[0].switches[0].id=7 as never;expect(migrateProjectsWithReport([invalid]).report.excluded).toBeGreaterThan(0);const strict=normalizeProjectSave(invalid);expect(strict.roomTypes[0].switches.map(row=>row.id)).toEqual(['target']);expect(strict.roomTypes[0].switches).toHaveLength(1);
});
test('normal binding extension and legacy absence survive wire normalization',()=>{
 const p=rawProject();p.roomTypes[0].switches[0].tstatBinding={areaId:'area',assignmentIds:['hvac']};Object.assign(p.roomTypes[0].switches[0].tstatBinding!,{future:['keep']});const normal=migrateProjectsWithReport([p]);expect(normal.report).toEqual({issues:[],excluded:0,repaired:0});expect(wire(normal.projects[0].roomTypes[0].switches[0])).toEqual(wire(p.roomTypes[0].switches[0]));expect(wire(normal.projects[0].roomTypes[0].switches[0].tstatBinding)).toEqual({areaId:'area',assignmentIds:['hvac'],future:['keep']});
 delete p.roomTypes[0].switches[0].tstatBinding;const legacy=migrateProjectsWithReport([p]);expect(legacy.report).toEqual({issues:[],excluded:0,repaired:0});expect(wire(legacy.projects[0].roomTypes[0].switches[0])).toEqual(wire(p.roomTypes[0].switches[0]));expect(Object.hasOwn(legacy.projects[0].roomTypes[0].switches[0],'tstatBindingQuarantine')).toBe(false);
});
test('CFS graph project workbook and Lutron consumers keep forensic raw out of normal output',()=>{
 const p=migrateProjectsWithReport([rawProject()]).projects[0],room=p.roomTypes[0],source=room.switches[0];const before=JSON.stringify(source);const derived=deriveTstatOccupancy(room);expect(derived.switches.find(r=>r.id===source.id)).toBe(source);expect(derived.switches.filter(r=>r.id===source.id)).toHaveLength(1);
 const rows=buildCfsZoneRows({roomType:room,circuits:[],locations:[],locationById:new Map(),areaAddressByAssignmentCircuit:new Map(),palladiomBySceneTargets:new Map([['target',room.switches[1]]]),selectedAreaIds:new Set(),hiddenDeviceKeys:new Set(),sortMode:'device'});expect(rows.some(r=>r.isBacklight)).toBe(false);
 const graph=buildCfsLinkageGraph({roomType:room,circuits:[],locations:[]});expect(graph.edges.some(e=>e.from==='switch:'+source.id)).toBe(false);expect(JSON.stringify(graph)).not.toContain('FORENSIC_RAW_ONLY');
 const external=buildLutronAutomationSpec({project:p,roomTypeId:room.id});expect(external.switches.some(r=>r.id===source.id)).toBe(false);expect(external.warnings.some(w=>w.code==='tstat_binding_quarantined')).toBe(true);expect(JSON.stringify(external)).not.toContain('FORENSIC_RAW_ONLY');
 const workbook=new ExcelJS.Workbook();const empty:CfsExcelSheetModel={visibleBaseColumns:[],visibleFunctionColumns:[],displayedRows:[],headerGroups:{switchGroups:[],buttonGroups:[],functionNameGroups:[],conditionGroups:[]},mergeInfo:{device:new Map(),dimming:new Map(),designer:new Map(),zone:new Map(),daliGroup:new Map()},highlights:{ffe:false,energySaving:false,areaScene:false,individualOverride:false,inspectionMark:false},expandedPirHeaderKeys:new Set(),resolvers:{baseValues:()=>[],functionValues:()=>[],baseColumnLabel:c=>c.label,hasChangedBaseCell:()=>false,hasChangedFunctionCell:()=>false,hasAreaSceneValueCell:()=>false,hasSceneDifferentOverride:()=>false,hasInspectionMarkForCell:()=>false,isPriorityTriggerColumn:()=>false}};
 appendProjectExcelSheets(workbook,p,{devices:[],wattPerPdu:3.3,buildCfsModel:()=>empty});const text:string[]=[];for(const sheet of workbook.worksheets)sheet.eachRow(row=>row.eachCell(cell=>text.push(cell.text)));expect(text.join('\n')).not.toContain('FORENSIC_RAW_ONLY');expect(text).toContain('Quarantined control (inactive)');expect(JSON.stringify(source)).toBe(before);
});
test('copy operations never use or replace a quarantined function within an otherwise normal physical group',()=>{
 const a={...createEmptySwitchEntry('lutronPico'),id:'a',switchGroupId:'source',buttonCount:'1',buttonLabel:'1'},q={...a,id:'q',tstatBindingQuarantine:null},d={...a,id:'d',switchGroupId:'dest'};const rows=[a,q,d];const before=JSON.stringify(rows);
 expect(copyOperation(rows,'q','function')).toBeNull();expect(copyOperation(rows,'a','switch')).toBeNull();expect(switchButtonCopyTargets(rows,'a')).toEqual([]);expect(copySwitchButton(rows,'a',['d'],()=> 'new')).toBe(rows);
 const clipboard=copyOperation(rows,'d','switch')!;expect(operationPasteTargets(rows,clipboard)).toEqual([]);expect(pasteOperation(rows,clipboard,['source'],()=> 'new')).toBe(rows);expect(JSON.stringify(rows)).toBe(before);
});
test('transition proof rejects changed identity and normal binding disguised as a repair',()=>{
 const raw=rawProject(),out=migrateProjectsWithReport([raw]).projects[0],before=raw.roomTypes[0].switches[0],after=out.roomTypes[0].switches[0];expect(isLosslessTstatQuarantineTransition(before as unknown as Record<string,unknown>,{...after,id:'different'})).toBe(false);
 const normal=wire(raw);normal.roomTypes[0].switches[0].tstatBinding={areaId:'area',assignmentIds:['hvac']} as never;const fake=wire(out);fake.roomTypes[0].switches[0].tstatBindingQuarantine={version:1,reason:'invalid-binding',raw:normal.roomTypes[0].switches[0].tstatBinding};expect(collectionLosses([normal],[fake]).some(i=>i.action==='excluded')).toBe(true);
});
test('quarantine proof never hides sibling settings other-room parent or empty-project losses',()=>{
 const raw=rawProject();raw.roomTypes[0].switches[0].buttonSetting.circuitSettings=[{circuitId:'a',percentage:'50'},{circuitId:'b',percentage:'60'}];raw.roomTypes.push({...createNewRoomType('Other'),id:'other',switches:[createEmptySwitchEntry('contact')]});const output=migrateProjectsWithReport([raw]).projects;
 const sibling=wire(output);sibling[0].roomTypes[0].switches[0].buttonSetting.circuitSettings.pop();expect(collectionLosses([raw],sibling)).toContainEqual({path:'projects[0].roomTypes[0].switches[0].buttonSetting.circuitSettings',action:'excluded',count:1});
 const other=wire(output);other[0].roomTypes[1].switches=[];expect(collectionLosses([raw],other)).toContainEqual({path:'projects[0].roomTypes[1].switches',action:'excluded',count:1});
 const parent=wire(output);parent[0].roomTypes[0].switches.shift();expect(collectionLosses([raw],parent)).toContainEqual({path:'projects[0].roomTypes[0].switches',action:'excluded',count:1});expect(collectionLosses([raw],[])).toEqual([{path:'projects',action:'excluded',count:1}]);expect(migrateProjectsWithReport([])).toEqual({projects:[],report:{issues:[],excluded:0,repaired:0}});
});
