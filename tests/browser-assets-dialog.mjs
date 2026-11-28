// 资产弹窗：列表 → 详情（大图左 / 信息右）→ 翻页 → 回列表 → 分类切换。
// 走真实路径造数据：新建系列 → 导入分镜 JSON → 打开「角色设置」。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// 连续性校验要求：上一镜的 end 必须等于下一镜的 start。
const CHAIN = ['阿青站在石阶下', '阿青望向山口', '断剑落在石阶上', '阿青捡起断剑', '阿青把剑递给老剑师'];
const shot = (number, extra = {}) => ({
  number, scene: '山门', visual: '阿青站在山门前' + number, duration: 10,
  shotSize: '中景', movement: '固定', angle: '平视',
  start: CHAIN[number - 1], action: '抬头看', end: CHAIN[number],
  ...extra,
});

const JSON_BODY = {
  title: '测试集',
  assets: [
    { assetId: 'c1', kind: 'character', name: '阿青', description: '十六岁少年，黑短发，青色布衣' },
    { assetId: 'c2', kind: 'character', name: '老剑师', description: '' },
    { assetId: 's1', kind: 'scene', name: '山门', description: '黑色石阶，薄雾' },
    { assetId: 'p1', kind: 'prop', name: '断剑', description: '红绳剑柄，斜断口' },
  ],
  shots: [
    shot(1, { assets: [{ assetId: 'c1', role: 'subject' }, { assetId: 's1', role: 'background' }] }),
    shot(2, { visual: '断剑特写', assets: [{ assetId: 'p1', role: 'prop' }] }),
    shot(3, { visual: '老剑师登场', assets: [{ assetId: 'c2', role: 'subject' }] }),
    shot(4, { visual: '阿青拾剑', assets: [{ assetId: 'c1', role: 'subject' }] }),
  ],
};

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
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
  await page.locator('.studio-dialog input').first().fill('资产测试系列');
  await page.getByRole('button', { name: '创建并打开' }).click();
  await page.waitForTimeout(1200);
  const ids = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0]; return s.id + '/' + s.episodes[0].id; });
  await page.goto('http://127.0.0.1:5173/#/library/' + ids);
  await page.waitForTimeout(1400);

  await page.getByRole('button', { name: /导入分镜/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel('分镜 JSON 正文').fill(JSON.stringify(JSON_BODY, null, 2));
  await page.waitForTimeout(1200);
  assert.match(await page.evaluate(() => document.querySelector('.studio-dialog')?.innerText ?? ''), /校验通过/, '送进去的分镜应能通过校验');
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.waitForTimeout(1500);

  // —— 列表：表格 ——
  await page.getByRole('button', { name: '角色设置' }).click();
  await page.waitForTimeout(800);
  const list = await page.evaluate(() => {
    const table = document.querySelector('.asset-table.assets-dialog-table');
    return {
      hasTable: Boolean(table),
      headers: [...document.querySelectorAll('.assets-dialog-table thead th')].map(el => el.textContent),
      rows: document.querySelectorAll('.assets-dialog-table .asset-row').length,
      textareas: document.querySelectorAll('.assets-dialog-table textarea').length,
      names: [...document.querySelectorAll('.assets-dialog-table .asset-name')].map(el => el.textContent),
      locked: [...document.querySelectorAll('.assets-dialog-table .asset-row')].map(row => row.querySelector('.asset-name-cell .tag')?.textContent),
      thumbs: document.querySelectorAll('.assets-dialog-table .asset-table-thumb').length,
      refCells: document.querySelectorAll('.assets-dialog-table .asset-reference-drop').length,
    };
  });
  assert.equal(list.hasTable, true, '列表应是表格，不是卡片网格');
  assert.deepEqual(list.headers, ['形态', '名称', '固定描述', '关联镜头', '参考图', '图片', '操作']);
  assert.equal(list.rows, 2, '角色应有 2 行');
  assert.equal(list.textareas, 0, '表格里不该有内联输入框——编辑属于详情');
  assert.equal(list.thumbs, 2, '每行都要有缩略图');
  assert.equal(list.refCells, 2, '每行都要有参考图格');
  assert.deepEqual(list.names, ['阿青', '老剑师']);
  // 锁定时长短语为空的那一行要露出来
  assert.deepEqual(list.locked, ['已锁定', '未锁定'], `锁定状态要一眼可见：${JSON.stringify(list.locked)}`);
  results.push({ step: 'list', ...list });

  // 描述列要吃掉剩余宽度；否则旧表格的固定列宽会把空白摊到别的列上。
  const widths = await page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table thead th')].map(th => Math.round(th.getBoundingClientRect().width)));
  assert.ok(widths[2] > widths[1] * 1.8, `描述列应最宽：${JSON.stringify(widths)}`);
  assert.ok(widths[5] <= 110 && widths[6] <= 130, `图片与操作列应收紧：${JSON.stringify(widths)}`);
  const noOverflow = await page.evaluate(() => {
    const wrap = document.querySelector('.assets-dialog-table').closest('.asset-table-wrap');
    return { inner: wrap.scrollWidth - wrap.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(noOverflow.inner, 0, '宽屏下表格不该出现横向滚动');
  assert.equal(noOverflow.page, 0, '宽屏下页面不该横向溢出');

  // 描述超长时能展开
  const descButton = page.locator('.assets-dialog-table .form-desc').first();
  assert.equal(await descButton.getAttribute('aria-expanded'), 'false');
  await descButton.click();
  await page.waitForTimeout(300);
  assert.equal(await descButton.getAttribute('aria-expanded'), 'true', '描述应可展开');
  await descButton.click();
  await page.waitForTimeout(300);
  assert.equal(await descButton.getAttribute('aria-expanded'), 'false', '再点应收起');

  // —— 详情 ——
  await page.locator('.assets-dialog-table .asset-name').first().click();
  await page.waitForTimeout(600);
  const detail = await page.evaluate(() => {
    const media = document.querySelector('.lightbox-media');
    const info = document.querySelector('.lightbox-info');
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; };
    return {
      hasLightbox: Boolean(document.querySelector('.lightbox')),
      media: box(media), info: box(info),
      counter: (document.querySelector('.media-detail .small.muted')?.textContent ?? '').trim(),
      placeholder: Boolean(document.querySelector('.asset-detail-empty')),
      readonlyPrompt: document.querySelectorAll('.lightbox-info textarea[readonly]').length,
      hasUpload: Boolean(document.querySelector('.lightbox-info input[type=file]')),
      hasSaveField: Boolean(document.querySelector('.lightbox-info textarea:not([readonly])')),
      refs: [...document.querySelectorAll('.lightbox-info p')].map(p => p.textContent).find(t => t?.includes('关联镜头')) ?? '',
    };
  });
  assert.equal(detail.hasLightbox, true, '应进入 lightbox 详情');
  assert.ok(detail.media.x < detail.info.x, '大图应在左、信息在右');
  assert.equal(detail.placeholder, true, '没有设定图时应有占位，不留白洞');
  assert.equal(detail.readonlyPrompt, 1, '完整图片提示词应是只读一栏');
  assert.equal(detail.hasUpload, true, '详情里应能上传设定图');
  assert.equal(detail.hasSaveField, true, '详情里应能改固定描述');
  assert.match(detail.counter, /1 \/ 2/, '计数器应为 1 / 2');
  // 关联镜头要给人看的镜号，不是内部 id
  assert.match(detail.refs, /第1镜/, `关联镜头应是镜号：${detail.refs}`);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(detail.refs), `关联镜头不该出现 UUID：${detail.refs}`);
  results.push({ step: 'detail', counter: detail.counter, refs: detail.refs });

  // —— 翻页 ——
  await page.getByRole('button', { name: '下一张' }).click();
  await page.waitForTimeout(500);
  assert.match(await page.evaluate(() => (document.querySelector('.media-detail .small.muted')?.textContent ?? '').trim()), /2 \/ 2/);

  // —— 回列表，换分类 ——
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.assets-dialog-table .asset-row').count(), 2, '应能回到列表');

  // 弹窗尺寸固定：切分类只换内容，窗口不该跟着长高缩矮。
  const boxOf = () => page.evaluate(() => { const r = document.querySelector('.studio-dialog').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  assert.equal(await page.evaluate(() => document.querySelector('.studio-dialog').classList.contains('fixed-dialog')), true, '资产弹窗应是固定尺寸');
  const boxCharacter = await boxOf();

  await page.getByLabel('资产分类').selectOption('scene');
  await page.waitForTimeout(500);
  assert.deepEqual(await boxOf(), boxCharacter, `切到场景后弹窗尺寸不该变：${JSON.stringify(boxCharacter)}`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table .asset-name')].map(el => el.textContent)), ['山门']);

  // 换分类应自动回列表，不能停在上一类的某张图上
  await page.locator('.assets-dialog-table .asset-name').first().click();
  await page.waitForTimeout(400);
  await page.getByLabel('资产分类').selectOption('prop');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.lightbox'))), false, '换分类应回到列表');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.assets-dialog-table .asset-name')].map(el => el.textContent)), ['断剑']);

  assert.deepEqual(errors, []);

  // —— 窄屏：900px 断点下详情要单列堆叠，不许横向溢出 ——
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto('http://127.0.0.1:5173/#/library');
  await mobile.evaluate(() => localStorage.clear());
  await mobile.goto('http://127.0.0.1:5173/#/library');
  await mobile.waitForTimeout(1200);
  await mobile.getByRole('button', { name: '新建系列' }).first().click();
  await mobile.waitForTimeout(500);
  await mobile.locator('.studio-dialog input').first().fill('窄屏资产');
  await mobile.getByRole('button', { name: '创建并打开' }).click();
  await mobile.waitForTimeout(1200);
  const mobileIds = await mobile.evaluate(() => { const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0]; return s.id + '/' + s.episodes[0].id; });
  await mobile.goto('http://127.0.0.1:5173/#/library/' + mobileIds);
  await mobile.waitForTimeout(1400);
  await mobile.getByRole('button', { name: /导入分镜/ }).first().click();
  await mobile.waitForTimeout(600);
  await mobile.getByLabel('分镜 JSON 正文').fill(JSON.stringify(JSON_BODY, null, 2));
  await mobile.waitForTimeout(1200);
  await mobile.getByRole('button', { name: '确认导入' }).click();
  await mobile.waitForTimeout(1500);
  await mobile.getByRole('button', { name: '角色设置' }).click();
  await mobile.waitForTimeout(800);
  // 窄屏列表变卡片：关联镜头留着，参考图藏掉（挂载靠拖，触摸屏用不了）。
  const cardLayout = await mobile.evaluate(() => {
    const row = document.querySelector('.assets-dialog-table tbody .asset-row');
    const visible = index => { const cell = row.children[index]; return cell ? getComputedStyle(cell).display !== 'none' : false; };
    return { shotRefVisible: visible(3), referenceVisible: visible(4), thumbVisible: visible(5), actionsVisible: visible(6) };
  });
  assert.equal(cardLayout.shotRefVisible, true, '窄屏应显示关联镜头');
  assert.equal(cardLayout.referenceVisible, false, '窄屏藏掉参考图格');
  assert.equal(cardLayout.thumbVisible, true, '窄屏应显示缩略图');
  assert.equal(cardLayout.actionsVisible, true, '窄屏应显示操作');
  await mobile.locator('.assets-dialog-table .asset-name').first().click();
  await mobile.waitForTimeout(700);
  const mobileGeo = await mobile.evaluate(() => {
    const media = document.querySelector('.lightbox-media').getBoundingClientRect();
    const info = document.querySelector('.lightbox-info').getBoundingClientRect();
    return { stacked: info.top >= media.bottom - 2, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(mobileGeo.stacked, true, '窄屏详情应单列堆叠');
  assert.ok(mobileGeo.overflow <= 2, `窄屏不该横向溢出：${mobileGeo.overflow}`);
  results.push({ step: 'mobile', ...mobileGeo });
  await phone.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }