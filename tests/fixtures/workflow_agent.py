#!/usr/bin/env python3
"""Use the shared native wire fixture; add deterministic workflow artifact output."""
import json
from pathlib import Path


def workflow_artifacts(prompt, cancel):
    marker = "ARTIFACT_OUTPUT_JSON: "
    if marker not in prompt:
        return True
    output = json.loads(prompt.rsplit(marker, 1)[1].strip())
    directory = Path(output["result"]).parent
    if (directory / "hold-running").exists() and cancel.wait(20):
        return False
    outcome, responsible = "passed", None
    for mode in ["review-fail-once", "review-fail-unlinked-once"]:
        failure = directory / mode
        if output["role"] == "review" and failure.exists():
            failure.unlink()
            outcome = "failed"
            if mode == "review-fail-once":
                responsible = json.loads((directory / "task-index.json").read_text())[0]["id"]
            break
    missing = directory / "missing-handoff-once"
    if missing.exists():
        missing.unlink()
    else:
        Path(output["handoff"]).write_text("# Task Handoff\n\n" + "本次按照任务范围完成实现检查，记录实际测试证据，保留无关修改；交接后由下一位执行者核对验收标准。" * 3)
    Path(output["result"]).write_text(json.dumps({
        "outcome": outcome,
        "summary": "Fixture acceptance failed; correct the associated behaviour." if outcome == "failed" else "Fixture task completed.",
        "evidence": "Deterministic fixture assertion: " + outcome,
        "responsible_task_id": responsible,
    }))
    return True


fixture = Path(__file__).resolve().parents[3] / "a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py"
source = fixture.read_text()
marker = "def run(prompt, count):\n"
assert source.count(marker) == 1
source = source.replace(marker, marker + "    if not workflow_artifacts(prompt, CANCEL):\n        finish(canceled=True)\n        return\n")
exec(compile(source, str(fixture), "exec"), {"__name__": "__main__", "__file__": str(fixture), "workflow_artifacts": workflow_artifacts})
