import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const E2E_ADMIN_PIN_PATH = path.resolve('.data', 'e2e-admin-pin.txt');

test('одиночные мутации вопросов отклоняют JSON больше 2 МБ', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Проверка API не зависит от ориентации.');

  const pin = readFileSync(E2E_ADMIN_PIN_PATH, 'utf8').trim();
  const login = await page.request.post('/api/admin/session', {
    headers: {
      Origin: 'http://localhost:3101',
      'Sec-Fetch-Site': 'same-origin',
    },
    data: { pin },
  });
  expect(login.status()).toBe(200);
  const session = await login.json() as { csrfToken: string };
  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    Origin: 'http://localhost:3101',
    'Sec-Fetch-Site': 'same-origin',
  };
  const oversizedJson = JSON.stringify({ padding: 'x'.repeat(2_000_000) });

  for (const [method, url] of [
    ['POST', '/api/admin/questions'],
    ['PUT', '/api/admin/questions/1'],
    ['PATCH', '/api/admin/questions/1'],
  ] as const) {
    const response = await page.request.fetch(url, { method, headers, data: oversizedJson });
    expect(response.status(), `${method} ${url}`).toBe(413);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(await response.json()).toEqual({ error: 'mutation_too_large' });
  }
});
