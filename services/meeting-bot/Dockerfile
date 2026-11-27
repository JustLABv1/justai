# Headless browser bot that joins a web meeting and forwards its audio to JustAI.
# One container runs one bot for one meeting; see README.md.
FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

COPY requirements.txt /tmp/requirements.txt
# Only the headless Chromium shell is needed; --with-deps installs its system libraries.
# Playwright's bundled Node driver needs libatomic, which the slim image lacks.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libatomic1 \
    && pip install --root-user-action=ignore -r /tmp/requirements.txt \
    && python -m playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /tmp/requirements.txt \
    && useradd --create-home --uid 10001 bot

WORKDIR /app
COPY meeting_bot /app/meeting_bot
COPY tests /app/tests

USER bot
ENTRYPOINT ["python", "-m", "meeting_bot"]
