# Emby Guess Game — Build Spec

## Core concept

One continuous movie guessing game that loops forever. Anyone can join at any time by entering their name. No room codes, no host controls.

## Two connection types

- **Display (TV):** Shows the video clip, scores, 20s countdown timer, then reveals the movie title + who won for 10s, then auto-advances to the next round. No guessing ability.
- **Player (phone):** Streams the same video clip, has a text input to guess the movie name, shows whether they won or who did. One guess per round.

## Tech stack

- Cloudflare Worker (router + static assets + API)
- Durable Object (game state + WebSocket hub, SQLite-backed)
- R2 bucket (pre-staged HLS clip segments)
- hls.js from CDN for video playback

## Data flow

1. Worker proxies requests to Emby API (`EMBY_URL`, `EMBY_USER_ID`, `EMBY_API_KEY` secret)
2. Emby transcodes movies to HLS (master.m3u8 -> media playlist -> .ts segments)
3. Worker downloads segments, stores them in R2 under `clips/{roomCode}/{round}/`
4. Worker serves clips from R2 at `/clip/{roomCode}/{round}/{file}` with CORS + cache headers
5. Poster images are proxied through the Worker (`/poster/{itemId}`) and cached in R2 — never expose the Emby API key to the browser

## Critical implementation details

- Stage the **first clip synchronously** before broadcasting the round — otherwise clients get a 404 on the playlist URL (race condition)
- **Stagger clip staging** with 3s delays between clips to avoid crashing Emby (Emby is fragile under concurrent transcoding load)
- **Throttle Emby API requests** with 1.5s delays in debug/test endpoints
- The Durable Object generates a random 4-char room code on first init and persists it. The code is displayed on the TV but never entered by players — everyone connects to the same `/ws` endpoint
- Reconnection by player name — if someone disconnects and rejoins with the same name, they keep their score
- Auto-start the game when the first player joins (no lobby waiting)
- Auto-advance: 20s guessing window -> reveal -> 10s pause -> next round -> loop forever
- Fetch more movies from Emby when running low (auto-refill the round queue)
- Clip-serving regex must support room codes of any length (`[A-Z0-9]+`, not `{4}`)

## Pages

- `/` — Landing: enter name, pick "Play" or "Display on TV"
- `/display.html` — TV view: fetches room code from `/api/code`, shows it, connects WebSocket as role "display"
- `/player.html` — Phone view: streams clip, guess input, result feedback, connects as role "player"
- `/debug.html` — Diagnostic page that tests each stage: config -> Emby connectivity -> auth -> library -> HLS transcoding -> R2 bucket -> full pipeline (with detailed error output at each step)

## Environment variables

- `EMBY_URL` (var) — Emby server base URL
- `EMBY_USER_ID` (var) — Emby user ID to query library as
- `EMBY_API_KEY` (secret) — Emby API key, never exposed to browser
- `CLIP_QUEUE_DEPTH` (var, default "4") — how many rounds ahead to pre-stage
- `CLIP_DURATION_SECONDS` (var, default "3") — seconds of clip per round
