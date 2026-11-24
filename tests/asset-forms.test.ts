import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from '../src/domain/types';
import { formBaseAsset, splitFormName } from '../src/features/assets/helpers';

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
