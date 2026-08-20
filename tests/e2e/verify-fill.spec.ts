import { test, expect } from '@playwright/test';

test('debug 404 errors and React behavior', async ({ page }) => {
  const errors404: string[] = [];
  page.on('response', resp => {
    if (resp.status() === 404) errors404.push(resp.url());
  });
  
  const consoleLogs: string[] = [];
  page.on('console', m => consoleLogs.push(`[${m.type()}] ${m.text()}`));
  
  await page.goto('http://localhost:3001/');
  await page.waitForLoadState('networkidle');
  
  // Check if React is running
  const hasReact = await page.evaluate(() => {
    return typeof (window as any).__NEXT_DATA__ !== 'undefined';
  });
  console.log('Next.js running:', hasReact);
  
  // Check input type
  const inputType = await page.evaluate(() => {
    const el = document.querySelector('input[placeholder="新規プロジェクト名"]') as HTMLInputElement;
    return el ? { type: el.type, value: el.value, disabled: el.disabled } : null;
  });
  console.log('Input element:', JSON.stringify(inputType));
  
  // Click and type
  await page.click('input[placeholder="新規プロジェクト名"]');
  await page.keyboard.type('Test123');
  
  // Check value in React
  const reactState = await page.evaluate(() => {
    const el = document.querySelector('input[placeholder="新規プロジェクト名"]') as HTMLInputElement;
    return { value: el?.value, nativeInputValue: (el as unknown as { _valueTracker?: { getValue: () => string } } | null)?._valueTracker?.getValue() };
  });
  console.log('After type react state:', JSON.stringify(reactState));
  
  // Click button
  await page.click('button.btn-primary');
  await page.waitForTimeout(500);
  
  // Check DOM
  const cardsHtml = await page.evaluate(() => {
    return document.querySelector('.screen-list')?.innerHTML || 'no screen-list';
  });
  console.log('Cards HTML:', cardsHtml.substring(0, 200));
  
  for (const url of errors404) console.log('404:', url);
  for (const log of consoleLogs.filter(l => l.includes('[error]') || l.includes('[log]'))) {
    console.log(log);
  }
  
  expect(true).toBe(true);
});
