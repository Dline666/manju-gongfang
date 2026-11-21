import { useEffect, useState } from 'react';
const videos = new Map<string, { blob: Blob; url: string }>();
const listeners = new Set<() => void>();
export const videoKey = (projectId: string, shotId: string) => `${projectId}:${shotId}`;
export function setVideo(projectId: string, shotId: string, blob: Blob) {
  const key = videoKey(projectId, shotId); const previous = videos.get(key);
  if (previous) URL.revokeObjectURL(previous.url);
  videos.set(key, { blob, url: URL.createObjectURL(blob) }); listeners.forEach(fn => fn());
}
export function releaseVideo(projectId: string, shotId: string) {
  const key = videoKey(projectId, shotId); const previous = videos.get(key);
  if (previous) { URL.revokeObjectURL(previous.url); videos.delete(key); listeners.forEach(fn => fn()); }
}
export const getVideo = (projectId: string, shotId: string) => videos.get(videoKey(projectId, shotId));
export function releaseVideos(projectId: string) { for (const [key, value] of videos) if (key.startsWith(projectId + ':')) { URL.revokeObjectURL(value.url); videos.delete(key); } listeners.forEach(fn => fn()); }
export function useVideo(projectId: string, shotId: string) { const [, update] = useState(0); useEffect(() => { const listener = () => update(n => n + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []); return getVideo(projectId, shotId); }
let dbPromise: Promise<IDBDatabase> | undefined;
function openDb() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('manju-media-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('media');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('无法访问本地素材存储。'));
  });
}
export async function putMedia(blob: Blob, id = crypto.randomUUID()) {
  if (blob.type.startsWith('video/')) throw new Error('视频仅可保存在当前会话。');
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('media', 'readwrite'); tx.objectStore('media').put(blob, id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('本地素材保存失败，请检查存储空间。')); tx.onabort = () => reject(new Error('素材保存被中断。')); });
  return id;
}
export async function getMedia(id: string): Promise<Blob | undefined> {
  const db = await openDb(); return new Promise((resolve, reject) => { const req = db.transaction('media').objectStore('media').get(id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('素材读取失败。')); });
}
export function useMediaUrl(id?: string) {
  const [url, setUrl] = useState<string>();
  useEffect(() => { let active = true; let objectUrl: string | undefined; setUrl(undefined); if (id) getMedia(id).then(blob => { if (active && blob) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => {}); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [id]);
  return url;
}
export async function mediaDuration(blob: Blob, kind: 'video' | 'audio' = 'video'): Promise<number> {
  const url = URL.createObjectURL(blob);
  try { return await new Promise((resolve, reject) => { const media = document.createElement(kind); const timer = window.setTimeout(() => finish(new Error('读取素材超时。')), 15000); function finish(error?: Error) { clearTimeout(timer); media.removeAttribute('src'); media.load(); if (error) reject(error); } media.onloadedmetadata = () => { const duration = media.duration; finish(); Number.isFinite(duration) && duration > 0 ? resolve(duration) : reject(new Error('素材时长无效。')); }; media.onerror = () => finish(new Error('浏览器无法读取此文件，请使用 MP4/H.264 视频或 WAV/MP3 音频。')); media.preload = 'metadata'; media.src = url; }); } finally { URL.revokeObjectURL(url); }
}
export async function blobDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); }); }
