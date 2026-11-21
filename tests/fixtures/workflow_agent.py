#!/usr/bin/env python3
"""Use the shared native wire fixture; add deterministic workflow artifact output."""
import json
import os
import re
from pathlib import Path


def workflow_artifacts(prompt, cancel):
    if prompt.startswith("REIN SPEC TASK UPDATE\n"):
        update = json.loads(prompt.rsplit("\nTASK_UPDATE_JSON: ", 1)[1])
        path = Path(update["tasks_file"])
        skip = path.parent / "skip-document-update-once"
        if skip.exists():
            skip.unlink()
            return True
        checks = {item["index"]: item for item in update["checklist"]}
        lines, count, fence = [], 0, None
        for line in path.read_text().splitlines():
            text = line.lstrip()
            marker = re.match(r"(`{3,}|~{3,})", text)
            if marker:
                if fence is None:
                    fence = marker.group(1)[0]
                elif marker.group(1)[0] == fence:
                    fence = None
                lines.append(line)
                continue
            item = re.match(r"(\s*[-*+] \[)[ xX](\]\s+)(.+)", line) if fence is None else None
            if item and item.group(3).strip():
                count += 1
                if count in checks:
                    line = item.group(1) + ("x" if checks[count]["checked"] else " ") + item.group(2) + item.group(3)
            lines.append(line)
        if update["verification"]:
            if "## Verification Results" not in lines:
                lines += ["", "## Verification Results"]
            for item in update["verification"]:
                prefix = "- " + item["id"] + ": "
                lines = [line for line in lines if not line.startswith(prefix)]
                lines.append(prefix + item["outcome"] + " — fixture execution evidence")
        temporary = path.with_suffix(".tmp")
        temporary.write_text("\n".join(lines) + "\n")
        temporary.replace(path)
        return True
    if prompt.startswith("Use the installed rein-spec skill."):
        directory = Path(prompt.split("\nSPEC_DIR: ", 1)[1].split("\n", 1)[0])
        message = json.loads(prompt.rsplit("\nREIN_SPEC_USER_MESSAGE:\n", 1)[1])
        user = message["text"]
        state_path = directory / ".spec-state.json"
        state = json.loads(state_path.read_text())
        edited = message.get("edited_document")
        if user in ["fixture-edit-requirements", "fixture-edit-design", "fixture-edit-tasks"]:
            edited = user.removeprefix("fixture-edit-") + ".md"
            file = directory / edited
            file.write_text(file.read_text() + "\nFixture chat revision.\n")
        if edited:
            state["phase"] = edited.removesuffix(".md")
            state["decisions"].append({"document":edited,"decision":"revision_requested","message":user})
        phase = state["phase"]
        if phase not in ["requirements", "design", "tasks"]:
            return True
        if user == "fixture-no-state":
            return True
        if user == "fixture-truncated-state":
            state_path.write_text('{"phase":')
            return True
        # Simulated model decisions belong only in the fixture; production never classifies text.
        choice = message.get("next_document")
        if user == "保留现有文档": choice = "keep"
        if user == "修改现有文档": choice = "modify"
        approved = user in ["同意", "确认需求，继续设计", "确认设计，拆分任务", "确认任务，开始构建", "就按这个方案来吧", "这个设计可以，往下做吧", "按这份任务计划执行吧", "保留现有文档", "修改现有文档"]
        document = phase + ".md"
        awaiting_choice = False
        if approved and (state["blocking"] == "User review of " + document or str(state["blocking"]).startswith("Choose next document:")):
            next_phase = {"requirements":"design", "design":"tasks", "tasks":"building"}[phase]
            target = directory / (next_phase + ".md")
            exists = next_phase != "building" and target.exists() and target.read_text().strip()
            if exists and not choice:
                state["blocking"] = "Choose next document: " + target.name + " — modify or keep?"
                awaiting_choice = True
            else:
                revisions = json.loads(prompt.split("\nDOCUMENT_REVISIONS: ", 1)[1].split("\n", 1)[0])
                state["decisions"].append({"document":document,"decision":"approved","message":user,"revision":revisions[document]})
                phase = next_phase
                state["phase"] = phase
                if exists and choice == "modify":
                    target.write_text("# 重新生成的设计\n依据最新需求修订。" if phase == "design" else "# 重新生成的任务\n- [ ] T-01 修订实现\n  Acceptance: AC-01\n")
                if exists and choice == "keep" and (directory / "violate-keep-once").exists():
                    (directory / "violate-keep-once").unlink()
                    target.write_text(target.read_text() + "\nUnexpected rewrite.\n")
        bugfix = state["context"]["template"] == "bugfix"
        if phase == "requirements" and not (directory / "requirements.md").read_text().strip():
            (directory / "requirements.md").write_text("# 导出修复需求\n\n## Acceptance Criteria\n- AC-01: 大文件导出不会崩溃，保留现有导出格式。" if bugfix else "# 需求\n\n## Acceptance Criteria\n- AC-01: 实现用户要求的行为。")
        elif phase == "design" and not (directory / "design.md").read_text().strip():
            (directory / "design.md").write_text("# 导出修复设计\n\n分析内存占用的根因，采用分批导出并验证兼容性。" if bugfix else "# 设计\n\n沿用现有项目配置。")
        elif phase == "tasks" and not (directory / "tasks.md").read_text().strip():
            title = "修复大文件导出" if bugfix else "实现用户要求的行为"
            (directory / "tasks.md").write_text("# 任务\n\n- [ ] T-01 " + title + "\n  Acceptance: AC-01\n")
        if not awaiting_choice:
            state["blocking"] = "需要保留旧的导出格式吗？" if user == "先澄清" else "User review of " + phase + ".md" if phase != "building" else None
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state))
        temporary.replace(state_path)
        while (directory / "hold-planning").exists():
            if cancel.wait(0.01):
                return False
    marker = "ARTIFACT_OUTPUT_JSON: "
    if marker not in prompt:
        return True
    output = json.loads(prompt.rsplit(marker, 1)[1].strip())
    directory = Path(output["result"]).parent
    if (directory / "crash-execution").exists():
        os._exit(23)
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
fork_helpers = '''def thread_file(thread):
    return HOME / ("fixture-" + thread + ".json")

def thread_history(thread):
    path = thread_file(thread)
    return json.loads(path.read_text()) if path.exists() else {"turns": 0, "history": []}

def count_turn():
    if PI:
        counter = SESSION.with_suffix(".count")
        count = int(counter.read_text()) if counter.exists() else (
            sum(json.loads(line).get("message", {}).get("role") == "user"
                for line in SESSION.read_text().splitlines()) if SESSION.exists() else 0)
        counter.parent.mkdir(parents=True, exist_ok=True)
        counter.write_text(str(count + 1))
        if not SESSION.exists():
            SESSION.write_text(json.dumps({"type": "session", "id": str(uuid.uuid4()),
                "version": 3, "cwd": os.getcwd()}) + "\\n")
        return count + 1
    data = thread_history(THREAD)
    data.setdefault("cwd", os.getcwd())
    data["turns"] += 1
    thread_file(THREAD).parent.mkdir(parents=True, exist_ok=True)
    thread_file(THREAD).write_text(json.dumps(data))
    return data["turns"]

def save_fork_turn(prompt, text, item):
    if not PI:
        data = thread_history(THREAD)
        data["history"].append({"id": TURN, "status": "completed", "items": [
            {"type": "agentMessage", "id": item, "text": text}]})
        thread_file(THREAD).write_text(json.dumps(data))
        return
    entries = [json.loads(line) for line in SESSION.read_text().splitlines()] if SESSION.exists() else [
        {"type": "session", "id": str(uuid.uuid4()), "version": 3, "cwd": os.getcwd()}]
    parent = entries[-1]["id"] if len(entries) > 1 else None
    for role, content in [("user", prompt), ("assistant", text)]:
        entry_id = str(uuid.uuid4())
        entries.append({"type": "message", "id": entry_id, "parentId": parent,
            "message": {"role": role, "content": [{"type": "text", "text": content}],
                "timestamp": int(time.time() * 1000)}})
        parent = entry_id
    SESSION.write_text("\\n".join(json.dumps(entry) for entry in entries) + "\\n")

'''
source = source.replace('def count_turn():', 'def original_count_turn():', 1)
source = source.replace('def finish(', fork_helpers + 'def finish(', 1)
source = source.replace(
    '    elif method in ("thread/start", "thread/resume"):',
    '''    elif method == "thread/read":
        thread = request["params"]["threadId"]
        response(request, {"thread": {"id": thread, "cwd": thread_history(thread)["cwd"]}})
    elif method == "thread/turns/list":
        history = thread_history(request["params"]["threadId"])["history"]
        response(request, {"data": list(reversed(history))[:request["params"].get("limit", 10)]})
    elif method == "thread/fork":
        params = request["params"]
        history = thread_history(params["threadId"])["history"]
        stop = next(i for i, turn in enumerate(history) if turn["id"] == params["lastTurnId"]) + 1
        new_thread = "fork-" + str(uuid.uuid4())
        thread_file(new_thread).write_text(json.dumps({"turns": stop, "history": history[:stop]}))
        response(request, {"thread": {"id": new_thread}})
    elif method in ("thread/start", "thread/resume"):''',
    1,
)
marker = "def run(prompt, count):\n"
assert source.count(marker) == 1
source = source.replace(marker, marker + "    if not workflow_artifacts(prompt, CANCEL):\n        finish(canceled=True)\n        return\n    if prompt.startswith('REIN TASK RUNTIME') and (Path(json.loads(prompt.rsplit('ARTIFACT_OUTPUT_JSON: ', 1)[1])['result']).parent / 'require-approval').exists():\n        prompt = 'approval'\n    if prompt.startswith('REIN SPEC TASK UPDATE') and (Path(json.loads(prompt.rsplit('TASK_UPDATE_JSON: ', 1)[1])['tasks_file']).parent / 'require-document-approval').exists():\n        prompt = 'approval'\n")
source = source.replace(marker, marker + "    if '\\nREIN_SPEC_USER_MESSAGE:\\n' in prompt:\n        control = json.loads(prompt.rsplit('\\nREIN_SPEC_USER_MESSAGE:\\n', 1)[1]).get('text')\n        if control in ('fixture-approval', 'fixture-crash'):\n            prompt = control.removeprefix('fixture-')\n")
source = source.replace(marker, marker + "    long_approval = prompt == 'long-approval'\n    if long_approval:\n        prompt = 'approval'\n")
source = source.replace('"command": "echo fixture"', '"command": None if long_approval else "echo fixture", "reason": "请确认本次操作的范围。" * 300 if long_approval else "", "tool_arguments": {"command": "echo TOOL_ARGUMENTS_ONLY_IN_DETAILS", "data": "x" * 4000} if long_approval else {}')
question_fixture = """    if prompt == "questions":
        PENDING = "fixture-questions" if PI else 43
        if PI:
            emit({"type": "extension_ui_request", "id": PENDING, "method": "select", "title": "选择工作目录", "options": ["项目默认目录（推荐）", "每次选择目录"]})
        else:
            emit({"id": PENDING, "method": "item/tool/requestUserInput", "params": {"threadId": THREAD, "turnId": TURN, "questions": [
                {"id": "audience", "header": "使用场景", "question": "主要在哪个场景使用？", "options": [{"label": "个人使用（推荐）", "description": "单人本机使用，先验证核心流程。"}, {"label": "团队共享", "description": "需要管理成员和访问权限。"}]},
                {"id": "retention", "header": "数据保存", "question": "数据需要保存多久？", "options": [{"label": "仅当前会话", "description": "关闭后清除。"}, {"label": "保留历史", "description": "可在后续会话继续访问。"}]},
                {"id": "constraints", "header": "其他约束", "question": "还有哪些必须遵守的边界？"}
            ]}})
        while not ANSWER.wait(0.01):
            if CANCEL.is_set():
                finish(canceled=True)
                return
"""
source = source.replace('    if prompt == "approval":', question_fixture + '    if prompt == "approval":')
source = source.replace(
    '    item = "message-" + str(count)',
    '''    if prompt.endswith("\\nUSER MESSAGE:\\nfixture-chat-references"):
        directory = Path.cwd()
        text = (
            f"@Haibin 与 @codex，请看 [清单](file://{directory}/src/preview.txt#L2)。\\n\\n"
            f"相对位置：src/preview.txt:2。\\n\\n"
            f"[目录外]({directory.parent}/secret-outside.txt) · [符号链接](src/linked.txt)\\n\\n"
            "\\u0060@code\\u0060，email@Haibin.example"
        )
    item = "message-" + str(count)''',
)
source = source.replace('    item = "message-" + str(count)\n',
    '    item = "message-" + str(count)\n    save_fork_turn(prompt, text, item)\n', 1)
exec(compile(source, str(fixture), "exec"), {"__name__": "__main__", "__file__": str(fixture), "workflow_artifacts": workflow_artifacts, "Path": Path})
