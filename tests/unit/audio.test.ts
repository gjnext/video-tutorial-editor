import { describe, expect, it } from 'vitest';
import { activeAudioAt, audioPlacements, clipEnd, createAudioClip, gainAt, resolveAudioMove, splitAudioClip, trimAudioClip } from '../../shared/audio';
import { assetMap } from '../../shared/compose';
import { audioOverhang } from '../../shared/timeline';
import { secondsToFlicks as S, flicksToSample } from '../../shared/time';
import { audioAsset, projectWithVideo } from './helpers';

describe('audio editing (Test 4)', () => {
  const asset = audioAsset('aud', 18);

  it('trim, split, move keep exact boundaries', () => {
    let clips = [createAudioClip(asset, 'narration', S(1))];
    const id = clips[0].id;
    clips = trimAudioClip(clips, id, 'start', S(2), asset); // drop the first second of audio
    expect(clips[0]).toMatchObject({ start: S(2), sourceIn: S(1), sourceOut: S(18) });
    clips = trimAudioClip(clips, id, 'end', S(15), asset);
    expect(clips[0]).toMatchObject({ sourceOut: S(14) });
    expect(clipEnd(clips[0])).toBe(S(15));

    const split = splitAudioClip(clips, id, S(6));
    clips = split.clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ start: S(2), sourceIn: S(1), sourceOut: S(5) });
    expect(clips[1]).toMatchObject({ start: S(6), sourceIn: S(5), sourceOut: S(14) });

    // Move the right part later to add silence between narration segments.
    const want = resolveAudioMove(clips, split.rightId!, S(8), 'narration');
    expect(want).toBe(S(8));
    clips = clips.map((c) => (c.id === split.rightId ? { ...c, start: want } : c));
    // At project 9 s we hear source 6 s of the file.
    const active = activeAudioAt({ ...projectWithVideo(20), audio: clips }, S(9));
    expect(active).toHaveLength(1);
    expect(active[0].sourceTime).toBe(S(6));
    // Silence in the gap.
    expect(activeAudioAt({ ...projectWithVideo(20), audio: clips }, S(7))).toHaveLength(0);
  });

  it('moves never overlap clips on the same track', () => {
    const a = { ...createAudioClip(asset, 'narration', 0), sourceOut: S(4) };
    const b = { ...createAudioClip(asset, 'narration', S(10)), sourceOut: S(4) };
    const clips = [a, b];
    expect(resolveAudioMove(clips, b.id, S(2), 'narration')).toBe(S(4)); // stops at a's end
    expect(resolveAudioMove(clips, b.id, S(1), 'narration')).toBe(S(4));
    expect(resolveAudioMove(clips, b.id, S(1), 'music')).toBe(S(1)); // other track is free
  });

  it('fade envelopes are linear and bounded', () => {
    const pl = { id: 'x', assetId: 'a', start: S(1), sourceIn: 0, sourceOut: S(4), gain: 0.8, fadeIn: S(1), fadeOut: S(2) };
    expect(gainAt(pl, S(0.5))).toBe(0);
    expect(gainAt(pl, S(1.5))).toBeCloseTo(0.4, 9);
    expect(gainAt(pl, S(2.5))).toBeCloseTo(0.8, 9);
    expect(gainAt(pl, S(4))).toBeCloseTo(0.4, 9);
    expect(gainAt(pl, S(5))).toBe(0);
  });

  it('placements are truncated at the project end and report overhang', () => {
    const p = projectWithVideo(13);
    p.media.push(asset);
    p.audio = [createAudioClip(asset, 'narration', 0)];
    expect(audioOverhang(p)).toBe(S(5));
    const pls = audioPlacements(p, S(13), assetMap(p.media));
    expect(pls[0].sourceOut).toBe(S(13));
  });

  it('sample positions are exact at 48 kHz', () => {
    expect(flicksToSample(S(2.5), 48000)).toBe(120000);
    expect(flicksToSample(S(1) / 48000 * 7, 48000)).toBe(7);
  });
});
