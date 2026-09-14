import { expect, type Page } from './safe-test';

export async function openSaveRecovery(page: Page): Promise<void> {
  if (!await page.getByTestId('save-recovery-panel').isVisible()) {
    await page.getByTestId('save-recovery-toggle').click();
  }
  await expect(page.getByTestId('save-recovery-panel')).toBeVisible();
}
