"""Synchronize an internally mirrored pyannote bundle from S3-compatible storage."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

import boto3
from botocore.config import Config


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required for the S3 model sync")
    return value


def main() -> None:
    bucket = required("PYANNOTE_MODEL_S3_BUCKET")
    prefix = os.getenv("PYANNOTE_MODEL_S3_PREFIX", "pyannote").strip("/")
    destination = Path(required("PYANNOTE_MODEL_DESTINATION")).resolve()
    endpoint = os.getenv("PYANNOTE_MODEL_S3_ENDPOINT", "").strip() or None
    region = os.getenv("PYANNOTE_MODEL_S3_REGION", "").strip() or None
    force_path_style = os.getenv("PYANNOTE_MODEL_S3_FORCE_PATH_STYLE", "false").lower() == "true"
    key_prefix = f"{prefix}/" if prefix else ""

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        config=Config(s3={"addressing_style": "path" if force_path_style else "auto"}),
    )
    paginator = client.get_paginator("list_objects_v2")
    downloaded = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=key_prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            relative = PurePosixPath(key[len(key_prefix) :])
            if not relative.parts or relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"unsafe S3 object key: {key}")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, key, str(target))
            downloaded += 1

    if not downloaded:
        raise RuntimeError(f"no model files found at s3://{bucket}/{key_prefix}")
    print(f"Synchronized {downloaded} model files from s3://{bucket}/{key_prefix}", flush=True)


if __name__ == "__main__":
    main()
