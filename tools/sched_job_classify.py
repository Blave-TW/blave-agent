"""Read-only dry run: what each scheduled report job on this machine becomes under the no-shell scheduled turn
(audit 2026-10-26 R1, spec §6.1) — recipe / template / no_template — without changing anything.

It reads `report_jobs/<id>/job.json`, checks for `recipe.json`, and parses `run.py` with the runtime's own rule
(sched_pack.pack_call); it never runs or prints a script, and writes nothing. One JSON line per job, then a summary
line. Needs sched_pack.py next to this file or in ../runtime/ (copy both to the machine; stdlib only).

    python3 sched_job_classify.py [--workspace /opt/blave-agent/workspace]
"""
import argparse
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.join(os.path.dirname(_HERE), "runtime")]
import sched_pack  # noqa: E402

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")


def classify(workspace):
    """[(job id, consent, class)] for every job directory; class is recipe / template / no_template / bad_job."""
    jobs_dir = os.path.join(workspace, "report_jobs")
    try:
        names = sorted(os.listdir(jobs_dir))
    except OSError:
        return []
    out = []
    for name in names:
        jd = os.path.join(jobs_dir, name)
        if not (ID_RE.fullmatch(name) and os.path.isdir(jd)):
            continue
        try:
            with open(os.path.join(jd, "job.json"), encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            doc = None
        if not isinstance(doc, dict) or doc.get("kind") == "watch":
            if isinstance(doc, dict):
                continue   # a retired watchboard job is not a registration
            out.append((name, False, "bad_job"))
            continue
        call = sched_pack.pack_call(jd)
        kind = "recipe" if call == {"recipe": True} else "template" if call else "no_template"
        out.append((name, doc.get("agent_consent") is True, kind))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--workspace", default=os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace"))
    args = ap.parse_args(argv)
    rows = classify(args.workspace)
    for job, consent, kind in rows:
        print(json.dumps({"job": job, "agent_consent": consent, "class": kind}))
    print(json.dumps({"summary": True, "jobs": len(rows), "with_consent": sum(c for _, c, _ in rows),
                      "consent_no_template": sum(1 for _, c, k in rows if c and k == "no_template")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
