const popover = page => page.locator('.search-select-popover');

async function ensureOpen(page, label) {
  const list = popover(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await list.isVisible().catch(() => false)) return list;
    await page.getByRole('combobox', { name: label }).click();
    await page.waitForTimeout(250);
  }
  return list;
}

export async function searchSelectOptions(page, label) {
  const list = await ensureOpen(page, label);
  await list.waitFor();
  const more = list.locator('.search-select-more');
  if (await more.count()) await more.click();
  const texts = await list.locator('.search-select-option').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return texts;
}

export async function pickSearchOption(page, label, match) {
  const list = await ensureOpen(page, label);
  await list.waitFor();
  let option = list.locator('.search-select-option').filter({ hasText: match });
  if (!(await option.count())) {
    const more = list.locator('.search-select-more');
    if (await more.count()) await more.click();
    option = list.locator('.search-select-option').filter({ hasText: match });
  }
  await option.first().click();
  await page.locator('.search-select-popover').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
}
