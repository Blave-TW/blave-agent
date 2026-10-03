"""Publish a runtime release to the central channel.

Packages runtime/ into a tar.gz, uploads it + an updated manifest to S3
(private bucket; machines never touch S3 — the api's /openclaw/agent/release/*
endpoints stream it to them behind proxy-token auth). Every deployed machine's
updater polls the manifest every 5 minutes, so an upload here reaches the whole
fleet within ~5 minutes (+60s api-side manifest cache).

Usage (from this repo's root; AWS creds come from the environment):
    python publish.py                     # dry-run: show what would ship
    python publish.py publish             # upload, whole fleet
    python publish.py publish --canary    # upload, only the api's canary user_ids
    python publish.py promote             # point the whole fleet at the canary version

Canary: the tarball goes up as usual, but the manifest is written to
manifest-canary.json; the api (`release_manifest()`, `_RELEASE_CANARY_UIDS`)
serves it only to the listed users while it is newer than manifest.json.
`promote` copies it to manifest.json — same version number, same tarball.

SDK pin (runtime/SDK_VERSION): every publish first checks that pip can resolve
`claude-agent-sdk==<pin>` from wheels only, for every platform the fleet and
the desktop run (SDK_TARGETS). PyPI has skipped the win_amd64 wheel for
several releases (0.2.157, 0.2.160–0.2.163); on Windows that pin would never
install (or, without --only-binary, install with no bundled CLI).

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
# (pip --platform, --python-version): Linux cloud (Ubuntu 22.04), Windows cloud,
# Windows desktop, Mac desktop arm64 / Intel.
SDK_TARGETS = [
    ("manylinux_2_17_x86_64", "3.10"),
    ("win_amd64", "3.14"),
    ("win_amd64", "3.12"),
    ("macosx_11_0_arm64", "3.12"),
    ("macosx_11_0_x86_64", "3.12"),
]


def sdk_preflight(pin, targets=SDK_TARGETS):
    """Names of the targets pip cannot resolve `claude-agent-sdk==<pin>` for from
    wheels only. --dry-run reads the index metadata, so no wheel is downloaded."""
    import subprocess
    import tempfile

    bad = []
    with tempfile.TemporaryDirectory() as tmp:
        for plat, py in targets:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
                 "--only-binary=:all:", "--platform", plat, "--python-version", py,
                 "--implementation", "cp", "--target", tmp, "--quiet",
                 "--disable-pip-version-check", f"claude-agent-sdk=={pin}"],
                capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                bad.append(f"{plat}/py{py}")
    return bad


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
            if name.endswith(".py") or name in ("VERSION", "SDK_VERSION", "jobs.json"):
                tar.add(os.path.join(RUNTIME, name), arcname=name)
        for name in unit_names:
            path = os.path.join(SYSTEMD, name)
            if not os.path.isfile(path):
                sys.exit(f"ERROR: jobs.json declares {name} but {SYSTEMD} lacks it "
                         f"(needs the api checkout beside this repo)")
            tar.add(path, arcname=name)
    return version, buf.getvalue()


def _s3():
    import boto3

    try:
        s3 = boto3.client(
            "s3",
            aws_access_key_id=os.environ["BLAVE_S3_KEY"],
            aws_secret_access_key=os.environ["BLAVE_S3_SECRET"],
            region_name=os.environ["BLAVE_S3_REGION"],
        )
        return s3, os.environ["BLAVE_S3_BUCKET"]
    except KeyError as e:
        # fail loudly and name the variable — a half-set environment must not
        # silently fall back to an ambient profile and publish to the wrong bucket
        sys.exit(f"ERROR: {e.args[0]} not set — see this file's docstring")


def _exists(s3, bucket, key):
    # Only a genuine 404 means "not there": a wrong bucket, bad key or wrong region
    # must NOT read as one (it used to be `except Exception: pass`, which fell
    # through to the upload).
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code not in ("404", "NoSuchKey", "NotFound"):
            raise
        return False
    return True


def promote():
    s3, bucket = _s3()
    body = s3.get_object(Bucket=bucket, Key=f"{S3_PREFIX}/manifest-canary.json")["Body"].read()
    manifest = json.loads(body)
    if not _exists(s3, bucket, f"{S3_PREFIX}/releases/{manifest['latest']}.tar.gz"):
        sys.exit(f"ERROR: canary names {manifest['latest']} but its tarball is missing")
    s3.put_object(Bucket=bucket, Key=f"{S3_PREFIX}/manifest.json", Body=body,
                  ContentType="application/json")
    print(f"promoted {manifest['latest']} to the whole fleet — picked up within ~6 minutes")


def main():
    args = sys.argv[1:]
    if args[:1] == ["promote"]:
        return promote()
    do_publish = args[:1] == ["publish"]
    canary = "--canary" in args
    version, data = build_tarball()
    sha = hashlib.sha256(data).hexdigest()
    manifest = {"latest": version, "sha256": sha, "size": len(data)}
    print(f"release {version}: {len(data)} bytes, sha256={sha}")
    pin = open(os.path.join(RUNTIME, "SDK_VERSION")).read().strip()
    bad = sdk_preflight(pin)
    if bad:
        sys.exit(f"ERROR: claude-agent-sdk=={pin} has no wheel-only install for {', '.join(bad)} "
                 f"— pick a pin PyPI ships for every platform (runtime/SDK_VERSION)")
    print(f"sdk pin {pin}: wheels resolve on {len(SDK_TARGETS)} platforms")

    if not do_publish:
        print("dry-run only — rerun with `publish` to upload")
        return

    s3, bucket = _s3()
    tar_key = f"{S3_PREFIX}/releases/{version}.tar.gz"
    # refuse to overwrite an existing version — rolled-back machines skip
    # re-attempts of the same number, so a silent overwrite would strand them.
    if _exists(s3, bucket, tar_key):
        print(f"ERROR: {version} already published — bump runtime/VERSION first")
        sys.exit(1)

    s3.put_object(Bucket=bucket, Key=tar_key, Body=data)
    s3.put_object(
        Bucket=bucket,
        Key=f"{S3_PREFIX}/manifest-canary.json" if canary else f"{S3_PREFIX}/manifest.json",
        Body=json.dumps(manifest).encode(),
        ContentType="application/json",
    )
    if canary:
        print("published to the canary users only — `python publish.py promote` for the fleet")
    else:
        print("published — fleet picks it up within ~6 minutes")


if __name__ == "__main__":
    main()
