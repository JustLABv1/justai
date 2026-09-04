# Live transcription ingress

JustAI now accepts three kinds of live audio:

1. Browser microphone or browser tab/system audio.
2. A server-side network media source.
3. Audio forwarded by a meeting-bot adapter or desktop companion.

All three sources become ordinary `transcription_sources`. They use the same
PCM framing, provider transport, transcript events, source recordings, and
rolling diarization pipeline.

## Browser tab or system audio

When creating a live session, select **Browser tab or system audio** as the
host audio source. The browser opens its native screen-share picker. Select a
tab, window, or screen and enable **Share audio**. The video track is used only
to keep the browser capture alive; JustAI sends the selected audio track to the
transcription WebSocket. You can also select **External stream or meeting bot**
to create the room without requesting browser permissions, then add one of the
server-side sources below.

This is the supported way to transcribe a YouTube or TV livestream from a
browser: open the authorized stream in a tab and share that tab's audio. A
browser cannot capture protected media or another application's audio unless
the operating system/browser exposes it through the picker.

## Direct network streams

The live-session UI accepts an authorized `http`, `https`, `rtmp`, or `rtmps`
media URL. HLS playlist URLs (`.m3u8`) and direct audio feeds are the common
cases. A YouTube watch-page URL is not itself a media stream URL and is
intentionally rejected; use browser tab capture or an authorized HLS/RTMP
source.

The backend:

- encrypts the URL at rest;
- validates the scheme and destination before passing it to FFmpeg;
- converts the first audio track to mono PCM16 at 16 kHz;
- reconnects the decoder and provider stream after transient failures;
- keeps source offsets and optional source recording continuity across retries.

Private or loopback media targets are rejected unless the operator explicitly
sets `JUSTAI_ALLOW_PRIVATE_TARGETS=true`. FFmpeg must be installed in the
backend image, which is already a readiness requirement.

The API endpoints are:

```text
POST /api/v1/transcription/sessions/:sessionId/stream-sources
POST /api/v1/transcription/stream-sources/:sourceId/stop
```

The create body is:

```json
{
  "name": "News channel",
  "url": "https://media.example.test/live/channel.m3u8"
}
```

## Meeting-bot ingress

`POST /api/v1/transcription/sessions/:sessionId/bot-sources` creates a
platform-labelled source and returns an ingest token once. The token is not a
JustAI user token and does not grant access to the workspace. It only exchanges
for a short-lived, one-use transcription WebSocket ticket for that source.

The adapter flow is:

```text
POST /api/v1/transcription/sessions/:sessionId/bot-sources
  -> save the returned token
POST /api/v1/transcription/bot-sources/:sourceId/tickets
  Authorization: Bearer <ingest-token>
  -> short-lived WebSocket ticket
GET /api/v1/ws/transcription?ticket=<ticket>
  -> audio ingress
```

The platform field accepts `generic`, `zoom`, `google-meet`, and
`microsoft-teams`. These labels select the adapter configuration and source
identity; they do not make the backend log in to a third-party meeting.
Actual Zoom/Google Meet/Teams joining still belongs in a separately deployed
adapter or desktop companion with the organization's platform credentials and
consent flow.

After the WebSocket opens, the adapter sends:

```json
{"type":"transcription.start","sessionId":"...","sourceId":"..."}
```

Each binary message is a little-endian frame:

```text
1 byte   protocol version (1)
8 bytes  capture timestamp in Unix milliseconds
4 bytes  monotonically increasing sequence number
4 bytes  source sample rate (8000..96000)
N bytes  mono signed PCM16 audio
```

The adapter can send `source.level`, `source.pause`, `source.resume`, `ping`,
and `transcription.stop` text messages. The server emits the same
`transcription.partial`, `transcription.final`, source, and error events
that browser captures receive.

Rotate a bot token with:

```text
POST /api/v1/transcription/bot-sources/:sourceId/rotate
```

Rotation immediately revokes the previous token. Stop a bot source with:

```text
POST /api/v1/transcription/bot-sources/:sourceId/stop
```

Stop the source or the whole session when the meeting ends.
