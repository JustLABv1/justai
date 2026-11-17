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
transcription stream over bounded HTTP audio uploads. You can also select **External stream or meeting bot**
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

To schedule unattended capture, include an RFC 3339 start time and optionally
an end time:

```json
{
  "name": "Evening news",
  "url": "https://media.example.test/live/channel.m3u8",
  "scheduledStartAt": "2026-09-22T20:00:00+02:00",
  "scheduledEndAt": null
}
```

Scheduled sources remain dormant until their start time, so they do not consume
a transcription connection or start the session-duration clock early. Without
an end time, a clean stream end completes the capture immediately. Unexpected
disconnects are retried for 15 minutes before the capture is completed; the
configured maximum session duration remains the final safety limit.

## Scheduled capture when the broadcaster changes its plan

A fixed start time breaks when a broadcaster reschedules. Livestream sources
therefore support three layers of protection.

**1. Edit the schedule.** While a capture has not started, change its times
(`PATCH /api/v1/transcription/stream-sources/:id/schedule`, or **Edit schedule**
on the scheduled session). A source that is already watching (see below) can
still change its end time and silence limit.

**2. Start when the stream goes live.** Instead of a start time, choose *When the
stream goes live* and a window (`startMode: "when_live"`, `scheduledStartAt` =
watch from, `scheduledEndAt` = watch until; the end is required and the window
is at most 48 hours). From the window start the source is `watching`: the backend
listens to the stream without using a transcription provider, and the session
clock does not run. Capture starts when a few seconds of speech are heard.
Music and silence are ignored, which matters for streams such as the Bundestag's
that play music between sessions.

Optionally set `silenceStopSeconds` (2 minutes to 4 hours) to end the capture
when the programme returns to music or silence. Shorter breaks keep it running.
The limit is armed only after speech was heard in that capture.

**3. Follow the Bundestag plan.** For `https://www.bundestag.de/mediathek/live` the
resolver returns the announced sessions (`plan`). Choosing one sets a watch window
from 15 minutes before the announced start to 3 hours after the announced end
(sessions often run long) and, with `planFollow: true` and a `planKey`, JustAI
re-reads the plan every 10 minutes while the source is `scheduled` or `watching`
and moves the window if the session was rescheduled. A plan-following source also
starts 10 minutes after the announced start even if speech could not be confirmed,
and says so in its alert.

### Safety net

Each stream source carries an `alert` shown on the session. It is set when the
window moved ("Schedule updated from the Bundestag plan…"), the session vanished
from the plan, the stream was unreachable for 10 minutes while watching, capture
started without speech confirmation, a capture ended after the silence limit, or
the window ended without any speech (the source then has status `failed`).
There is no email or push notification system, so alerts appear in the session and
are counted for operators in the backend's `/metrics`:

```text
justai_livestream_watching
justai_livestream_events_total{event="speech_start|fallback_start|watch_missed|silence_stop|plan_changed|plan_missing|plan_fetch_failed|stream_unreachable"}
```

Alert on `increase(justai_livestream_events_total{event="watch_missed"}[1h]) > 0`.

### Topics: read one agenda item as soon as it is finished

A Bundestag sitting runs for many hours and covers many items. With **Track topics**
(chosen together with a Bundestag session) or **Load agenda items** (in the session's
topics list) JustAI loads the items of that sitting from the Bundestag's published
planned course ("Geplanter Ablauf der Plenarsitzungen", a PDF read with `pdftotext`).
Each item has a label ("EPL 15", "TOP II, III"), a title and a planned slot.

