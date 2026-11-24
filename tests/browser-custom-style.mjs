// 视觉风格自定义验收：剧本页可以新增自定义风格，选中后存进本机设置，
// 刷新仍在，风格会跟着作品数据进入提示词，所有作品都能选用，也能删掉。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

const CUSTOM = '赛博霓虹，冷青加洋红，高对比';
const DEFAULT_STYLE = '东方玄幻水墨风，冷灰 + 金色灵光';

const screenplay = `# 第一部分｜核心前提

【核心前提】
少年在雨夜山门拾起一把断剑。

【黄金3秒钩子】
类型：反常细节
△ 门缝里的光一寸一寸暗下去。

# 第二部分｜场景因果节拍表

| 场次 | 场景目标 | 遭遇阻碍 |
|---|---|---|
| 1 | 拾剑 | 山门无人 |

# 第三部分｜世界观与人物关系确认

【世界边界】
- 时代：架空。

# 第四部分｜标准漫剧剧本

## 第一章  断剑归门

### 场景1 外景 · 山门 — 清晨

**剧情：**少年在雨夜山门拾起一把断剑。
**人物：**阿青

【镜头：远景】
△ 少年在雨夜山门拾起一把断剑。（时长3s）

【镜头：中景】
阿青（平静）：“我来拿回我的剑。”（时长2s）
`;

const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = []; const calls = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/functions/v1/app?*', async route => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const body = route.request().postDataJSON(); calls.push({ action, body });
      if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay } } });
      else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
      else throw new Error(`Unexpected network action: ${action}`);
    });
    // 存档模块要用页面实际加载的那份，否则拿到的是另一个模块实例。
    const store = () => page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      return import(entry);
    });
    const styleSelect = () => page.locator('label.field').filter({ hasText: '视觉风格' }).locator('select');

    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await expect(styleSelect()).toBeVisible();

    // 1. 下拉里有内置风格，也有一个「新增自定义风格…」入口。
    const options = await styleSelect().locator('option').allTextContents();
    assert.ok(options.includes(DEFAULT_STYLE), '内置视觉风格必须还在');
    assert.ok(options.includes('+ 新增自定义风格…'), '下拉里要有新增入口');
    assert.equal(options.length, 4, `下拉应只有 3 个内置 + 新增入口，实际 ${options.length}`);

    // 2. 选新增入口 → 弹出新增弹窗。
    await styleSelect().selectOption('__add_style__');
    const dialog = page.getByRole('dialog').filter({ hasText: '新增自定义视觉风格' });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // 3. 写名字保存 → 自动选中并存进本机设置。
    await dialog.locator('input').fill(CUSTOM);
    await dialog.getByRole('button', { name: '保存并使用' }).click();
    await expect(dialog).toBeHidden();
    assert.equal(await styleSelect().inputValue(), CUSTOM, '新增后必须立刻选中这个风格');
    assert.ok((await styleSelect().locator('option').allTextContents()).includes(CUSTOM), '新增后要出现在下拉里');

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    assert.deepEqual(saved.settings.styles, [CUSTOM], '自定义风格存到全局设置里');
    assert.equal(saved.projects[0].style, CUSTOM, '作品要记住自己选中的风格');

    // 4. 刷新后仍在：设置和作品都持久化。
    await page.reload();
    await expect(styleSelect()).toBeVisible();
    assert.ok((await styleSelect().locator('option').allTextContents()).includes(CUSTOM), '刷新后自定义风格必须还在');
    assert.equal(await styleSelect().inputValue(), CUSTOM, '刷新后作品仍然选中这个风格');

    // 5. 风格跟着作品数据进入剧本提示词，并按原样发出去。
    await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      module.setKey('gemini', 'fixture-not-transmitted');
    });
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const scriptBox = page.getByLabel('即将发送的完整提示词');
    await expect(scriptBox).toBeEditable();
    const prompt = await scriptBox.inputValue();
    assert.ok(prompt.includes('统一风格：' + CUSTOM), `自定义风格必须进入剧本提示词，实际提示词：\n${prompt}`);
    await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const screenplayCall = calls.find(call => call.action === 'screenplay');
    assert.ok(screenplayCall, '必须真实发出剧本请求');
    assert.ok(screenplayCall.body.prompt.includes('统一风格：' + CUSTOM), '发出去的提示词必须带上自定义风格');

    // 6. 自定义风格是全局的：换一部作品也能选，但不会替新作品改掉默认风格。
    const secondId = await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      const first = module.getStudio().projects.find(p => p.style === '赛博霓虹，冷青加洋红，高对比');
      const second = module.createProject('第二个作品', '另一个故事');
      return { first: first?.id, second: second.id };
    });
    assert.ok(secondId.first, '第一部作品必须还在');
    await expect(styleSelect()).toBeVisible();
    assert.ok((await styleSelect().locator('option').allTextContents()).includes(CUSTOM), '新作品也要能选到这个自定义风格');
    assert.equal(await styleSelect().inputValue(), DEFAULT_STYLE, '新作品不继承上一部的风格');

    // 7. 回到第一部作品删掉它：设置里清空，作品回落到默认风格。
    await page.evaluate(async id => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      module.selectProject(id);
    }, secondId.first);
    await expect(styleSelect()).toBeVisible();
    assert.equal(await styleSelect().inputValue(), CUSTOM, '切回第一部作品仍然选中自定义风格');
    await page.getByRole('button', { name: '删除当前自定义风格' }).click();
    await expect(page.getByRole('button', { name: '删除当前自定义风格' })).toBeHidden();
    const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    assert.deepEqual(afterDelete.settings.styles, [], '删除后设置里不再有自定义风格');
    assert.equal(afterDelete.projects.find(p => p.style === CUSTOM), undefined, '删除后作品不再引用这个风格');

    assert.deepEqual(errors, []);
    results.push({ width, passed: true, calls: calls.map(call => call.action) });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
