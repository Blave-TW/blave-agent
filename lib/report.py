"""
Report helper — build a report and drop it in `workspace/reports/`.

A report is a JSON document the platform stores and the web workspace renders in
its Reports list (charts, KPI rows, tables, prose). The machine publishes one by
landing a file at `workspace/reports/<id>.json`. **The write is the finish line:**
the runtime's uploader (a 2-minute timer) ships it and moves the file to
`reports/sent/`, or to `reports/failed/` plus a line in
`reports/upload_errors.log`. Do not wait for the upload before saying the report
is produced.

This module is a convenience only — the drop directory is the contract, so a
report written with `json.dump` into that path works exactly the same. What it
saves you: the atomic write the contract requires, the envelope boilerplate, the
mandatory leading `meta` block, the image sidecar (written before the JSON, in
the order the contract requires), and the three-directory status check.

Block types and their fields: `references/reports.md`.

A report is never overwritten: when the id is taken, the report is written under the next
free one (`<id>-2`, `-3`, …) and the earlier report and its pictures stay as they were.
`write_report` returns the path it wrote. Two exceptions, both narrow: `replace=True`
rewrites what THIS turn wrote under that id (correcting your own report), and `edit_report`
changes the one report the user named, where it is (its title, a paragraph, a typo).

Usage:
    from lib.report import write_report

    path = write_report(
        "mcpt-2317-20260901",
        "2317 策略績效勝過 98.8% 的隨機排列",
        [
            {"type": "text", "variant": "lead", "markdown": "p = 0.012..."},
            {"type": "kpi_row", "items": [
                {"label": "p-value", "value": "0.012", "tone": "neutral"}]},
            {"type": "image", "file": "perm.png", "alt": "permutation histogram"},
        ],
        type="research",
        report_type="一次性",
        images={"perm.png": open("tmp/perm.png", "rb").read()},
    )

Diagnosis only — never the next step after `write_report`. Reach for it when a
report never appeared or you suspect it was refused:

    from lib.report import status
    status("mcpt-2317-20260901")   # 'pending' | 'sent' | 'failed: <reason>' | 'unknown'
"""

import json
import os
import re
import shutil
import time
import unicodedata
from zoneinfo import ZoneInfo

# The uploader scans $BLAVE_AGENT_WORKSPACE/reports, so that env var wins when it
# is set. It is often absent though: scheduled strategy subprocesses are started
# with a minimal env that strips every BLAVE_* variable, so fall back to the
# directory this file lives in (lib/ is always inside the workspace).
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
REPORTS_DIR = os.path.join(WORKSPACE, "reports")
SENT_DIR = os.path.join(REPORTS_DIR, "sent")
FAILED_DIR = os.path.join(REPORTS_DIR, "failed")
ERROR_LOG = os.path.join(REPORTS_DIR, "upload_errors.log")

_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
# An `image` block's `file`: a plain name inside the sidecar, never a path. This one
# IS checked here — the name is used to open a file for writing, so `../` would put
# bytes outside the drop dir. Everything else about the picture (extension, size) is
# the uploader's call, and it reports through reports/upload_errors.log.
_FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
FILES_SUFFIX = ".files"
# ≈ 40 CJK / 80 Latin: the public share page cuts a title at ~50 CJK, so this leaves a margin.
RESEARCH_TITLE_WIDTH = 80
# Cited web images (an `image` block with `source`, references/reports.md › Citing an image
# from the web). The api sets no cap on purpose: a 400 files the whole report as failed, and a
# third citation is not a broken document — so the cap lives here, where the agent can fix it.
CITED_IMAGES_MAX = 2
# What the desktop's browser_capture names the files it drops into <id>.files/ (shell/browser/capture.js).
CAPTURE_PREFIX = "cite-"


# Every id write_report has used on this machine, one JSON line each {id, asked, turn, at}. Two
# jobs: on a cloud machine the uploader keeps only the last ~20 files in sent/, so the files alone
# forget which ids are taken; and `replace=True` finds what this turn wrote through it.
LEDGER = os.path.join(REPORTS_DIR, ".written.jsonl")
LEDGER_KEEP = 5000
# publish()'s data-only suffix. The runtime tells a data-only report by an id ENDING in it
# (report_runner._published), so a serial number goes in front of it, never after.
AUTO_SUFFIX = "-auto"
_ID_MAX = 64


def _ledger():
    """[(id, asked, turn)] oldest first; unreadable lines are skipped."""
    out = []
    try:
        with open(LEDGER, encoding="utf-8") as f:
            for ln in f:
                try:
                    d = json.loads(ln)
                    out.append((d["id"], d.get("asked") or d["id"], d.get("turn")))
                except (ValueError, KeyError, TypeError):
                    continue
    except OSError:
        pass
    return out


