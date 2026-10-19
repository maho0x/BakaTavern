import { expect, test, type Page } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import { importCards, messages, uniqueName } from './helpers.ts';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Characters' });

/** The library: always shown on desktop, a drawer on phones. */
async function openLibrary(page: Page) {
  if (!(await rail(page).getByRole('button', { name: 'Select several' }).isVisible())) {
    await page.getByRole('button', { name: 'Characters' }).first().click();
  }
  await expect(rail(page).getByRole('button', { name: 'Select several' })).toBeVisible();
}

const entry = (page: Page, name: string) => rail(page).getByRole('button', { name: new RegExp(`^${name} `) });

test('characters are changed together and gathered in tag folders', async ({ page }, testInfo) => {
  const [ada, bo, cy] = ['Ada', 'Bo', 'Cy'].map((n) => uniqueName(`Shelf ${n}`, testInfo)) as [
    string,
    string,
    string,
  ];
  const crew = `Crew ${testInfo.project.name}`;
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await importCards(page, [
    { name: 'ada', card: { v3: v3Card(ada) } },
    { name: 'bo', card: { v3: v3Card(bo) } },
    { name: 'cy', card: { v3: v3Card(cy) } },
  ]);
  await expect(messages(page)).toHaveCount(1);
  await openLibrary(page);

  // Two of them get a tag and a star at once.
  await rail(page).getByRole('button', { name: 'Select several' }).click();
  await entry(page, ada).click();
  await entry(page, bo).click();
  const bulk = rail(page).getByRole('toolbar', { name: 'Selected characters' });
  await expect(bulk).toContainText('2 selected');
  await bulk.getByRole('combobox', { name: 'Tag' }).fill(crew);
  await bulk.getByRole('button', { name: 'Add tag' }).click();
  await bulk.getByRole('button', { name: 'Favorite', exact: true }).click();
  await expect(entry(page, ada).getByRole('img', { name: 'Favorite' })).toBeVisible();
  await rail(page).getByRole('button', { name: 'Select several' }).click();

  // The tag becomes a closed folder: its members leave the main list.
  await rail(page).getByRole('button', { name: 'Tags' }).click();
  const tags = page.getByRole('dialog', { name: 'Tags' });
  await tags.getByRole('combobox', { name: `Folder: ${crew}` }).selectOption('closed');
  await tags.getByRole('button', { name: 'Close' }).click();
  await openLibrary(page);
  const folder = rail(page).getByRole('button', { name: new RegExp(`^${crew}`) });
  await expect(folder).toContainText('2 inside');
  await expect(entry(page, ada)).toHaveCount(0);
  await expect(entry(page, cy)).toBeVisible();
  await folder.click();
  await expect(entry(page, ada)).toBeVisible();
  await expect(entry(page, bo)).toBeVisible();
  await expect(entry(page, cy)).toHaveCount(0);
  await rail(page).getByRole('button', { name: crew, exact: true }).click();

  // One is deleted from the selection.
  await rail(page).getByRole('button', { name: 'Select several' }).click();
  await entry(page, cy).click();
  await rail(page)
    .getByRole('toolbar', { name: 'Selected characters' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(entry(page, cy)).toHaveCount(0);
});
