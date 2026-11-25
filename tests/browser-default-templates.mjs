// 出厂默认模板必须在老存档里也能看到：
// 早期版本在模板编辑器点过「保存」会留下一个空的 promptTemplates，存档里有它就看不到出厂模板。
// 这条回归盯两件事：老存档自动补齐出厂块；用户主动清空某一步后能一键补回。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

const savedState = promptTemplates => ({
  version: 1, projects: [], activeId: null,
  settings: {
    scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
    speechModel: 'speech-2.8-hd', styles: [],
    ...(promptTemplates ? { promptTemplates } : {}),
  },
});

const results = [];
try {
  for (const width of [1440, 390]) {
    // 1. 老存档：留下一个空的 promptTemplates。
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(payload => { localStorage.setItem('manju-studio-v1', payload); }, JSON.stringify(savedState({ templates: {} })));
      await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script');
      const editor = page.locator('.template-editor');
      await editor.waitFor();
      await page.getByRole('tab', { name: '全局模板（默认）' }).click();
      await page.waitForTimeout(300);
      const titles = await editor.locator('input[aria-label^="块标题"]').evaluateAll(nodes => nodes.map(n => n.value));
      assert.deepEqual(titles, ['镜数与时长（硬性）', '人物 · 提取规则', '场景 · 提取规则', '道具 · 提取规则'], `老存档要自动补上出厂的四条块，实际：${titles.join('、')}`);
      const preview = await page.locator('textarea[aria-label*="模板预览"]').first().inputValue();
      assert.ok(preview.includes('代称'), '出厂的提取规则要真的进预览');
      assert.ok(preview.includes('鞋子款式'), '出厂的提取规则要真的进预览');
      assert.ok(preview.includes('（时长12s）'), '出厂的镜数与时长条款要真的进预览');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '老存档自动补齐', 块数: titles.length });
      await context.close();
    }

    // 2. 用户主动清空剧本模板后，一键补回出厂默认块。
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(payload => { localStorage.setItem('manju-studio-v1', payload); }, JSON.stringify(savedState({ templates: { script: { blocks: [] } } })));
      await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script');
      const editor = page.locator('.template-editor');
      await editor.waitFor();
      await page.getByRole('tab', { name: '全局模板（默认）' }).click();
      await page.waitForTimeout(300);
      assert.equal(await editor.locator('input[aria-label^="块标题"]').count(), 0, '主动清空的步骤保持为空');
      await editor.getByRole('button', { name: '补入出厂默认块' }).click();
      await page.waitForTimeout(300);
      const filled = await editor.locator('input[aria-label^="块标题"]').evaluateAll(nodes => nodes.map(n => n.value));
      assert.deepEqual(filled, ['镜数与时长（硬性）', '人物 · 提取规则', '场景 · 提取规则', '道具 · 提取规则'], `一键补回出厂默认块，实际：${filled.join('、')}`);

      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
      const texts = stored.settings.promptTemplates.templates.script.blocks.map(block => block.text);
      assert.equal(texts.length, 4, '补回的出厂块要存进全局模板');
      assert.ok(texts.some(text => text.includes('代称')), '存下来的正文要是出厂文案');
      assert.ok(texts.some(text => text.includes('（时长12s）')), '镜数与时长条款也要存下来');

      // 再点一次不会重复追加。
      await editor.getByRole('button', { name: '补入出厂默认块' }).click();
      await page.waitForTimeout(300);
      const again = await editor.locator('input[aria-label^="块标题"]').count();
      assert.equal(again, 4, '重复补入不产生重复块');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '一键补回出厂默认块', 块数: again });
      await context.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