def _note_written(report_id, asked, at):
    """Best-effort: the report itself is already on disk."""
    try:
        line = json.dumps({"id": report_id, "asked": asked, "turn": os.environ.get("BLAVE_TURN_ID") or None, "at": at})
        with open(LEDGER, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        with open(LEDGER, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > LEDGER_KEEP:
            _write_text_atomic(LEDGER, "".join(lines[-LEDGER_KEEP:]))
    except OSError:
        pass


def _on_disk(report_id):
    return any(os.path.exists(os.path.join(d, report_id + ".json")) for d in (REPORTS_DIR, SENT_DIR))


def _serial(report_id, n):
    """The n-th id of `report_id`: itself, then `-2`, `-3`, … — in front of a trailing `-auto`,
    and cut to fit the 64 characters an id may have."""
    if n < 2:
        return report_id
    tail = AUTO_SUFFIX if report_id.endswith(AUTO_SUFFIX) and len(report_id) > len(AUTO_SUFFIX) else ""
    suffix = f"-{n}{tail}"
    return report_id[:len(report_id) - len(tail)][:_ID_MAX - len(suffix)] + suffix


def _free_id(report_id, taken=()):
    """First id of the series with no report file in reports/ or reports/sent/ (and not in
    `taken`). With `taken` empty this is, rule for rule, where the desktop's browser_capture
    puts a picture (shell/browser/capture.js citeSlot) — change both or neither."""
    n = 1
    while _serial(report_id, n) in taken or _on_disk(_serial(report_id, n)):
        n += 1
    return _serial(report_id, n)


def _own(report_id):
    """The id this turn wrote when it asked for (or was given) `report_id`, or None. No turn id
    (a scheduled run.py, a script outside a turn) = nothing is ever its own."""
    turn = os.environ.get("BLAVE_TURN_ID")
    hit = None
    for rid, asked, t in _ledger() if turn else ():
        if t == turn and report_id in (rid, asked):
            hit = rid
    return hit


def target_id(report_id, replace=False):
    """The id `write_report(report_id, replace=replace)` writes to right now. An id whose only
    copy sits in reports/failed/ is free: the platform never took that report, and writing the
    id again is how it is fixed (the uploader then clears the refused copy)."""
    own = _own(report_id) if replace else None
    return own or _free_id(report_id, {rid for rid, _, _ in _ledger()
                                        if not os.path.exists(os.path.join(FAILED_DIR, rid + ".json"))})


def _capture_dirs(asked, final):
    """Sidecar directories that can hold this report's captures, the report's own first. None of
    them belongs to a report written in an earlier turn: each id is either free or this turn's."""
    ids = dict.fromkeys((final, _free_id(asked), _free_id(final)))
    return [os.path.join(REPORTS_DIR, i + FILES_SUFFIX) for i in ids]


def _captures_in(d):
    try:
        return sorted(n for n in os.listdir(d) if n.startswith(CAPTURE_PREFIX) and _FILE_RE.fullmatch(n))
    except OSError:
        return []


def captured_files(report_id, replace=False):
    """File names browser_capture left for the report `write_report(report_id, replace=replace)`
    is about to write, sorted."""
    final = target_id(report_id, replace)
    return sorted({n for d in _capture_dirs(report_id, final) for n in _captures_in(d)})


def _gather_files(asked, final, blocks):
    """Bring every picture the blocks name into `<final>.files/`. A capture waiting in another
    of this report's directories is moved; a picture the producer put into `<asked>.files/` by
    hand is copied, because that directory may belong to an earlier report."""
    home = os.path.join(REPORTS_DIR, final + FILES_SUFFIX)
    moves = [d for d in _capture_dirs(asked, final) if d != home]
    copies = [os.path.join(REPORTS_DIR, asked + FILES_SUFFIX)] if asked != final else []
    for name in {b.get("file") for b in blocks if isinstance(b, dict) and b.get("type") == "image"}:
        if not isinstance(name, str) or not _FILE_RE.fullmatch(name) or os.path.exists(os.path.join(home, name)):
            continue
        capture = name.startswith(CAPTURE_PREFIX)
        for d in (moves if capture else []) + copies:
            src = os.path.join(d, name)
            if not os.path.isfile(src) or os.path.islink(src):
                continue
            os.makedirs(home, exist_ok=True)
            if capture and d in moves:
                os.replace(src, os.path.join(home, name))
            else:
                shutil.copyfile(src, os.path.join(home, name))
            break


def _sweep_captures(asked, final, blocks):
    """Delete the captured pictures no image block of the report just written refers to — a
    capture that was tried and not used would otherwise sit in the sidecar for good. Only
    browser_capture's own files; pictures handed to `write_report(images=…)` are never touched."""
    used = {b.get("file") for b in blocks if isinstance(b, dict) and b.get("type") == "image"}
    home = os.path.join(REPORTS_DIR, final + FILES_SUFFIX)
    gone = []
    for d in _capture_dirs(asked, final):
        for name in _captures_in(d):
            if d == home and name in used:
                continue
            try:
                os.remove(os.path.join(d, name))
                gone.append(name)
            except OSError as e:
                print(f"WARNING: unused capture {name} not removed: {e}")
        if d != home:
            try:
                os.rmdir(d)   # only when empty
            except OSError:
                pass
    return gone


def _research_warnings(title, blocks):
    """Two points of the research skeleton (references/reports.md §7b) that decide how a
    report reads when only its head is seen.
    Advisory only: a refused report is lost, a weak one can be rewritten. `blocks[0]`
    is the meta block by the time this runs, and its `title` is the one the web renders —
    a caller-supplied meta may differ from the envelope title."""
    out = []
    shown = blocks[0].get("title", title) if blocks and isinstance(blocks[0], dict) else title
    width = sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in str(shown))
    if width > RESEARCH_TITLE_WIDTH:
        out.append(f"research title is {width} wide (CJK counts 2), over {RESEARCH_TITLE_WIDTH}; "
                   "the report list truncates it, state the claim shorter "
                   "(references/reports.md 7b)")
    i = 1
    if i < len(blocks) and isinstance(blocks[i], dict) and blocks[i].get("variant") == "lead":
        i += 1
    if not (i < len(blocks) and isinstance(blocks[i], dict) and blocks[i].get("type") == "kpi_row"):
        out.append("research report has no kpi_row right after the lead; its first item is the "
                   "key number readers see first (references/reports.md 7b)")
    return out


def _shareable_warnings(type, meta):
    """`meta.shareable` (references/reports.md 7b B7) is the research self-check record and no
    longer gates sharing, so a missing one only nags; a non-bool is refused by the api."""
    return _shareable_only(type, meta)


def _shareable_only(type, meta):
    if "shareable" not in meta:
        return ["research report has no meta.shareable; record it true or false on purpose "
                "(references/reports.md 7b B7)"] if type == "research" else []
    if not isinstance(meta["shareable"], bool):
        return [f"meta.shareable must be true or false, got {meta['shareable']!r}; the api "
                "refuses the report (references/reports.md 7b B7)"]
    if type != "research":
        return [f"meta.shareable has no meaning on a {type} report, only on research; "
                "leave it out (references/reports.md 7b B7)"]
    return []


_FN_TEXT_MAX = 1000    # = api report_blocks_validate._v_footnote
_FN_ID_MAX = 32
_CLOSERS = ")）」』】》”’\"'"


def join_notes(texts):
    """Footnote fragments as one line: a fragment that does not end in punctuation gets a full
    stop first (a fragment ending in ";" is carrying on into the next one and stays as it is)."""
    out = ""
    for t in texts:
        t = t.strip()
        core = t.rstrip(_CLOSERS)
        if core and not unicodedata.category(core[-1]).startswith("P"):
            t += "。" if re.search("[\u3400-\u9fff]", t) else "."
        out += t
    return out


def unique_footnotes(blocks):
    """(blocks, the ids that were repeated). The api refuses a footnote block whose item ids
    repeat, and `[^id]` in the text resolves to the first row with that id — so a repeated id
    is joined into that first row (the reference then reaches all of it). Only when the two
    cannot be one row (different links, or over the text cap) does the later one get a new id
    (`src-2`). Mirrored in runtime/report_uploader.py and shell/reportshare.js;
    tests/check_report_footnotes.py runs the three on the same cases."""
    fixed, out = [], []
    for b in blocks:
        if not (isinstance(b, dict) and b.get("type") == "footnote" and isinstance(b.get("items"), list)):
            out.append(b)
            continue
        rows, first = [], {}
        for it in b["items"]:
            if not (isinstance(it, dict) and isinstance(it.get("id"), str) and isinstance(it.get("text"), str)):
                rows.append(it)
                continue
            head = first.get(it["id"])
            if head is None:
                it = dict(it)
                first[it["id"]] = it
                rows.append(it)
                continue
            fixed.append(it["id"])
            if head.get("url") == it.get("url"):
                if it["text"].strip() in head["text"]:
                    continue
                joined = join_notes([head["text"], it["text"]])
                if len(joined) <= _FN_TEXT_MAX:
                    head["text"] = joined
                    continue
            n, taken = 2, {r.get("id") for r in b["items"] if isinstance(r, dict)} | set(first)
            while f"{it['id'][:_FN_ID_MAX - 4]}-{n}" in taken:
                n += 1
            it = dict(it, id=f"{it['id'][:_FN_ID_MAX - 4]}-{n}")
            first[it["id"]] = it
            rows.append(it)
        out.append(dict(b, items=rows))
    return out, sorted(set(fixed))


def _write_bytes(path, data):
    """One sidecar picture, written the way the report itself is: into a `.tmp` the
    uploader's scan ignores, then `os.replace()` so it appears whole or not at all."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _mark_scheduled(report_id):
    """A scheduled agent run (the runner sets BLAVE_SCHEDULED_JOB for that turn) records which
    report it produced, so report_runner can tell its own report from anything else written in
    the same minutes. Best-effort: the report itself is already on disk."""
    job = os.environ.get("BLAVE_SCHEDULED_JOB")
    if not job or not _JOB_ID_RE.fullmatch(job):
        return
    try:
        d = os.path.join(JOBS_DIR, job)
        if os.path.isdir(d):
            with open(os.path.join(d, ".published"), "a", encoding="utf-8") as f:
                f.write(report_id + "\n")
    except OSError:
        pass


def write_report(report_id, title, blocks, type="research", report_type=None,
                 created_at=None, meta=None, images=None, replace=False):
    """Write one report into the drop directory. Returns the path of the file written.

    report_id   `[A-Za-z0-9_-]{1,64}`; the id you ask for. When no report has it, it is
                the file name and the report id. When one has, this report gets the
                next free id (`<id>-2`, `-3`, …; `<id>-2-auto` for an id ending in
                `-auto`) and the earlier report and its pictures are left as they are:
                every run is kept, nothing is ever overwritten by default. Do NOT use
                the runtime's own ids (`daily-YYYY-MM-DD`, `wk-YYYY-MM-DD`).
    replace     True = rewrite the report THIS turn wrote under `report_id` (the id you
                asked for then, or the one it got) — for correcting your own report
                before you reply. Anything written in an earlier turn, by a scheduled
                run or by another process is never replaced: the report is then
                written as a new one, as if `replace` were not given.
    title       1–200 chars; shown in the report list and the push notification.
    blocks      the block list (see `references/reports.md`). A `meta` block is
                prepended unless blocks[0] already is one.
    type        `performance` / `morning` / `research` — report list grouping.
    report_type display string for the report header ("績效週報", "一次性");
                defaults to `type`.
    created_at  unix seconds, int; defaults to now.
    meta        extra props for the generated meta block (`period`, `account`,
                `benchmark`, `origin`, `machine`, `extra`, and on research the
                `shareable` boolean of references/reports.md 7b B7, which makes the
                report schema 1.3).
    images      `{file name: bytes}` for the picture sidecar `<id>.files/`, named
                from an `image` block as `{"type": "image", "file": "perm.png",
                "alt": ...}`. The uploader carries the bytes and swaps `file` for
                the `sha256` the platform stores — which is the only way to get a
                figure out of a scheduled run, where the machine token is stripped
                from the environment. png / jpg / jpeg / webp / gif, ≤2MB each.

    A footnote id used more than once is joined into one footnote line (`unique_footnotes`).
    Nothing else here is validated beyond the report id, the image file names (a name
    becomes a path on this disk, so it may not be one) and the cap of CITED_IMAGES_MAX
    image blocks carrying `source` (the api has no such cap): the api is the only validator,
    and a second copy of the rules on this side would drift and start refusing reports
    the platform accepts. A rejected report lands in `reports/failed/` with the
    api's message (it names the offending field path) in `upload_errors.log`.
    For `type="research"` two points of the §7b skeleton (title width, a `kpi_row`
    right after the lead) and a missing `meta.shareable` are printed as `WARNING:`
    lines, as is a `shareable` that is not a bool or sits on another type — advice,
    never a refusal.
    """
    if not isinstance(report_id, str) or not _ID_RE.fullmatch(report_id):
        raise ValueError(f"report id {report_id!r} must match [A-Za-z0-9_-]{{1,64}}")
    return _write(report_id, target_id(report_id, replace), title, blocks, type, report_type,
                  created_at, meta, images)


def _write(asked, report_id, title, blocks, type, report_type, created_at, meta, images, edited=False):
    """The one place a report file is written. `asked` is the id the caller named, `report_id`
    the id it is written under; `edited` = the user's own report changed in place."""
    # Check every name before writing any of them: a bad one halfway through would
    # otherwise leave a sidecar holding some of the pictures and raise anyway.
    for name in images or {}:
        if not isinstance(name, str) or not _FILE_RE.fullmatch(name):
            raise ValueError(f"image name {name!r} must be a plain file name "
                             "matching [A-Za-z0-9][A-Za-z0-9._-]{0,79}, not a path")
    # The api refuses repeated footnote ids, on a cloud upload and on a public link alike:
    # put right here, where every report is written, not found out when the user shares it.
    blocks, repeated = unique_footnotes(list(blocks))
    cited = [i for i, b in enumerate(blocks)
             if isinstance(b, dict) and b.get("type") == "image" and "source" in b]
    if len(cited) > CITED_IMAGES_MAX:
        raise ValueError(f"{len(cited)} cited images (image blocks with source) at blocks "
                         f"{cited}; at most {CITED_IMAGES_MAX} per report. Keep the ones a claim "
                         f"in the text rests on and drop blocks {cited[CITED_IMAGES_MAX:]} "
                         "(references/reports.md > Citing an image from the web)")
    created_at = int(created_at if created_at is not None else time.time())
    if not blocks or not (isinstance(blocks[0], dict) and blocks[0].get("type") == "meta"):
        head = {"type": "meta", "title": title,
                "report_type": report_type or type, "generated_at": created_at}
        head.update(meta or {})
        blocks.insert(0, head)
    # Each bump only when its content is present, so a report without it is still accepted
    # by an api one version behind. 1.4 = a news block, a `private` block or a footnote link. The 1.3 meta flags count by presence: an explicit false
    # is still a prop a 1.1/1.2 validator refuses.
    if cited:
        version = "1.6"   # image 的引用來源;1.6 是 1.5 的超集
    elif any(isinstance(b, dict) and b.get("type") == "bar_chart" and b.get("variant") == "profile" for b in blocks):
        version = "1.5"   # 連續數值軸剖面(爆倉地圖);1.5 是 1.4 的超集
    elif any(isinstance(b, dict) and (b.get("type") == "news" or "private" in b
                                      or (b.get("type") == "footnote"
                                          and any("url" in i for i in b.get("items") or [])))
             for b in blocks):
        version = "1.4"
    elif "shareable" in blocks[0] or "involves_futures" in blocks[0]:
        version = "1.3"
    elif any(isinstance(b, dict) and b.get("type") == "candlestick" for b in blocks):
        version = "1.2"
    else:
        version = "1.1"
    doc = {"schema_version": version, "id": report_id, "type": type,
           "title": title, "created_at": created_at, "blocks": blocks}

    os.makedirs(REPORTS_DIR, exist_ok=True)
    # Pictures first, JSON last — the report landing is what makes the set visible to
    # the uploader, so everything it references must already be on disk. Raising here
    # leaves a sidecar with no report, which the uploader sweeps after a day.
    _gather_files(asked, report_id, blocks)
    for name, data in (images or {}).items():
        _write_bytes(os.path.join(REPORTS_DIR, report_id + FILES_SUFFIX, name), data)
    path = os.path.join(REPORTS_DIR, report_id + ".json")
    # Atomic: the uploader may scan mid-write. The temp name must not end in
    # `.json` or the scan would pick up the half-written file.
    tmp = path + ".tmp"
    # utf-8 explicitly — titles carry Chinese and a Windows machine's locale
    # default (cp950) raises on them. allow_nan=False so a NaN fails here, with
    # a stack trace, instead of being refused by the api hours later.
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, allow_nan=False)
        os.replace(tmp, path)
    except Exception:
        # A half-written .tmp is inert (the uploader only scans `.json`), but leaving
        # one behind after every rejected NaN just accumulates confusing litter.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    _sweep_captures(asked, report_id, blocks)
    if _own(report_id) != report_id:
        _note_written(report_id, asked, created_at)
    # ASCII only: a report job's stdout goes to run.log in the Windows locale codec (cp950),
    # and an unencodable advisory line would fail a run whose report is already written.
    _mark_scheduled(report_id)
    if repeated:
        print(f"[report] footnote id(s) {', '.join(repeated)} were used more than once: each is now one footnote "
              "line. Next time give every footnote item its own id.")
    warnings = _research_warnings(title, blocks) if type == "research" else []
    warnings += _shareable_warnings(type, blocks[0])
    for w in warnings:
        print(f"WARNING: {w}")
    if report_id != asked:
        print(f"[report] {asked} was already a report, so this one is a NEW report, written as {report_id}; "
              "the earlier one is untouched. Nothing to fix, and nothing to tell the user about ids or numbers.")
    if edited:
        print(f"[report] {report_id} changed in place: the same report, in the same place in the list. A public "
              "link to it keeps showing the version that was shared until the user updates it from the report's "
              "title bar; say so only if the user asks about the link.")
    elif os.environ.get("BLAVE_TURN_ID"):
        print("[report] To correct THIS report before you reply, write it again with the same id and replace=True; "
              "without it the correction becomes one more report.")
    # Agents re-read reports/<id>.json to "verify" and hit FileNotFoundError once the uploader
    # has moved it (uid=1: five times in three turns) — say where the file goes before they try.
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        # 電腦版:app 不自己打開報告,回覆底下出一張結果卡讓人點開——講「已打開」就是謊報
        print(f"[report] {report_id}.json written to This computer > Reports (not the cloud machine). The app "
              "shows a card under your reply that opens it: say the report is ready and do not say it is open. "
              "Do not read it back and do not poll its status; reply now.")
    else:
        print(f"[report] {report_id}.json written. The uploader moves it to reports/sent/, so do not "
              f"read reports/{report_id}.json back; if you need it again, open "
              f"reports/sent/{report_id}.json. It appears in the workspace Reports list (Reports in the sidebar) shortly. "
              "Nothing to check; reply now.")
    # 報告已經打開(或在清單裡)了:聊天只講結論,不把報告再念一遍(設計稽核 B6;canon Copy › 文案密度)
    print("[report] Chat reply: one or two sentences after the one saying where the report is - ONE conclusion and "
          "ONE thing to watch. Do not restate the report: no heading, no bold label, no list, no figure it "
          "already shows, and no status line about this run (such as 'Published successfully.').")
    return path


