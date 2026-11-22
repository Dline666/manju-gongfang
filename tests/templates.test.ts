import test from 'node:test';
import assert from 'node:assert/strict';
import { directorPrompt, directorSpec, imagePrompt, scriptPrompt, scriptSpec, videoPrompt, videoSpec } from '../src/lib/prompts';
import { applyPromptOverrides, promptBlock, validatePromptSpec } from '../src/lib/promptSpec';
import { findUnknownVariables, styleSpecFor, templates } from '../src/lib/promptTemplates';
import { savedStudioSchema } from '../src/store/schema';
import { defaultSettings, defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '灰白布衣', lock: '十七岁少年，灰白旧布衣，背空剑鞘', imageId: 'image-hero' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶九十九级，晨雾低垂', imageId: 'image-scene' };

function makeProject(promptConfig?: Project['promptConfig']): Project {
  return {
    id: 'project', name: '断剑归门', theme: '少年拾起断剑', style: defaultStyle,
    createdAt: '', updatedAt: '', revision: 0, source: 'template', skills: ['script', 'storyboard', 'image', 'video'],
    storyboardReady: true, assets: [hero, scene],
    shots: [{ ...makeShot(1), visual: '沈砚走上石阶', start: '石阶前', action: '抬手', end: '站定', dialogues: [{ id: 'd1', speakerId: 'hero', text: '我回来了。' }] }],
    promptConfig,
  };
}

test('五个模板齐全，默认渲染包含可编辑规则与锁定契约', () => {
  assert.deepEqual(templates.map(template => template.id), ['script', 'assets', 'director', 'image', 'video']);
  const project = makeProject();
  const script = scriptPrompt(project);
  assert.ok(script.includes('三幕结构'));
  assert.ok(script.includes('不写抽象心理'));
  assert.ok(script.includes('【优先级】P0'));
  assert.ok(script.includes('总计90秒'));
  assert.ok(imagePrompt(project, hero).includes('只输出一张角色三视图'));
  assert.ok(videoPrompt(project, project.shots[0]).includes('动作按时间顺序描述'));
  const director = directorSpec(project);
  assert.equal(promptBlock(director, 'director.contract')?.locked, true);
  assert.ok(directorPrompt(project).includes('shotSize'));
});

test('可编辑块被作品配置覆盖，锁定块忽略覆盖', () => {
  const project = makeProject({ v: 1, blocks: { 'script.drama': '自定义剧作规范：只写雨夜。', 'script.contract': '篡改契约', 'video.motion': '动作只写一个。' } });
  const script = scriptPrompt(project);
  assert.ok(script.includes('自定义剧作规范：只写雨夜。'));
  assert.ok(!script.includes('三幕结构'));
  assert.ok(script.includes('只输出合法JSON'), 'locked contract must stay');
  assert.ok(!script.includes('篡改契约'));
  const video = videoPrompt(project, project.shots[0]);
  assert.ok(video.includes('动作只写一个。'));
  assert.ok(!video.includes('动作按时间顺序描述'));
});

test('变量白名单：已知变量替换，未知变量被报告', () => {
  const project = makeProject({ v: 1, blocks: { 'script.genre': '题材：{{project.theme}}，{{unknown.extra}}' } });
  assert.ok(scriptPrompt(project).includes('题材：少年拾起断剑，{{unknown.extra}}'));
  assert.deepEqual(findUnknownVariables('{{project.theme}} {{style.medium}}'), []);
  assert.deepEqual(findUnknownVariables('{{unknown.extra}} {{project.theme}} {{bad}}'), ['unknown.extra', 'bad']);
});

test('风格设定展开到图片/视频提示词，project.style 仍保留', () => {
  const project = makeProject({ v: 1, style: { medium: '测试介质', palette: '测试配色', forbidden: ['水印', '文字'] } });
  const image = imagePrompt(project, scene);
  assert.ok(image.includes('介质：测试介质'));
  assert.ok(image.includes('配色：测试配色'));
  assert.ok(image.includes('禁写：水印、文字'));
  assert.ok(image.startsWith('为漫剧制作场景设定图'));
  assert.ok(image.includes(defaultStyle));
  const video = videoPrompt(project, project.shots[0]);
  assert.ok(video.includes('【风格块】'));
  assert.ok(video.includes('测试介质'));
  assert.equal(styleSpecFor(project).medium, '测试介质');
});

test('预算校验：视频提示词超过 7000 字会报告', () => {
  const project = makeProject({ v: 1, blocks: { 'video.forbidden': `禁写：${'x'.repeat(8000)}` } });
  const prompt = videoPrompt(project, project.shots[0]);
  assert.ok(prompt.length > 7000);
  const issues = validatePromptSpec(videoSpec(project, project.shots[0]));
  assert.ok(issues.some(issue => issue.includes('超过上限')), issues.join('；'));
});

test('覆盖入口保护锁定块，并可恢复默认', () => {
  const project = makeProject();
  const spec = scriptSpec(project);
  const overridden = applyPromptOverrides(spec, { 'script.contract': '篡改', 'script.drama': '新规范' });
  assert.equal(promptBlock(overridden, 'script.contract')?.text, promptBlock(spec, 'script.contract')?.text);
  assert.equal(promptBlock(overridden, 'script.drama')?.text, '新规范');
});

test('promptConfig 可选字段能通过存档 schema，旧作品不受影响', () => {
  const withConfig = makeProject({ v: 1, style: { medium: '宣纸' }, blocks: { 'script.drama': '只写雨夜' } });
  const saved = savedStudioSchema.parse({ version: 1, projects: [withConfig], activeId: withConfig.id, settings: defaultSettings });
  assert.deepEqual(saved.projects[0].promptConfig, withConfig.promptConfig);
  const legacy = makeProject();
  assert.equal(savedStudioSchema.parse({ version: 1, projects: [legacy], activeId: legacy.id, settings: defaultSettings }).projects[0].promptConfig, undefined);
});
