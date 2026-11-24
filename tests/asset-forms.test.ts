import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset, Project } from '../src/domain/types';
import { formBaseAsset, referenceAssetFor, removeAsset, splitFormName } from '../src/features/assets/helpers';

function asset(id: string, name: string, extra: Partial<Asset> = {}): Asset {
  return { id, kind: 'character', name, description: '描述', lock: '固定短语', ...extra };
}
function projectWith(assets: Asset[]): Project {
  return { id: 'project', name: '测试', theme: '', style: '', createdAt: '', updatedAt: '', revision: 0, skills: [], shots: [], assets, source: 'empty', storyboardReady: false };
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

test('参考图只解析仍存在且不是自己的资产，删除来源时引用被清掉', () => {
  const source = asset('source', '阿青', { imageId: 'img-a' });
  const form = asset('form', '阿青 · 战损', { referenceAssetId: 'source' });
  const other = asset('other', '阿青 · 夜行', { referenceAssetId: 'source' });
  const self = asset('self', '独立', { referenceAssetId: 'self' });
  const assets = [source, form, other, self];
  assert.equal(referenceAssetFor(form, assets)?.id, 'source');
  assert.equal(referenceAssetFor(asset('none', '无参考'), assets), undefined);
  assert.equal(referenceAssetFor(self, assets), undefined, '不能引用自己');
  assert.equal(referenceAssetFor(asset('dangling', '悬空', { referenceAssetId: 'gone' }), assets), undefined);
  const removed = removeAsset(projectWith([source, form, other]), 'source');
  assert.deepEqual(removed.assets.map(item => item.referenceAssetId), [undefined, undefined], '删除来源资产后清空挂载，避免留下悬空引用');
});
