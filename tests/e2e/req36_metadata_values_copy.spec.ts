import {test,expect} from '@playwright/test';
import {createNewProject,migrateProjectsWithReport,normalizeProjectSave} from '../../app/lib/storage';
import {createNewRoomType,createEmptySwitchEntry,createEmptyHvacAssignment,createEmptyCircuitEntry} from '../../app/lib/constants';
import {createCfsCellResolvers} from '../../app/lib/cfsCellResolvers';
import {sceneValueForCircuit} from '../../app/lib/cfsValueResolver';
import {sceneSettingValueForCircuitGroup} from '../../app/lib/circuitGroups';
import {buildAreaSceneMatrix} from '../../app/lib/areaSceneMatrix';
import {copySwitchButton} from '../../app/lib/switchButtonCopy';
import {copyOperation,pasteOperation} from '../../app/lib/switchOperationClipboard';
import {buildCfsZoneRows} from '../../app/lib/useCfsZoneRows';
import {buildCfsLinkageGraph} from '../../app/lib/cfsLinkageGraph';
import type {CfsZoneRow,FunctionColumn} from '../../app/lib/cfsTableModel';
import type {Scene,SceneCircuitSetting,SwitchEntry} from '../../app/types';

test('unknown optional modes retain scene room-scene switch and inspection records',()=>{
 const p=createNewProject('Anonymous optional metadata');const r=createNewRoomType('Room');p.roomTypes=[r];
 const setting={circuitId:'load',percentage:'  old literal\nbody  ',valueMode:'future-mode'} as unknown as SceneCircuitSetting;
 r.scenes=[{id:'scene',areaId:'area',name:'Scene',settings:[setting]}];r.roomScenes[0].settings=[setting];
 const sw={...createEmptySwitchEntry('contact'),id:'switch'};sw.buttonSetting.circuitSettings=[setting];r.switches=[sw];
 r.hvacAssignments=[{...createEmptyHvacAssignment(),id:'hvac',thermostatNumber:'bad',masterAssignmentId:42} as never];
 r.nextThermostatNumber='bad' as never;
 r.inspectionMarks=[{id:'mark',sourceType:'areaScene',sourceId:'scene',targetId:'load',scope:'areaScene',label:'',previousValue:'old',value:'new',valueMode:'future',previousValueMode:'future',markedAt:'2026-11-02T00:00:00Z'} as never];
 const {projects,report}=migrateProjectsWithReport([p]);const out=projects[0].roomTypes[0];
 expect([out.scenes.length,out.roomScenes.length,out.switches.length,out.hvacAssignments.length,out.inspectionMarks?.length]).toEqual([1,r.roomScenes.length,1,1,1]);
 for(const s of [out.scenes[0].settings[0],out.roomScenes[0].settings[0],out.switches[0].buttonSetting.circuitSettings[0]]){expect(s.percentage).toBe(setting.percentage);expect(s.valueMode??'standard').toBe('standard');}
 expect(out.hvacAssignments[0].thermostatNumber).toBeUndefined();expect(out.nextThermostatNumber).toBeUndefined();
 expect(report.issues.some(issue=>issue.action==='excluded')).toBe(false);expect(normalizeProjectSave(projects[0])).toEqual(projects[0]);
 const broken=structuredClone(p);broken.roomTypes[0].scenes[0].settings[0].circuitId=17 as never;
 expect(migrateProjectsWithReport([broken]).report.issues.length).toBeGreaterThan(0);
});

for(const metric of ['Setpoint','Drift'])test(`HVAC ${metric} preserves direct and inherited Text bytes`,()=>{
 const body='  23\n°C?  ';const s={circuitId:'hvac-target',percentage:body,valueMode:'text' as const};
 const scene:Scene={id:'scene',areaId:'area',name:'Scene',settings:[s]};const source=createEmptySwitchEntry('command');source.buttonSetting.circuitSettings=[s];
 const row={isHvac:true,hvacSettingId:s.circuitId,hvacMetric:metric,locationId:'area',circuits:[]} as unknown as CfsZoneRow;
 const col={source} as FunctionColumn;const resolver=createCfsCellResolvers({scenesById:new Map([['scene',scene]]),showAreaSceneNames:false,displayBacklightCondition:v=>v});
 expect(resolver.rawFunctionValues(row,col)).toEqual([body]);source.buttonSetting.circuitSettings=[];source.buttonSetting.sceneIds=['scene'];
 expect(resolver.rawFunctionValues(row,col)).toEqual([body]);
 scene.settings=[{...s,percentage:'23',valueMode:'standard'}];expect(resolver.rawFunctionValues(row,col)).toEqual(['23°C']);
});

