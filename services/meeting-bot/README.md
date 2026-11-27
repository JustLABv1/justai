# Meeting bot

Joins a web meeting with headless Chromium, as a guest with a visible name, and
forwards what the other participants say to a JustAI live transcription. It is the
adapter side of JustAI's [meeting-bot ingress](../../docs/transcription-ingress.md#meeting-bot-ingress):
the backend never logs in to a meeting itself.

One process runs one bot for one meeting. It needs outbound HTTPS to the meeting
and to JustAI, and nothing inbound.

## Status

Built for the **Cisco Meeting Server web app** (`--platform cisco-meeting-server`,
for example a federal instance such as `meet.bdbos.bund.de`) and usable with other
browser meeting clients (`--platform generic`). The join flow has **not been
checked against a real deployment yet**: it is tested against a local stand-in page
only (see Tests). Expect to adjust it on the first real meeting with a selectors
file, and do that in a test meeting.

Only join meetings where the organizer agrees to a transcription bot. The bot shows
up as a participant named "JustAI Transkription (Bot)" by default; keep a name that
makes clear what it is.

## How it works

1. **JustAI first.** The bot exchanges the source's ingest token for a one-use
   ticket, opens the SSE stream, and waits until JustAI has connected a
   transcription provider. If that fails it exits before joining the meeting.
2. **Join.** Chromium opens the meeting link. The bot fills in what the page asks
   for (meeting ID, passcode, name), switches its camera and microphone off where a
   toggle reports its state, and presses the join button. Fields and buttons are
   found by their labels and texts in German and English, not by CSS classes, so a
   redesign of the web app does not necessarily break it. The browser's own
   camera and microphone are fakes (a black picture and silence); the bot never
   sends sound into the meeting.
   By default the camera shows a card with the JustAI logo and "Dieses Gespräch wird
   von JustAI transkribiert" and stays on, so every participant sees that a bot is
   listening; the microphone is muted. `--camera off` (`BOT_CAMERA=off`) sends a
   black picture and switches the camera off instead. Toggles are recognised by
   their pressed state, by an action label ("Mikrofon stummschalten") or by a state
   label ("Mikrofon aktiviert", as the Cisco Meeting Server web app writes it).
   Headless Chromium normally announces itself as "HeadlessChrome", which meeting
   apps reject as an unsupported browser, so the bot uses a regular Chrome user agent.
3. **Capture.** A script injected before the page loads taps every incoming
   WebRTC audio track (all other participants), mixes them, resamples to 16 kHz
   mono PCM16 and hands 100 ms chunks to the bot, which uploads them in JustAI's
   frame format. A slow upload drops the oldest audio past 1 MB instead of drifting
   ever further behind.
4. **Leave** when the page says the meeting ended, nobody else has sent audio for
   `--alone-minutes`, nothing was heard for `--silence-minutes`, after
   `--max-minutes`, when the JustAI session is ended, or on SIGTERM/SIGINT. The
   bot clicks "Leave" and sends `transcription.stop`, so the last turn is finalised.

## Service mode (what the Helm chart runs)

`python -m meeting_bot serve` runs an HTTP service on port 8091 that the JustAI
backend starts and stops bots through. With it configured (`JUSTAI_MEETING_BOT_URL`
and `JUSTAI_MEETING_BOT_TOKEN` on the backend), a user adds a meeting-bot source with
**Join the meeting automatically**, a meeting link and, if needed, the meeting ID and
passcode; the backend creates the ingest token, asks the service to join, shows the
bot's status (joining, in the meeting, left, could not join) on the source, and
makes the bot leave when the source or the session stops. The passcode is passed
through and not stored.

| Service setting | Default |
| --- | --- |
| `MEETING_BOT_SERVICE_TOKEN` or `MEETING_BOT_SERVICE_TOKEN_FILE` | required, shared with the backend, at least 16 characters |
| `JUSTAI_URL` | required: the backend address bots send audio to (in a cluster, its service) |
| `MEETING_BOT_PORT` | `8091` |
| `MEETING_BOT_MAX_BOTS` | `2` bots at the same time |
| `BOT_NAME`, `BOT_LOCALE`, `BOT_JOIN_TIMEOUT_SECONDS`, `BOT_MAX_MINUTES`, `BOT_ALONE_MINUTES`, `BOT_SILENCE_MINUTES`, `BOT_DEBUG_DIR` | as for a single bot |
| `BOT_HEADFUL` | `false`; `1` shows each bot's browser window (local debugging) |

The JustAI address always comes from the service's configuration, never from a
request. Bots live in the service's memory: run one instance, and expect a restart
to end running bots (the backend then reports them as gone).

To try it locally against a dev backend on port 8080:

