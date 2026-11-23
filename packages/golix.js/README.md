# golix.js

Host [Golix](https://golix.cosmosfutsal.com) rooms from Node and join rooms as a player. Needs Node 22 or later.

```sh
npm install golix.js
```

The full guide is at https://golix.cosmosfutsal.com/docs/.

## Hosting a room

```js
const golix = require('golix.js');

golix().then((HBInit) => {
  const room = HBInit({
    roomName: 'My room',
    maxPlayers: 12,
    noPlayer: true,
    lobby: 'wss://golix.cosmosfutsal.com',
    // 22 characters of A-Z, a-z, 0-9, - and _; keeps the room link across restarts.
    roomSecret: process.env.ROOM_SECRET,
    // Only the first time this roomSecret opens a room: from https://golix.cosmosfutsal.com/headlesstoken
    token: process.env.ROOM_TOKEN,
  });
  room.onRoomLink = (link) => console.log(link);
  room.onPlayerJoin = (player) => room.sendAnnouncement(`Welcome ${player.name}`, player.id);
});
```

With ES modules: `import golix from 'golix.js'; const HBInit = await golix();`.

Players connect to the process over WebRTC, or through the lobby when a direct connection fails. `webrtc: { bindAddress, portRange: [first, last], iceServers }` sets the local address, the UDP ports and the STUN/TURN servers for those connections.

Besides the original events, a room has `onLobbyDisconnect(retryInMs)` and `onLobbyReconnect()`.

### Action keys

`room.setActionKeys(true)` lets players send six extra keys (Q, E, R, F, C and V by default). Each press and release arrives as `room.onPlayerAction(player, actionId, isPressed)` with `actionId` 1 to 6. The keys do nothing by themselves, and in rooms that never turn them on players do not send them.

### Kits

`setTeamColors` takes up to five stripe colors. `room.setPlayerColors(playerId, angle, textColor, colors)` dresses one player in their own kit instead of the team's; `room.clearPlayerColors(playerId)` takes it off.

### Raids and floods

Rooms ask joiners for a captcha on their own for 5 minutes when 6 players with new keys join within 10 seconds; `room.setRaidProtection({ joins, seconds, minutes })` tunes that and `null` turns it off. `room.setMaxPlayersPerConn(n)` caps the players one address may have in the room.

### Modding

`room.setPlayerPhysics(id, { kickStrength, acceleration, radius, ... })` changes one player's physics until cleared with `null`. `room.setHudItem(id, { text, x, y, align, color, size })` pins text on every player's screen and `room.clearHudItem(id)` removes it. `room.setCamera({ playerId } | { discIndex } | { x, y } | null, zoom)` drives everyone's camera. `onCollisionDiscVsDisc`, `onCollisionDiscVsPlane`, `onCollisionDiscVsSegment` and `onCollisionDiscVsVertex` report bounces.

## Joining a room as a player

```js
const { session, auth, key } = await golix.joinRoom({ room: 'https://golix.cosmosfutsal.com/play?c=<id>', name: 'bot' });
session.send({ type: 'chat', text: 'hi' });
session.onEvent((event) => console.log(event));
```

Store `key` and pass it back as `key` to join again with the same `auth`.

## Replays

`decodeReplay`, `encodeReplay` and `trimReplay(replay, fromFrame, toFrame)` read, write and cut `.glx` replays; the game runs at 60 frames per second.

## Identity

`player.auth` is an 87-character base64url P-256 public key that stays with the player's browser, and `player.conn` the hex of their network address; both are only set in `onPlayerJoin`. Bans match either.
