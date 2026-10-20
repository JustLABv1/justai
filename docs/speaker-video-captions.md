# Speaker names from video captions

In the video upload dialog, enable **Speaker separation**, then **Names from
video captions**. Select a vision endpoint/model, image budget, and whether
consistent matches should be applied automatically. These browser preferences
are remembered per workspace; the API validates endpoint access again for each
upload. Migration `060_video_caption_pipeline.sql` stores the chosen settings
and durable caption job link on the upload.

The pipeline order is Upload → Transcription → Speaker separation → Speaker
names → Grammar polish → Finalization. Disabled name recognition is skipped.
The names step displays analyzed/selected image counts, waits for its durable
background job, and reuses that job after a video-worker restart. A failed names
step can be retried independently without repeating ASR or diarization.
Cancelling the video also cancels and fences its name analysis. Reprocessing an
earlier stage clears the previous name-analysis link because audio labels can
change. Automatically applied names still require three matching images across
two speech turns; uncertain matches remain reviewable suggestions.

After a video has completed transcription and diarization, open **Speakers →
Read name captions**. Select an enabled vision endpoint, optionally override its
vision model, choose a maximum of 12, 24, or 48 images, and start the analysis.
The default is 24 images and manual confirmation of suggestions.

The backend reads printed names in the lower half of sampled video frames and
matches their timestamps to existing audio speaker labels. It does not identify
faces. Each image crop is sent to the selected endpoint as one vision request.
No new OCR service, Python dependency, or Helm workload is required. The backend
uses the existing FFmpeg binary and S3 video storage/processing origin.

## Sampling and decisions

- At most four images per speaker, across their two longest clear turns of at
  least eight seconds. Samples are taken around six and twelve seconds into a
  turn, away from its end. Speakers are sampled in rounds to share the budget.
- Frames with overlapping or unassigned audio around the sampled timestamp are
  excluded. Manually named speakers are excluded and remain protected at write
  time, including concurrent renames and merges.
- A model answer must contain the recognized name literally in its transcribed
  caption text, with confidence at least 0.8. Missing, ambiguous, or unreadable
  captions do not produce names.
- A single observation is a suggestion capped at 0.65; two are capped at 0.78.
  Automatic application is optional and requires three matching observations
  across at least two turns, no conflicting caption, and confidence >= 0.85.
  A name found on multiple audio labels is also treated as ambiguous.
- Suggestions can be accepted or dismissed in the existing speaker list.
  Review results to see image evidence and seek to its video timestamp.
  Conflicting captions expose both matching and conflicting images.

Sampling is intentionally limited: a short-lived caption outside the selected
frames can be missed. Increasing the budget covers more speakers, but does not
increase the four-image maximum per speaker. A person speaking only once will
receive a suggestion rather than automatic naming. Correct audio diarization is
still required; a caption cannot reliably repair a merged audio speaker label.

## Background execution and deployment

Migration `059_speaker_video_captions.sql` creates durable analysis runs. Deploy
backend and frontend together; the normal backend migration runner applies migrations 059 and 060.
The worker starts with the transcription manager. Jobs continue after navigation
and resume saved observations after a pod restart. A database advisory lock and
90-second renewable lease limit active analysis to one job across replicas;
lease tokens fence progress and final writes. An expired job is retried at most
three times before being marked failed. One active run per session is enforced
by a partial unique index. Jobs can be cancelled from the analysis dialog.

FFmpeg extracts one bounded JPEG crop at a time (at most 960×540 and 512 KiB),
with a 20-second extraction timeout. Vision requests have a 45-second timeout,
512 output tokens, and a 16 KiB response cap. Three consecutive failures stop a
run. The whole run has a deadline sized to its bounded frame count. Original
videos are never decoded into memory in their entirety.

Only observations, timestamps, and decisions are retained in PostgreSQL. Signed
storage URLs and image bytes are not persisted. Evidence images are re-extracted
on demand through an authenticated, session-scoped endpoint, so the original
video must still be retained. Video expiry/deletion makes evidence unavailable.
Endpoint scope and session access are checked before starting and again by the
worker. Images are processed by the selected endpoint under that endpoint's data
handling policy.

## Verification

Run the normal frontend checks and the backend speaker-caption tests. The
integration test is opt-in and must point to a **dedicated test database**:

```sh
cd services/backend
JUSTAI_CAPTION_TEST_DATABASE_URL='postgres://…/dedicated_test_database' \
  go test -tags integration ./server \
  -run TestSpeakerCaptionDurablePipelineIntegration -count=1
```

It applies migrations twice, checks the per-session uniqueness constraint and
cross-worker lease, resumes a saved checkpoint, rejects an obsolete lease token,
checks the automatic upload step and independent retry without losing earlier work,
and runs synthetic media through real FFmpeg and a fake HTTP vision endpoint to
persist an automatically named speaker. No paid model calls are made.
