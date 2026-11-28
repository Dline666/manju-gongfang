import { HelpPopover } from '../../components/Ui';
import { PageHeader } from '../../components/PageHeader';
import { useActiveSeries, useStudio } from '../../store/studio';
import TemplateEditorPage, { type TemplateScope, type TemplateTab } from './TemplateEditorPage';

const TEMPLATE_TABS: TemplateTab[] = ['script', 'assets', 'director', 'image', 'video'];

/**
 * 提示词模板页（#/settings/templates）。
 * 深链 `?kind=image&sub=scene&scope=project` 仍然能直接跳到对应品类与作用域。
 * 模型配置在另一页（#/settings），这里不出现任何 Key 输入。
 */
function readRoute(): { kind: TemplateTab; sub?: string; scope: TemplateScope } {
  const [path, query] = location.hash.replace('#/', '').split('?');
  const params = new URLSearchParams(query ?? '');
  const kind = params.get('kind');
  return {
    kind: TEMPLATE_TABS.includes(kind as TemplateTab) ? kind as TemplateTab : 'script',
    sub: params.get('sub') ?? undefined,
    scope: params.get('scope') === 'project' && path.startsWith('settings/templates') ? 'project' : 'global',
  };
}

export default function TemplatesPage() {
  const state = useStudio();
  // 「作品级覆盖」现在落在系列上：一个系列的所有集共用一份覆盖层。
  const series = useActiveSeries() ?? (state.activeSeriesId ? state.series.find(item => item.id === state.activeSeriesId) : undefined);
  const project = series;
  const route = readRoute();
  return <div className="stack compact-page">
    <PageHeader title="提示词模板" help={<HelpPopover label="模板说明" title="提示词模板"><p>模板里只有你写的块：可改、可增、可删、可调序。作品数据（主题、剧本、资产、附件）不在模板里，由系统每次自动附带。</p><p className="mt-2">全局模板是所有作品的默认；某个系列可以只覆盖其中某一步，其余步骤继续跟随全局。</p><p className="mt-2">每个要调模型的步骤可以选一份 Skill，正文写在 Skill 库里，写一次可多步复用；空正文不会进提示词。</p></HelpPopover>} />
    <TemplateEditorPage key={location.hash} project={project} initialScope={project ? route.scope : 'global'} initialKind={route.kind} initialSub={route.sub} />
  </div>;
}