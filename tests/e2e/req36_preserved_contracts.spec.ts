import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {createEmptyHvacAssignment,createEmptySwitchEntry,createNewRoomType,createEmptyCircuitEntry} from '../../app/lib/constants';
import {createNewProject} from '../../app/lib/storage';
import {deriveTstatOccupancy,updateTstatRegistration} from '../../app/lib/tstatOccupancy';
import {dedupeSwitchIds} from '../../app/lib/switchSync';
import {hasTstatBindingQuarantine} from '../../app/lib/tstatBindingQuarantine';
import {uniqueExcelSheetName} from '../../app/lib/excelSheetName';
import {uniqueProjectExcelSheetName} from '../../app/lib/projectExcelTables';
import {buildLutronAutomationSpec} from '../../app/lib/lutronSpec';
import type {RoomType,SwitchEntry} from '../../app/types';

function executable(source:string,select:(node:ts.Node)=>string|undefined,env:Record<string,unknown>){
 const tree=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found:string|undefined;
 const visit=(node:ts.Node)=>{found??=select(node);ts.forEachChild(node,visit);};visit(tree);expect(found).toBeTruthy();
 return vm.runInNewContext(ts.transpileModule(`(${found!})`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,env);
}
test('ordinary Switch edits retain legacy registration absence and stored managed controls',()=>{
 for(const managed of [false,true]){
  let room=createNewRoomType('Room');room.hvacAssignments=[{...createEmptyHvacAssignment(),id:'hvac',area:'area'}];
  if(managed)room=updateTstatRegistration(room,room.hvacAssignments);
  room.switches.push({...createEmptySwitchEntry('lutronPd'),id:'ordinary',switchGroupId:'panel',buttonLabel:'M1'});
  const before=structuredClone(room);let registrationCalls=0;
  const set=executable(readFileSync('app/components/ProjectScreen.tsx','utf8'),node=>ts.isVariableDeclaration(node)&&node.name.getText()==='setSwitches'&&node.initializer&&ts.isCallExpression(node.initializer)?node.initializer.arguments[0].getText():undefined,
   {deriveTstatOccupancy,updateTstatRegistration:(r:RoomType)=>{registrationCalls++;return r;},valuesDiffer:(a:unknown,b:unknown)=>JSON.stringify(a)!==JSON.stringify(b),updateActiveRoomType:(fn:(r:RoomType)=>RoomType)=>{room=fn(room);}});
  set((rows:SwitchEntry[])=>rows.map(row=>row.id==='ordinary'?{...row,switchName:'Changed ordinary name'}:row));
  expect(registrationCalls).toBe(0);expect(room.hvacAssignments).toEqual(before.hvacAssignments);expect(room.nextThermostatNumber).toBe(before.nextThermostatNumber);
  expect(room.switches.filter(r=>r.kind==='tstat')).toEqual(before.switches.filter(r=>r.kind==='tstat'));
  expect(room.switches.find(r=>r.id==='ordinary')?.switchName).toBe('Changed ordinary name');
 }
});
test('existing normalizers repair ordinary IDs without touching managed TSTAT rows',()=>{
 const managed={...createEmptySwitchEntry('tstat'),id:'managed',tstatBinding:{areaId:'area',assignmentIds:['hvac']}};
 const ordinary={...createEmptySwitchEntry('lutronPd'),id:'duplicate'};const rows=[managed,{...ordinary},{...ordinary}];
 const normalize=executable(readFileSync('app/components/SwitchView.tsx','utf8'),node=>ts.isFunctionDeclaration(node)&&node.name?.text==='normalizeNonThermostatRows'?node.getText():undefined,{hasTstatBindingQuarantine});
 const next=normalize(rows,dedupeSwitchIds) as SwitchEntry[];expect(next[0]).toBe(managed);expect(next[0]).toEqual(rows[0]);expect(new Set(next.slice(1).map(r=>r.id)).size).toBe(2);expect(rows[1].id).toBe('duplicate');
});
test('Excel names retain fallbacks boundaries surrogate safety reservation and case-insensitive suffixes',()=>{
 const used=new Set<string>();expect(uniqueExcelSheetName('', 'Fallback',used)).toBe('Fallback');expect(uniqueExcelSheetName('fallback','',used)).toBe('fallback (2)');
 expect(uniqueProjectExcelSheetName('History',used)).toBe('History_');expect(uniqueProjectExcelSheetName("'a\u0001[]'",used)).toBe('a___');
 const long='x'.repeat(29)+'😀';const first=uniqueExcelSheetName(long,'',used);const second=uniqueExcelSheetName(long,'',used);
 expect(first.length).toBeLessThanOrEqual(31);expect(second.length).toBeLessThanOrEqual(31);expect(second).toMatch(/ \(2\)$/);expect(second).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
test('Lutron Text metadata preserves literal value and existing Command machine reference',()=>{
 const p=createNewProject('Anonymous export');const r=createNewRoomType('Room');p.roomTypes=[r];const circuit={...createEmptyCircuitEntry('L1'),id:'load',area:'area'};p.circuits=[circuit];r.circuitIds=['load'];
 const setting={circuitId:'load',percentage:'  23\ntext  ',valueMode:'text' as const};r.scenes=[{id:'scene',name:'Scene',areaId:'area',settings:[setting]}];r.roomScenes[0].settings=[setting];
 const command={...createEmptySwitchEntry('command'),id:'cmd',switchNumber:'tstat-control:stable-reference'};command.buttonSetting.circuitSettings=[setting];r.switches=[command];
 const output=buildLutronAutomationSpec({project:p,roomTypeId:r.id,generatedAt:'2026-11-02T00:00:00Z'});
 expect(output.areaScenes[0].levels[0]).toMatchObject({value:setting.percentage,valueMode:'text'});expect(output.roomScenes[0].directLevels[0]).toMatchObject({value:setting.percentage,valueMode:'text'});
 expect(output.switches[0]).toMatchObject({switchNumber:command.switchNumber,circuitOverrides:[expect.objectContaining({value:setting.percentage,valueMode:'text'})]});
});
