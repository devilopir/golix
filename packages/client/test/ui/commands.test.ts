import { defaultStadiums, Team } from '@golix/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type SettingsStore } from '../../src/settings/settings.ts';
import { defaultTheme } from '../../src/theme/index.ts';
import { runCommand, type CommandContext } from '../../src/ui/commands.ts';
import { StadiumStore, stadiumChecksum } from '../../src/ui/stadiums.ts';
import { MemoryStorage } from '../settings/memoryStorage.ts';
import { FakeSession, player, room } from './fakes.ts';

const CUSTOM = `{ name: "Tiny", width: 100, height: 50 }`;
const UNSTORABLE = `{ name: "Locked", width: 100, height: 50, canBeStored: false }`;

describe('chat commands', () => {
  let session: FakeSession;
  let settings: SettingsStore;
  let stadiums: StadiumStore;
  let replies: string[];
  let setHandicap: ReturnType<typeof vi.fn<(ms: number) => void>>;
  let ctx: CommandContext;

  const run = (line: string) => {
    replies = [];
    runCommand(line, ctx);
    return replies;
  };

  beforeEach(() => {
    session = new FakeSession(room([player(1, 'dktest', { admin: true }), player(2, 'other')]));
    const storage = new MemoryStorage();
    settings = createSettingsStore(storage);
    stadiums = new StadiumStore(storage);
    setHandicap = vi.fn<(ms: number) => void>();
    ctx = { session, settings, stadiums, defaultColors: defaultTheme.teams, setHandicap, reply: (t) => replies.push(t) };
  });

  it('answers unknown commands, /help included', () => {
    expect(run('/help')).toEqual(['Unrecognized command: "help"']);
    expect(run('/toString')).toEqual(['Unrecognized command: "toString"']);
    expect(run('/')).toEqual(['Unrecognized command: ""']);
  });

  it('/avatar sets up to two characters and ignores a missing argument', () => {
    expect(run('/avatar')).toEqual([]);
    expect(session.sent).toEqual([]);
    expect(run('/avatar ABC')).toEqual(['Avatar set']);
    expect(settings.get('avatar')).toBe('AB');
    expect(session.requests()).toEqual([{ type: 'setAvatar', playerId: 1, avatar: 'AB' }]);
  });

  it('/clear_avatar clears it', () => {
    run('/avatar 9');
    expect(run('/clear_avatar')).toEqual(['Avatar cleared']);
    expect(settings.get('avatar')).toBe('');
    expect(session.requests().at(-1)).toEqual({ type: 'setAvatar', playerId: 1, avatar: '' });
  });

  it('/checksum names original and custom stadiums', () => {
    expect(run('/checksum')).toEqual([`Current stadium is original: "${defaultStadiums[0].name}"`]);
    session.state.stadiumSource = CUSTOM;
    expect(run('/checksum')).toEqual([`Stadium: "Tiny" (checksum: ${stadiumChecksum(CUSTOM)})`]);
    expect(stadiumChecksum(CUSTOM)).toMatch(/^[0-9A-F]{8}$/);
  });

  it('/set_password and /clear_password need the host', () => {
    expect(run('/set_password')).toEqual([]);
    expect(run('/set_password abc123')).toEqual(['Password set']);
    expect(run('/clear_password')).toEqual(['Password cleared']);
    expect(session.sent).toEqual([
      { type: 'setPassword', password: 'abc123' },
      { type: 'setPassword', password: null },
    ]);
    session.state.players[0].admin = false;
    expect(run('/set_password x')).toEqual(['Only the host can change the password']);
    expect(run('/clear_password')).toEqual(['Only the host can change the password']);
  });

  it('/clear_bans asks the server to clear the ban list', () => {
    expect(run('/clear_bans')).toEqual(['All bans have been cleared']);
    expect(session.sent).toEqual([{ type: 'clearBans' }]);
  });

  it('/clear_bans and /recaptcha do nothing for non-hosts', () => {
    session.state.players[0].admin = false;
    expect(run('/clear_bans')).toEqual([]);
    expect(run('/recaptcha on')).toEqual([]);
    expect(run('/recaptcha')).toEqual(['Usage: /recaptcha <on|off>']);
    expect(session.sent).toEqual([]);
  });

  it('/extrapolation validates the range and persists', () => {
    expect(run('/extrapolation')).toEqual(['Extrapolation requires a value in milliseconds.']);
    expect(run('/extrapolation 5000')).toEqual(['Extrapolation must be a value between -200 and 1000 milliseconds']);
    expect(run('/extrapolation -300')).toEqual(['Extrapolation must be a value between -200 and 1000 milliseconds']);
    expect(run('/extrapolation 100')).toEqual(['Extrapolation set to 100 msec']);
    expect(settings.get('extrapolation')).toBe(100);
  });

  it('/handicap sets the ping handicap', () => {
    expect(run('/handicap')).toEqual(['Ping handicap requires a value in milliseconds.']);
    expect(run('/handicap 100')).toEqual(['Ping handicap set to 100 msec']);
    expect(setHandicap).toHaveBeenCalledWith(100);
  });

  it('/handicap clamps out-of-range values to 0-1000 ms', () => {
    expect(run('/handicap -50')).toEqual(['Ping handicap set to 0 msec']);
    expect(run('/handicap 5000')).toEqual(['Ping handicap set to 1000 msec']);
    expect(setHandicap.mock.calls).toEqual([[0], [1000]]);
  });

  it('/kick_ratelimit requests the new limit', () => {
    expect(run('/kick_ratelimit')).toEqual(['Usage: /kick_ratelimit <min> <rate> <burst>']);
    expect(run('/kick_ratelimit 2 x 2')).toEqual(['Usage: /kick_ratelimit <min> <rate> <burst>']);
    expect(run('/kick_ratelimit 2 15 2')).toEqual([]);
    expect(session.requests()).toEqual([{ type: 'setKickRateLimit', limit: { min: 2, rate: 15, burst: 2 }, byPlayer: 1 }]);
  });

  it('/recaptcha turns the captcha on and off in a room this browser hosts', () => {
    expect(run('/recaptcha')).toEqual(['Usage: /recaptcha <on|off>']);
    expect(run('/recaptcha on')).toEqual(['Only the player hosting the room can change this']);
    const calls: boolean[] = [];
    let available = true;
    ctx.setRecaptcha = (required) => (calls.push(required), required && available);
    expect(run('/recaptcha on')).toEqual(['Room join Recaptcha enabled']);
    expect(run('/recaptcha off')).toEqual(['Room join Recaptcha disabled']);
    available = false;
    expect(run('/recaptcha on')).toEqual(['Room join Recaptcha is not available on this server, so joins are limited to one per address every 30 seconds']);
    expect(calls).toEqual([true, false, true]);
    expect(session.sent).toEqual([]);
  });

  it('/store keeps custom stadiums that allow it', () => {
    expect(run('/store')).toEqual(["Can't store default stadium."]);
    session.state.stadiumSource = UNSTORABLE;
    expect(run('/store')).toEqual(["Couldn't store stadium"]);
    session.state.stadiumSource = CUSTOM;
    expect(run('/store')).toEqual(['Stadium stored']);
    expect(stadiums.list()).toEqual([{ name: 'Tiny', source: CUSTOM }]);
  });

  it('/colors validates arguments and requests team colors', () => {
    expect(run('/colors')).toEqual(['Not enough arguments']);
    expect(run('/colors red')).toEqual(['Not enough arguments']);
    expect(run('/colors red 0 FFFFFF')).toEqual(['Not enough arguments']);
    expect(run('/colors green 0 FFFFFF FF0000')).toEqual(['First argument must be either "red" or "blue"']);
    expect(run('/colors red 0 FFFFFF FF0000 00FF00 0000FF 123456 654321 ABCDEF')).toEqual(['Too many arguments']);
    expect(session.sent).toEqual([]);
    expect(run('/colors blue 0 FFFFFF FF0000 00FF00 0000FF 123456 654321')).toEqual([]);
    expect(run('/colors red 60 FFFFFF FF0000 00FF00 0000FF')).toEqual([]);
    expect(run('/colors blue clear')).toEqual([]);
    expect(session.requests()).toEqual([
      { type: 'setTeamColors', team: Team.blue, colors: { angle: 0, textColor: 0xffffff, colors: [0xff0000, 0x00ff00, 0x0000ff, 0x123456, 0x654321] }, byPlayer: 1 },
      { type: 'setTeamColors', team: Team.red, colors: { angle: 60, textColor: 0xffffff, colors: [0xff0000, 0x00ff00, 0x0000ff] }, byPlayer: 1 },
      { type: 'setTeamColors', team: Team.blue, colors: defaultTheme.teams.blue, byPlayer: 1 },
    ]);
  });
});
