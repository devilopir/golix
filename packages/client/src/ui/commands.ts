import { LIMITS, parseStadium, Team, type RoomEvent, type TeamColors } from '@golix/shared';
import type { RoomSession } from '../session.ts';
import { AVATAR_MAX_LENGTH, type SettingsStore } from '../settings/settings.ts';
import { isDefaultStadium, stadiumChecksum, stadiumName, type StadiumStore } from './stadiums.ts';

export interface CommandContext {
  session: RoomSession;
  settings: SettingsStore;
  stadiums: StadiumStore;
  defaultColors: { readonly red: TeamColors; readonly blue: TeamColors };
  setHandicap(ms: number): void;
  /** Returns whether joiners now get a captcha, or null when this browser does not host the room. */
  setRecaptcha?(required: boolean): boolean | null;
  reply(text: string): void;
}

export const EXTRAPOLATION_MIN = -200;
export const EXTRAPOLATION_MAX = 1000;
export const HANDICAP_MAX = 1000;

const COLORS_MAX_ARGS = 3 + LIMITS.teamColors;
const COLORS_MIN_ARGS = 4;

function request(ctx: CommandContext, event: RoomEvent): void {
  ctx.session.send({ type: 'request', event });
}

function isHost(ctx: CommandContext): boolean {
  return ctx.session.getRoom().players.some((p) => p.id === ctx.session.playerId && p.admin);
}

function hex(text: string): number {
  return Number.parseInt(text, 16) || 0;
}

type Command = (args: string[], ctx: CommandContext) => void;

const COMMANDS: Readonly<Record<string, Command>> = {
  avatar([text], ctx) {
    if (text === undefined) return;
    const avatar = Array.from(text).slice(0, AVATAR_MAX_LENGTH).join('');
    ctx.settings.set('avatar', avatar);
    request(ctx, { type: 'setAvatar', playerId: ctx.session.playerId, avatar });
    ctx.reply('Avatar set');
  },
  clear_avatar(_args, ctx) {
    ctx.settings.set('avatar', '');
    request(ctx, { type: 'setAvatar', playerId: ctx.session.playerId, avatar: '' });
    ctx.reply('Avatar cleared');
  },
  checksum(_args, ctx) {
    const source = ctx.session.getRoom().stadiumSource;
    const name = stadiumName(source);
    ctx.reply(isDefaultStadium(source) ? `Current stadium is original: "${name}"` : `Stadium: "${name}" (checksum: ${stadiumChecksum(source)})`);
  },
  set_password([password], ctx) {
    if (password === undefined) return;
    if (!isHost(ctx)) return ctx.reply('Only the host can change the password');
    ctx.session.send({ type: 'setPassword', password });
    ctx.reply('Password set');
  },
  clear_password(_args, ctx) {
    if (!isHost(ctx)) return ctx.reply('Only the host can change the password');
    ctx.session.send({ type: 'setPassword', password: null });
    ctx.reply('Password cleared');
  },
  clear_bans(_args, ctx) {
    if (!isHost(ctx)) return;
    ctx.session.send({ type: 'clearBans' });
    ctx.reply('All bans have been cleared');
  },
  extrapolation([value], ctx) {
    const ms = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(ms)) return ctx.reply('Extrapolation requires a value in milliseconds.');
    if (ms < EXTRAPOLATION_MIN || ms > EXTRAPOLATION_MAX) {
      return ctx.reply(`Extrapolation must be a value between ${EXTRAPOLATION_MIN} and ${EXTRAPOLATION_MAX} milliseconds`);
    }
    ctx.settings.set('extrapolation', ms);
    ctx.reply(`Extrapolation set to ${ms} msec`);
  },
  handicap([value], ctx) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(parsed)) return ctx.reply('Ping handicap requires a value in milliseconds.');
    const ms = Math.min(Math.max(parsed, 0), HANDICAP_MAX);
    ctx.setHandicap(ms);
    ctx.reply(`Ping handicap set to ${ms} msec`);
  },
  kick_ratelimit(args, ctx) {
    const [min, rate, burst] = args.map((a) => Number.parseInt(a, 10));
    if (args.length < 3 || [min, rate, burst].some(Number.isNaN)) return ctx.reply('Usage: /kick_ratelimit <min> <rate> <burst>');
    request(ctx, { type: 'setKickRateLimit', limit: { min, rate, burst }, byPlayer: ctx.session.playerId });
  },
  recaptcha([mode], ctx) {
    if (mode !== 'on' && mode !== 'off') return ctx.reply('Usage: /recaptcha <on|off>');
    if (!isHost(ctx)) return;
    const captcha = ctx.setRecaptcha?.(mode === 'on') ?? null;
    if (captcha === null) return ctx.reply('Only the player hosting the room can change this');
    if (mode === 'off') ctx.reply('Room join Recaptcha disabled');
    else ctx.reply(captcha ? 'Room join Recaptcha enabled' : 'Room join Recaptcha is not available on this server, so joins are limited to one per address every 30 seconds');
  },
  store(_args, ctx) {
    const source = ctx.session.getRoom().stadiumSource;
    if (isDefaultStadium(source)) return ctx.reply("Can't store default stadium.");
    try {
      const stadium = parseStadium(source);
      if (!stadium.canBeStored) return ctx.reply("Couldn't store stadium");
      ctx.stadiums.add({ name: stadium.name, source });
    } catch {
      return ctx.reply("Couldn't store stadium");
    }
    ctx.reply('Stadium stored');
  },
  colors(args, ctx) {
    if (args.length < 2) return ctx.reply('Not enough arguments');
    const [key] = args;
    if (key !== 'red' && key !== 'blue') return ctx.reply('First argument must be either "red" or "blue"');
    const team = key === 'red' ? Team.red : Team.blue;
    const byPlayer = ctx.session.playerId;
    if (args[1] === 'clear') return request(ctx, { type: 'setTeamColors', team, colors: ctx.defaultColors[key], byPlayer });
    if (args.length < COLORS_MIN_ARGS) return ctx.reply('Not enough arguments');
    if (args.length > COLORS_MAX_ARGS) return ctx.reply('Too many arguments');
    const [, angle, textColor, ...stripes] = args;
    const colors: TeamColors = { angle: Number.parseInt(angle, 10) || 0, textColor: hex(textColor), colors: stripes.map(hex) };
    request(ctx, { type: 'setTeamColors', team, colors, byPlayer });
  },
};

/** Runs a chat line that starts with "/". */
export function runCommand(line: string, ctx: CommandContext): void {
  const [name = '', ...args] = line.slice(1).split(/\s+/).filter((part) => part !== '');
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) return ctx.reply(`Unrecognized command: "${name}"`);
  command(args, ctx);
}
