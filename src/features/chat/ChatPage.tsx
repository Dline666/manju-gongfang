import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, FileJson, MessageSquarePlus, MessagesSquare, Send, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SkillId } from '../../domain/types';
import { useStudio } from '../../store/studio';
import { appendMessage, createSession, deleteSession, ensureSession, openSession, setSessionSkill, useChat, type ChatMessage, type ChatSession } from '../../store/chat';
import { chatSkillBlock, chatSkills } from '../../lib/skills';
import { ApiError, callApi, credentials, errorMessage } from '../../lib/api';
import { Button, Empty, ErrorNote, copyText } from '../../components/Ui';
import { finishJob, startJob, updateJob } from '../../store/jobs';
import { modelFor } from '../../lib/endpoints';
import { parseStoryboardJsonText, previewImport, validateStoryboardJson } from '../../lib/storyboardJson';
import StoryboardImportDialog from '../episode/StoryboardImportDialog';
import SaveToSeriesDialog from './SaveToSeriesDialog';

/** 三个快捷入口与 Skill 下拉是同一件事：选技能 = 用这个 Skill 发下一条。 */
const quickActions: { id: SkillId; label: string; hint: string }[] = [
  { id: 'novel', label: '生成小说', hint: '按集写 1500–2500 字，60–90 秒成片' },
  { id: 'novel-to-screenplay', label: '小说生剧本', hint: '只压缩，不新增人物与场景' },
  { id: 'screenplay-to-storyboard-json', label: '剧本生分镜 JSON', hint: '纯 JSON，导入后成为本集分镜' },
];

/**
 * 一条助手消息能做什么，取决于它看起来是什么。
 * 分镜 JSON 的识别是「严格的」：必须是纯 JSON 且能过校验，否则不给「导入」按钮——
 * 给了按钮又点不动，比不给更糟。
 */
type ReplyKind = 'json' | 'text' | 'invalid-json';

function classifyReply(message: ChatMessage): ReplyKind {
  if (message.role !== 'assistant' || message.error) return 'text';
  if (message.skill === 'screenplay-to-storyboard-json') {
    const parsed = parseStoryboardJsonText(message.text);
    return parsed.ok ? 'json' : 'invalid-json';
  }
  // 用户没选 Skill、但模型回了 JSON，也允许直接导入（聊天室本来就是自由对话）。
  const trimmed = message.text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseStoryboardJsonText(trimmed).ok ? 'json' : 'text';
  }
  return 'text';
}

