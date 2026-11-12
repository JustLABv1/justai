# Sandbox service that runs short Python programs for JustAI chats.
#
# The image bundles the scientific stack because the service runs without
# network access, so nothing can be installed at run time.
FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    # Build the matplotlib font cache once; every run starts from a copy of it.
    && MPLCONFIGDIR=/opt/runner/mpl python -c "import matplotlib.pyplot" \
    # The runtime never installs anything (it has no network), so drop the
    # package tooling and its vendored libraries instead of shipping their CVEs.
    && python -m pip uninstall --yes pip setuptools wheel \
    && rm -rf /usr/local/lib/python3.13/ensurepip /usr/local/bin/pip* /usr/local/bin/wheel \
    && mkdir -p /work

COPY app.py bootstrap.py /opt/runner/
RUN chmod -R a=rX /opt/runner

# This service intentionally starts as root: it gives every run its own
# unprivileged uid and sweeps leftovers afterwards. Deploy it with all
# capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID and
# KILL, a read-only root file system and no network access (see README.md).
WORKDIR /opt/runner
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD ["python", "-I", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=2).status == 200 else 1)"]
CMD ["python", "-I", "/opt/runner/app.py"]
