"""Publish a runtime release to the central channel.

Packages runtime/ into a tar.gz, uploads it + an updated manifest to S3
(private bucket; machines never touch S3 — the api's /openclaw/agent/release/*
endpoints stream it to them behind proxy-token auth). Every deployed machine's
updater polls the manifest every 5 minutes, so an upload here reaches the whole
fleet within ~5 minutes (+60s api-side manifest cache).

Usage (from this repo's root; AWS creds come from the environment):
    python publish.py            # dry-run: show what would ship
    python publish.py publish    # actually upload

Credentials — this repo is PUBLIC, so nothing here reads api/common/config.py:
    BLAVE_S3_KEY      AWS access key id
    BLAVE_S3_SECRET   AWS secret access key
    BLAVE_S3_REGION   region (e.g. ap-southeast-1)
    BLAVE_S3_BUCKET   bucket name
A dry-run needs none of them; only `publish` does.

Version comes from runtime/VERSION — bump it first; re-publishing an existing
version number is refused (machines that rolled a version back skip re-attempts
of the same number, so a fix must ship under a new one).
"""
import hashlib
import io
import json
import os
import re
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.join(HERE, "runtime")
# The systemd units stay with the machine-provisioning stack in the api repo:
# provision.sh installs all 27 at first boot, jobs.json declares the 10 that
# ride with a release. Read them from the sibling checkout — this runs on a
# maintainer's machine, and a missing sibling fails loudly right here, never
# silently on the fleet.
SYSTEMD = os.path.join(os.path.dirname(HERE), "api", "blave_agent", "systemd")
S3_PREFIX = "blave-agent"


def build_tarball():
    """Flat tar.gz of the runtime payload — file basenames only, so the machine
    updater can enforce a flat extract (no paths, no symlink/dir tricks).

    jobs.json (if present) rides along with every systemd unit it declares,
    pulled from the api repo's blave_agent/systemd/ — the updater installs them
    (jobs-manifest). A declared-but-missing unit file fails the publish here,
    not silently on the fleet."""
    version = open(os.path.join(RUNTIME, "VERSION")).read().strip()
    # the fleet updater's downgrade guard only orders dotted-numeric versions;
    # anything else ("v1.1.20", "1.1.20-fix") bypasses it and lands everywhere
    if not re.fullmatch(r"\d+(\.\d+)*", version):
        sys.exit(f"ERROR: runtime/VERSION {version!r} must be dotted-numeric (e.g. 1.1.20)")
    jobs_path = os.path.join(RUNTIME, "jobs.json")
    unit_names = []
    if os.path.isfile(jobs_path):
        with open(jobs_path) as f:
            unit_names = sorted((json.load(f).get("linux_units") or {}))
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in sorted(os.listdir(RUNTIME)):
            if name.endswith(".py") or name in ("VERSION", "jobs.json"):
                tar.add(os.path.join(RUNTIME, name), arcname=name)
        for name in unit_names:
            path = os.path.join(SYSTEMD, name)
            if not os.path.isfile(path):
                sys.exit(f"ERROR: jobs.json declares {name} but {SYSTEMD} lacks it "
                         f"(needs the api checkout beside this repo)")
            tar.add(path, arcname=name)
    return version, buf.getvalue()


def main():
    do_publish = len(sys.argv) > 1 and sys.argv[1] == "publish"
    version, data = build_tarball()
    sha = hashlib.sha256(data).hexdigest()
    manifest = {"latest": version, "sha256": sha, "size": len(data)}
    print(f"release {version}: {len(data)} bytes, sha256={sha}")

    if not do_publish:
        print("dry-run only — rerun with `publish` to upload")
        return

    import boto3

    try:
        s3 = boto3.client(
            "s3",
            aws_access_key_id=os.environ["BLAVE_S3_KEY"],
            aws_secret_access_key=os.environ["BLAVE_S3_SECRET"],
            region_name=os.environ["BLAVE_S3_REGION"],
        )
        bucket = os.environ["BLAVE_S3_BUCKET"]
    except KeyError as e:
        # fail loudly and name the variable — a half-set environment must not
        # silently fall back to an ambient profile and publish to the wrong bucket
        sys.exit(f"ERROR: {e.args[0]} not set — see this file's docstring")
    tar_key = f"{S3_PREFIX}/releases/{version}.tar.gz"

    # refuse to overwrite an existing version — rolled-back machines skip
    # re-attempts of the same number, so a silent overwrite would strand them.
    # Only a genuine 404 means "not published yet": a wrong bucket, bad key or
    # wrong region must NOT read as one. (It used to be `except Exception: pass`,
    # which swallowed all of those and fell through to the upload — harmless while
    # the creds came from common/config.py, live the moment they come from four
    # environment variables that a human types.)
    try:
        s3.head_object(Bucket=bucket, Key=tar_key)
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code not in ("404", "NoSuchKey", "NotFound"):
            raise
    else:
        print(f"ERROR: {version} already published — bump runtime/VERSION first")
        sys.exit(1)

    s3.put_object(Bucket=bucket, Key=tar_key, Body=data)
    s3.put_object(
        Bucket=bucket,
        Key=f"{S3_PREFIX}/manifest.json",
        Body=json.dumps(manifest).encode(),
        ContentType="application/json",
    )
    print(f"published — fleet picks it up within ~6 minutes")


if __name__ == "__main__":
    main()
