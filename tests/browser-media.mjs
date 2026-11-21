import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('heading', { name: '我的作品' }).waitFor();
  console.log('Starting real FFmpeg WASM H264/AAC smoke');
  const smoke = await page.evaluate(async () => {
    const { smokeEncode } = await import('/src/lib/media/encoder.ts');
    const blob = await smokeEncode();
    const { downloadBlob } = await import('/src/components/Ui.tsx');
    const { inspectMedia } = await import('/src/lib/media/inputs.ts');
    const duration = await inspectMedia(blob, 'video');
    downloadBlob(blob, 'smoke.mp4');
    return { size: blob.size, duration };
  });
  assert.ok(smoke.size > 1000); assert.ok(Math.abs(smoke.duration - 1) < 1 / 24);
  console.log('SMOKE', JSON.stringify(smoke));
  const colors = ['d93838', '38b938', '3858d9', 'd9b938', 'b938d9', '38b9b9', 'ee8833', '885533', '884488', '888888'];
  const fixtures = await page.evaluate(async colors => {
    const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
    const { default: workerURL } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js?worker&url');
    const ffmpeg = new FFmpeg(); const output = [];
    try {
      await ffmpeg.load({ classWorkerURL: workerURL, coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`, wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
      for (const color of colors) {
        const code = await ffmpeg.exec(['-f', 'lavfi', '-i', `color=c=0x${color}:s=180x320:r=24:d=1`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-y', 'fixture.mp4']);
        if (code !== 0) throw new Error(`Fixture encode failed: ${code}`);
        output.push(Array.from(await ffmpeg.readFile('fixture.mp4')));
      }
      return output;
    } finally { ffmpeg.terminate(); }
  }, colors);
  await page.getByLabel('一句话故事主题').fill('测试用：少年握紧断剑走向山门');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await page.getByRole('button', { name: '模板演练', exact: true }).click();
  await page.getByRole('button', { name: '建立模板草稿（非AI）' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.goto('http://127.0.0.1:5173/#/generation');
  const voice = await readFile('dev/test-voice.wav');
  await page.locator('.generation-card').nth(9).waitFor();
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: `查看第${i + 1}镜视频详情`, exact: true }).click();
    const card = page.getByRole('dialog');
    await card.locator('input[type=file]').nth(0).setInputFiles({ name: `test-${i + 1}.mp4`, mimeType: 'video/mp4', buffer: Buffer.from(fixtures[i]) });
    await card.locator('video').waitFor();
    await card.locator('input[type=file]').nth(1).setInputFiles({ name: `voice-${i + 1}.wav`, mimeType: 'audio/wav', buffer: voice });
    await card.locator('audio').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const longVoice = await page.evaluate(async () => {
    const { getMedia } = await import('/src/store/media.ts');
    const { joinSpeech } = await import('/src/lib/dubbing.ts');
    const project = JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0];
    const voice = await getMedia(project.shots[0].audio.mediaId);
    const joined = await joinSpeech([voice, voice]);
    return Array.from(new Uint8Array(await joined.blob.arrayBuffer()));
  });
  await page.getByRole('button', { name: '查看第1镜视频详情', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').nth(1).setInputFiles({ name: 'overlong.wav', mimeType: 'audio/wav', buffer: Buffer.from(longVoice) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0].shots[0].audio.name === 'overlong.wav');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '预览成片', exact: true }).click();
  const encode = page.getByRole('button', { name: '生成真实 MP4', exact: true });
  await page.getByText(/超过镜头 9 秒；不会裁剪对白/).first().waitFor();
  assert.equal(await encode.isDisabled(), true, 'overlong dialogue must block encoding');
  await page.getByRole('button', { name: '返回生成 / 重新导入', exact: true }).click();
  await page.getByRole('button', { name: '查看第1镜视频详情', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').nth(1).setInputFiles({ name: 'voice-1.wav', mimeType: 'audio/wav', buffer: voice });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0].shots[0].audio.name === 'voice-1.wav');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '预览成片', exact: true }).click();
  await encode.waitFor();
  try { await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('生成真实 MP4') && !b.disabled), null, { timeout: 60000 }); }
  catch (error) { console.log('PREFLIGHT', await page.locator('main').innerText()); throw error; }
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, 'mobile export overflow');
  await page.screenshot({ path: 'dev/export-390.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '开始连续预览', exact: true }).click();
  try { await page.waitForFunction(() => document.querySelector('input[aria-label="预览时间"]').value > 0.5, null, { timeout: 20000 }); }
  catch (error) { console.log('PREVIEW', await page.locator('section[aria-label="连续时间轴预览"]').innerText()); console.log(await page.locator('section[aria-label="连续时间轴预览"]').evaluate(section => [...section.querySelectorAll('video,audio')].map(m => ({ ready: m.readyState, paused: m.paused, time: m.currentTime, duration: m.duration, error: m.error?.message })))); throw error; }
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '第 10 镜', exact: true }).click();
  await page.getByText('总时间轴 · 当前第 10 镜', { exact: true }).waitFor();
  await page.getByRole('button', { name: '回到开头', exact: true }).click();
  console.log('Timeline preview, audio overrun and mobile export passed; testing cancellation');
  await encode.click();
  await page.getByRole('checkbox', { name: '我已检查每镜时长和音频模式，并确认以上规则' }).check();
  await page.getByRole('button', { name: '确认并开始逐镜编码' }).click();
  await page.getByText(/正在编码第 1 镜/).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '取消编码', exact: true }).click();
  await page.getByText('已取消，已启动的编码 Worker 会被终止；下次编码重新加载。', { exact: true }).waitFor();
  assert.equal(await page.locator('video[aria-label="最终 MP4 预览"]').count(), 0);
  console.log('Cancellation passed; retrying complete 90 second encode');
  await encode.click();
  await page.getByRole('checkbox', { name: '我已检查每镜时长和音频模式，并确认以上规则' }).check();
  const started = Date.now();
  await page.getByRole('button', { name: '确认并开始逐镜编码' }).click();
  await page.waitForFunction(() => document.querySelector('video[aria-label="最终 MP4 预览"]') || document.querySelector('pre[role="alert"]'), null, { timeout: 600000 });
  const failure = page.locator('pre[role=alert]');
  if (await failure.count()) throw new Error(await failure.textContent());
  const final = page.locator('video[aria-label="最终 MP4 预览"]');
  await final.evaluate(async video => { await video.play(); });
  await page.waitForFunction(() => document.querySelector('video[aria-label="最终 MP4 预览"]').currentTime > 0.1);
  const mp4Download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 MP4', exact: true }).click();
  await (await mp4Download).saveAs('dev/test-film.mp4');
  const info = await final.evaluate(async (video, voiceBytes) => {
    video.pause();
    const response = await fetch(video.src); const bytes = await response.arrayBuffer();
    const audioContext = new AudioContext({ sampleRate: 48000 }); const audio = await audioContext.decodeAudioData(bytes.slice(0));
    const source = await audioContext.decodeAudioData(new Uint8Array(voiceBytes).buffer);
    const original = source.getChannelData(0), channel = audio.getChannelData(0); let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const segments = [];
    for (let shot = 0; shot < 10; shot++) {
      const offset = shot * 9 * audio.sampleRate;
      let cross = 0, left = 0, right = 0, silence = 0;
      for (let i = 0; i < original.length; i++) { const a = original[i], b = channel[offset + i]; cross += a * b; left += a * a; right += b * b; }
      for (let i = 8 * audio.sampleRate; i < 9 * audio.sampleRate; i++) silence += channel[offset + i] ** 2;
      segments.push({ correlation: cross / Math.sqrt(left * right), paddingRms: Math.sqrt(silence / audio.sampleRate) });
    }
    await audioContext.close();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); const frames = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve, reject) => { video.onerror = reject; video.requestVideoFrameCallback(resolve); video.currentTime = i * 9 + 4; });
      ctx.drawImage(video, 0, 0, 1, 1); frames.push(Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3));
    }
    video.onseeked = video.onerror = null;
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, bytes: bytes.byteLength, audioDuration: audio.duration, audioRms: Math.sqrt(sum / channel.length), segments, frames };
  }, Array.from(voice));
  assert.ok(Math.abs(info.duration - 90) < 1 / 24, JSON.stringify(info));
  assert.ok(Math.abs(info.audioDuration - 90) < 1 / 24);
  assert.equal(info.width, 720); assert.equal(info.height, 1280); assert.ok(info.audioRms > 0.001);
  info.segments.forEach((segment, i) => {
    assert.ok(segment.correlation > 0.9, `shot ${i + 1}: voice differs or is misaligned: ${JSON.stringify(segment)}`);
    assert.ok(segment.paddingRms < 0.002, `shot ${i + 1}: replacement audio contains original tone`);
  });
  info.frames.forEach((frame, i) => {
    const expected = colors[i].match(/../g).map(part => parseInt(part, 16));
    assert.ok(frame.every((value, channel) => Math.abs(value - expected[channel]) < 18), `shot ${i + 1}: expected ${expected}, got ${frame}`);
  });
  await page.getByRole('button', { name: '生成完整素材 ZIP', exact: true }).click();
  await page.getByRole('button', { name: '下载 ZIP', exact: true }).waitFor({ timeout: 60000 });
  const zipDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 ZIP', exact: true }).click();
  await (await zipDownload).saveAs('dev/test-materials.zip');
  const entries = unzipSync(await readFile('dev/test-materials.zip'));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.complete, true); assert.equal(manifest.shots.length, 10);
  assert.equal(Object.keys(entries).filter(n => n.startsWith('documents/')).length, 5);
  assert.equal(Object.keys(entries).filter(n => n.endsWith('/video.mp4')).length, 10);
  assert.equal(Object.keys(entries).filter(n => n.endsWith('/dubbing.wav')).length, 10);
  assert.ok(strFromU8(entries['subtitles.srt']).includes('00:01:30,000'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, smoke, film: info, encodeSeconds: (Date.now() - started) / 1000, archiveFiles: Object.keys(entries).length, errors }, null, 2));
} finally { await browser.close(); }
