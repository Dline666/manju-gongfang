import { ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, HelpPopover } from '../../components/Ui';
import { PageHeader } from '../../components/PageHeader';
import { clearKeys, useStudio } from '../../store/studio';
import ProviderGroups from './ProviderGroups';

/**
 * 模型配置页（#/settings）。
 * 只放模型相关内容：哪家服务商、Key 填了没有、当前用哪个模型。
 * 提示词模板在另一页（#/settings/templates），这里不出现任何模板内容。
 */
export default function ModelsPage() {
  const state = useStudio();
  return <div className="stack compact-page">
    <PageHeader title="连接你的创作能力" help={<HelpPopover label="模型配置说明" title="模型配置"><p>每家服务商默认只占一行：名字、用途、Key 状态与当前模型。点「设置」才展开 Key 与模型 ID。</p><p className="mt-2">Key 只留在当前页面内存，刷新后需要重新填写；端点名称、Base URL 与模型 ID 只保存在本机浏览器。</p><p className="mt-2">每次生成都会先确认任务；产生的费用由对应模型平台计收。没有 Key 也能编辑、演练与手动制作。</p></HelpPopover>} actions={<Button variant="secondary" size="sm" onClick={() => { clearKeys(); toast.success('所有 Key 已从当前页面清除'); }}><Trash2 size={15} />清除全部 Key</Button>} />
    <p className="small muted row"><ShieldCheck size={14} />Key 只在当前页面内存，刷新后需重填；Base URL 与模型 ID 只存在本机。</p>
    <ProviderGroups state={state} />
    <p className="small muted row"><ExternalLink size={13} />每次生成都会先确认；费用由对应模型平台计收。</p>
  </div>;
}