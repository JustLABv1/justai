# Shared FFmpeg build artifact

This image contains the source-verified static FFmpeg binaries used by the
backend, combined, and pyannote runtime images. Keeping it separate prevents
every application release from recompiling FFmpeg and OpenSSL.

The versioned GHCR image is built automatically when this directory changes.
Release workflows rebuild it through the shared BuildKit cache and pass its
exact output digest to consumer builds as the `ffmpeg-builder` named context.
Consumer Dockerfiles keep an equivalent source-build stage as a fallback, so
ordinary local builds do not depend on the artifact already existing.

Build and verify it locally with:

```bash
docker build -t justai-ffmpeg docker/ffmpeg
docker run --rm justai-ffmpeg -version
docker run --rm --entrypoint /opt/ffmpeg/bin/ffprobe justai-ffmpeg -version
```

When changing FFmpeg or OpenSSL, update the version and checksum consistently
in this Dockerfile, the three consumer Dockerfiles, and the workflow
`FFMPEG_TAG` values.
