import {
  captureDocumentIdentity,
  emulateReducedMotion,
  expectNoOverflowOrClipping,
  expectReducedMotion,
  expectResponseToPaintWithin,
  expectSameDocument,
  installFocusTracker,
  installReloadSpy,
  measureResponseToPaint,
} from './helpers/browser';
import { expect, test } from './fixtures/test';

test('browser harness provides isolated fixtures and interaction observers', async ({ page, api }) => {
  api.stub('GET', '/api/e2e/ready', { json: { state: 'fixture-ready' } });

  await page.goto('/login');
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);
  const focusTracker = await installFocusTracker(page);

  await emulateReducedMotion(page);
  await expectReducedMotion(page);

  const email = page.getByLabel('Email');
  await email.focus();
  await expect(email).toBeFocused();
  await expect.poll(async () => (await focusTracker.active())?.tagName).toBe('input');

  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/e2e/ready'
  ));
  await page.evaluate(() => {
    void fetch('/api/e2e/ready')
      .then((response) => response.json())
      .then((payload: { state: string }) => {
        const output = document.createElement('output');
        output.dataset.testid = 'fixture-result';
        output.textContent = payload.state;
        document.body.append(output);
      });
  });

  const timing = await measureResponseToPaint(
    page,
    responsePromise,
    page.getByTestId('fixture-result').filter({ hasText: 'fixture-ready' }),
  );
  expect(timing.status).toBe(200);
  await expectResponseToPaintWithin(timing, 1_000);

  await expectSameDocument(page, documentIdentity);
  await reloadSpy.expectNoReloads();
  await expectNoOverflowOrClipping(page, ['html', 'body', '#auth-card', 'form']);
  expect(api.count('GET', '/api/e2e/ready')).toBe(1);
});