test('whitespace-only presence agrees without rewriting Text payload',()=>{
 const circuit={...createEmptyCircuitEntry('L1'),id:'load',area:'area'};
 for(const body of ['','  ','\t\n']){const scene:Scene={id:'scene',areaId:'area',name:'Scene',settings:[{circuitId:'load',percentage:body,valueMode:'text'}]};
  const before=JSON.stringify(scene);expect(sceneValueForCircuit(scene,'load')).toBe('');expect(sceneSettingValueForCircuitGroup(scene.settings,[circuit],circuit)).toBe('');
  const matrix=buildAreaSceneMatrix({scenes:[scene],circuits:[circuit],hvacAssignments:[],curtainAssignments:[],switches:[],locations:[{id:'area',name:'Area',number:'1',code:'A',color:''}]});
  expect(matrix.groups.flatMap(g=>g.rows).find(r=>r.target.circuit?.id==='load')?.cells[0].state).toBe('empty');expect(JSON.stringify(scene)).toBe(before);
 }
 const literal='  A\nB  ';expect(sceneValueForCircuit({id:'s',areaId:'area',name:'S',settings:[{circuitId:'load',percentage:literal,valueMode:'text'}]},'load')).toBe(literal);
});

function pico(id:string,group:string,settings:SceneCircuitSetting[]=[]):SwitchEntry{return {...createEmptySwitchEntry('lutronPico'),id,switchGroupId:group,buttonLabel:'1',buttonCount:'1',buttonSetting:{sceneId:'',sceneIds:[],circuitSettings:settings}};}
test('button and operation paste remap only owned Pico LED references',()=>{
 const rows=[pico('source','a',[{circuitId:'pico-led:a:mur',percentage:' 50 ',valueMode:'text'},{circuitId:'pico-led:foreign:dnd',percentage:'Off'},{circuitId:'load',percentage:'10'}]),pico('dest','b')];
 const before=JSON.stringify(rows);const expected=['pico-led:b:mur','pico-led:foreign:dnd','load'];
 expect(copySwitchButton(rows,'source',['dest'],()=> 'new')[1].buttonSetting.circuitSettings.map(s=>s.circuitId)).toEqual(expected);
 for(const scope of ['function','switch'] as const){const clipboard=copyOperation(rows,'source',scope)!;expect(pasteOperation(rows,clipboard,[scope==='switch'?'b':'dest'],()=> 'new')[1].buttonSetting.circuitSettings.map(s=>s.circuitId)).toEqual(expected);}
 expect(JSON.stringify(rows)).toBe(before);
});
test('button copy rejects invalid priority atomically and leaves unrelated invalid rows alone',()=>{
 const rows=[{...pico('s','a'),isPriorityFunction:true},pico('d','b')];expect(copySwitchButton(rows,'s',['d'],()=> 'new')).toBe(rows);
 const valid=[{...rows[0],isPriorityFunction:undefined},rows[1],{...pico('unrelated','c'),isPriorityFunction:true}];
 const next=copySwitchButton(valid,'s',['d'],()=> 'new');expect(next).not.toBe(valid);expect(next[2]).toBe(valid[2]);
});
test('inactive managed control produces neither backlight row nor active graph reference and retains raw settings',()=>{
 const room=createNewRoomType('Room');const source={...createEmptySwitchEntry('tstat'),id:'inactive',switchGroupId:'control',condition:'Keep',tstatBinding:{areaId:'area',assignmentIds:['missing']},backlightTarget:'target',backlightCondition:'masterOn'};
 const target={...createEmptySwitchEntry('lutronPd'),id:'target-row',switchGroupId:'target',backlightAssignment:'__byScene'};room.switches=[source,target];const before=JSON.stringify(room);
 const rows=buildCfsZoneRows({roomType:room,circuits:[],locations:[],locationById:new Map(),areaAddressByAssignmentCircuit:new Map(),palladiomBySceneTargets:new Map([['target',target]]),selectedAreaIds:new Set(),hiddenDeviceKeys:new Set(),sortMode:'device'});
 expect(rows.filter(r=>r.isBacklight)).toEqual([]);const graph=buildCfsLinkageGraph({roomType:room,circuits:[],locations:[]});
 expect(graph.edges.filter(e=>e.label==='Backlight target')).toEqual([]);expect(graph.issues.filter(i=>i.code==='missing_backlight_cfs_row')).toEqual([]);expect(JSON.stringify(room)).toBe(before);
 room.hvacAssignments=[{...createEmptyHvacAssignment(),id:'missing',area:'area'}];
 const activeRows=buildCfsZoneRows({roomType:room,circuits:[],locations:[],locationById:new Map(),areaAddressByAssignmentCircuit:new Map(),palladiomBySceneTargets:new Map([['target',target]]),selectedAreaIds:new Set(),hiddenDeviceKeys:new Set(),sortMode:'device'});
 expect(activeRows.filter(r=>r.isBacklight)).toHaveLength(1);expect(buildCfsLinkageGraph({roomType:room,circuits:[],locations:[]}).edges.filter(e=>e.label==='Backlight target')).toHaveLength(1);
 room.hvacAssignments=[];expect(room.switches[0]).toBe(source);expect(room.switches[0].backlightTarget).toBe('target');
});