export default function ChatPage({ navigate }: { navigate: (route: string) => void }) {
  const chat = useChat();
  const studio = useStudio();
  const session = chat.sessions.find(item => item.id === chat.activeId) ?? ensureSession();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint?: string }>();
  const [importing, setImporting] = useState<{ text: string; sessionId: string }>();
  const [saving, setSaving] = useState<ChatMessage>();
  const controller = useRef<AbortController | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);

  const skill = session.skill;
  const activeSkill = chatSkills.find(item => item.id === skill);
  const series = studio.series;

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [session.messages.length, busy]);
  useEffect(() => () => controller.current?.abort(), []);

  const overrides = studio.settings.promptTemplates?.builtinSkills;
  const disabled = studio.settings.promptTemplates?.disabledBuiltinSkills;

  /** 发送：把选中的 Skill 全文当锁定块拼在最前面，再拼会话里最近几轮上下文。 */
  async function send(text: string) {
    const body = text.trim();
    if (!body || busy) return;
    setFailure(undefined);
    const target = session;
    appendMessage(target.id, { role: 'user', text: body, ...(skill ? { skill } : {}) });
    setDraft('');
    // 发失败就把原文放回输入框：这段可能是几百字的设定，丢了要重写一遍。
    const restore = () => setDraft(current => current.trim() ? current : body);
    // 上下文只取最近 6 条，避免长会话把提示词撑爆；本轮用户消息已经在 messages 里，跳过最后一条。
    const history = target.messages.slice(-6).map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.text.slice(0, 4000)}`).join('\n\n');
    const block = chatSkillBlock(skill, overrides, disabled);
    const prompt = [block, history, `用户：${body}`].filter(part => part.trim()).join('\n\n---\n\n');

    const provider = studio.settings.scriptProvider;
    if (!studio.keys[provider]) {
      setFailure({ message: '还没有可用的剧本端点。', hint: '请先到设置页填写剧本服务的 API Key（Gemini 首选 / DeepSeek 备选）。' });
      appendMessage(target.id, { role: 'assistant', text: '这次没有发出去：还没有填写剧本服务的 API Key。请先到设置页配置，再回来发送。', error: true });
      restore();
      return;
    }
    setBusy(true);
    const jobId = startJob({ kind: 'script', label: activeSkill ? `${activeSkill.name} · 生成中` : '聊天生成中' });
    const control = new AbortController();
    controller.current = control;
    try {
      const auth = credentials(provider, 'script');
      if (jobId) updateJob(jobId, { detail: `模型 ${modelFor(studio.settings, provider, 'script')} 正在生成` });
      const data = await callApi<{ text: string }>('chat', { ...auth, prompt }, control.signal);
      const reply = (data.text ?? '').trim();
      if (!reply) throw new ApiError('invalid_chat');
      appendMessage(target.id, { role: 'assistant', text: reply, ...(skill ? { skill } : {}) });
      finishJob(jobId, 'done');
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : new ApiError('internal_error', 0, undefined, errorMessage(caught));
      const message = errorMessage(error);
      setFailure({ message, hint: error.hint });
      appendMessage(target.id, { role: 'assistant', text: `这次生成没有完成：${message}`, error: true, ...(skill ? { skill } : {}) });
      restore();
      finishJob(jobId, control.signal.aborted ? 'canceled' : 'failed', error.code);
    } finally {
      if (controller.current === control) controller.current = undefined;
      setBusy(false);
    }
  }

  const sessions = chat.sessions;
  return <div className="stack chat-page">
    <header className="page-heading chat-head">
      <div className="page-heading-title">
        <h1>聊天室<span className="accent">。</span></h1>
        <p className="muted">写小说 → 生剧本 → 生分镜 JSON，再把 JSON 导入某一集。</p>
      </div>
    </header>

    <section className="chat-shell">
      <aside className="chat-rail" aria-label="最近会话">
        <div className="chat-rail-head">
          <h2>最近会话</h2>
          <button className="icon-button" aria-label="新建会话" onClick={() => { createSession(); setFailure(undefined); }}><MessageSquarePlus size={16} /></button>
        </div>
        {sessions.length === 0
          ? <p className="small muted chat-rail-empty">还没有会话。直接在下面对话框开始，第一条消息会成为会话标题。</p>
          : <ul className="chat-rail-list">{sessions.map(item => <li key={item.id}>
            <button className={`chat-rail-item ${item.id === session.id ? 'is-active' : ''}`} onClick={() => { openSession(item.id); setFailure(undefined); }}>
              <span className="chat-rail-title">{item.title}</span>
              <span className="chat-rail-meta">{item.messages.length} 条 · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
            </button>
            <button className="icon-button chat-rail-delete" aria-label={`删除会话 ${item.title}`} onClick={() => deleteSession(item.id)}><Trash2 size={14} /></button>
          </li>)}</ul>}
      </aside>

      <div className="chat-main">
        <div className="chat-scroller" role="log" aria-live="polite">
          {session.messages.length === 0
            ? <div className="chat-welcome">
              <span className="chat-mark"><MessagesSquare size={26} strokeWidth={1.4} /></span>
              <h2>从一个念头开始</h2>
              <p className="muted">选一个 Skill，或什么都不选直接聊。分镜 JSON 是唯一能导进某一集的格式。</p>
              <div className="chat-quick">
                {quickActions.map(action => <button key={action.id} className="chat-quick-item" onClick={() => { setSessionSkill(session.id, action.id); setDraft(''); }}>
                  <strong>{action.label}</strong>
                  <span className="muted">{action.hint}</span>
                </button>)}
              </div>
            </div>
            : session.messages.map(message => <MessageBubble key={message.id} message={message}
                onCopy={() => void copyText(message.text)}
                onSave={message.role === 'assistant' && !message.error ? () => setSaving(message) : undefined}
                onImport={classifyReply(message) === 'json' ? () => setImporting({ text: message.text, sessionId: session.id }) : undefined}
                invalidJson={classifyReply(message) === 'invalid-json'} />)}
          {busy && <div className="chat-thinking" role="status"><span className="animate-pulse">模型正在写…</span><small className="muted">{activeSkill ? `Skill：${activeSkill.name}` : '自由对话'}</small></div>}
          <div ref={bottom} />
        </div>

        {failure && <div className="chat-failure"><ErrorNote message={failure.message} hint={failure.hint} /></div>}

        <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(draft); }}>
          <div className="chat-composer-top">
            <label className="chat-skill">
              <span className="small muted">Skill</span>
              <select value={skill ?? ''} disabled={busy} onChange={event => setSessionSkill(session.id, (event.target.value || undefined) as SkillId | undefined)}>
                <option value="">不选 · 自由对话</option>
                {chatSkills.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {activeSkill && <span className="tag">已选 · {activeSkill.name}</span>}
            <span className="small muted chat-composer-hint">{activeSkill ? activeSkill.description : '不套任何 Skill，模型按你的话直接回答'}</span>
          </div>
          <textarea className="chat-input" value={draft} disabled={busy} maxLength={8000}
            aria-label="聊天输入"
            placeholder={skill === 'novel' ? '一句话设定，或「继续」接着写……' : skill === 'novel-to-screenplay' ? '粘贴本集小说全文……' : skill === 'screenplay-to-storyboard-json' ? '粘贴本集剧本全文……' : '想写什么故事？'}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(draft); } }} />
          <div className="chat-composer-bottom">
            <span className="small muted">Ctrl / ⌘ + Enter 发送</span>
            <div className="row tight">
              {busy && <Button variant="outline" size="sm" onClick={() => { controller.current?.abort(); }}>停止等待</Button>}
              <Button type="submit" disabled={busy || !draft.trim()}><Send size={15} /> 发送</Button>
            </div>
          </div>
        </form>
      </div>
    </section>

    {importing && <StoryboardImportDialog
      open
      rawText={importing.text}
      onClose={() => setImporting(undefined)}
      onImported={(seriesId, episodeId) => { setImporting(undefined); navigate(`library/${seriesId}/${episodeId}`); }} />}
    {saving && <SaveToSeriesDialog open message={saving} sessionId={session.id} series={series} onClose={() => setSaving(undefined)} onSaved={() => setSaving(undefined)} />}
  </div>;
}

function MessageBubble({ message, onCopy, onSave, onImport, invalidJson }: {
  message: ChatMessage;
  onCopy: () => void;
  onSave?: () => void;
  onImport?: () => void;
  invalidJson?: boolean;
}) {
  const isUser = message.role === 'user';
  const skill = chatSkills.find(item => item.id === message.skill);
  const json = useMemo(() => {
    if (!onImport && !invalidJson) return undefined;
    const parsed = parseStoryboardJsonText(message.text);
    if (!parsed.ok) return undefined;
    const outcome = validateStoryboardJson(parsed.value);
    return outcome.ok ? previewImport(outcome.result) : undefined;
  }, [message.text, onImport, invalidJson]);

  return <article className={`chat-msg ${isUser ? 'is-user' : 'is-assistant'} ${message.error ? 'is-error' : ''}`}>
    <div className="chat-msg-meta">
      <span>{isUser ? '我' : '模型'}</span>
      {skill && <span className="tag subtle">{skill.name}</span>}
      <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <div className="chat-msg-body">
      {onImport && json
        ? <div className="chat-json-summary">
          <div className="row between wrap"><strong>这是一份可导入的分镜 JSON</strong><span className="tag success"><Check size={12} /> 校验通过</span></div>
          <p className="small muted">{json.assetsByKind.character} 人物 · {json.assetsByKind.scene} 场景 · {json.assetsByKind.prop} 道具 · {json.shots.length} 镜 · 共 {json.totalDuration} 秒</p>
          {json.filledAssets.length > 0 && <p className="small muted">补齐项：{json.filledAssets.join('、')}（顶层登记里没有，导入时会自动补出来）</p>}
          <pre className="chat-json-raw">{message.text.length > 1200 ? `${message.text.slice(0, 1200)}…` : message.text}</pre>
        </div>
        : <div className="chat-msg-text">{message.text}</div>}
      {invalidJson && <p className="small muted chat-json-warn">这段内容被标记为分镜 JSON，但不是合格的纯 JSON 或未通过校验，所以没有给「导入」按钮。可以让模型重新输出，或复制出来手工修。</p>}
    </div>
    <div className="chat-msg-actions">
      <button className="chat-action" onClick={onCopy}><Copy size={13} /> 复制全文</button>
      {onSave && <button className="chat-action" onClick={onSave}><ArrowUpRight size={13} /> 保存到系列</button>}
      {onImport && <button className="chat-action chat-action-primary" onClick={onImport}><FileJson size={13} /> 导入到当前剧集</button>}
    </div>
  </article>;
}

export { Wand2 };