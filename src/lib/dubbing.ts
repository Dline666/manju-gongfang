export async function joinSpeech(parts: Blob[]) {
  const context = new AudioContext();
  try {
    const buffers = await Promise.all(parts.map(async part => context.decodeAudioData(await part.arrayBuffer())));
    const sampleRate = 32000;
    const duration = buffers.reduce((sum, buffer) => sum + buffer.duration, 0) + Math.max(0, buffers.length - 1) * .18;
    const offline = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
    let offset = 0;
    for (const buffer of buffers) { const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start(offset); offset += buffer.duration + .18; }
    const result = await offline.startRendering(); const samples = result.getChannelData(0);
    const data = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(data);
    const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true); }
    return { blob: new Blob([data], { type: 'audio/wav' }), duration };
  } finally { await context.close(); }
}
