import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    let paidRequests = 0;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/functions/v1/app')) paidRequests++; });
    const checkOverflow = async label => {
      const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 2).slice(0, 8).map(e => [e.tagName, e.className, e.getBoundingClientRect().right]) }));
      assert.ok(result.scroll <= width + 2, `${width} ${label}: ${JSON.stringify(result)}`);
      if (width === 390) {
        const title = page.locator('.topbar-trail > span:last-child');
        assert.ok((await title.boundingBox()).height < 30, `${label}: mobile breadcrumb wrapped`);
        assert.equal(await page.locator('.saved-label').isVisible(), false);
      }
    };
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('heading', { name: '我的作品' }).waitFor();
    assert.equal(await page.locator('.project-card').count(), 0);
    await checkOverflow('library');
    await page.screenshot({ path: `dev/library-${width}.png` });
    await page.getByLabel('一句话故事主题').fill('测试故事：少年在雨夜拾起一把断剑');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '模板演练', exact: true }).click();
    await page.getByRole('button', { name: '建立模板草稿（非AI）' }).click();
    await page.locator('.shot-card').nth(9).waitFor();
    assert.equal(await page.locator('.shot-card').count(), 10);
    await checkOverflow('script');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `dev/script-${width}.png` });
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
    await checkOverflow('settings');
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.getByRole('tab', { name: /场景/ }).click();
    await page.getByRole('button', { name: '新建场景', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('雨夜山门');
    await page.getByLabel('描述', { exact: true }).fill('黑色石阶与金色门环，细雨与低雾');
    await page.getByRole('button', { name: '保存资产', exact: true }).click();
    await page.getByRole('heading', { name: '雨夜山门', exact: true }).waitFor();
    await checkOverflow('assets');
    await page.getByRole('tab', { name: /音色/ }).click();
    await page.getByRole('button', { name: '新建音色', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('测试音色');
    await page.getByLabel('音色ID', { exact: false }).fill('test-only-not-a-real-voice');
    await page.getByRole('button', { name: '保存资产', exact: true }).click();
    await page.getByRole('button', { name: '下一步：分镜编排' }).click();
    await page.getByRole('button', { name: '预览并确认对应关系' }).click();
    await page.getByRole('button', { name: '确认对应并保存补全' }).click();
    await checkOverflow('storyboard');
    await page.getByRole('button', { name: '下一步：视频生成' }).click();
    await page.locator('.generation-card').nth(9).waitFor();
    await page.getByRole('button', { name: '查看第10镜视频详情', exact: true }).click();
    await checkOverflow('video dialog');
    await page.getByRole('button', { name: 'API 生成', exact: true }).click();
    await page.getByText('请先在设置页填写对应的 API Key。', { exact: true }).waitFor();
    await checkOverflow('generation');
    await page.screenshot({ path: `dev/generation-${width}.png` });
    await page.reload();
    await page.locator('.generation-card').nth(9).waitFor();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    assert.equal(saved.projects.length, 1);
    assert.equal(saved.projects[0].shots.length, 10);
    assert.equal(saved.projects[0].shots.reduce((n, s) => n + s.duration, 0), 90);
    assert.equal(saved.keys, undefined);
    await page.goto('http://127.0.0.1:5173/#/library');
    await page.locator('.project-card').waitFor();
    const name = saved.projects[0].name;
    await page.getByRole('button', { name: `复制 ${name}`, exact: true }).click();
    await page.locator('.project-card').nth(1).waitFor();
    const dup = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects);
    assert.notEqual(dup[0].shots[0].id, dup[1].shots[0].id);
    const copy = dup.find(p => p.id !== saved.projects[0].id);
    await page.getByRole('button', { name: `重命名 ${copy.name}`, exact: true }).click();
    await page.getByLabel('作品名称').fill('独立副本');
    await page.getByRole('button', { name: '保存名称' }).click();
    await page.getByRole('button', { name: '删除 独立副本', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    assert.equal(await page.locator('.project-card').count(), 1);
    if (width === 390) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.getByRole('button', { name: '模型与设置', exact: true }).click();
      await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
    }
    assert.deepEqual(errors, []);
    assert.equal(paidRequests, 0);
    results.push({ width, passed: true, errors, paidRequests });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
