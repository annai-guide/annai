import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider } from './helpers.js';

// Koe and Kokoro, K1: the text split (docs/superpowers/specs/2026-10-19-koe-kokoro-design.md).

test('Models shows Koe for talking and Koe for typing right after Main, each taking chat models', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const roles = page.getByRole('region', { name: 'Roles' });
  await expect(roles.locator('h3')).toHaveText([
    'Main: talks with you', 'Koe for talking: answers you at once when voice is on', 'Koe for typing: answers you at once when you type',
    'Utility: summaries and small jobs', 'Quick decision: yes-or-no checks', 'Speech in: how Shiori hears you', "Speech out: Shiori's voice",
  ]);
  await expect(roles.getByText('Empty: Shiori is one half, the main model. Add a fast model here to give her a quick voice in front.')).toHaveCount(2);
  await expect(page.getByLabel('Wait for the first words (seconds)').nth(1)).toHaveAttribute('placeholder', '8');
  await addProvider(page, 'Another address', { ability: 'Chat Completions', name: 'Fast', url: 'https://fast.example.test/v1', key: 'sk-fast', model: 'fast-model' });
  await page.getByLabel('Add a model to Koe for typing').selectOption({ label: 'fast-model' });
  await page.getByRole('button', { name: 'Add to Koe for typing' }).click();
  await expect(roles.locator('.role').nth(2).getByText('1. fast-model')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(2).getByText('1. fast-model')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(0).getByText('No models yet. Add one.')).toBeVisible();
});