def edit_report(report_id, title=None, change=None, images=None):
    """Change the ONE report the user named, where it is. Returns the path written.

    For 「把這份報告的標題改成…」, a paragraph to rewrite, a typo: the report keeps its id,
    its `created_at` (so its place in the list) and its pictures. Never for a report the
    user did not name, and never for 「再做一份」 / 「重做」 — that is a new report
    (`write_report` / `publish`). Do not edit the JSON file yourself: that skips the checks,
    the schema version, the sweep of unused captures and the ledger.

    report_id   the id of the report to change; it must be on this machine (`reports/`, or
                `reports/sent/` on a cloud machine, which keeps the last ~20).
    title       the new title, when the title changes.
    change      a function that takes the report's block list (a copy) and edits it in place
                or returns a new list: `lambda blocks: blocks[3].update(markdown="…")`.
    images      `{file name: bytes}` to add to (or replace in) the picture sidecar.

    A report that is shared by public link keeps showing the version that was shared; only the
    user can update the public version (a button in the report's title bar).
    """
    if not isinstance(report_id, str) or not _ID_RE.fullmatch(report_id):
        raise ValueError(f"report id {report_id!r} must match [A-Za-z0-9_-]{{1,64}}")
    if title is None and change is None and not images:
        raise ValueError("edit_report needs something to change: title=, change= or images=")
    home = next((d for d in (REPORTS_DIR, SENT_DIR) if os.path.isfile(os.path.join(d, report_id + ".json"))), None)
    if home is None:
        raise FileNotFoundError(f"no report {report_id!r} on this machine (reports/ and reports/sent/), so it cannot "
                                "be changed here. Do not write a new report under that id: tell the user this one "
                                "cannot be changed from here and offer to make a new one.")
    with open(os.path.join(home, report_id + ".json"), encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or not isinstance(doc.get("blocks"), list):
        raise ValueError(f"report {report_id!r} is not a report document (no block list)")
    blocks = json.loads(json.dumps(doc["blocks"]))
    if change is not None:
        out = change(blocks)
        blocks = blocks if out is None else list(out)
    if title is not None:
        if blocks and isinstance(blocks[0], dict) and blocks[0].get("type") == "meta":
            blocks[0]["title"] = title
    # A report already uploaded sits in sent/ with its pictures: the rewritten one goes back
    # into the drop directory, so the pictures its blocks still name come back with it.
    if home == SENT_DIR:
        side = os.path.join(SENT_DIR, report_id + FILES_SUFFIX)
        for name in {b.get("file") for b in blocks if isinstance(b, dict) and b.get("type") == "image"}:
            src = os.path.join(side, name) if isinstance(name, str) and _FILE_RE.fullmatch(name) else None
            if src and os.path.isfile(src) and not os.path.islink(src) and name not in (images or {}):
                with open(src, "rb") as f:
                    _write_bytes(os.path.join(REPORTS_DIR, report_id + FILES_SUFFIX, name), f.read())
    return _write(report_id, report_id, doc.get("title") if title is None else title, blocks,
                  doc.get("type", "research"), None, doc.get("created_at"), None, images, edited=True)


JOBS_DIR = os.path.join(WORKSPACE, "report_jobs")
TIMEZONE_PATH = os.path.join(WORKSPACE, "state", "timezone")
_TZ_MAX = 64
_JOB_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_CRON_FIELD_RE = re.compile(r"[0-9*,/-]+")
_CRON_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))