While the sitting is captured, every finished transcript segment is checked for the
chair calling an item up ("Ich rufe den Einzelplan 15 auf", "Wir kommen zu
Tagesordnungspunkt …"). The match uses the item's number, or its title words when no
number is spoken. The previous item is finished at that moment and the new one opens,
so the real boundaries come from the sitting, not from the planned slots, which drift.

A finished item is available immediately, while the sitting continues: open its
transcript, copy or download it, or have it summarised
(`GET /api/v1/transcription/topics/:id/transcript`, `POST …/summary`). Mark topics you
care about with the star to be notified when one finishes. If an announcement was not
recognised, **Start now** and **Finish** set the boundary by hand. The last open item
ends when the chair closes the sitting or the capture ends. Items that were already
finished are never reopened by a repeated mention.

Limits: boundaries are as exact as the chair's announcement is recognised, and a
topic is finished only when the next one is called up, so there is a short delay. The
announcement detector works on text patterns and has been tested against typical
phrasings and the real plan, not yet against a recorded sitting. Check the first live
sitting and use **Start now** / **Finish** where it differs.

### Recording only selected topics

To save transcription time, choose **Only selected topics** and tick the items you
need (`captureScope: "topics"`, `topicKeys`, `topicsSessionNo` on stream-source
creation; the agenda comes from `GET /api/v1/transcription/bundestag/agenda?sitting=N`).
The schedule is then derived from the agenda instead of the form:

- Capture starts 30 minutes before the first selected item's planned slot.
- After a selected item is finished (the next one was called up), the capture pauses
  when the next selected item is at least 20 minutes away. It resumes 30 minutes
  before that item's planned start, shifted by the delay observed so far (sittings
  usually run late). Between the windows no audio reaches the provider.
- After the last selected item the capture ends and the session is completed.
- If the sitting reaches a selected item before its window began, the item is marked
  missed with an alert and the capture continues with the remaining items.
- A hard stop applies 3 hours after the last selected item's planned end.

While paused the source shows as scheduled with an alert naming the resume time.
Restarted captures continue the source's timeline after the last transcript line, so
topic boundaries stay consistent across pauses and backend restarts. The eight-hour
`transcription.max_session_hours` limit counts from the first start, pauses included.

### Limits of speech detection

Speech is told from music by cheap audio features (no model), calibrated on the
Bundestag music programme and synthetic German speech. It can be fooled by heavy
background noise: at about 15 dB signal-to-noise (white noise) it no longer
recognised speech in testing. The design is therefore defensive: detection only
decides when to *start* and when to *stop*, it never drops audio during a capture,
the silence limit is armed only once speech was heard, and plan-following sources
have the time-based fallback above. Check the first live captures against the
real stream. The eight-hour `transcription.max_session_hours` limit still applies
from the moment capture starts; raise it for long plenary days.

## Meeting-bot ingress

`POST /api/v1/transcription/sessions/:sessionId/bot-sources` creates a
platform-labelled source and returns an ingest token once. The token is not a
JustAI user token and does not grant access to the workspace. It only exchanges
for a short-lived, one-use transcription stream ticket for that source.

The adapter flow is:

```text
POST /api/v1/transcription/sessions/:sessionId/bot-sources
  -> save the returned token
POST /api/v1/transcription/bot-sources/:sourceId/tickets
  Authorization: Bearer <ingest-token>
  -> short-lived stream ticket
GET /api/v1/streams/transcription?ticket=<ticket>
  -> SSE events, beginning with transport.ready and its streamId,
     uploadToken, and resumeToken
POST /api/v1/streams/:streamId/audio
  X-Stream-Token: <uploadToken>
  -> batched audio ingress
POST /api/v1/streams/:streamId/events
  X-Stream-Token: <uploadToken>
  -> JSON controls
```

The platform field accepts `generic`, `zoom`, `google-meet`, and
`microsoft-teams`. These labels select the adapter configuration and source
identity; they do not make the backend log in to a third-party meeting.
Actual Zoom/Google Meet/Teams joining still belongs in a separately deployed
adapter or desktop companion with the organization's platform credentials and
consent flow.

After the SSE stream emits `transport.ready`, the adapter POSTs this JSON to
the returned stream's `/events` endpoint:

```json
{"type":"transcription.start","sessionId":"...","sourceId":"...","transportSequence":1}
```

The `/audio` request body contains one or more frames. Each frame is prefixed
by its 4-byte big-endian length; the frame itself uses this little-endian format:

```text
1 byte   protocol version (1)
8 bytes  capture timestamp in Unix milliseconds
4 bytes  monotonically increasing sequence number
4 bytes  source sample rate (8000..96000)
N bytes  mono signed PCM16 audio
```

Every control carries a strictly increasing `transportSequence`; retries are
idempotent and stale duplicates are ignored. The adapter can POST
`source.level`, `source.pause`, `source.resume`, `ping`, and
`transcription.stop` JSON events. The server emits the same
`transcription.partial`, `transcription.final`, source, and error events
that browser captures receive.

