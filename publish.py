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
    python publish.py lock                # after changing runtime/SDK_VERSION (network)

Canary: the tarball goes up as usual, but the manifest is written to
manifest-canary.json; the api (`release_manifest()`, `_RELEASE_CANARY_UIDS`)
serves it only to the listed users while it is newer than manifest.json.
`promote` copies it to manifest.json — same version number, same tarball.

SDK pin (runtime/SDK_VERSION): after changing it, `python publish.py lock`
resolves `claude-agent-sdk==<pin>` from wheels only for every platform the fleet
and the desktop run (SDK_TARGETS) and writes runtime/sdk-lock-<key>.txt — every
package of the tree pinned with the sha256 of each of its wheels. Commit those
with the pin; publish refuses a missing or stale lock and ships them in the
tarball (sdk_sync.py and provision install with --require-hashes). A pin PyPI has
no win_amd64 wheel for (0.2.157, 0.2.160–0.2.163) fails `lock`: on Windows it
would never install (or, without --only-binary, install with no bundled CLI).

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
# (lock key, pip --platform, --python-version): Linux cloud (Ubuntu 22.04), Windows
# cloud, Windows desktop, Mac desktop arm64 / Intel. The key is what
# sdk_pin.lock_key() computes on the machine itself.
SDK_TARGETS = [
    ("linux_x86_64-py3.10", "manylinux_2_17_x86_64", "3.10"),
    ("win_amd64-py3.14", "win_amd64", "3.14"),
    ("win_amd64-py3.12", "win_amd64", "3.12"),
    ("macosx_arm64-py3.12", "macosx_11_0_arm64", "3.12"),
    ("macosx_x86_64-py3.12", "macosx_11_0_x86_64", "3.12"),
]


def lock_path(key):
    return os.path.join(RUNTIME, f"sdk-lock-{key}.txt")


def _wheel_hashes(name, version):
    """Every wheel PyPI has for name==version: the machine's pip picks the wheel
    for its own tags (a newer manylinux than the one resolved here), and that
    file's hash has to be in the lock."""
    import urllib.request

    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as r:
        files = json.load(r)["urls"]
    return sorted({f["digests"]["sha256"] for f in files if f["filename"].endswith(".whl")})


def sdk_lock_text(pin, key, plat, py):
    """The pinned, hashed requirement set for one target, or None when pip cannot
    resolve `claude-agent-sdk==<pin>` there from wheels only. --dry-run reads the
    index metadata, so no wheel is downloaded."""
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "report.json")
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
             "--only-binary=:all:", "--platform", plat, "--python-version", py,
             "--implementation", "cp", "--target", os.path.join(tmp, "t"), "--quiet",
             "--disable-pip-version-check", "--report", report, f"claude-agent-sdk=={pin}"],
            capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return None
        items = json.load(open(report))["install"]
    lines = [f"# claude-agent-sdk=={pin} {key} — written by `python publish.py lock`, do not edit"]
    for it in sorted(items, key=lambda i: i["metadata"]["name"].lower()):
        name, version = it["metadata"]["name"], it["metadata"]["version"]
        hashes = " ".join(f"--hash=sha256:{h}" for h in _wheel_hashes(name, version))
        lines.append(f"{name}=={version} {hashes}")
    return "\n".join(lines) + "\n"


def write_locks(pin, targets=SDK_TARGETS):
    """(Re)write runtime/sdk-lock-<key>.txt for every target; returns the keys pip
    could not resolve (nothing is written for those — the old file is removed)."""
    bad = []
    for key, plat, py in targets:
        text = sdk_lock_text(pin, key, plat, py)
        if text is None:
            bad.append(key)
            if os.path.exists(lock_path(key)):
                os.remove(lock_path(key))
            continue
        with open(lock_path(key), "w", encoding="utf-8") as f:
            f.write(text)
    return bad


def stale_locks(pin, targets=SDK_TARGETS):
    """Targets whose committed lock is missing or was written for another pin."""
    bad = []
    for key, _, _ in targets:
        try:
            with open(lock_path(key), encoding="utf-8") as f:
                head = f.readline()
        except OSError:
            head = ""
        if not head.startswith(f"# claude-agent-sdk=={pin} {key} "):
            bad.append(key)
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
            if (name.endswith(".py") or name in ("VERSION", "SDK_VERSION", "jobs.json")
                    or (name.startswith("sdk-lock-") and name.endswith(".txt"))):
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


def _vkey(v):
    return tuple(int(x) for x in str(v).split("."))


def promote(s3=None, bucket=None):
    """Point manifest.json at the canary — only if the canary is newer than what the
    fleet has, and only if the tarball it names is byte-for-byte what it claims."""
    if s3 is None:
        s3, bucket = _s3()
    body = s3.get_object(Bucket=bucket, Key=f"{S3_PREFIX}/manifest-canary.json")["Body"].read()
    canary = json.loads(body)
    try:
        current = json.loads(
            s3.get_object(Bucket=bucket, Key=f"{S3_PREFIX}/manifest.json")["Body"].read())
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code not in ("404", "NoSuchKey", "NotFound"):
            raise
        current = {"latest": "0"}
    if _vkey(canary["latest"]) <= _vkey(current["latest"]):
        sys.exit(f"ERROR: canary {canary['latest']} is not newer than the fleet's "
                 f"{current['latest']} — nothing to promote")
    tar = s3.get_object(Bucket=bucket,
                        Key=f"{S3_PREFIX}/releases/{canary['latest']}.tar.gz")["Body"].read()
    if hashlib.sha256(tar).hexdigest() != canary["sha256"] or len(tar) != canary["size"]:
        sys.exit(f"ERROR: tarball {canary['latest']} does not match the canary manifest's "
                 f"sha256/size — not promoting")
    s3.put_object(Bucket=bucket, Key=f"{S3_PREFIX}/manifest.json", Body=body,
                  ContentType="application/json")
    print(f"promoted {canary['latest']} to the whole fleet — picked up within ~6 minutes")


def main():
    args = sys.argv[1:]
    if args[:1] == ["promote"]:
        return promote()
    if args[:1] == ["lock"]:
        pin = open(os.path.join(RUNTIME, "SDK_VERSION")).read().strip()
        bad = write_locks(pin)
        if bad:
            sys.exit(f"ERROR: claude-agent-sdk=={pin} has no wheel-only install for {', '.join(bad)} "
                     f"— pick a pin PyPI ships for every platform (runtime/SDK_VERSION)")
        print(f"wrote {len(SDK_TARGETS)} lock files for {pin} — commit them with the pin")
        return
    do_publish = args[:1] == ["publish"]
    canary = "--canary" in args
    version, data = build_tarball()
    sha = hashlib.sha256(data).hexdigest()
    manifest = {"latest": version, "sha256": sha, "size": len(data)}
    print(f"release {version}: {len(data)} bytes, sha256={sha}")
    pin = open(os.path.join(RUNTIME, "SDK_VERSION")).read().strip()
    stale = stale_locks(pin)
    if stale:
        sys.exit(f"ERROR: runtime/sdk-lock-*.txt missing or not for {pin}: {', '.join(stale)} "
                 f"— run `python publish.py lock` and commit the result")
    print(f"sdk pin {pin}: hash-locked for {len(SDK_TARGETS)} platforms")

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