def _check_cron(cron):
    """The 5 normalised fields, or raise ValueError. Same grammar the runtime
    evaluates (numbers, `*`, ranges, lists, `/step`; minute 0–59, hour 0–23, day 1–31,
    month 1–12, weekday 0–7) — a registration that passes here shows up with a real
    next-run time instead of as a broken file the user can only delete."""
    fields = cron.split() if isinstance(cron, str) else []
    if len(fields) != 5 or not all(_CRON_FIELD_RE.fullmatch(f) for f in fields):
        raise ValueError(f"cron {cron!r} must be 5 fields of [0-9*,/-] (minute hour dom month dow)")
    for field, (lo, hi) in zip(fields, _CRON_RANGES):
        for part in field.split(","):
            step = 1
            if "/" in part:
                part, step_s = part.split("/", 1)
                if not step_s.isdigit() or int(step_s) < 1:
                    raise ValueError(f"cron {cron!r}: bad step in {field!r}")
                step = int(step_s)
            if part == "*":
                continue
            bounds = part.split("-", 1) if "-" in part else [part]
            if not all(b.isdigit() for b in bounds):
                raise ValueError(f"cron {cron!r}: bad value {part!r} in {field!r}")
            a, b = int(bounds[0]), int(bounds[-1])
            if a < lo or b > hi or a > b:
                raise ValueError(f"cron {cron!r}: {part!r} outside {lo}–{hi} in {field!r}")
    return fields


