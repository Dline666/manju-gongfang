import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from '../src/domain/types';
import { formBaseAsset, groupAssets, referenceAssetFor, splitFormName } from '../src/features/episode/assetForms';

function asset(id: string, name: string, extra: Partial<Asset> = {}): Asset {
  return { id, kind: 'character', name, description: '描述', lock: '固定短语', ...extra };
}

test('非基础形态能解析出基础形态，基础形态与普通资产不附带参考图', () => {
  const base = asset('base', '阿青', { imageId: 'img-base' });
  const form = asset('form', '阿青 · 战损');
  const plain = asset('plain', '山门');
  assert.deepEqual(splitFormName('阿青 · 战损'), { base: '阿青', form: '战损' });
  assert.deepEqual(splitFormName('阿青'), { base: '阿青', form: '' });
  assert.deepEqual(splitFormName('阿青 / 战损'), { base: '阿青', form: '战损' });
  assert.equal(formBaseAsset(base, [base, form]), undefined);
  assert.equal(formBaseAsset(plain, [plain]), undefined);
  assert.equal(formBaseAsset(form, [base, form, plain])?.id, 'base');
  assert.equal(formBaseAsset(form, [base, form])?.imageId, 'img-base');
});

test('同名但不同类别的资产、以及找不到的基础形态都不会被当成参考图来源', () => {
  const base = asset('base', '阿青', { imageId: 'img-base' });
  const sceneBase = asset('scene', '阿青', { kind: 'scene', imageId: 'img-scene' });
  const form = asset('form', '阿青 · 夜行');
  const sceneForm = asset('scene-form', '阿青 · 夜行', { kind: 'scene' });
  const orphan = asset('orphan', '无人 · 形态');
  assert.equal(formBaseAsset(form, [base, sceneBase, form]), base);
  assert.equal(formBaseAsset(sceneForm, [base, sceneBase, sceneForm]), sceneBase);
  assert.equal(formBaseAsset(orphan, [asset('other-form', '无人 · 另一种形态')]), undefined);
  assert.equal(formBaseAsset(asset('self', '阿青 · 战损'), [asset('self', '阿青 · 战损')]), undefined);
});

test('参考图只解析仍存在且不是自己的资产，旧形态沿用基础形态，清除后保持为空', () => {
  const source = asset('source', '阿青', { imageId: 'img-a' });
  const form = asset('form', '阿青 · 战损', { referenceAssetId: 'source' });
  const other = asset('other', '阿青 · 夜行', { referenceAssetId: 'source' });
  const self = asset('self', '独立', { referenceAssetId: 'self' });
  const assets = [source, form, other, self];
  assert.equal(referenceAssetFor(form, assets)?.id, 'source');
  assert.equal(referenceAssetFor(asset('none', '无参考'), assets), undefined);
  assert.equal(referenceAssetFor(self, assets), undefined, '不能引用自己');
  assert.equal(referenceAssetFor(asset('dangling', '悬空', { referenceAssetId: 'gone' }), assets), undefined);
  assert.equal(referenceAssetFor(asset('legacy', '阿青 · 旧形态'), [source, asset('legacy', '阿青 · 旧形态')])?.id, 'source', '旧存档里的形态自动沿用基础形态的设定图');
  assert.equal(referenceAssetFor(asset('cleared', '阿青 · 已清空', { referenceAssetId: '' }), [source, asset('cleared', '阿青 · 已清空', { referenceAssetId: '' })]), undefined, '空字符串表示明确清空，不能回落到基础形态');
});

test('分组把形态挂到基础形态下，形态先出现在数组里也不会自成一组', () => {
  const base = asset('base', '阿青');
  const form = asset('form', '阿青 · 战损');
  const other = asset('other', '老剑师');
  const grouped = groupAssets([form, base, other]);
  assert.equal(grouped.length, 2, '两个基础形态各一组');
  assert.equal(grouped[0].base.id, 'base', '基础形态在前');
  assert.deepEqual(grouped[0].forms.map(item => item.id), ['form']);
  assert.deepEqual(grouped[1].forms, []);
  assert.deepEqual(groupAssets([other]).map(group => group.base.id), ['other']);
});

test('找不到基础形态的游离形态单独成组，不会被丢掉', () => {
  const orphan = asset('orphan', '无人 · 形态');
  const grouped = groupAssets([orphan]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].base.id, 'orphan', '游离形态要能显示出来');
  assert.deepEqual(grouped[0].forms, []);
});

test('同名基础形态按类别互不干扰', () => {
  const person = asset('p', '阿青');
  const scene = asset('s', '阿青', { kind: 'scene' });
  const personForm = asset('pf', '阿青 · 战损');
  const sceneForm = asset('sf', '阿青 · 战损', { kind: 'scene' });
  const grouped = groupAssets([person, scene, personForm, sceneForm]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].forms.map(item => item.id), ['pf']);
  assert.deepEqual(grouped[1].forms.map(item => item.id), ['sf']);
});