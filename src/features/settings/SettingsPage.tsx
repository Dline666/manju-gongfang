import { KeyRound, ShieldCheck, Trash2, ExternalLink } from 'lucide-react';
import { clearKeys, useStudio } from '../../store/studio';
import { Button } from '../../components/Ui';
import { toast } from 'sonner';
import ProviderGroups from './ProviderGroups';
export default function SettingsPage() {
  const state = useStudio();
  return <div className="stack"><div className="page-heading"><div><div className="eyebrow">MAKE IT YOURS</div><h1>连接你的创作能力</h1><p className="muted">填入你自己的 API Key，按需连接模型。不填也可以编辑、演练与手动制作。</p></div><KeyRound className="muted" size={32}/></div><div className="notice"><ShieldCheck size={22}/><div><strong>密钥不写进作品，也不保存到磁盘</strong><p>Key 仅保留在当前页面内存，刷新后需要重新填写。生成时通过 HTTPS 交给本站云函数转发至对应官方接口，不共享平台额度。</p></div></div>
    <ProviderGroups state={state} />
    <div className="panel row between wrap"><div><h3>只保存必要的创作数据</h3><p className="muted small">文字与进度保存在浏览器；图片和配音存在本机，视频仅保存链接与文件名。</p></div><Button variant="secondary" onClick={()=>{clearKeys();toast.success('所有 Key 已从当前页面清除');}}><Trash2 size={16}/>清除全部 Key</Button></div><p className="small muted row"><ExternalLink size={13}/>每次生成都会先确认任务；产生的费用由对应模型平台计收。</p>
  </div>;
}