def _write_text_atomic(path, text):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _machine_timezone():
    """The IANA zone the platform recorded for this machine's user, or "" (never set,
    unreadable, or a value that no longer resolves)."""
    try:
        with open(TIMEZONE_PATH, encoding="utf-8-sig") as f:
            tz = f.readline(_TZ_MAX + 1).strip()
    except FileNotFoundError:
        return ""  # never set — the caller's error message is the one that matters
    except (OSError, UnicodeDecodeError) as e:
        print(f"Error: {e}")
        return ""
    return tz if _tz_ok(tz) else ""


def set_timezone(tz):
    """Record which time zone the user is in (`state/timezone`, one IANA name). Returns it.

    The platform writes this from the user's browser when they open the workspace page, so
    you normally never call it. Call it when `register_schedule` tells you the machine has
    no time zone on record: ASK the user which zone they are in (「你在哪個時區?」), pass
    what they answer, then register. Never guess it from their language, their symbols or
    this machine's clock — every scheduled report they own is read in this zone.
    The platform's own write carries `if_unset`, so it will not overwrite what you set here.
    """
    if not _tz_ok(tz):
        raise ValueError(f"tz {tz!r} must be an IANA time zone name, e.g. 'Asia/Taipei' — "
                         "ask the user which time zone they are in")
    os.makedirs(os.path.dirname(TIMEZONE_PATH), exist_ok=True)
    _write_text_atomic(TIMEZONE_PATH, tz + "\n")
    return tz


