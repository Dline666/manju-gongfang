import { useSyncExternalStore } from 'react';
import { uid, type SkillId } from '../domain/types';

/**
 * 聊天室会话。
 *
 * 只存文本：视频仍然只存链接与文件名，刷新后需要重新导入（旧规则不变）。
 * 会话与「系列」解耦——聊天室里可以自由对话、可以对着某集写，但不强制绑定。
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 正文。助手回复可能是小说、剧本或分镜 JSON。 */
  text: string;
  createdAt: string;
  /** 这条回复是用哪个 Skill 产出的；空表示自由对话。 */
  skill?: SkillId;
  /** 失败标记：失败的消息也要留在会话里，用户才知道刚才发生了什么。 */
  error?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** 本会话当前选中的 Skill；空表示「不选」。下拉选择跟随会话保存。 */
  skill?: SkillId;
  /** 保存到系列时记下的落点，方便再次保存时默认选它。 */
  seriesId?: string;
  episodeId?: string;
}

const STORAGE_KEY = 'manju-chat-v1';
/** 会话数量上限：聊天记录是文本，但也不能无限增长。 */
const SESSION_LIMIT = 50;
/** 单条消息上限（字符）：分镜 JSON 会长，小说也长，给足但仍设上限。 */
export const MESSAGE_LIMIT = 60_000;

interface ChatState {
  sessions: ChatSession[];
  activeId: string | null;
  storageError: string | null;
}

function load(): ChatState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [], activeId: null, storageError: null };
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    if (!Array.isArray(parsed.sessions)) return { sessions: [], activeId: null, storageError: null };
    const sessions = parsed.sessions.filter(session => session && typeof session.id === 'string' && Array.isArray(session.messages));
    const activeId = sessions.some(session => session.id === parsed.activeId) ? parsed.activeId ?? null : null;
    return { sessions, activeId, storageError: null };
  } catch {
    // 会话是附带内容，坏掉不该让整个工作台停摆：重置会话，但明确告知。
    return { sessions: [], activeId: null, storageError: '聊天记录无法读取，已重置为空白会话；作品数据不受影响。' };
  }
}

let state: ChatState = load();
const listeners = new Set<() => void>();
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: state.sessions, activeId: state.activeId }));
    if (state.storageError?.startsWith('聊天记录无法读取')) state = { ...state, storageError: null };
  } catch {
    state = { ...state, storageError: '本地空间不足或浏览器禁止存储，聊天记录尚未保存。' };
  }
}
function emit() {
  persist();
  listeners.forEach(listener => listener());
}

export function getChat() { return state; }
export function useChat() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getChat);
}

export function createSession(title = '新对话'): ChatSession {
  const date = new Date().toISOString();
  const session: ChatSession = { id: uid(), title, createdAt: date, updatedAt: date, messages: [] };
  state = { ...state, sessions: [session, ...state.sessions].slice(0, SESSION_LIMIT), activeId: session.id };
  emit();
  return session;
}

export function openSession(id: string) {
  if (!state.sessions.some(session => session.id === id)) return;
  state = { ...state, activeId: id };
  emit();
}

export function deleteSession(id: string) {
  const sessions = state.sessions.filter(session => session.id !== id);
  state = { ...state, sessions, activeId: state.activeId === id ? null : state.activeId };
  emit();
}

export function renameSession(id: string, title: string) {
  const value = title.trim().slice(0, 60);
  state = { ...state, sessions: state.sessions.map(session => session.id === id ? { ...session, title: value || session.title } : session) };
  emit();
}

/** 当前会话；没有就顺手建一个，聊天室一打开就能直接输入。 */
export function ensureSession(): ChatSession {
  const current = state.sessions.find(session => session.id === state.activeId);
  if (current) return current;
  return createSession();
}

export function setSessionSkill(id: string, skill: SkillId | undefined) {
  state = { ...state, sessions: state.sessions.map(session => session.id === id ? { ...session, skill, updatedAt: new Date().toISOString() } : session) };
  emit();
}

export function setSessionTarget(id: string, seriesId: string | undefined, episodeId: string | undefined) {
  state = { ...state, sessions: state.sessions.map(session => session.id === id ? { ...session, seriesId, episodeId, updatedAt: new Date().toISOString() } : session) };
  emit();
}

export function appendMessage(id: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
  const full: ChatMessage = { ...message, id: uid(), createdAt: new Date().toISOString(), text: message.text.slice(0, MESSAGE_LIMIT) };
  state = {
    ...state,
    sessions: state.sessions.map(session => {
      if (session.id !== id) return session;
      const messages = [...session.messages, full];
      // 第一条用户消息自动成为会话标题，省掉一次重命名。
      const title = session.messages.length === 0 && message.role === 'user'
        ? message.text.trim().replace(/\s+/g, ' ').slice(0, 24) || session.title
        : session.title;
      return { ...session, messages, title, updatedAt: full.createdAt };
    }),
  };
  emit();
  return full;
}

/**
 * 流式过程中的半截正文：只活在内存里，不写 localStorage。
 * 逐字落盘会每一帧序列化整份会话，而且在生成中途刷新会留下半句话。
 */
let draft: { sessionId: string; messageId: string; text: string } | null = null;
const draftListeners = new Set<() => void>();
export function getDraft() { return draft; }
export function subscribeDraft(listener: () => void) {
  draftListeners.add(listener);
  return () => { draftListeners.delete(listener); };
}
export function useDraft() {
  return useSyncExternalStore(subscribeDraft, getDraft, getDraft);
}
export function setDraft(sessionId: string, messageId: string, text: string) {
  draft = { sessionId, messageId, text };
  draftListeners.forEach(listener => listener());
}
export function clearDraft() {
  if (!draft) return;
  draft = null;
  draftListeners.forEach(listener => listener());
}
/** 流结束：把最终正文一次性写进会话并清掉草稿。 */
export function commitDraft(sessionId: string, messageId: string, text: string, error = false) {
  draft = null;
  draftListeners.forEach(listener => listener());
  updateMessage(sessionId, messageId, error ? { text, error: true } : { text });
}

/** 撤掉占位消息：生成彻底失败且一个字都没流出来时用，避免留下空气泡。 */
export function removeMessage(sessionId: string, messageId: string) {
  state = {
    ...state,
    sessions: state.sessions.map(session => session.id === sessionId
      ? { ...session, messages: session.messages.filter(message => message.id !== messageId) }
      : session),
  };
  emit();
}

/** 流式/追加更新最后一条助手消息（本次实现是一次性写入，保留这个口子便于以后接流式）。 */
export function updateMessage(sessionId: string, messageId: string, patch: Partial<Pick<ChatMessage, 'text' | 'error'>>) {
  state = {
    ...state,
    sessions: state.sessions.map(session => session.id === sessionId
      ? { ...session, messages: session.messages.map(message => message.id === messageId ? { ...message, ...patch, ...(patch.text !== undefined ? { text: patch.text.slice(0, MESSAGE_LIMIT) } : {}) } : message) }
      : session),
  };
  emit();
}

/** 把一条助手消息的正文推进某个系列/集的落点（小说或剧本）。 */
export function markSavedTo(sessionId: string, seriesId: string, episodeId: string) {
  setSessionTarget(sessionId, seriesId, episodeId);
}

/** 仅供测试：清空会话状态。 */
export function resetChat() {
  state = { sessions: [], activeId: null, storageError: null };
  emit();
}