```sh
cd services/meeting-bot
openssl rand -hex 32 > /tmp/meeting-bot-token
JUSTAI_URL=http://localhost:8080 MEETING_BOT_SERVICE_TOKEN_FILE=/tmp/meeting-bot-token \
  BOT_HEADFUL=1 python -m meeting_bot serve
# and start the backend with
JUSTAI_MEETING_BOT_URL=http://localhost:8091 JUSTAI_MEETING_BOT_TOKEN="$(cat /tmp/meeting-bot-token)" \
  go run . -c ./config.yaml
```

## Running a single bot

Without the service, one process runs one bot. Create the source in JustAI (in a live session: *External stream or meeting bot*,
platform *Cisco Meeting Server*, or via the API) and keep the token it shows once:

```text
POST /api/v1/transcription/sessions/:sessionId/bot-sources
{"platform": "cisco-meeting-server", "name": "BDBOS-Besprechung", "meetingUrl": "https://…"}
```

Then start the bot:

```sh
docker build -t justai-meeting-bot services/meeting-bot
docker run --rm \
  -e JUSTAI_URL=https://justai.example.org \
  -e JUSTAI_BOT_SOURCE_ID=<source id> \
  -e JUSTAI_BOT_TOKEN_FILE=/run/secrets/justai_bot_token \
  -e MEETING_URL='https://meet.example.org/…' \
  -e MEETING_ID=123456789 \
  -e MEETING_PASSCODE_FILE=/run/secrets/meeting_passcode \
  -v "$PWD/secrets:/run/secrets:ro" \
  justai-meeting-bot
```

| Setting | Environment | Default |
| --- | --- | --- |
| `--justai-url` | `JUSTAI_URL` | required, https |
| `--source-id` | `JUSTAI_BOT_SOURCE_ID` | required |
| ingest token | `JUSTAI_BOT_TOKEN` or `JUSTAI_BOT_TOKEN_FILE` | required |
| `--meeting-url` | `MEETING_URL` | required: the meeting link, or the web app's join page |
| `--meeting-id` | `MEETING_ID` | when the page asks for one |
| passcode | `MEETING_PASSCODE` or `MEETING_PASSCODE_FILE` | when the page asks for one |
| `--name` | `BOT_NAME` | `JustAI Transkription (Bot)` |
| `--platform` | `BOT_PLATFORM` | `cisco-meeting-server` (`generic` uses the same heuristics) |
| `--locale` | `BOT_LOCALE` | `de-DE` |
| `--join-timeout` | `BOT_JOIN_TIMEOUT_SECONDS` | `600` (a waiting room counts) |
| `--max-minutes` | `BOT_MAX_MINUTES` | `240`, `0` = no limit |
| `--alone-minutes` | `BOT_ALONE_MINUTES` | `2`, `0` = never |
| `--silence-minutes` | `BOT_SILENCE_MINUTES` | `30`, `0` = never |
| `--selectors-file` | `BOT_SELECTORS_FILE` | none |
| `--debug-dir` | `BOT_DEBUG_DIR` | none |

Secrets are read from the environment or from files only, never from arguments, and
are never logged; the meeting link is logged as scheme and host only.

Exit codes: `0` normal end, `2` configuration, `3` join failed, `4` JustAI stream
failed, `5` browser failed.

The bot counts as alone when the page's participant count shows only the bot (the
Cisco Meeting Server web app says "3 Teilnehmer im Meeting" on its participants
button). Pages without a readable count fall back to incoming audio tracks; a
meeting server that mixes everyone into one stream keeps that stream while the bot is
alone, so there `--silence-minutes` or the "meeting ended" page ends the bot. A
selectors file can point `participants` at the element that holds the count.

## When joining fails

Run with `--debug-dir /some/dir` (mount it into the container). On a failed join the
bot saves a screenshot and the page's HTML there. These can show meeting details;
delete them after use. With the markup in hand, pin the steps the heuristics got
wrong in a JSON file passed with `--selectors-file`; each key takes a Playwright
selector and replaces the heuristic for that step:

```json
{
  "meeting_id": "#meeting-id",
  "passcode": "input[type=password]",
  "name": "#display-name",
  "join": "button:has-text('Teilnehmen')",
  "leave": "[aria-label='Besprechung verlassen']",
  "in_call": ".call-view",
  "ended": "text=Die Besprechung wurde beendet",
  "participants": "[data-test=participants-button]"
}
```

For local debugging, `--headful` shows the browser window.

## Tests

```sh
cd services/meeting-bot
python -m pip install -r requirements.txt
python -m playwright install chromium
python -m unittest discover -s tests -t . -v
```

The tests contact nothing outside the machine. `tests/fake_justai.py` follows the
backend's ingress rules (one-use tickets, SSE replay and resume, sequenced controls,
audio batch order). `tests/test_bot_browser.py` runs the real bot against a local
page with a guest join flow (meeting ID and passcode, then name and device toggles,
then a call that refuses headless user agents) whose "other participant" sends a
440 Hz tone over WebRTC, and checks that the tone arrives at JustAI as 16 kHz audio.
The browser tests are skipped when Chromium is not installed.