def _tz_ok(tz):
    if not isinstance(tz, str) or not 1 <= len(tz) <= _TZ_MAX:
        return False
    try:
        ZoneInfo(tz)
    except (KeyError, ValueError):
        return False
    return True


# 雲端排程報告每份一輪 agent 的估價(點 = TWD,每份)。Claude:09-26 Sonnet 實測 0.46–0.55 USD/份
# × 1.25 markup × 32(pricing.md 的扣費公式)≈ 18–22 點,加 web search 每次 0.4 點。
# 上限是 1.0 USD(runtime agent_turn SCHEDULED_MAX_BUDGET_USD)= 1.0 × 1.25 × 32 = 40 點,超過就停、改出純資料版。
# 每次跑用的是用戶「當時」的模型偏好,不是登記那一刻的,所以估價只能講「依你當時的模型」。
SCHEDULED_COST_TWD = {"claude": (18, 25), "deepseek": (0.5, 1)}


def scheduled_cost(model=None):
    """(low, high) TWD a scheduled agent run costs on `model` (default: the model this turn runs
    on, BLAVE_TURN_MODEL). Quote it when registering (references/reports.md §1b R8)."""
    m = (model or os.environ.get("BLAVE_TURN_MODEL") or "").lower()
    return SCHEDULED_COST_TWD["deepseek" if "deepseek" in m else "claude"]


