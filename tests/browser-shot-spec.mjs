// 剧本步的「镜数与时长」三层锁：
// 1) 生成后先校验，不合格自动重试一次（只贴违规清单），再不合格就停下并把清单给用户；
// 2) 导入不合规的剧本要拦住，并逐镜说清差多少秒；
// 3) 旧作品（没有按新规格校验过）不被新规则误伤。
//
// 验收记录用的是模拟模型通道：真实模型连续 5 次生成需要用户的 Key 与付费确认。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { makeScreenplay, makeOffSpecScreenplay } from './screenplay-fixtures.mjs';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

/** 读当前作品的剧本规格：镜数、每镜时长、合计、违规清单。 */
async function readSpec(page) {
  return page.evaluate(async () => {
    const names = performance.getEntriesByType('resource').map(entry => entry.name);
    const store = await import(names.find(name => name.includes('/src/store/studio.ts')));
    const lib = await import(names.find(name => name.includes('/src/lib/screenplay.ts')));
    const project = store.getStudio().projects[0];
    const spec = lib.validateScreenplayShots(project.screenplay || '');
    return {
      screenplay: project.screenplay || '',
      specVersion: project.specVersion,
      durations: spec.shots.map(shot => shot.duration),
      total: spec.total,
      issues: spec.issues,
    };
  });
}

/** 起一部作品并放一个假 Key（请求被拦截，不会真的发出去）。 */
async function startProject(page) {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByLabel('一句话故事主题').fill('断剑归门');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').map(item => item.name).find(name => name.includes('/src/store/studio.ts'));
    const module = await import(entry);
    module.setKey('gemini', 'fixture-not-transmitted');
  });
  await page.goto('http://127.0.0.1:5173/#/script');
  await page.waitForTimeout(300);
}

async function generateOnce(page) {
  await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
  await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(300);
}

