import type { Shot } from '../../domain/types';

/** PCM in MOV intermediates avoids adding AAC encoder padding at every shot boundary. */
export function shotCommand(shot: Shot, hasOriginalAudio: boolean): string[] {
  const duration = String(shot.duration);
  const inputs = ['-i', '/input/input-video'];
  let audioInput = '0:a:0';
  if (shot.audioMode === 'dubbing') {
    inputs.push('-i', '/input/input-audio');
    audioInput = '1:a:0';
  } else if (shot.audioMode === 'silent' || !hasOriginalAudio) {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    audioInput = '1:a:0';
  }
  const filter = [
    'setpts=PTS-STARTPTS',
    // Use display aspect ratio (including non-square source pixels), then square pixels.
    "scale=w='if(gt(dar,9/16),720,max(2,trunc(1280*dar/2)*2))':h='if(gt(dar,9/16),max(2,trunc(720/dar/2)*2),1280)':out_color_matrix=bt709:out_range=tv",
    'setsar=1', 'pad=720:1280:(ow-iw)/2:(oh-ih)/2:black', 'fps=24',
    `tpad=stop_mode=clone:stop_duration=${duration}`, `trim=duration=${duration}`, 'setpts=PTS-STARTPTS',
  ].join(',');
  return [...inputs, '-map', '0:v:0', '-map', audioInput,
    '-vf', filter, '-af', `aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}`,
    '-t', duration, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '24',
    '-threads', '1', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-video_track_timescale', '24000',
    '-map_metadata', '-1', '-sn', '-dn', 'segment.mov'];
}

export function concatList(durations: number[], extension = 'mov'): string {
  // Names are generated, never user-controlled. Explicit durations keep concat offsets exact.
  return durations.map((duration, index) => `file 'parts/part-${index}.${extension}'\nduration ${duration.toFixed(9)}\n`).join('');
}
