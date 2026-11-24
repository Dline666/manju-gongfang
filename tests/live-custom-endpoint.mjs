// 真实链路实测：两个自定义端点各打各的上游。
//   文本端点 → gemini-4-argon（chat/completions）
//   图像端点 → gpt-image-2（images/generations）
// 全程：页面 → Vite → 本地 Function（8000）→ 中转站 → 真图入库 / 真剧本。
//
// 用法（PowerShell）：
//   $env:GEMINI_KEY='sk-xxx'
//   $env:GPT_KEY='sk-yyy'
//   node tests/live-custom-endpoint.mjs
//
// 若本地 Function 需要走代理，先用带代理环境变量的方式重启它：
//   $env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:HTTP_PROXY='http://127.0.0.1:7897'
//   deno run --watch --allow-net --allow-env dev/function-local.ts
//
// Key 只走环境变量进页面内存：不打印、不落盘、不进存档。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pickSearchOption } from './select-helpers.mjs';

const BASE = process.env.CUSTOM_BASE_URL || 'https://ai.cangyuansuanli.cn/v1';
const GEMINI_KEY = process.env.GEMINI_KEY;
const GPT_KEY = process.env.GPT_KEY;
const IMAGE_MODEL = process.env.CUSTOM_MODEL || 'gpt-image-2';
const TEXT_MODEL = process.env.CUSTOM_TEXT_MODEL || 'gemini-4-argon';
if (!GEMINI_KEY || !GPT_KEY) {
  console.error('需要环境变量 GEMINI_KEY / GPT_KEY');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const calls = [];
const report = { baseUrl: BASE, textModel: TEXT_MODEL, imageModel: IMAGE_MODEL, steps: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  // 不拦截 /functions/v1/app：这一条要真的打到本地 Function 与真实上游。
  page.on('response', response => {
    const url = response.url();
    if (!url.includes('/functions/v1/app')) return;
    calls.push({ action: new URL(url).searchParams.get('action'), status: response.status() });
  });

  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(async () => {
    const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts');
    const p = s.createProject('自定义端点实测', '少年在雨夜山门拾起一把断剑，却不知剑里封着自己被削去的神格');
    s.updateProject(p.id, { style: '东方玄幻水墨风，冷灰 + 金色灵光' });
    location.hash = '/settings';
  });
  await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
  const openTab = async title => { await page.getByRole('tab', { name: new RegExp(`^${title}`) }).click(); };
  const openPanel = () => page.locator('.provider-panel').filter({ has: page.locator('input[placeholder="https://api.example.com/v1"]') });

  // 端点一：只管剧本（gemini）
  await openTab('自定义端点');
  await page.getByRole('button', { name: '添加自定义端点' }).click();
  await openPanel().getByLabel('端点名称').fill('文本端点');
  await openPanel().getByLabel('Base URL').fill(BASE);
  await openPanel().getByLabel('API Key').fill(GEMINI_KEY);
  await openPanel().getByLabel('生图', { exact: true }).uncheck();
  await openPanel().getByLabel('文本模型 ID').fill(TEXT_MODEL);

  // 端点二：只管生图（gpt）
  await page.getByRole('button', { name: '添加自定义端点' }).click();
  await openPanel().getByLabel('端点名称').fill('图像端点');
  await openPanel().getByLabel('Base URL').fill(BASE);
  await openPanel().getByLabel('API Key').fill(GPT_KEY);
  await openPanel().getByLabel('剧本', { exact: true }).uncheck();
  await openPanel().getByLabel('生图模型 ID').fill(IMAGE_MODEL);

  // 各挂各的默认端点
  await openTab('剧本');
  await pickSearchOption(page, '剧本默认模型平台', '文本端点');
  await page.getByRole('tab', { name: /^生图/ }).click();
  await pickSearchOption(page, '生图默认模型平台', '图像端点');

  // ── 链路一：剧本（chat/completions）
  if (process.env.SKIP_TEXT !== '1') {
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '确认发送并生成', exact: true }).click();
    let textError = '';
    try { await dialog.waitFor({ state: 'hidden', timeout: 240000 }); }
    catch { textError = (await dialog.textContent() || '').replace(/\s+/g, ' ').slice(0, 400); }
    const shots = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0].shots.length);
    report.steps.push({ step: 'screenplay', ok: !textError && shots > 0, shots, error: textError || undefined });
  }

  // ── 链路二：生图（images/generations）
  await page.evaluate(async () => {
    const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts');
    const p = s.getStudio().projects[0];
    s.updateProject(p.id, {
      assets: [{ id: 'live-hero', kind: 'character', name: '实测人物', description: '十七岁少年，灰白旧布衣', lock: '十七岁少年，灰白旧布衣' }],
    });
  });
  await page.goto('http://127.0.0.1:5173/#/assets');
  await page.getByRole('button', { name: '查看实测人物详情', exact: true }).click();
  await page.getByRole('button', { name: '生成设定图', exact: true }).click();
  const imageDialog = page.getByRole('dialog');
  await imageDialog.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
  let imageError = '';
  try { await imageDialog.waitFor({ state: 'hidden', timeout: 240000 }); }
  catch { imageError = (await imageDialog.textContent() || '').replace(/\s+/g, ' ').slice(0, 400); }
  const imageId = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0].assets[0].imageId);
  report.steps.push({ step: 'image', ok: !imageError && !!imageId, imageId: imageId ?? null, error: imageError || undefined });
  // 把真实生成的图从浏览器素材库导出来，方便人工核对
  if (imageId) {
    try {
      const { writeFile } = await import('node:fs/promises');
      const dataUrl = await page.evaluate(async id => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('manju-media-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const blob = await new Promise((resolve, reject) => { const r = db.transaction('media').objectStore('media').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return `data:${blob.type};base64,${btoa(binary)}`;
      }, imageId);
      await writeFile('dev/live-image.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
      report.steps.at(-1).savedTo = 'dev/live-image.png';
      await page.screenshot({ path: 'dev/live-assets.png' });
      report.steps.at(-1).screenshot = 'dev/live-assets.png';
    } catch (error) { report.steps.at(-1).exportError = String(error).slice(0, 120); }
  }

  report.calls = calls;
  report.pageErrors = pageErrors;
  report.passed = report.steps.every(step => step.ok);
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.steps.some(step => step.ok), '至少一条链路要真的跑通');
  await context.close();
} finally { await browser.close(); }
