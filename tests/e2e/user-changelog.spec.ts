import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import changelog from '../../app/data/user-changelog.json';
import {
  USER_CHANGELOG_SEEN_KEY as KEY, selectUnreadChangelog, loadUnreadChangelog, saveChangelogSeen,
  type UserChangelogEntry,
} from '../../app/lib/userChangelog';

const entries: UserChangelogEntry[] = changelog.entries;
const latest = entries[0]?.id;
const oldMarker = JSON.stringify({lastSeenId:'test-retired-release'});
const region = (page: Page) => page.getByRole('region', {name:"What's new"});
const rawKey = (page: Page) => page.evaluate(key => localStorage.getItem(key), KEY);
const record = (id: string) => JSON.stringify({lastSeenId:id});

async function seed(page: Page, raw: string | null) {
  await page.goto('/');
  await expect(page.getByRole('heading', {name:'CFS Project Selection'})).toBeVisible();
  await page.evaluate(({key, raw}) => {
    if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key,raw);
    localStorage.setItem('t30-unrelated-sentinel','preserve-me');
  }, {key:KEY,raw});
  await page.reload();
  await expect(page.getByRole('button', {name:'Create Project',exact:true})).toBeEnabled();
}

test.beforeEach(async ({page}) => { await installLocalEditingMocks(page); });

test('changelog logic: first visit, invalid data, opaque IDs, multi-release and cap', () => {
  const history = Array.from({length:8}, (_,i) => ({id:`release-${8-i}`,date:'2026-09-17',title:`Release ${8-i}`,items:['Synthetic test item']}));
  expect(selectUnreadChangelog(history, null)).toEqual({latestId:'release-8',initialize:false,visible:[history[0]],remaining:0});
  for (const raw of ['','{broken','null','[]','{}','true','1','"id"',record(''),record('  '),'{"lastSeenId":3}']) {
    expect(selectUnreadChangelog(history, raw)).toEqual({latestId:'release-8',initialize:true,visible:[],remaining:0});
  }
  expect(selectUnreadChangelog(history, record('release-8')).visible).toEqual([]);
  const two = selectUnreadChangelog(history, record('release-6'));
  expect(two.visible.map(e=>e.id)).toEqual(['release-8','release-7']);
  expect(two.remaining).toBe(0);
  const six = selectUnreadChangelog(history, record('release-2'));
  expect(six.visible.map(e=>e.id)).toEqual(['release-8','release-7','release-6','release-5','release-4']);
  expect(six.remaining).toBe(1);
  expect(selectUnreadChangelog(history, record('unknown')).remaining).toBe(3);
  expect(selectUnreadChangelog([], oldMarker)).toEqual({latestId:null,initialize:false,visible:[],remaining:0});
});

test('changelog logic: storage failures cannot propagate or touch another key', () => {
  const history=[{id:'new',date:'2026-09-17',title:'Test',items:['Test']}];
  const writes: [string,string][]=[];
  const storage={getItem:(key:string)=>{expect(key).toBe(KEY);return null;},setItem:(key:string,value:string)=>{writes.push([key,value]);}};
  expect(loadUnreadChangelog(history,()=>storage).visible).toEqual(history);
  expect(writes).toEqual([]);
  expect(loadUnreadChangelog([],()=>storage).latestId).toBeNull();
  expect(writes).toHaveLength(0);
  loadUnreadChangelog(history,()=>({...storage,getItem:()=>'{broken'}));
  expect(writes).toEqual([[KEY,record('new')]]);
  const fail=()=>{throw new Error('storage denied');};
  expect(loadUnreadChangelog(history,fail).visible).toEqual([]);
  expect(loadUnreadChangelog(history,()=>({getItem:fail,setItem:fail})).visible).toEqual([]);
  expect(loadUnreadChangelog(history,()=>({getItem:()=>oldMarker,setItem:fail})).visible).toEqual(history);
  expect(saveChangelogSeen({setItem:fail},'new')).toBe(false);
});

