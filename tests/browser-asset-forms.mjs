// 资产表的「形态」与「参考图」两列。
// 形态：名字写成「角色 · 形态」即归到同一角色下，可展开收起、可新增形态。
// 参考图：把有图的缩略图拖到另一行的参考图格即挂载，可清除。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CHAIN = ['山阶下', '山门前', '断剑旁', '拾剑后', '递剑后'];
const shot = (n, extra = {}) => ({
  number: n, scene: '山门', visual: '第' + n + '镜画面', duration: 10,
  shotSize: '中景', movement: '固定', angle: '平视',
  start: CHAIN[n - 1], action: '动作', end: CHAIN[n], ...extra,
});
const JSON_BODY = {
  title: '形态与参考图',
  assets: [
    { assetId: 'c1', kind: 'character', name: '阿青', description: '十六岁少年，黑短发' },
    { assetId: 'c2', kind: 'character', name: '阿青 · 战损', description: '阿青战损形态，衣袍破损' },
    { assetId: 'c3', kind: 'character', name: '老剑师', description: '白发老者' },
  ],
  shots: [shot(1, { assets: [{ assetId: 'c1', role: 'subject' }] }), shot(2), shot(3), shot(4)],
};

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = [];

try {
  await page.goto('http://127.0.0.1:5173/#/library');
  await page.evaluate(() => localStorage.clear());
  await page.goto('http://127.0.0.1:5173/#/library');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '新建系列' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.studio-dialog input').first().fill('形态参考图');
  await page.getByRole('button', { name: '创建并打开' }).click();
  await page.waitForTimeout(1200);
  const ids = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0]; return s.id + '/' + s.episodes[0].id; });
  await page.goto('http://127.0.0.1:5173/#/library/' + ids);
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: /导入分镜/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel('分镜 JSON 正文').fill(JSON.stringify(JSON_BODY));
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '角色设置' }).click();
  await page.waitForTimeout(900);

  // —— 形态分组：默认展开 ——
  const readRows = () => page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table tbody .asset-row')].map(tr => ({
    form: tr.querySelector('.asset-form .tag')?.textContent,
    name: tr.querySelector('.asset-name')?.textContent,
    isForm: tr.classList.contains('is-form'),
    hasToggle: Boolean(tr.querySelector('.form-toggle')),
    actions: tr.querySelectorAll('.asset-row-actions button').length,
  })));
  let rows = await readRows();
  assert.equal(rows.length, 3, '有形态的基础资产默认展开，应有 3 行');
  assert.equal(rows[0].form, '基础形态');
  assert.equal(rows[0].name, '阿青', '基础行显示基础名');
  assert.equal(rows[0].hasToggle, true, '有形态的基础行要有展开按钮');
  assert.equal(rows[1].form, '战损', '形态行标注形态名');
  assert.equal(rows[1].name, '阿青', '形态行的名称列只显示基础名');
  assert.equal(rows[1].isForm, true, '形态行要有 is-form 标记');
  assert.equal(rows[1].hasToggle, false, '形态行不该有展开按钮');
  assert.equal(rows[2].name, '老剑师');
  assert.equal(rows[2].form, '基础形态');
  results.push({ step: 'forms', rows: rows.length });

  // 折叠 / 展开
  await page.locator('.form-toggle').first().click();
  await page.waitForTimeout(400);
  assert.equal((await readRows()).length, 2, '折叠后形态行应隐藏');
  await page.locator('.form-toggle').first().click();
  await page.waitForTimeout(400);
  assert.equal((await readRows()).length, 3, '再展开应回来');

  // 新增形态：每个基础行都能加，包括还没有形态的
  assert.equal(await page.getByRole('button', { name: '为老剑师新增形态' }).count(), 1, '没有形态的基础行也要能新增形态');
  await page.getByRole('button', { name: '为老剑师新增形态' }).click();
  await page.waitForTimeout(800);
  const afterAdd = await readRows();
  assert.equal(afterAdd.length, 4, '新增形态后应多一行');
  const added = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0];
    return s.episodes[0].assets.find(a => a.name.includes('新形态'));
  });
  assert.ok(added, '新形态应写进这一集');
  assert.equal(added.name, '老剑师 · 新形态');
  assert.equal(added.kind, 'character');
  assert.ok(added.description.includes('老剑师'.slice(0, 2)) || added.description.length > 0, '新形态应带描述种子');
  results.push({ step: 'add-form', name: added.name });

  // —— 参考图：先把阿青的设定图传上去 ——
  await page.locator('.assets-dialog-table .asset-name').first().click();
  await page.waitForTimeout(600);
  await page.setInputFiles('.lightbox-info input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(1600);
  const hasImage = await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('manju-studio-v1')).series[0].episodes[0].assets[0].imageId));
  assert.equal(hasImage, true, '阿青应有设定图');
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.waitForTimeout(600);

  // 只有带图的缩略图可拖
  const dragState = await page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table tbody .asset-table-thumb')].map(el => el.getAttribute('draggable')));
  assert.equal(dragState[0], 'true', '有图的缩略图应可拖');
  assert.equal(dragState[1], 'false', '没图的缩略图不该可拖');

  // 拖到「老剑师」那一行的参考图格
  const targetIndex = (await readRows()).findIndex(row => row.name === '老剑师');
  await page.dragAndDrop(`.assets-dialog-table tbody .asset-table-thumb >> nth=0`, `.assets-dialog-table tbody .asset-reference-drop >> nth=${targetIndex}`);
  await page.waitForTimeout(1200);
  const mounted = await page.evaluate((index) => {
    const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0];
    const cells = [...document.querySelectorAll('.assets-dialog-table tbody .asset-reference-drop')];
    const cell = cells[index];
    return {
      ref: s.episodes[0].assets.find(a => a.name === '老剑师')?.referenceAssetId ?? 'unset',
      sourceName: s.episodes[0].assets[0].name,
      hasImage: Boolean(cell.querySelector('img')),
      hasClear: Boolean(cell.querySelector('.asset-reference-clear')),
      label: cell.getAttribute('aria-label'),
    };
  }, targetIndex);
  assert.notEqual(mounted.ref, 'unset', '拖过之后应写入 referenceAssetId');
  assert.equal(mounted.hasImage, true, '参考图格应显示来源资产的图');
  assert.equal(mounted.hasClear, true, '挂载后应出现清除按钮');
  assert.match(mounted.label, /来自「阿青」/, `aria-label 应说明来源：${mounted.label}`);
  results.push({ step: 'reference', ...mounted });

  // 形态自动沿用基础形态的设定图：阿青传了图后，「阿青 · 战损」的参考图格应该自己就有。
  const inherited = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.assets-dialog-table tbody .asset-row')];
    const formRow = rows.find(row => row.querySelector('.asset-form .tag')?.textContent === '战损');
    const cell = formRow?.querySelector('.asset-reference-drop');
    return { hasImage: Boolean(cell?.querySelector('img')), label: cell?.getAttribute('aria-label') };
  });
  assert.equal(inherited.hasImage, true, '形态应自动沿用基础形态的设定图');
  assert.match(inherited.label, /来自「阿青」/, `形态的参考图来源应写成基础形态：${ inherited.label }`);

  // 清除：只清「老剑师」那一格（「阿青 · 战损」那格是继承来的，不该被顺手清掉）
  const clearTargets = await page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table tbody .asset-reference-clear')].map(el => el.getAttribute('aria-label')));
  assert.ok(clearTargets.some(label => /清除老剑师/.test(label)), `应有针对老剑师的清除按钮：${JSON.stringify(clearTargets)}`);
  await page.getByRole('button', { name: '清除老剑师的参考图' }).click();
  await page.waitForTimeout(900);
  const cleared = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0];
    return {
      refs: s.episodes[0].assets.map(a => ({ name: a.name, ref: a.referenceAssetId ?? 'unset' })),
      lightbox: Boolean(document.querySelector('.lightbox')),
      remainingClears: [...document.querySelectorAll('.assets-dialog-table tbody .asset-reference-clear')].map(el => el.getAttribute('aria-label')),
    };
  });
  assert.equal(cleared.lightbox, false, '点清除不该跳到详情');
  const oldMan = cleared.refs.find(item => item.name === '老剑师');
  assert.equal(oldMan.ref, '', `清除后应写成空串，表示明确不挂参考图；实际 ${JSON.stringify(cleared.refs)}`);
  assert.ok(!cleared.remainingClears.some(label => /清除老剑师/.test(label)), '清除后那一格不该再有清除按钮');
  assert.ok(cleared.remainingClears.some(label => /清除阿青 · 战损/.test(label)), '继承来的参考图不该被顺手清掉');
  results.push({ step: 'clear', ...cleared });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }