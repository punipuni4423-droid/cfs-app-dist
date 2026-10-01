import { expect, type Page, type Locator } from './safe-test';
import type { ProjectData } from '../../../app/types';

export async function expectOperationBlocksUi(page: Page): Promise<void> {
  const overlay = page.getByTestId('database-operation-overlay');
  await expect(overlay).toBeVisible();
  expect(await overlay.evaluate(element => element.matches(':modal'))).toBe(true);
  for (const key of ['Tab', 'Shift+Tab', 'Escape', 'Enter', 'Control+y', 'Control+z']) await page.keyboard.press(key);
  expect(await overlay.evaluate(element => element.contains(document.activeElement))).toBe(true);
}

/** A previously queued React input callback, NOT user input through the modal. */
export async function queuedInput(field: Locator, value: string): Promise<void> {
  await field.evaluate((element, value) => {
    const key = Object.keys(element).find(key => key.startsWith('__reactProps$'));
    const props = key && (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key];
    if (!props || typeof props.onChange !== 'function') throw new Error('Queued input fixture cannot find the React callback');
    props.onChange({ target: { value }, currentTarget: { value } });
  }, value);
}

/** Test-only queued update at Home's paired project state/ref boundary.
 * Bypasses UI navigation to exercise rebase after import while the modal blocks users.
 */
export async function queuedProjectPatch(page: Page, projectId: string, patch: Partial<ProjectData>): Promise<void> {
  await page.locator('.screen-card').first().evaluate((element, { projectId, patch }) => {
    type Hook = { memoizedState: unknown; next?: Hook; queue?: { dispatch: (value: unknown) => void } };
    type Fiber = { memoizedState?: Hook; return?: Fiber };
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
    while (fiber) {
      const hook = fiber.memoizedState;
      const projects = hook?.memoizedState;
      const ref = hook?.next?.memoizedState as { current?: ProjectData[] } | undefined;
      if (Array.isArray(projects) && ref?.current === projects && hook?.queue && projects.some(project => project.id === projectId)) {
        const next = projects.map(project => project.id === projectId ? { ...project, ...patch } : project);
        ref.current = next;
        hook.queue.dispatch(next);
        return;
      }
      fiber = fiber.return;
    }
    throw new Error('Queued project fixture cannot find the paired Home state/ref');
  }, { projectId, patch });
}
