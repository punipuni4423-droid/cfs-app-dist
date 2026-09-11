import { defineConfig } from '@playwright/test';
import { baseURL } from './tests/playwright-safety';
export default defineConfig({ testDir: './tests/safety', workers: 1, retries: 0, timeout: 15000, use: { baseURL, serviceWorkers: 'block' } });
