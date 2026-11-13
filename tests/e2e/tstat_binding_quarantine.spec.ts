import {test,expect} from '@playwright/test';
import {createEmptySwitchEntry,createEmptyHvacAssignment,createNewRoomType} from '../../app/lib/constants';
import {createNewProject,migrateProjectsWithReport,normalizeProjectSave} from '../../app/lib/storage';
import {deriveTstatOccupancy,isActiveTstatControl,updateTstatRegistration} from '../../app/lib/tstatOccupancy';
import {duplicateRoomType} from '../../app/lib/roomTypeCopy';
import type {SwitchEntry} from '../../app/types';
const json=(v:unknown)=>JSON.parse(JSON.stringify(v));
function fixture(){const p=createNewProject('Anonymous quarantine');const r=createNewRoomType('Room');r.id='room';r.hvacAssignments=[{...createEmptyHvacAssignment(),id:'hvac',area:'area',thermostatNumber:1}];
 r.switches=[{...createEmptySwitchEntry('tstat'),id:'saved-row',switchGroupId:'saved-group',switchNumber:'TH1',tstatBinding:{areaId:'area',assignmentIds:['hvac']},buttonFunction:'Keep action',condition:'Keep condition',backlightTarget:'Keep target',backlightCondition:'masterOn',buttonSetting:{sceneId:'scene',sceneIds:['scene'],circuitSettings:[{circuitId:'load',percentage:'  literal\nbody  ',valueMode:'text'}]}}];Object.assign(r.switches[0],{futureField:{preserve:'future'}});p.roomTypes=[r];return p;}
const shapes=[null,'binding',17,true,[],{}, {areaId:7,assignmentIds:[]},{areaId:'area',assignmentIds:'hvac'},{areaId:'area',assignmentIds:[7]}];
for(const [index,raw] of shapes.entries())test(`invalid JSON binding shape ${index} retains row content raw and one repair`,()=>{
 const p=fixture(),expected=migrateProjectsWithReport([p]).projects[0].roomTypes[0].switches[0];p.roomTypes[0].switches[0].tstatBinding=raw as never;
 const {projects,report}=migrateProjectsWithReport([p]);const room=projects[0].roomTypes[0];expect(room.switches).toHaveLength(1);const row=room.switches[0];
 expect(json(row)).toEqual(json({...expected,tstatBinding:{areaId:'',assignmentIds:[]},tstatBindingQuarantine:{version:1,reason:'invalid-binding',raw}}));
 expect(report).toMatchObject({repaired:1,excluded:0});expect(report.issues).toEqual([{path:'projects[0].roomTypes[0].switches[0].tstatBinding',action:'repaired',count:1}]);expect(isActiveTstatControl(row,room.hvacAssignments,room.switches)).toBe(false);
 expect(migrateProjectsWithReport(json(projects)).report.issues).toEqual([]);expect(json(migrateProjectsWithReport(json(projects)).projects)).toEqual(json(projects));expect(normalizeProjectSave(projects[0])).toEqual(projects[0]);
});
for(const wrapper of [null,false,{version:9,raw:{id:'forensic'}},{version:1,reason:'invalid-binding',raw:{id:'forensic'},future:'preserve'}])test(`quarantine own-property presence is inactive for ${JSON.stringify(wrapper)}`,()=>{
 for(const bindingPresent of [true,false]){const p=fixture(),input=p.roomTypes[0].switches[0];if(!bindingPresent)delete input.tstatBinding;Object.assign(input,{tstatBindingQuarantine:wrapper});
 const {projects,report}=migrateProjectsWithReport([p]);const room=projects[0].roomTypes[0],row=room.switches[0];expect(json(row)).toEqual(json(input));expect(report.issues).toEqual([]);expect(isActiveTstatControl(row,room.hvacAssignments,room.switches)).toBe(false);
 const derived=deriveTstatOccupancy(room);expect(derived.switches.find(r=>r.id===row.id)).toBe(row);expect(derived.warnings.join(' ')).toMatch(/quarantin|invalid binding/i);expect(JSON.stringify(derived.warnings)).not.toContain('forensic');
 const registered=updateTstatRegistration(room,room.hvacAssignments);expect(json(registered.switches.find(r=>r.id===row.id))).toEqual(json(row));
 const copy=duplicateRoomType(projects[0],room.id)!.project.roomTypes.at(-1)!;const copied=copy.switches.find(r=>(r as unknown as Record<string,unknown>).tstatBindingQuarantine!==undefined||(wrapper===null&&Object.hasOwn(r,'tstatBindingQuarantine')))!;expect(json((copied as unknown as Record<string,unknown>).tstatBindingQuarantine)).toEqual(wrapper);
 }
});
test('existing quarantine plus invalid binding preserves both JSON values once',()=>{
 const p=fixture(),row=p.roomTypes[0].switches[0],previous={version:9,extra:['old-id']};row.tstatBinding={areaId:'area',assignmentIds:false} as never;Object.assign(row,{tstatBindingQuarantine:previous});
 const first=migrateProjectsWithReport([p]),out=first.projects[0].roomTypes[0].switches[0] as unknown as Record<string,unknown>;expect(out.tstatBindingQuarantine).toEqual({version:1,reason:'invalid-binding',raw:{areaId:'area',assignmentIds:false},previousQuarantine:previous});expect(first.report).toMatchObject({repaired:1,excluded:0});expect(json(migrateProjectsWithReport(json(first.projects)))).toEqual({projects:json(first.projects),report:{issues:[],excluded:0,repaired:0}});
});
test('quarantine identity and Area never auto-merge into a replacement scaffold',()=>{
 const p=fixture(),room=p.roomTypes[0],row=room.switches[0];row.switchGroupId='tstat-control:room:area:area';row.id=row.switchGroupId+':function:1';row.tstatBinding={areaId:'',assignmentIds:[]};Object.assign(row,{tstatBindingQuarantine:{version:1,reason:'invalid-binding',raw:{private:'forensic'}}});
 const before=JSON.stringify(row),derived=deriveTstatOccupancy(room);expect(new Set(derived.switches.map(r=>r.id)).size).toBe(derived.switches.length);expect(derived.switches.filter(r=>r.switchGroupId===row.switchGroupId)).toEqual([row]);expect(JSON.stringify(derived.switches.find(r=>r.id===row.id))).toBe(before);expect(derived.switches.filter(r=>r.id!==row.id).every(r=>r.buttonFunction!=='Keep action'&&r.backlightTarget!=='Keep target')).toBe(true);
});
test('normal binding including extension and missing legacy stay byte-identical',()=>{
 const p=fixture();Object.assign(p.roomTypes[0].switches[0].tstatBinding!,{future:'preserve'});const before=json(migrateProjectsWithReport([p]).projects);expect(json(migrateProjectsWithReport(before).projects)).toEqual(before);expect(migrateProjectsWithReport(before).report.issues).toEqual([]);
 const row={...createEmptySwitchEntry('tstat'),id:'legacy'} as SwitchEntry;expect(isActiveTstatControl(row,[])).toBe(true);
});

