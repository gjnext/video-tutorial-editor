import { createEmptyProject, type CursorKeyframe, type MediaAsset, type Project } from '../../shared/schema';
import { secondsToFlicks as S } from '../../shared/time';

export function videoAsset(id = 'vid', seconds = 8, width = 1920, height = 1080): MediaAsset {
  return { id, kind: 'video', name: `${id}.mp4`, path: `/tmp/${id}.mp4`, duration: S(seconds), width, height, frameRate: 30, origin: 'recorded' };
}

export function audioAsset(id = 'aud', seconds = 18): MediaAsset {
  return { id, kind: 'audio', name: `${id}.mp3`, path: `/tmp/${id}.mp3`, duration: S(seconds), sampleRate: 44100, channels: 2, origin: 'imported' };
}

export function kf(id: string, sec: number, x: number, y: number, extra: Partial<CursorKeyframe> = {}): CursorKeyframe {
  return { id, time: S(sec), x, y, easing: 'smooth', moveDuration: null, curve: 0, ...extra };
}

export function projectWithVideo(seconds = 8, width = 1920, height = 1080): Project {
  const p = createEmptyProject('Test');
  const a = videoAsset('vid', seconds, width, height);
  p.media.push(a);
  p.video.segments.push({ id: 'seg1', kind: 'clip', assetId: a.id, sourceIn: 0, sourceOut: a.duration });
  return p;
}