def scheduled_agent_available():
    """False on the desktop (data-only scheduled reports this version) and on a trial / one-slot
    cloud machine (its only turn slot stays the user's). Then R8 asks nothing: the scheduled
    version is data only."""
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        return False
    state = os.environ.get("BLAVE_AGENT_STATE") or os.path.join(os.path.dirname(WORKSPACE), "state")
    try:
        with open(os.path.join(state, "turn_limits.json"), encoding="utf-8") as f:
            d = json.load(f)
        return int(d.get("max_turns")) > 1 and not d.get("trial")
    except (OSError, ValueError, TypeError, AttributeError):
        # 讀不到名額設定就不知道是不是試用機:不當成可用(試用機不能登記成同意;同 report_runner.check_upgrade)
        return False


def register_schedule(id, title, prompt, cron, human, script, enabled=True, tz=None, agent_consent=None):
    """Register (or update) a scheduled report: writes `report_jobs/<id>/run.py` and
    `job.json`. Returns the job directory. The runtime reads that file, fires the script
    when the cron comes due, records each run and reports the list to the web — never
    touch crontab / schtasks yourself.

    id      `[a-z0-9][a-z0-9-]{0,39}`, a slug (`perf-4h`, `tsmc-morning`); same id =
            update (keeps `created_at`, bumps `updated_at`, clears any pending edit).
    title   1–80 chars, the list row.
    prompt  1–2000 chars — the user's own words, verbatim, not your rewrite; the
            web shows it back to them as the report's description.
    cron    standard 5-field cron (no `@daily`, no seconds), **written in the user's own
            wall-clock time, exactly as they said it**: 台北 08:30 is `30 8 * * *`, full
            stop. Do NOT convert it to the machine's clock — the runtime evaluates the
            cron in `tz` (below), so a conversion would shift the report by that offset
            a second time. The same expression works on Linux and Windows.
    human   1–60 chars, the schedule in words (「每 4 小時」「每個交易日 08:30」);
            the only form the user ever sees, so make it match the cron exactly.
    script  the full text of run.py. It runs like a scheduled strategy: cwd is the
            workspace, every `BLAVE_*` variable stripped, no machine token; it
            publishes by writing into `reports/` (write_report / templates
            `publish(pack)`), and writes nothing when there is nothing to report.
    agent_consent  True only after you told the user a scheduled run wakes you and costs about
            `scheduled_cost()` points each time (on whatever model they are on then) and they
            said yes; False when they withdraw it; None (default) keeps what the job had — an
            edit does not drop it. Without it the job runs data-only, as every job registered
            before this existed does. True needs `scheduled_agent_available()` and a cron that
            fires at most hourly (one fixed minute) (references/reports.md §8).
    tz      IANA zone the cron is read in. Leave it out: it is taken from the machine's
            own setting (`state/timezone`, written by the platform from the user's
            browser). If that is missing this raises — ask the user which time zone they
            are in, record it with `set_timezone()`, then register; never guess one.
    """
    if not isinstance(id, str) or not _JOB_ID_RE.fullmatch(id):
        raise ValueError(f"job id {id!r} must match [a-z0-9][a-z0-9-]{{0,39}}")
    for name, value, cap in (("title", title, 80), ("prompt", prompt, 2000), ("human", human, 60)):
        if not isinstance(value, str) or not 1 <= len(value) <= cap:
            raise ValueError(f"{name} must be a string of 1–{cap} characters")
    fields = _check_cron(cron)
    if not isinstance(script, str) or not script.strip():
        raise ValueError("script must be the full text of run.py")
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be True or False")
    if tz is None:
        tz = _machine_timezone()
    if not tz:
        raise ValueError(
            "this machine has no time zone on record (workspace/state/timezone), so the "
            "wall clock your cron would be read in is unknown. Ask the user which time "
            "zone they are in, record it with lib.report.set_timezone('Asia/Taipei'), then "
            "register again — do not guess it and do not convert the time yourself")
    if not _tz_ok(tz):
        raise ValueError(f"tz {tz!r} must be an IANA time zone name, e.g. 'Asia/Taipei'")

    job_dir = os.path.join(JOBS_DIR, id)
    os.makedirs(job_dir, exist_ok=True)
    now = int(time.time())
    created_at, prev_consent = now, False
    try:
        with open(os.path.join(job_dir, "job.json"), encoding="utf-8") as f:
            prev = json.load(f)
        if (isinstance(prev, dict) and isinstance(prev.get("created_at"), int)
                and not isinstance(prev["created_at"], bool)):
            created_at = prev["created_at"]
        prev_consent = isinstance(prev, dict) and prev.get("agent_consent") is True
    except (OSError, ValueError):
        pass
    explicit = agent_consent is not None
    if not explicit:
        agent_consent = bool(prev_consent)
    if not isinstance(agent_consent, bool):
        raise ValueError("agent_consent must be True, False or None (keep)")
    if agent_consent:
        if explicit and not scheduled_agent_available():
            raise ValueError("this machine runs scheduled reports data-only (desktop, or a trial / one-slot "
                             "machine): register without agent_consent and tell the user the scheduled "
                             "version is data only (references/reports.md R8)")
        if not fields[0].isdigit():
            raise ValueError(f"cron {cron!r} fires more than once an hour: a job that wakes the agent fires at "
                             "most hourly — give the minute field one number (e.g. '30 8 * * *'), or pass "
                             "agent_consent=False for a data-only job")
    _write_text_atomic(os.path.join(job_dir, "run.py"), script)
    doc = {"id": id, "title": title, "prompt": prompt,
           "schedule": {"human": human, "cron": " ".join(fields), "tz": tz},
           "enabled": enabled, "created_at": created_at, "updated_at": now, "pending": None}
    if agent_consent:
        doc["agent_consent"] = True
    _write_text_atomic(os.path.join(job_dir, "job.json"),
                       json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    return job_dir


def list_schedules():
    """Every registered job, for answering 「我有哪些定期報告」: the job.json fields
    plus `last_run` (the last line of the runtime's runs.jsonl, or None). A job whose
    job.json is unreadable comes back as `{"id", "error"}`."""
    try:
        names = sorted(os.listdir(JOBS_DIR))
    except OSError:
        return []
    out = []
    for name in names:
        d = os.path.join(JOBS_DIR, name)
        if not os.path.isdir(d):
            continue
        try:
            with open(os.path.join(d, "job.json"), encoding="utf-8") as f:
                doc = json.load(f)
            if not isinstance(doc, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as e:
            out.append({"id": name, "error": f"bad job.json: {e}"})
            continue
        doc["last_run"] = None
        try:
            with open(os.path.join(d, "runs.jsonl"), encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            if lines:
                doc["last_run"] = json.loads(lines[-1])
        except (OSError, ValueError):
            pass
        out.append(doc)
    return out


def remove_schedule(id):
    """Delete a job (registration, script and run history). True if it existed.
    Already-published reports are untouched. Use this when the user asks in chat;
    the web's own delete button does not come through here."""
    if not isinstance(id, str) or not _JOB_ID_RE.fullmatch(id):
        raise ValueError(f"job id {id!r} must match [a-z0-9][a-z0-9-]{{0,39}}")
    d = os.path.join(JOBS_DIR, id)
    if not os.path.isdir(d):
        return False
    shutil.rmtree(d)
    return True


def status(report_id):
    """Where a dropped report got to: 'pending' (still queued), 'sent',
    'failed' (with the reason), or 'unknown'.

    A diagnostic for after the fact, not a step after `write_report` — the
    uploader runs on a 2-minute timer, so never poll this waiting for 'sent'.

    'unknown' is not an error — `reports/sent/` keeps only the most recent ~20
    files, so a report that shipped a while ago reports 'unknown' too.
    """
    name = report_id + ".json"
    if os.path.exists(os.path.join(REPORTS_DIR, name)):
        return "pending"
    if os.path.exists(os.path.join(SENT_DIR, name)):
        return "sent"
    if os.path.exists(os.path.join(FAILED_DIR, name)):
        return f"failed: {_last_error(report_id) or 'see reports/upload_errors.log'}"
    return "unknown"


def _last_error(report_id):
    try:
        with open(ERROR_LOG, encoding="utf-8", errors="replace") as f:
            lines = [ln.strip() for ln in f if f" {report_id}: " in ln]
    except OSError:
        return None
    return lines[-1] if lines else None
