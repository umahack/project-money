import {
  captureDocumentIdentity,
  expectDocumentReplaced,
  installReloadSpy,
} from './helpers/browser';
import { expect, installAuthenticatedSession, test } from './fixtures/test';

function currentMonthInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to derive the isolated fixture month.');
  return `${year}-${month}`;
}

const planResponse = {
  income: 75_000,
  emiTotal: 25_000,
  afterFixed: 50_000,
  breakdown: { needs: 25_000, wants: 15_000, save: 10_000 },
  month: currentMonthInIndia(),
  spentThisMonth: 4_000,
  byCategory: { Food: 4_000 },
  tips: ['Synthetic fixture guidance'],
};

const billResponse = {
  emis: [
    { id: 701, label: 'Fixture rent', amount: 25_000, category: 'Rent' },
  ],
};

test('legacy Plan salary save reloads the document, hides Plan content, and broadly refetches', async ({
  page,
  api,
}) => {
  api.stub('GET', '/api/invites', { json: { invites: [] } });
  api.stub('GET', '/api/finance/plan', { json: planResponse });
  api.stub('GET', '/api/finance/salary', {
    json: { salary: { month: planResponse.month, amount: planResponse.income } },
  });
  api.stub('GET', '/api/finance/emis', { json: billResponse });
  api.stub('POST', '/api/finance/salary', {
    json: { ok: true, month: planResponse.month, amount: planResponse.income },
  });

  await installAuthenticatedSession(page);
  await page.goto('/plan');
  await expect(page.getByRole('heading', { name: 'Your month, line by line 🧾' })).toBeVisible();
  await expect(page.getByLabel('Monthly pay')).toHaveValue('75000');
  await expect.poll(() => api.count('GET', '/api/finance/salary')).toBeGreaterThan(0);

  const initialReads = {
    plan: api.count('GET', '/api/finance/plan'),
    salary: api.count('GET', '/api/finance/salary'),
    bills: api.count('GET', '/api/finance/emis'),
  };
  const documentIdentity = await captureDocumentIdentity(page);
  const reloadSpy = await installReloadSpy(page);

  // Keep the post-reload plan reads pending long enough to observe the
  // legacy page-level loading branch before the broad reads resolve.
  api.stub('GET', '/api/finance/plan', { json: planResponse, delayMs: 1_000 });

  await page.getByLabel('Monthly pay').fill('76000');
  const reloaded = page.waitForEvent('domcontentloaded');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await reloaded;

  expect(await reloadSpy.count()).toBe(1);
  await expect(page.getByText('Loading…', { exact: true })).toBeVisible({ timeout: 500 });
  await expect(page.getByLabel('Monthly pay')).toHaveCount(0);
  await expectDocumentReplaced(page, documentIdentity);

  await expect(page.getByRole('heading', { name: 'Your month, line by line 🧾' })).toBeVisible({
    timeout: 3_000,
  });
  await expect(page.getByLabel('Monthly pay')).toBeVisible();

  const finalReads = {
    plan: api.count('GET', '/api/finance/plan'),
    salary: api.count('GET', '/api/finance/salary'),
    bills: api.count('GET', '/api/finance/emis'),
  };
  expect(api.count('POST', '/api/finance/salary')).toBe(1);
  expect(finalReads.plan - initialReads.plan).toBeGreaterThanOrEqual(1);
  expect(finalReads.salary - initialReads.salary).toBeGreaterThanOrEqual(1);
  // Plan and PlanInputs each reload the complete bill collection.
  expect(finalReads.bills - initialReads.bills).toBeGreaterThanOrEqual(2);
});
