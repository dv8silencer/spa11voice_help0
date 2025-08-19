# ElevenLabs Web Voice Demo

Minimal single‑page web app (SPA) that streams your microphone audio to ElevenLabs Conversational AI over WebSocket and plays back the AI’s audio responses. The browser handles capture and playback; a tiny Node server provides a signed ElevenLabs WebSocket URL so your API key remains server‑side.

## Features

- Push‑to‑talk (hold to stream mic audio)
- Playback queue for smooth, uninterrupted AI responses
- Signed URL proxy (secrets never reach the browser)
- Configuration via `config.secrets.env` only (no process env usage)

## Requirements

- Node.js 18+
- ElevenLabs account with a Conversational AI agent (Agent ID + API key)

## Quick Start

1) Install dependencies

```bash
npm install
```

2) Configure secrets (copy the example and fill values)

```bash
cp config.secrets.env.example config.secrets.env
```

Edit `config.secrets.env`:

```
ELEVENLABS_API_KEY=your_xi_api_key
ELEVENLABS_AGENT_ID=your_agent_id
OUTPUT_SAMPLE_RATE=16000
AUDIO_CHUNK_SIZE_MS=100
AUDIO_BUFFER_MAX_SIZE=8000
AUDIO_MIN_CHUNK_SIZE=1600
ELEVENLABS_RESPONSE_TIMEOUT=200
PORT=3000
```

3) Start the server

```bash
npm start
```

4) Open the app

- Go to `http://localhost:3000`
- Click “Connect”, grant mic permissions
- Hold “Hold to Talk” while speaking; release to hear the AI

Tip: Works over HTTP on localhost. For remote use, prefer HTTPS (required by browsers for mic access).

## How It Works

- Server: `POST /api/get-signed-url` uses your API key to obtain a signed ElevenLabs WebSocket URL and returns it to the browser.
- Client: Connects to the signed URL; streams PCM16 mono frames as `user_audio_chunk` messages; buffers ElevenLabs `audio` chunks, then decodes and enqueues them for smooth playback.
- Silence frames are sent briefly when idle to keep VAD responsive (never while mic streaming or while AI audio is playing).

## Configuration

All configuration is read from `config.secrets.env`:

- `ELEVENLABS_API_KEY`: ElevenLabs API key (server‑only)
- `ELEVENLABS_AGENT_ID`: Conversational AI agent id
- `OUTPUT_SAMPLE_RATE`: Target (11Labs) interaction sample rate (default `16000`)
- `AUDIO_CHUNK_SIZE_MS`: Buffer window for outgoing mic frames (default `100`)
- `AUDIO_BUFFER_MAX_SIZE`: Max buffer size for a send (bytes)
- `AUDIO_MIN_CHUNK_SIZE`: Minimum chunk size to send (bytes)
- `ELEVENLABS_RESPONSE_TIMEOUT`: Wait after last chunk before flushing to playback (ms)
- `PORT`: HTTP port for the server (default `3000`)

Notes:

- Client tries MP3/WAV/OGG decode first; if that fails, treats ElevenLabs audio as PCM16 and resamples to your audio output.
- If responses sound clipped, try `ELEVENLABS_RESPONSE_TIMEOUT=300` (or 400).
- If logs show `audio_format: "pcm_24000"`, consider `OUTPUT_SAMPLE_RATE=24000` to minimize resampling.

## Endpoints

- `GET /` → SPA
- `GET /healthz` → `{ ok: true }`
- `GET /api/config` → Non‑secret client config
- `POST /api/get-signed-url` → Retrieves a signed ElevenLabs WS URL (server uses your API key)

## Project Structure

```
server.js                  # Express server (serves SPA, proxies signed URL)
public/index.html          # Simple UI
public/app.js              # WebAudio + WebSocket client
config.secrets.env         # Your local config (not committed)
config.secrets.env.example # Example config to copy
LICENSE                    # MIT license
README.md                  # This file
```

## Security

- Keep `config.secrets.env` private; do not share or deploy it publicly.
- The browser never sees your API key; it only receives a short‑lived signed WS URL.

## License

MIT — see `LICENSE`. THE SOFTWARE IS PROVIDED “AS IS,” WITHOUT WARRANTY OF ANY KIND.
