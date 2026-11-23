import type { Settings } from '../settings/settings.ts';

export type SoundName = 'kick' | 'goal' | 'chat' | 'mention' | 'join' | 'leave';

export type SoundCategory = 'game' | 'crowd' | 'chat' | 'highlight';

export interface SampleSound {
  file: string;
  category: SoundCategory;
  /** Seconds after the start at which the clip begins fading and is silent; the rest of the file is cut. */
  fadeOut?: { start: number; end: number };
}

/** Recorded clips served from public/sounds; a goal plays its own clip plus the crowd. */
export const SOUND_SAMPLES: Readonly<Record<SoundName, readonly SampleSound[]>> = {
  kick: [{ file: 'kick.wav', category: 'game' }],
  goal: [
    { file: 'goal.wav', category: 'game' },
    { file: 'crowd.ogg', category: 'crowd', fadeOut: { start: 1.5, end: 2.5 } },
  ],
  chat: [{ file: 'chat.wav', category: 'chat' }],
  mention: [{ file: 'highlight.wav', category: 'highlight' }],
  join: [{ file: 'join.wav', category: 'chat' }],
  leave: [{ file: 'leave.wav', category: 'chat' }],
};

type SoundSettings = Pick<Settings, 'soundEnabled' | 'chatSoundEnabled' | 'highlightSoundEnabled' | 'crowdSoundEnabled'>;

export function isCategoryEnabled(settings: SoundSettings, category: SoundCategory): boolean {
  if (!settings.soundEnabled) return false;
  switch (category) {
    case 'game':
      return true;
    case 'crowd':
      return settings.crowdSoundEnabled;
    case 'chat':
      return settings.chatSoundEnabled;
    case 'highlight':
      return settings.highlightSoundEnabled;
  }
}