test('first browser visit shows only the latest until Close; empty history does not create a key', async ({page,context}) => {
  await seed(page,null);
  expect(await rawKey(page)).toBeNull();
  if(!latest){await expect(region(page)).toHaveCount(0);return;}
  await expect(region(page).locator('article')).toHaveCount(1);
  const latestHeading = region(page).locator('h3').first();
  await expect(latestHeading).toContainText(entries[0].date);
  for (const line of entries[0].title.split(' ／ ')) await expect(latestHeading).toContainText(line);
  await expect(region(page).locator('.update-highlights-more')).toHaveCount(0);
  await page.reload();
  await expect(region(page).locator('article')).toHaveCount(1);
  expect(await rawKey(page)).toBeNull();
  const other=await context.newPage();
  await other.goto('/');
  await expect(region(other).locator('article')).toHaveCount(1);
  expect(await rawKey(other)).toBeNull();
  await region(other).getByRole('button',{name:"Close what's new"}).click();
  await expect(region(other)).toHaveCount(0);
  expect(await rawKey(page)).toBe(record(latest));
  await page.reload();
  await expect(page.getByRole('heading', {name:'CFS Project Selection'})).toBeVisible();
  await expect(region(page)).toHaveCount(0);
  expect(await page.evaluate(()=>localStorage.getItem('t30-unrelated-sentinel'))).toBe('preserve-me');
  await other.close();
});

test('an existing latest marker remains read', async ({page}) => {
  test.skip(!latest,'No entries in this fixture');
  await seed(page,record(latest));
  await page.goto('/');
  await expect(page.getByRole('heading', {name:'CFS Project Selection'})).toBeVisible();
  expect(await rawKey(page)).toBe(record(latest));
  await expect(region(page)).toHaveCount(0);
});

for (const raw of ['', '{broken', '{"lastSeenId":null}']) {
  test(`invalid stored state resets silently: ${raw || 'empty'}`, async ({page}) => {
    test.skip(!latest,'No entries in this fixture');
    await seed(page,raw);
    await expect.poll(()=>rawKey(page)).toBe(record(latest));
    await expect(region(page)).toHaveCount(0);
  });
}

test('unread remains across reload and a new tab; close persists without touching other keys', async ({page,context}) => {
  test.skip(!latest,'No entries in this fixture');
  await seed(page,oldMarker);
  await expect(region(page)).toBeVisible();
  expect(await rawKey(page)).toBe(oldMarker);
  await page.reload();
  await expect(region(page)).toBeVisible();
  const next=await context.newPage();
  await next.goto('/');
  await expect(region(next)).toBeVisible();
  await next.close();
  await region(page).getByRole('button',{name:"Close what's new"}).click();
  await expect(region(page)).toHaveCount(0);
  expect(await rawKey(page)).toBe(record(latest));
  await page.reload();
  await expect(page.getByRole('heading',{name:'CFS Project Selection'})).toBeVisible();
  await expect(region(page)).toHaveCount(0);
  expect(await page.evaluate(()=>localStorage.getItem('t30-unrelated-sentinel'))).toBe('preserve-me');
});

test('retained history renders newest five releases with the exact remaining count', async ({page}) => {
  test.skip(!latest,'No entries in this fixture');
  await seed(page,oldMarker);
  await expect(region(page).locator('article')).toHaveCount(Math.min(5,entries.length));
  await expect(region(page).locator('ul').first()).toHaveCSS('list-style-type','disc');
  for(const [index, entry] of entries.slice(0,5).entries()) {
    const article = region(page).locator('article').nth(index);
    await expect(article.locator('h3')).toContainText(entry.date);
    for (const line of entry.title.split(' ／ ')) await expect(article.locator('h3')).toContainText(line);
    for(const item of entry.items) for (const line of item.split(' ／ ')) await expect(article.getByText(line,{exact:true})).toBeVisible();
  }
  if(entries.length>5) {
    const remaining = entries.length-5;
    await expect(region(page)).toContainText(`${remaining} more earlier ${remaining === 1 ? 'update' : 'updates'} not shown.`);
  }
  else await expect(region(page).locator('.update-highlights-more')).toHaveCount(0);
});

test('another tab close shares the marker; an already open banner rechecks on reload', async ({page,context}) => {
  test.skip(!latest,'No entries in this fixture');
  await seed(page,oldMarker);
  const other=await context.newPage();
  await other.goto('/');
  await region(other).getByRole('button',{name:"Close what's new"}).click();
  expect(await rawKey(page)).toBe(record(latest));
  await expect(region(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'CFS Project Selection'})).toBeVisible();
  await expect(region(page)).toHaveCount(0);
  await other.close();
});

test('multiple skipped releases respect the saved boundary and close marks all as read', async ({page}) => {
  test.skip(entries.length<7,'Requires isolated seven-release fixture');
  await seed(page,record(entries[6].id));
  await expect(region(page).locator('article')).toHaveCount(5);
  await expect(region(page)).toContainText('1 more earlier update not shown.');
  await expect(region(page)).not.toContainText(entries[6].title);
  await region(page).getByRole('button',{name:"Close what's new"}).click();
  expect(await rawKey(page)).toBe(record(latest));
  await page.reload();
  await expect(page.getByRole('heading',{name:'CFS Project Selection'})).toBeVisible();
  await expect(region(page)).toHaveCount(0);
});