const results = [];
try {
  for (const width of [1440, 390]) {
    // ── 验收 1：连续 5 次生成同一主题，每次都要落在规格里 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = []; const calls = [];
      page.on('pageerror', e => errors.push(e.message));
      const replies = [
        makeScreenplay({ shots: 4, seconds: 12 }),
        makeScreenplay({ shots: 5, seconds: 12 }),
        makeScreenplay({ shots: 6, seconds: 14 }),
        makeScreenplay({ shots: 5, seconds: 10 }),
        makeScreenplay({ shots: 4, seconds: 15 }),
      ];
      let index = 0;
      await page.route('**/functions/v1/app?*', async route => {
        const action = new URL(route.request().url()).searchParams.get('action');
        calls.push({ action, body: route.request().postDataJSON() });
        if (action === 'screenplay') {
          const screenplay = replies[Math.min(index, replies.length - 1)];
          index += 1;
          await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay } } });
        } else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
        else throw new Error(`Unexpected action: ${action}`);
      });
      await startProject(page);
      const records = [];
      for (let round = 0; round < 5; round += 1) {
        await generateOnce(page);
        const spec = await readSpec(page);
        records.push({ 第几次: round + 1, 镜数: spec.durations.length, 每镜秒: spec.durations, 合计秒: spec.total, 违规: spec.issues.length });
        assert.deepEqual(spec.issues, [], `第 ${round + 1} 次生成不该有违规：${spec.issues.join('；')}`);
        assert.ok(spec.durations.length >= 4 && spec.durations.length <= 6, `第 ${round + 1} 次镜数要在 4–6，实际 ${spec.durations.length}`);
        for (const duration of spec.durations) assert.ok(duration >= 10 && duration <= 15, `第 ${round + 1} 次单镜时长要在 10–15，实际 ${duration}`);
        assert.ok(spec.total >= 40 && spec.total <= 90, `第 ${round + 1} 次总时长要在 40–90，实际 ${spec.total}`);
        assert.equal(spec.specVersion, 'shot-spec-v1', '合规的剧本要标上新规格');
      }
      const screenplayCalls = calls.filter(call => call.action === 'screenplay');
      assert.equal(screenplayCalls.length, 5, '合规的生成不该触发重试');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '连续 5 次生成（模拟通道）', 记录: records, 重试次数: screenplayCalls.length - 5 });
      await context.close();
    }

    // ── 第 3 层：第一次不合格 → 自动重试一次 → 第二次合格 → 覆盖 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = []; const calls = [];
      page.on('pageerror', e => errors.push(e.message));
      let index = 0;
      await page.route('**/functions/v1/app?*', async route => {
        const action = new URL(route.request().url()).searchParams.get('action');
        const body = route.request().postDataJSON(); calls.push({ action, body });
        if (action === 'screenplay') {
          const screenplay = index === 0 ? makeOffSpecScreenplay({ shots: 3, seconds: 7 }) : makeScreenplay({ shots: 5, seconds: 12 });
          index += 1;
          await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay } } });
        } else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
        else throw new Error(`Unexpected action: ${action}`);
      });
      await startProject(page);
      await generateOnce(page);
      const screenplayCalls = calls.filter(call => call.action === 'screenplay');
      assert.equal(screenplayCalls.length, 2, '不合格要自动重试一次');
      const retryPrompt = screenplayCalls[1].body.prompt;
      assert.ok(retryPrompt.includes('第1镜只有 7 秒'), `重试提示词要贴违规清单：${retryPrompt.slice(0, 200)}`);
      assert.ok(retryPrompt.includes('共 3 镜'), '重试提示词要贴镜数违规');
      assert.ok(!retryPrompt.includes('统一风格：'), '重试提示词不重发整套模板');
      const spec = await readSpec(page);
      assert.deepEqual(spec.issues, [], '重试后的剧本要合规');
      assert.equal(spec.durations.length, 5);
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '不合格自动重试一次', 重试次数: 1, 重试后镜数: spec.durations.length, 每镜秒: spec.durations, 合计秒: spec.total });
      await context.close();
    }

    // ── 第 3 层：重试仍不合格 → 不覆盖现有剧本，把清单给用户 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = []; const calls = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/functions/v1/app?*', async route => {
        const action = new URL(route.request().url()).searchParams.get('action');
        calls.push({ action, body: route.request().postDataJSON() });
        if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay: makeOffSpecScreenplay({ shots: 3, seconds: 7 }) } } });
        else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
        else throw new Error(`Unexpected action: ${action}`);
      });
      await startProject(page);
      // 先存一份合规剧本，重试失败时它不能被覆盖。
      // 不刷新页面：Key 只在内存里，刷新就没了。
      const before = makeScreenplay({ shots: 4, seconds: 12 });
      await page.evaluate(async text => {
        const entry = performance.getEntriesByType('resource').map(item => item.name).find(name => name.includes('/src/store/studio.ts'));
        const module = await import(entry);
        module.updateProject(module.getStudio().projects[0].id, project => ({ ...project, screenplay: text }), true);
      }, before);
      await page.waitForTimeout(300);
      await generateOnce(page);
      const screenplayCalls = calls.filter(call => call.action === 'screenplay');
      assert.equal(screenplayCalls.length, 2, '只自动重试一次，不再循环');
      const spec = await readSpec(page);
      assert.equal(spec.screenplay, before, '重试仍不合格时不覆盖现有剧本');
      const panel = page.locator('section', { hasText: '镜数与时长不合格' });
      await expect(panel.first()).toBeVisible();
      await expect(panel.first()).toContainText('共 3 镜');
      await expect(panel.first()).toContainText('第1镜只有 7 秒');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '重试仍不合格停下', 重试次数: 1, 现有剧本是否被覆盖: false, 清单: (await panel.first().innerText()).replace(/\s+/g, ' ').slice(0, 120) });
      await context.close();
    }

    // ── 验收 2：导入 3 镜 / 8 镜 / 7 秒剧本，要拦住并指出差多少秒 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/functions/v1/app?*', async route => {
        const action = new URL(route.request().url()).searchParams.get('action');
        if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
        else throw new Error(`Unexpected action: ${action}`);
      });
      await startProject(page);
      const cases = [
        { 名称: '3 镜', 文本: makeOffSpecScreenplay({ shots: 3, seconds: 12 }), 期望: '共 3 镜' },
        { 名称: '8 镜', 文本: makeOffSpecScreenplay({ shots: 8, seconds: 12 }), 期望: '共 8 镜' },
        { 名称: '第 2 镜 7 秒', 文本: makeOffSpecScreenplay({ shots: 5, seconds: 12 }).replace('【镜头2：远景】（时长12s）', '【镜头2：远景】（时长7s）'), 期望: '第2镜只有 7 秒' },
      ];
      const records = [];
      for (const item of cases) {
        await page.getByRole('button', { name: '导入剧本', exact: true }).click();
        await page.getByLabel('或粘贴原文').fill(item.文本);
        await page.getByRole('button', { name: '解析并预览', exact: true }).click();
        await page.waitForTimeout(300);
        const panel = page.locator('section', { hasText: '没有通过镜数与时长校验' });
        await expect(panel.first()).toBeVisible();
        await expect(panel.first()).toContainText(item.期望);
        const save = page.getByRole('button', { name: '确认导入并替换剧本', exact: true });
        assert.equal(await save.isDisabled(), true, '不合规的剧本不许直接导入');
        await expect(page.getByRole('button', { name: '仍按旧规格导入（不锁镜数与时长）' })).toBeVisible();
        records.push({ 场景: item.名称, 指出: item.期望 });
        await page.getByRole('button', { name: '仍按旧规格导入（不锁镜数与时长）' }).click();
        await page.waitForTimeout(300);
      }
      const spec = await readSpec(page);
      assert.equal(spec.specVersion, undefined, '明确按旧规格导入的不锁镜数与时长');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '导入不合规剧本被拦住', 记录: records });
      await context.close();
    }

    // ── 验收 3：旧的 10 镜 90 秒作品不被新规则误伤 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const legacy = makeOffSpecScreenplay({ shots: 10, seconds: 9 });
      const saved = {
        version: 1,
        activeId: 'legacy',
        projects: [{
          id: 'legacy', name: '旧作品', theme: '旧主题', style: '东方玄幻水墨风，冷灰 + 金色灵光',
          createdAt: '', updatedAt: '', revision: 0, skills: ['script'], shots: [], assets: [],
          source: 'ai', storyboardReady: false, screenplay: legacy,
        }],
        settings: { scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance', speechModel: 'speech-2.8-hd', styles: [] },
      };
      await page.addInitScript(payload => {
        localStorage.setItem('manju-studio-v1', payload);
      }, JSON.stringify(saved));
      await page.goto('http://127.0.0.1:5173/#/script');
      await page.waitForTimeout(500);
      await expect(page.locator('section', { hasText: '镜数与时长规格' }).first()).toBeVisible();
      await expect(page.locator('span', { hasText: '旧规格' }).first()).toBeVisible();
      await expect(page.getByText('这份剧本是旧规格')).toBeVisible();
      assert.equal(await page.locator('section', { hasText: '镜数与时长不合格' }).count(), 0, '旧作品不该被新规则判为不合格');
      const confirm = page.getByRole('button', { name: '确认并进入下一步' });
      assert.equal(await confirm.isEnabled(), true, '旧作品照常能进入下一步');
      const box = page.getByLabel('剧本全文');
      assert.equal((await box.inputValue()).includes('【镜头10：远景】'), true, '旧剧本正文照常显示');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '旧作品不被误伤', 镜数: 10, 总秒: 90, 可进入下一步: true });
      await context.close();
    }
    // ── 验收：只看界面走通「找到模板 → 改一句话 → 恢复默认 → 关掉一个 Skill 再生成」 ──
    {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = []; const calls = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/functions/v1/app?*', async route => {
        const action = new URL(route.request().url()).searchParams.get('action');
        calls.push({ action, body: route.request().postDataJSON() });
        if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay: makeScreenplay({ shots: 5, seconds: 12 }) } } });
        else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
        else throw new Error(`Unexpected action: ${action}`);
      });
      await startProject(page);
      const editor = page.locator('.template-editor');

      // 1. 找到模板：全局模板 → 剧本 → 第一块就是「镜数与时长（硬性）」。
      await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script');
      await editor.waitFor();
      await page.getByRole('tab', { name: '全局模板（默认）' }).click();
      await page.waitForTimeout(300);
      const body = editor.locator('textarea:not([readonly])').first();
      const factoryText = await body.inputValue();
      assert.ok(factoryText.includes('4、5 或 6 镜'), '出厂块就是镜数与时长条款');

      // 2. 改一句话并保存：下一次生成就带这句。
      await body.fill(`${factoryText}\n这一句是用户自己改的。`);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);
      const afterEdit = await page.evaluate(async () => {
        const names = performance.getEntriesByType('resource').map(entry => entry.name);
        const store = await import(names.find(name => name.includes('/src/store/studio.ts')));
        const lib = await import(names.find(name => name.includes('/src/lib/prompts.ts')));
        const state = store.getStudio();
        return lib.scriptPrompt(state.projects[0], state.settings.promptTemplates);
      });
      assert.ok(afterEdit.includes('这一句是用户自己改的。'), '改完立刻生效于下一次生成');

      // 3. 恢复默认：正文回到出厂文案。
      await editor.getByRole('button', { name: '恢复默认 镜数与时长（硬性）' }).click();
      await page.waitForTimeout(200);
      assert.equal(await body.inputValue(), factoryText, '恢复默认要把出厂正文还回来');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);

      // 4. 关掉一个 Skill：新建一份 Skill、选中它、再关掉。
      await editor.getByRole('button', { name: 'Skill 库', exact: true }).click();
      await page.waitForTimeout(300);
      await editor.getByRole('button', { name: '新增 Skill' }).click();
      await page.waitForTimeout(200);
      const skillNames = editor.locator('input[aria-label^="Skill 名称"]');
      const newSkillName = skillNames.nth(await skillNames.count() - 1);
      const newSkill = newSkillName.locator('xpath=ancestor::section[1]');
      await newSkill.locator('textarea').fill('我的小说转剧本配方。');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);
      await editor.getByRole('button', { name: '模板块', exact: true }).click();
      await page.waitForTimeout(300);
      const skillSelect = editor.locator('select[aria-label="选择 Skill · 剧本"]');
      const skillId = await skillSelect.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent || '' })).find(option => option.text.includes('新 Skill'))?.value);
      assert.ok(skillId, '新建的 Skill 要出现在剧本这一步的下拉里');
      await skillSelect.selectOption(skillId);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);
      const withSkill = await page.evaluate(async () => {
        const names = performance.getEntriesByType('resource').map(entry => entry.name);
        const store = await import(names.find(name => name.includes('/src/store/studio.ts')));
        const lib = await import(names.find(name => name.includes('/src/lib/prompts.ts')));
        const state = store.getStudio();
        return lib.scriptPrompt(state.projects[0], state.settings.promptTemplates);
      });
      assert.ok(withSkill.includes('我的小说转剧本配方。'), '选中的 Skill 要进提示词');

      // 5. 关掉它：下拉选「不启用 Skill」，再生成一次确认没带上。
      await skillSelect.selectOption('');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(300);
      await page.goto('http://127.0.0.1:5173/#/script');
      await page.waitForTimeout(300);
      await generateOnce(page);
      const sent = calls.filter(call => call.action === 'screenplay').pop().body.prompt;
      assert.ok(!sent.includes('我的小说转剧本配方。'), '关掉的 Skill 不该再进提示词');
      assert.ok(sent.includes('4、5 或 6 镜'), '出厂的镜数与时长条款仍在提示词里');
      assert.deepEqual(errors, []);
      results.push({ width, 场景: '界面上改模板 → 恢复默认 → 关掉 Skill 再生成', 改一句: '生效', 恢复默认: '回到出厂文案', 关掉Skill: '不再进提示词' });
      await context.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
