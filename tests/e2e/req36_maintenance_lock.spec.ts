import {test,expect} from '@playwright/test';
import {promises as fs} from 'node:fs';import path from 'node:path';
import {probeMaintenanceLock} from '../../app/lib/appUpdateLaunch';

test('maintenance hint reads the lock without requesting write access',async({},info)=>{
 const root=info.outputPath('read-only-access');await fs.mkdir(path.join(root,'.cfs-updater'),{recursive:true});await fs.writeFile(path.join(root,'.cfs-updater/maintenance.lock'),'owned anonymous fixture');
 const original=fs.open;const modes:unknown[]=[];
 try{fs.open=(async(file,flags,...args)=>{modes.push(flags);return original(file,flags,...args);}) as typeof fs.open;
  expect(await probeMaintenanceLock(root)).toBe('free');expect(modes).toEqual(['r']);
 }finally{fs.open=original;}
});

for(const [code,expected] of [['EBUSY','held'],['EPERM','held'],['ENOENT','free']] as const){
 test(`maintenance hint preserves ${code} as ${expected}`,async({},info)=>{
  const root=info.outputPath(code);await fs.mkdir(path.join(root,'.cfs-updater'),{recursive:true});await fs.writeFile(path.join(root,'.cfs-updater/maintenance.lock'),'owned anonymous fixture');
  const original=fs.open;try{fs.open=(async()=>{throw Object.assign(new Error('Synthetic lock condition'),{code});}) as typeof fs.open;
   expect(await probeMaintenanceLock(root)).toBe(expected);
  }finally{fs.open=original;}
 });
}
