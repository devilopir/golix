# Golix

A 2D multiplayer football game that runs in the browser. Players host rooms from their own browser and others join over WebRTC; scripts can host rooms from Node.

Play at https://golix.cosmosfutsal.com. The guide for room scripts is at https://golix.cosmosfutsal.com/docs/.

## Packages

| Package | Contents |
|---|---|
| `packages/shared` | Deterministic physics, the `.hbs` stadium parser, game rules and the binary wire protocol |
| `packages/room` | `Room`, the authority that runs a room, in the browser or in Node |
| `packages/server` | Lobby and signaling server: room list, WebRTC offers and answers, relay when a direct connection fails |
| `packages/client` | The game client: Vite and Canvas 2D |
| `packages/headless` | `HBInit`, for hosting rooms from scripts |
| `packages/replay` | `.glx` replay recording and playback |
| `packages/golix.js` | The npm package for room scripts and bots |

The browser of the player who creates a room hosts it. Other players connect to it over a WebRTC data channel, and through the lobby when a direct connection cannot be made.

## Running locally

Needs Node 22 and pnpm.

```bash
pnpm install
pnpm --filter @golix/server start
pnpm --filter @golix/client dev
```

The client connects to the lobby at `ws://localhost:8787`; set `VITE_SERVER_URL` for another one.

The lobby reads these environment variables:

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Where it listens |
| `LOBBY_NOTICE` | A notice shown above the room list |
| `ROOM_REGISTER_LIMIT`, `ROOM_REGISTER_WINDOW_MS` | How many rooms one address may open per window (10 per 10 minutes by default) |
| `STUN_URLS`, `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS` | STUN and TURN servers handed to players, with the shared secret for TURN credentials |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Cloudflare Turnstile keys; with them rooms can ask joiners for a captcha, and opening a room needs a token |
| `TELEMETRY_FILE`, `LOBBY_KEY_FILE`, `BANS_FILE`, `KNOWN_ROOMS_FILE` | Files for connection reports, the key that signs captcha proofs, server-wide bans and rooms that may open without a token |

The lobby trusts `CF-Connecting-IP` and `CF-IPCountry` only from Cloudflare's addresses, so put it behind Cloudflare in production.

## Tests

```bash
pnpm test        # unit tests
pnpm typecheck
pnpm lint
pnpm e2e         # Playwright: two browsers playing a match, and the physics in Chromium, Firefox and WebKit
```

## Hosting a room from a script

```bash
LOBBY_URL=wss://lobby.example ROOM_NAME="My room" ADMIN_NAMES=nick1,nick2 \
  node --experimental-strip-types packages/headless/examples/admin-room.ts
```

Without installing anything, paste a room script into the site's `/headless/` page and press Run; the room runs in that tab. The npm package is built from `packages/golix.js` with `pnpm --filter golix.js build`.

## Deploying

`deploy/` has a Docker Compose setup for the lobby and the client behind a reverse proxy, and `deploy/headless/` one for a standalone scripted room.
