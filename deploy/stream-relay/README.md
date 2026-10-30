# Firewall-compatible livestream relay

The relay runs on infrastructure that can reach the public MP3 source. JustAI
behind the firewall makes only outbound HTTPS requests to it. Every audio response
is a completed five-second WAV file with an explicit `Content-Length` (160,044 bytes including the WAV header,
16 kHz mono signed PCM16 little endian). It does not require a streaming response
through the corporate proxy. Expect roughly 5–6 seconds of extra latency plus
proxy inspection, transport and transcription time.

This first version supports **direct HTTPS MP3 sources with `audio/mpeg`**, including
the parliamentary radio URL in `sources.example.json`. It deliberately rejects
redirects, webpages, HLS, DASH, RTMP and arbitrary user-supplied upstream URLs.
The existing direct capture mode remains available for those other protocols.

## Install the relay

From this directory on the relay host:

1. Copy `sources.example.json` to `sources.json` and configure the approved sources
   (1–8 IDs, each consisting of 1–64 letters, digits, underscores or hyphens).
2. Provision a TLS certificate for the relay DNS name at `tls.crt` and its private
   key at `secrets/tls_key`. Include intermediate certificates. The backend must
   trust the issuing CA; certificate verification cannot be disabled by this feature.
3. Generate a random token locally, for example:

   ```sh
   mkdir -p secrets
   chmod 700 secrets
   openssl rand -hex 32 > secrets/relay_token
   ```

   Make secrets readable by container UID 1001 (on Linux, for example, set the
   secret files to owner `1001:1001` and mode `0400`), restrict host access, and keep the
   directory accessible only to the operator. With Docker Compose file-backed
   secrets the host file's permissions matter; Compose does not reliably remap
   their UID or mode. Never commit tokens, source configuration or private keys.
4. Set `RELAY_BIND_ADDRESS` to the intended host interface in `.env`. Restrict
   incoming TCP 8443 at the host/network firewall to the application's egress IP
   (or corporate proxy egress IP). Docker publishing rules must also enforce this
   restriction; a host firewall rule that Docker bypasses is insufficient.
5. Run `docker compose up -d --build`.

The build reuses the backend's verified static FFmpeg build; compiling it can take
several minutes. No public relay image is assumed. Update/rebuild alongside the
backend to pick up security fixes.

The container runs without root, Linux capabilities or a writable root filesystem,
with memory, CPU, process and file-descriptor limits. TLS and bearer authentication
are mandatory. For a wider exposed network, additionally use your ingress's request
rate and connection limits; this small service is not a volumetric DDoS defense.

## Connect JustAI

Set on the **backend**, then restart it:

```text
JUSTAI_STREAM_RELAY_URL=https://relay.example.org:8443
JUSTAI_STREAM_RELAY_TOKEN_FILE=/run/secrets/stream_relay_token
```

The origin must use HTTPS, with no path, credentials or query. Mount a protected
copy of the same token file into the backend container. `backend.compose.yaml`
provides an optional Compose override; from `deploy/compose`, for example:

```sh
docker compose -f compose.yaml -f ../stream-relay/backend.compose.yaml up -d backend
```

Set `JUSTAI_STREAM_RELAY_URL` and the absolute `JUSTAI_STREAM_RELAY_TOKEN_PATH` in
that deployment's environment. Existing `HTTPS_PROXY` / `NO_PROXY` settings apply
to relay requests. Allowlist the relay host and port in the corporate proxy. The
backend is allowed to reach this **exact configured origin**, including when it
is on a private network; no global private-target permission is necessary.

In the existing livestream URL field, enter:

```text
https://relay.example.org:8443/v1/sources/bundestag
```

The application validates the authenticated manifest, stores this URL encrypted
like other stream URLs, and polls completed audio files. The token stays on the
backend and is never sent to the browser or stored in the source URL. Relay errors
use generic messages to avoid exposing credentials. Missing token configuration,
invalid certificates and redirects fail closed.

## Operation and security boundaries

- Sources are shared across authorized backend users of this deployment. A token
  permits reading **all configured sources**; use separate relay instances/tokens
  for different trust groups. Ordinary session permissions still apply in JustAI.
- All configured sources are captured continuously while the relay runs, even if
  no transcription is active. The in-memory ring keeps only the most recent
  twelve segments (60 seconds, about 1.9 MB per source); nothing is written to disk.
- Outbound connections resolve and validate all DNS answers and dial a checked IP,
  rejecting loopback, private, link-local, metadata and special-purpose addresses.
  Only HTTPS port 443 is supported upstream. Redirects and outbound environment
  proxies are disabled. Add outbound network ACLs as a second layer.
- FFmpeg receives MP3 bytes through stdin with only the `pipe` protocol enabled.
  It cannot follow media URLs, playlists or file references. Audio decode still
  processes untrusted media; keep FFmpeg current and retain container isolation.
- Tokens grant read-only access: there is no API for adding sources, arbitrary
  forwarding, CONNECT tunneling, command execution or file access.
- The client rejects malformed/truncated/oversized audio, redirects, expired ring
  positions and relay epoch changes. On gaps/restarts the existing live worker
  reconnects at the newest segment; this is live capture, not durable replay.
  A reconnect can skip or repeat audio near its boundary. For gap-free archival
  requirements use a durable recording pipeline instead.
- Upstream failures are retried every three seconds. A manifest can exist before
  audio arrives; if no new audio arrives for 30 seconds the backend reconnects.
  Source and scheduled session status continue to use the existing application UI.
- Rotate the token by replacing both protected copies and restarting the relay
  and backend. Existing sessions must reconnect. No overlap-key rotation is provided.
- Certificate issuance/renewal, token distribution and network firewall rules are
  deployment responsibilities. The service refuses to start without usable TLS
  key/certificate files and a token of at least 32 characters.

## Verify

With the deployment's CA trusted, use a diagnostic client that reads the bearer
token from a protected file/header configuration (avoid tokens in command arguments
or shell history). The authenticated manifest at `/v1/sources/bundestag` returns an
epoch and oldest/latest sequence; `latest` should increase about every five seconds.
`/v1/sources/bundestag/segments/<sequence>?epoch=<epoch>` must return HTTP 200 with
`Content-Length: 160044`. Requests without authentication must return HTTP 401.
Finally run a transcription through the corporate proxy and check that recording,
pause/resume, stop and reconnect behave correctly under the actual proxy policy.