SSE events carry monotonically increasing `id` fields and the server retains a
bounded replay window. Reconnect within 15 seconds with
`GET /api/v1/streams/transcription?resume=<resumeToken>&lastEventId=<id>`.
The upload and resume tokens are bearer secrets and must never be logged.

Rotate a bot token with:

```text
POST /api/v1/transcription/bot-sources/:sourceId/rotate
```

Rotation immediately revokes the previous token. Stop a bot source with:

```text
POST /api/v1/transcription/bot-sources/:sourceId/stop
```

Stop the source or the whole session when the meeting ends.
# Transcription reliability

Browser capture forwards continuous mono PCM16 audio, including silence. The
backend retains silence for providers with their own voice activity detection;
explicit-commit transports finalize turns locally. The local energy threshold is
not a speech classifier: music and background noise can still reach the model.

Live browser and direct-stream results use the same conservative repetition
cleanup. Raw provider text is retained separately from the displayed final text.
Cleanup does not recover missing speech or establish factual accuracy. When a
chunk contains a detected repetition loop, prompt carry-over is disabled for the
remaining stream to avoid feeding the loop back into the decoder.

Rolling-window overlap is retained while flushing the final tail, and reset for
the next utterance. Streaming delta fields are appended verbatim; complete text
fields replace the partial result.

Before changing models or chunk durations, replay the same recorded speech
through the configured endpoint and compare raw responses, displayed results,
word error rate, omissions, repetitions, and finalization latency. Include quiet
speech, music, silence, interruptions, repeated words, and mixed-language speech.
The default 2.5-second window favors latency; longer windows must be evaluated
against actual audio and the deployed model rather than assumed to be better.

## Livestream webpage links

The livestream link field checks the source before allowing scheduling. The
resolver accepts direct network media, public HTML audio/video/source elements,
Open Graph media, embedded HLS/DASH/audio URLs, and a single embedded player
(up to two iframe hops). Pages with multiple candidate streams are rejected
rather than choosing a channel silently. JavaScript-only players, login and DRM
are not supported by the general resolver.

The Bundestag `/mediathek/live` page uses a dedicated adapter: it follows the
MP3 source published on the official plenary audio page. This adapter captures
plenary audio, not arbitrary committee channels.

`POST /api/v1/transcription/stream-sources/resolve` accepts `{ "url": "..." }`
and returns a source name and kind, without exposing resolved media URLs.
Creation validates the source again. The original URL remains encrypted at rest
and is resolved on capture start and each reconnect, so temporary media URLs
are not frozen at scheduling time. Resolution uses the existing public-target
and redirect policy, bounded page sizes and request timeouts. A source that
cannot be resolved at capture time retries during the reconnect grace period
and then shows a failed status.

## Processing after live capture

New live sessions can select speaker separation (including Pyannote) and/or
polish. Selecting speaker separation enables audio recording automatically.
Before a scheduled capture starts, **Processing settings** can change these
choices. The backend rejects changes once capture has begun.

A persisted `transcription_live_processing` job waits for session completion,
stopped stream workers, and finalized recordings. Speaker separation runs
first, followed by polish; neither stage reruns ASR. Completed steps are retained
on retry. Failed steps can be retried or skipped in the transcript workspace.
Manual polish is blocked while this pipeline is active or waiting for a failed
speaker step. The job has a 35-minute lease and a 30-minute execution deadline;
expired leases are reclaimed after restarts.

Pyannote receives a signed URL to a temporary WAV assembled from the encrypted
recordings. This requires configured S3 processing storage even when recordings
normally use local storage. The temporary object and local plaintext file are
deleted after processing. A reclaimed attempt removes previous temporary objects
for the session. Other diarization providers use bounded audio windows. Sources
are labelled separately to avoid merging unrelated source-local speaker IDs.
Original transcript text and timestamps are retained.

## Livestream capture through a file-inspecting proxy

An optional standalone HTTPS relay converts approved MP3 streams into completed
five-second WAV files. Set `JUSTAI_STREAM_RELAY_URL` and
`JUSTAI_STREAM_RELAY_TOKEN_FILE` on the backend, then use the relay source URL in
the existing livestream field. See [installation and security boundaries](../deploy/stream-relay/README.md).
The relay uses operator-configured sources, TLS, backend-only bearer authentication,
public-address dial validation, and bounded in-memory retention. It is not an open
forward proxy and does not require incoming connections to the application.
