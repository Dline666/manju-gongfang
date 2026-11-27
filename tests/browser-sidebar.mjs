// 侧栏收起/展开验收：宽度、文案、图标居中、刷新后保持。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:5173/#/chat');
    await page.locator('.sidebar-toggle').waitFor({ timeout: 15000 });

    const asideWidth = () => page.evaluate(() => {
      const container = document.querySelector('[data-slot=sidebar-container]');
      return container ? Math.round(container.getBoundingClientRect().width) : -1;
    });
    const toggle = page.locator('.sidebar-toggle');

    // 展开态
    assert.equal(await asideWidth(), 240, '展开应 240px');
    assert.equal(await toggle.getAttribute('aria-label'), '收起侧边栏');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const brandVisible = await page.locator('.brand-text').isVisible();
    const labelVisible = await page.locator('.nav-label').first().isVisible();
    assert.ok(brandVisible && labelVisible, '展开时应显示文字');

    // 收起
    await toggle.click();
    await page.waitForTimeout(450);
    assert.equal(await asideWidth(), 64, '收起应 64px');
    assert.equal(await toggle.getAttribute('aria-label'), '展开侧边栏');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.brand-text').isVisible(), false, '收起后品牌文字应隐藏');
    assert.equal(await page.locator('.nav-label').first().isVisible(), false, '收起后导航文字应隐藏');

    // 图标必须居中，不能贴在左边；图标块应是正方形，不能变成窄高条。
    const geometry = await page.evaluate(() => {
      const container = document.querySelector('[data-slot=sidebar-container]');
      const box = container.getBoundingClientRect();
      const items = [...container.querySelectorAll('[data-slot=sidebar-content] .nav-item, [data-slot=sidebar-footer] .nav-item')].map(el => {
        const icon = el.querySelector('svg');
        const ir = icon.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        return {
          iconCenter: Math.round(ir.x + ir.width / 2),
          itemCenter: Math.round(er.x + er.width / 2),
          itemWidth: Math.round(er.width),
          itemHeight: Math.round(er.height),
          itemLeft: Math.round(er.x - box.x),
          overflowRight: Math.round(er.right - box.right),
        };
      });
      const brandIcon = container.querySelector('.brand-mark').getBoundingClientRect();
      const toggleBox = container.querySelector('.sidebar-toggle').getBoundingClientRect();
      return {
        boxCenter: Math.round(box.x + box.width / 2),
        items,
        brandCenter: Math.round(brandIcon.x + brandIcon.width / 2),
        toggleCenter: Math.round(toggleBox.x + toggleBox.width / 2),
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
      };
    });
    for (const item of geometry.items) {
      assert.ok(Math.abs(item.iconCenter - geometry.boxCenter) <= 6, `图标应居中：${item.iconCenter} vs ${geometry.boxCenter}`);
      assert.ok(item.overflowRight <= 1, `导航项不得溢出侧栏：${item.overflowRight}`);
      assert.ok(item.itemLeft >= 0, `导航项不得越出左边界：${item.itemLeft}`);
      // 窄高条是这版最典型的失败形态：文字没藏干净，把图标挤成一条竖缝。
      assert.ok(Math.abs(item.itemWidth - item.itemHeight) <= 2, `图标块应为正方形，实际 ${item.itemWidth}×${item.itemHeight}`);
    }
    assert.ok(Math.abs(geometry.brandCenter - geometry.boxCenter) <= 6, `品牌图标应居中：${geometry.brandCenter} vs ${geometry.boxCenter}`);
    assert.ok(Math.abs(geometry.toggleCenter - geometry.boxCenter) <= 6, `收起按钮应居中：${geometry.toggleCenter} vs ${geometry.boxCenter}`);
    assert.equal(geometry.scrollWidth <= geometry.clientWidth + 1, true, '收起后不应出现横向滚动');

    // 收起后状态文字不该留着挤成竖排
    const localStatus = await page.evaluate(() => {
      const el = document.querySelector('.local-status');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { visible: getComputedStyle(el).display !== 'none', w: Math.round(r.width), h: Math.round(r.height) };
    });
    assert.ok(!localStatus || !localStatus.visible, `收起后本地状态不该显示，实际 ${JSON.stringify(localStatus)}`);

    // tooltip 语义：收起后必须有 title
    const titles = await page.evaluate(() => [...document.querySelectorAll('[data-slot=sidebar-container] .nav-item')].map(el => el.getAttribute('title')));
    assert.ok(titles.every(Boolean), `收起后每个导航项都要有 title，实际：${JSON.stringify(titles)}`);

    // 刷新后保持收起
    await page.reload();
    await page.locator('.sidebar-toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    assert.equal(await asideWidth(), 64, '刷新后应保持收起');
    assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-label'), '展开侧边栏');

    // 收起后仍要能导航：文字藏了，图标必须还是可点的入口（此刻仍是收起态）。
    await page.locator('[data-slot=sidebar-container] .nav-item[title="作品集"]').click();
    await page.waitForTimeout(600);
    assert.match(page.url(), /#\/library/, '收起后点图标应能跳转');
    assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-label'), '展开侧边栏', '跳转后应保持收起');

    // 再展开，确认往返正常
    await page.locator('.sidebar-toggle').click();
    await page.waitForTimeout(450);
    assert.equal(await asideWidth(), 240, '应能重新展开');
    assert.equal(await page.locator('.nav-label').first().isVisible(), true);
    await page.locator('.sidebar-toggle').click();
    await page.waitForTimeout(450);

    // 主区域不能因此横向溢出
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `${width} 横向溢出`);
    assert.deepEqual(errors, []);
    results.push({ width, passed: true, geometry: { items: geometry.items.length } });
    await context.close();
  }

  // 移动端不该出现桌面图标栏，仍走抽屉。
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto('http://127.0.0.1:5173/#/chat');
  await mobile.waitForTimeout(1500);
  const mobileState = await mobile.evaluate(() => {
    const container = document.querySelector('[data-slot=sidebar-container]');
    const trigger = document.querySelector('.mobile-menu');
    return {
      desktopBarVisible: container ? getComputedStyle(container).display !== 'none' : false,
      hasMobileTrigger: Boolean(trigger) && getComputedStyle(trigger).display !== 'none',
    };
  });
  assert.equal(mobileState.desktopBarVisible, false, '移动端不该显示桌面侧栏');
  assert.equal(mobileState.hasMobileTrigger, true, '移动端应有抽屉触发按钮');
  await mobile.locator('.mobile-menu').click();
  await mobile.waitForTimeout(700);
  assert.equal(await mobile.evaluate(() => Boolean(document.querySelector('[role=dialog]'))), true, '抽屉应能打开');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, '移动端横向溢出');
  results.push({ width: 390, passed: true, mobile: mobileState });
  await phone.close();
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }