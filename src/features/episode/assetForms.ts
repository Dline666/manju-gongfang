import type { Asset } from '../../domain/types';

/**
 * 多形态沿用现有资产数据：名字写成「角色 · 形态」即归到同一角色下，基础形态就是角色名本身。
 * 点、间隔号、斜杠都接受，便于从旧清单里粘贴进来的名字直接归组。
 */
export function splitFormName(name: string): { base: string; form: string } {
  const match = name.match(/^(.*?)\s*[·・/]\s*(.+)$/);
  return match ? { base: match[1].trim(), form: match[2].trim() } : { base: name.trim(), form: '' };
}

/**
 * 非基础形态对应的基础形态资产；基础形态本身、名字解析不出基础形态时返回 undefined。
 * 只认同类别、名字完全等于基础名的资产，避免「阿青 · 战损」被同名场景误认。
 */
export function formBaseAsset(asset: Asset, assets: Asset[]): Asset | undefined {
  const { base, form } = splitFormName(asset.name);
  if (!form) return undefined;
  return assets.find(item => item.id !== asset.id && item.kind === asset.kind && splitFormName(item.name).form === '' && item.name.trim() === base);
}

/**
 * 某个资产挂载的参考图来源。
 * - `referenceAssetId` 是资产 id：用它；
 * - 空字符串：用户明确清空，纯文本生成；
 * - undefined：旧数据兼容——新形态沿用基础形态的当前设定图，其它资产留空。
 * 参考图按资产动态解析，所以来源资产换了设定图，引用它的资产也会跟着用新图。
 */
export function referenceAssetFor(asset: Asset, assets: Asset[]): Asset | undefined {
  if (asset.referenceAssetId === '') return undefined;
  if (asset.referenceAssetId) return assets.find(item => item.id === asset.referenceAssetId && item.id !== asset.id);
  const base = formBaseAsset(asset, assets);
  return base?.imageId ? base : undefined;
}

export interface AssetGroup {
  key: string;
  base: Asset;
  forms: Asset[];
}

/**
 * 按基础形态分组：基础形态在前，它的各种形态跟在后面。
 * 找不到基础形态的游离形态（例如「无人 · 形态」）单独成组——藏起来等于丢数据。
 * 两遍扫描：先立基础形态，再挂形态，否则「形态」出现在「基础」之前时会自己成一组。
 */
export function groupAssets(assets: Asset[]): AssetGroup[] {
  const groups: AssetGroup[] = [];
  const byBase = new Map<string, AssetGroup>();
  for (const asset of assets) {
    if (splitFormName(asset.name).form) continue;
    const group: AssetGroup = { key: asset.id, base: asset, forms: [] };
    groups.push(group);
    byBase.set(`${asset.kind}:${asset.name.trim()}`, group);
  }
  for (const asset of assets) {
    const { base, form } = splitFormName(asset.name);
    if (!form) continue;
    const parent = byBase.get(`${asset.kind}:${base}`);
    if (parent) parent.forms.push(asset);
    else groups.push({ key: asset.id, base: asset, forms: [] });
  }
  return groups;
}