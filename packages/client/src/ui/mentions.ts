export interface MentionPlayer {
  id: number;
  name: string;
}

/** `@` completes to the player's name, `#` to the player's id (for headless room commands). */
export interface MentionFragment {
  sigil: '@' | '#';
  text: string;
}

/** Mentions can't contain spaces, so names are written with underscores after the @. */
export function mentionName(name: string): string {
  return name.replace(/ /g, '_');
}

/** The @ or # fragment being typed at the end of `text`, or null when the caret isn't in one. */
export function mentionFragment(text: string): MentionFragment | null {
  const match = /(?:^|\s)([@#])(\S*)$/.exec(text);
  return match === null ? null : { sigil: match[1] as MentionFragment['sigil'], text: match[2] };
}

export function mentionCandidates(fragment: string, players: readonly MentionPlayer[]): MentionPlayer[] {
  const prefix = fragment.toLowerCase();
  return players.filter((p) => mentionName(p.name).toLowerCase().startsWith(prefix));
}

/** Completes the trailing fragment with the `index`-th matching player and a space, or null when there is no such match. */
export function completeMention(text: string, players: readonly MentionPlayer[], index: number): string | null {
  const fragment = mentionFragment(text);
  if (fragment === null) return null;
  const choice = mentionCandidates(fragment.text, players)[index];
  if (choice === undefined) return null;
  const completion = fragment.sigil === '@' ? mentionName(choice.name) : String(choice.id);
  return `${text.slice(0, text.length - fragment.text.length)}${completion} `;
}

export function mentions(text: string, name: string): boolean {
  return text.toLowerCase().includes(`@${mentionName(name).toLowerCase()}`);
}