test('empty history preserves an existing marker and leaves project actions usable', async ({page}) => {
  test.skip(entries.length>0,'Requires isolated empty-history fixture');
  await seed(page,oldMarker);
  await expect(region(page)).toHaveCount(0);
  expect(await rawKey(page)).toBe(oldMarker);
  await expect(page.getByRole('button',{name:'Import Data',exact:true})).toBeEnabled();
});

test('read failure suppresses new content without blocking project list', async ({page}) => {
  await page.addInitScript(key=>{
    const get=Storage.prototype.getItem;
    Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('Blocked','SecurityError');return get.call(this,k);};
  },KEY);
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Create Project',exact:true})).toBeEnabled();
  await expect(region(page)).toHaveCount(0);
});

test('first visit with quota failure shows latest, closes locally, and shows it again on reload', async ({page}) => {
  await page.addInitScript(key=>{
    const set=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v);};
  },KEY);
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Create Project',exact:true})).toBeEnabled();
  if(latest){
    await expect(region(page).locator('article')).toHaveCount(1);
    await region(page).getByRole('button',{name:"Close what's new"}).click();
    await expect(region(page)).toHaveCount(0);
    expect(await rawKey(page)).toBeNull();
    await page.reload();
    await expect(region(page).locator('article')).toHaveCount(1);
  } else await expect(region(page)).toHaveCount(0);
  expect(await rawKey(page)).toBeNull();
});

test('quota failure allows close, project creation/save/reload and shows unread again on return', async ({page}) => {
  test.skip(!latest,'No entries in this fixture');
  const state=await installLocalEditingMocks(page);
  await seed(page,oldMarker);
  await page.addInitScript(key=>{
    const set=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v);};
  },KEY);
  await page.reload();
  await expect(region(page)).toBeVisible();
  await region(page).getByRole('button',{name:"Close what's new"}).click();
  await expect(region(page)).toHaveCount(0);
  expect(await rawKey(page)).toBe(oldMarker);
  await page.getByPlaceholder('New project name',{exact:true}).fill('T30 Synthetic Project');
  await page.getByRole('button',{name:'Create Project',exact:true}).click();
  await expect(page.getByRole('tablist').first()).toBeVisible();
  await expect(region(page)).toHaveCount(0);
  await expect.poll(()=>state.projects.some(p=>p.name==='T30 Synthetic Project')).toBe(true);
  const saved=JSON.stringify(state.projects);
  await page.getByRole('button',{name:'Hide top bar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Show top bar',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Show top bar',exact:true}).click();
  await page.getByRole('button',{name:'Back to Project List',exact:true}).click();
  await expect(region(page)).toBeVisible();
  await page.reload();
  await expect(page.locator('button.screen-card').filter({hasText:'T30 Synthetic Project'})).toBeVisible();
  expect(JSON.stringify(state.projects)).toBe(saved);
});

for(const width of [390,1280,1536]) {
  test(`unread layout and existing list controls at ${width}px`, async ({page},info) => {
    test.skip(!latest,'No entries in this fixture');
    await page.setViewportSize({width,height:900});
    await seed(page,null);
    await expect(region(page)).toBeVisible();
    const input=page.getByPlaceholder('New project name',{exact:true});
    await input.fill('Unsubmitted text');
    await expect(input).toBeFocused();
    await page.screenshot({path:info.outputPath(`unread-${width}.png`),fullPage:true,animations:'disabled'});
    const metrics=await page.evaluate(()=>{
      const selectors=['.project-selection-title','.project-list-top-tools','.update-highlights','.screen-management-card'];
      const boxes=selectors.map(s=>{const r=document.querySelector(s)!.getBoundingClientRect();return {s,x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
      const overlaps=[];
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
        const a=boxes[i],b=boxes[j];
        if(Math.min(a.right,b.right)>Math.max(a.x,b.x)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+1)overlaps.push([a.s,b.s]);
      }
      return {overflow:document.documentElement.scrollWidth-innerWidth,overlaps,boxes};
    });
    await info.attach('layout',{body:JSON.stringify(metrics),contentType:'application/json'});
    expect(metrics.overflow).toBeLessThanOrEqual(0);
    expect(metrics.overlaps).toEqual([]);
    await page.getByTestId('save-recovery-toggle').click();
    await expect(page.locator('#save-recovery-panel')).toBeVisible();
    await expect(input).toHaveValue('Unsubmitted text');
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Import Data',exact:true}).click();
    expect((await chooser).isMultiple()).toBe(false);
    await expect(page.getByTestId('app-version-badge').first()).toBeVisible();
  });
}
