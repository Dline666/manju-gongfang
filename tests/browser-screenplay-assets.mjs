// 剧本顺带产出资产 → 分镜按 id 引用 → 视频提示词带画面与开场。
// 覆盖这条链路的三个界面事实：资产落进资产库、分镜显示在场资产、视频提示词带画面。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

import { makeScreenplay } from './screenplay-fixtures.mjs';
const screenplay = makeScreenplay();


const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

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
      if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: {
        title: '断剑归门', logline: '少年拾剑', screenplay,
        assets: {
          characters: [{ id: 'c1', name: '沈砚', aliases: '小砚', description: '沉默寡言', lock: '十七岁少年，灰白旧布衣，背空剑鞘' }],
          scenes: [{ id: 's1', name: '山门', lock: '青灰石阶九十九级，晨雾低垂' }],
          props: [{ id: 'p1', name: '断剑', lock: '红绳缠绕的剑柄，断口有微弱金色灵光' }],
        },
      } } });
      else if (action === 'director') await route.fulfill({ json: { ok: true, data: { shots: [
        { number: 1, title: '拾剑', scene: '外景 · 山门 — 清晨', sceneId: 's1', visual: '沈砚蹲在石阶下抠开泥。', duration: 3,
          shotSize: '远景', movement: '固定', angle: '平视', start: '石阶下', action: '抠开泥', end: '泥被抠开',
          dialogues: [{ speaker: '沈砚', text: '我回来了。' }],
          assets: [{ assetId: 'c1', role: 'subject' }, { assetId: 'p1', role: 'prop' }] },
      ] } } });
      else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
      else throw new Error(`Unexpected network action: ${action}`);
    });

    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      module.setKey('gemini', 'fixture-not-transmitted');
    });

    // 1. 生成剧本：资产随剧本一起落进资产库。
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);

    const state = await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      const project = module.getStudio().projects[0];
      return project.assets.map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, lock: asset.lock, aliases: asset.aliases }));
    });
    assert.equal(state.length, 3, '人物、场景、道具三类资产都要落地');
    assert.deepEqual(state.map(asset => asset.kind), ['character', 'scene', 'prop']);
    assert.equal(state[0].id, 'c1', '模型给的 id 沿用，分镜要按它引用');
    assert.equal(state[0].lock, '十七岁少年，灰白旧布衣，背空剑鞘', '固定短语逐字保留');
    assert.deepEqual(state[0].aliases, ['小砚'], '代称按逗号拆开');

    // 2. 资产页能看到这三项。
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.waitForTimeout(400);
    await page.getByRole('tab', { name: '人物' }).first().click();
    await page.waitForTimeout(300);
    await expect(page.getByText('沈砚').first()).toBeVisible();

    // 3. 导演分镜：提示词带本片资产清单，模型按 id 引用。
    await page.goto('http://127.0.0.1:5173/#/director');
    await page.getByRole('button', { name: 'AI 生成分镜（先确认）', exact: true }).click();
    const directorBox = page.getByLabel('即将发送的导演提示词');
    await expect(directorBox).toBeEditable();
    const directorPrompt = await directorBox.inputValue();
    assert.ok(directorPrompt.includes('c1'), '导演提示词要带资产 id');
    assert.ok(directorPrompt.includes('十七岁少年，灰白旧布衣，背空剑鞘'), '导演提示词要带固定短语');
    await page.getByRole('button', { name: '确认发送并生成分镜', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);

    // 4. 分镜卡片显示在场资产与主体。
    await page.getByRole('button', { name: /展开第1镜/ }).click();
    await page.waitForTimeout(300);
    const card = page.locator('#shot-1');
    await expect(card).toContainText('在场资产');
    await expect(card).toContainText('沈砚（主体）');
    await expect(card).toContainText('断剑');

    // 5. 视频提示词带画面与开场。
    const videoPrompt = await page.evaluate(async () => {
      const names = performance.getEntriesByType('resource').map(e => e.name);
      const store = await import(names.find(n => n.includes('/src/store/studio.ts')));
      const lib = await import(names.find(n => n.includes('/src/lib/prompts.ts')));
      const state = store.getStudio();
      const project = state.projects[0];
      return lib.videoPrompt(project, project.shots[0], state.settings.promptTemplates);
    });
    assert.ok(videoPrompt.includes('画面：沈砚蹲在石阶下抠开泥。'), '画面描述必须进视频提示词');
    assert.ok(videoPrompt.includes('开场：石阶下'), '开场状态必须进视频提示词');
    assert.ok(videoPrompt.includes('（主体）'), '主体资产要标出来');
    assert.ok(videoPrompt.includes('青灰石阶九十九级'), '场景固定短语逐字进视频提示词');

    assert.deepEqual(errors, []);
    results.push({ width, passed: true, calls: calls.map(call => call.action) });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
