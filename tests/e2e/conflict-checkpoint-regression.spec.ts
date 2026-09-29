import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftRecords } from './support/native-project-drafts';
import { createNewProject } from '../../app/lib/storage';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { hasProjectChanges } from '../../app/lib/projectSaveState';

test('409 Reload retains its original checkpoint and allows later edits and reload',async({page},info)=>{
  const state=await installLocalEditingMocks(page);
  const project=createNewProject('Synthetic guarded 409');
  project.remarks=[{id:'remark',title:'Initial',body:'base',hasTable:false,columns:[],rows:[]}];
  state.projects=[project] as unknown as Record<string,unknown>[];
  await page.goto('/');
  await page.locator('button.screen-card').filter({hasText:project.name}).click();
  await page.getByRole('tab',{name:'Remarks',exact:true}).click();
  const clockTime=await page.evaluate(()=>Date.now());
  await page.clock.install({time:clockTime});await page.clock.pauseAt(clockTime);
  await page.getByLabel('Body for remark 1',{exact:true}).fill('local-before-conflict');
  let posts=0;
  await page.context().route('**/api/projects',async route=>{
    if(route.request().method()!=='POST')return route.fallback();posts++;
    const server={...project,updatedAt:'2031-01-01T00:00:00.000Z',remarks:[{...project.remarks![0],body:'other-editor'}]};
    state.projects=[server] as unknown as Record<string,unknown>[];
    await route.fulfill({status:409,json:{code:'PROJECT_CONFLICT',error:'Project was updated by another user.',project:server}});
  });
  page.on('dialog',dialog=>dialog.type()==='prompt'?dialog.accept('R'):dialog.accept());
  await page.getByRole('button',{name:'Save current project without a new revision'}).click();
  await expect(page.getByLabel('Body for remark 1',{exact:true})).toHaveValue('other-editor');
  const beforeTimer=await readNativeDraftRecords(page);
  await page.clock.runFor(301);
  // Drain queued IndexedDB work without increasing a wall-clock sleep.
  await readNativeDraftRecords(page);
  const afterTimer=await readNativeDraftRecords(page);
  const firstOutput=info.outputPath('conflict-before-after-timer.json');
  fs.writeFileSync(firstOutput,JSON.stringify({beforeTimer,afterTimer,posts},null,2));
  await info.attach('conflict-before-after-timer',{path:firstOutput,contentType:'application/json'});
  expect(JSON.stringify(afterTimer)).toContain('local-before-conflict');
  expect(JSON.stringify(afterTimer)).not.toContain('other-editor');
  const original=afterTimer.find(r=>r.project.id===project.id&&!r.scope.tab.startsWith('recovery:'))!;
  const archive=afterTimer.find(r=>r.project.id===project.id&&r.scope.tab.startsWith('recovery:'))!;
  await page.getByLabel('Body for remark 1',{exact:true}).fill('new local edit after conflict');
  await page.clock.runFor(301);
  await expect.poll(async()=>(await readNativeDraftRecords(page)).find(r=>r.key===original.key)?.project.remarks?.[0]?.body).toBe('new local edit after conflict');
  const edited=(await readNativeDraftRecords(page)).find(r=>r.key===original.key)!;
  expect(edited.generation).toBeGreaterThan(original.generation);
  // A real edit back to the saved baseline must still replace the latest current-tab draft.
  await page.getByLabel('Body for remark 1',{exact:true}).fill('other-editor');
  await page.clock.runFor(301);
  await expect.poll(async()=>(await readNativeDraftRecords(page)).find(r=>r.key===original.key)?.project.remarks?.[0]?.body).toBe('other-editor');
  const final=await readNativeDraftRecords(page);
  expect(final.find(r=>r.key===archive.key)).toEqual(archive);
  expect(final.find(r=>r.key===original.key)!.generation).toBeGreaterThan(edited.generation);
  expect(posts).toBe(1);
  const output=info.outputPath('conflict-later-edit-records.json');fs.writeFileSync(output,JSON.stringify({edited,final,posts},null,2));
  await info.attach('conflict-later-edit-records',{path:output,contentType:'application/json'});
  await page.reload();
  await expect(page.getByLabel('Body for remark 1',{exact:true})).toHaveValue('other-editor');
  expect((await readNativeDraftRecords(page)).find(r=>r.key===archive.key)).toEqual(archive);
});

test('actual checkpoint timer skips only the loaded object and keeps independent project, owner, and later-object processing',async()=>{
  const source=fs.readFileSync(path.resolve('app/page.tsx'),'utf8');
  const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let expression:string|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='saveTimer.current'&&ts.isCallExpression(node.right)
      &&node.right.expression.getText(ast)==='setTimeout')expression=node.right.arguments[0]?.getText(ast);
    ts.forEachChild(node,visit);
  };visit(ast);expect(expression).toBeTruthy();
  const loaded=createNewProject('Loaded conflict snapshot'),other=createNewProject('Independent dirty project');
  other.name='Independent later edit';
  const owner={workspace:'synthetic',owner:'owner-A',tab:'tab-A'};
  const writes:any[]=[];const retained=new WeakSet([loaded]);
  const snapshot=[loaded,other];
  const bindings={snapshot,checkpointEpochs:new Map(),draftCheckpointEpoch:{current:new Map()},
    conflictLoadedSnapshots:{current:retained},persisted:new Map([[loaded.id,loaded],[other.id,{...other,name:'Independent baseline'}]]),
    checkpointedProjectIds:new Set([loaded.id,other.id]),bases:new Map([[loaded.id,loaded.updatedAt],[other.id,other.updatedAt]]),
    owner,saveTimer:{current:1},hasProjectChanges,
    checkpointProject:async(project:unknown,base:unknown,intent:unknown,captured:unknown)=>{writes.push({project,base,intent,captured});}};
  const js=ts.transpileModule(`return (${expression})();`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const fire=()=>new Function(...Object.keys(bindings),js)(...Object.values(bindings));
  await fire();expect(writes.map(w=>w.project.id)).toEqual([other.id]);expect(writes[0].captured).toBe(owner);
  expect(writes[0].intent).toBeUndefined(); // Existing checkpoint inheritance remains responsible for any unresolved intent.
  writes.length=0;snapshot[0]={...loaded};await fire();expect(writes.map(w=>w.project.id)).toEqual([loaded.id,other.id]);
  writes.length=0;bindings.draftCheckpointEpoch.current.set(loaded.id,1);await fire();expect(writes.map(w=>w.project.id)).toEqual([other.id]);
});
