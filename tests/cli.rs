use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

struct Harness(TempDir);

impl Harness {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rein"))
            .args(args)
            .env("REIN_HOME", self.0.path())
            .env(
                "A2ALINKER_TEST_TRACE",
                self.0.path().join("agent-trace.jsonl"),
            )
            .env("A2ALINKER_TEST_CHILD_PID", self.0.path().join("tool.pid"))
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn raw(&self, bytes: &[u8]) -> serde_json::Value {
        let mut stream = UnixStream::connect(self.0.path().join("reind.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(bytes).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.run(&["daemon", "stop"]);
    }
}

#[test]
fn lifecycle_and_queries_use_the_daemon() {
    let harness = Harness::new();
    assert!(harness.ok(&["daemon", "status"]).contains("stopped"));
    assert!(!harness.run(&["agents", "list"]).status.success());
    assert!(harness.ok(&["daemon", "start"]).contains("started"));
    assert!(harness.ok(&["daemon", "start"]).contains("already running"));
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
    let log_path = harness.0.path().join("daemon.log");
    assert!(
        std::fs::read_to_string(&log_path)
            .unwrap()
            .contains("reind: daemon started")
    );
    assert_eq!(
        std::fs::metadata(harness.0.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let duplicate = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("already running"));

    for args in [["agents", "list"], ["sessions", "list"], ["a2a", "list"]] {
        assert_eq!(harness.ok(&args).trim(), "[]");
    }
    let missing = harness.run(&["a2a", "inspect", "missing"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not found"));

    assert_eq!(harness.raw(b"invalid\n")["type"], "error");
    let oversized = vec![b'x'; 64 * 1024 + 1];
    assert!(
        harness.raw(&oversized)["message"]
            .as_str()
            .unwrap()
            .contains("exceeds")
    );
    assert_eq!(harness.ok(&["agents", "list"]).trim(), "[]");

    assert!(harness.ok(&["daemon", "stop"]).contains("stopped"));
    let log = std::fs::read_to_string(&log_path).unwrap();
    assert!(log.contains("reind: daemon stopping"));
    assert!(log.contains("reind: daemon stopped"));
    assert!(!harness.0.path().join("reind.sock").exists());
    assert!(harness.ok(&["daemon", "stop"]).contains("already stopped"));
    assert!(harness.ok(&["daemon", "start"]).contains("started"));
    harness.ok(&["daemon", "stop"]);
}

#[test]
fn abrupt_exit_releases_lock_and_stale_socket_is_recovered() {
    let harness = Harness::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !harness.0.path().join("reind.sock").exists() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("daemon did not bind its socket");
        }
        thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(harness.ok(&["daemon", "status"]).contains("stopped"));
    harness.ok(&["daemon", "start"]);
    harness.ok(&["daemon", "stop"]);
}

#[test]
fn startup_preserves_non_socket_files() {
    let harness = Harness::new();
    let path = harness.0.path().join("reind.sock");
    std::fs::write(&path, "keep me").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "keep me");
}

#[test]
fn command_help_and_required_arguments() {
    let harness = Harness::new();
    assert!(harness.ok(&["--help"]).contains("daemon"));
    assert!(harness.ok(&["up", "--help"]).contains("--prepare"));
    assert!(harness.ok(&["down", "--help"]).contains("TARGET"));
    assert!(harness.ok(&["ls", "--help"]).contains("ls"));
    assert!(harness.ok(&["a2a", "--help"]).contains("inspect"));
    assert!(!harness.run(&["a2a", "inspect"]).status.success());
    assert!(!harness.run(&["sessions", "unknown"]).status.success());
    assert!(
        harness
            .ok(&["register", "agent", "--help"])
            .contains("--insecure-skip-verify")
    );
    let missing = harness.run(&["register", "agent", "codex"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("--ca"));
    let conflicting = harness.run(&[
        "register",
        "agent",
        "codex",
        "--ca",
        "unused.pem",
        "--insecure-skip-verify",
    ]);
    assert!(!conflicting.status.success());
    assert!(String::from_utf8_lossy(&conflicting.stderr).contains("cannot be used with"));
}

#[test]
fn framework_commands_use_ipc_and_never_report_fake_success() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    for args in [
        vec!["login", "--hub", "https://localhost:9011"],
        vec!["login", "status"],
        vec!["run", "agent-1", "hello"],
        vec!["runs", "get", "run-1"],
        vec!["runs", "cancel", "run-1", "--attempt", "attempt-1"],
        vec![
            "runs",
            "reply",
            "run-1",
            "--attempt",
            "attempt-1",
            "--interaction",
            "interaction-1",
            "--response",
            "{\"decision\":\"accept\"}",
        ],
    ] {
        let output = harness.run(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("not implemented"));
    }
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
}

impl Harness {
    fn native(
        &self,
        provider: &str,
        workspace: &str,
        prompt: &str,
        session: Option<&str>,
    ) -> serde_json::Value {
        let workspace = self.0.path().join(workspace);
        std::fs::create_dir_all(&workspace).unwrap();
        let config = self.0.path().join("native-config");
        std::fs::create_dir_all(&config).unwrap();
        let executable = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py");
        let mut args = vec![
            "native",
            "run",
            provider,
            prompt,
            "--workspace",
            workspace.to_str().unwrap(),
            "--executable",
            executable.to_str().unwrap(),
            "--native-config",
            config.to_str().unwrap(),
        ];
        if let Some(session) = session {
            args.extend(["--session", session]);
        }
        serde_json::from_str(&self.ok(&args)).unwrap()
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        serde_json::from_str(&self.ok(args)).unwrap()
    }

    fn wait_state(&self, run: &serde_json::Value, states: &[&str]) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let snapshot = self.json(&["runs", "get", run["run_id"].as_str().unwrap()]);
            if states.contains(&snapshot["state"].as_str().unwrap()) {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "run did not reach {states:?}: {snapshot}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn events(&self, run: &serde_json::Value) -> Vec<serde_json::Value> {
        let mut after = 0;
        let mut events = vec![];
        loop {
            let page = self.json(&[
                "runs",
                "events",
                run["run_id"].as_str().unwrap(),
                "--after",
                &after.to_string(),
            ]);
            let Some(event) = page.as_array().unwrap().first() else {
                break;
            };
            assert_eq!(event["run_id"], run["run_id"]);
            assert_eq!(event["attempt_id"], run["attempt_id"]);
            assert_eq!(event["sequence"], after + 1);
            after += 1;
            events.push(event["event"].clone());
        }
        events
    }

    fn assert_agent_processes_stopped(&self) {
        let trace = std::fs::read_to_string(self.0.path().join("agent-trace.jsonl")).unwrap();
        let mut pids: std::collections::HashSet<u64> = trace
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["pid"]
                    .as_u64()
                    .unwrap()
            })
            .collect();
        if let Ok(pid) = std::fs::read_to_string(self.0.path().join("tool.pid")) {
            pids.insert(pid.parse().unwrap());
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        for pid in pids {
            loop {
                let status = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "stat="])
                    .output()
                    .unwrap();
                let status = String::from_utf8(status.stdout).unwrap();
                if status.trim().is_empty() || status.trim().starts_with('Z') {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "agent/tool process {pid} is still executing ({status})"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    fn cancel(&self, run: &serde_json::Value) {
        let ack = self.json(&[
            "runs",
            "cancel",
            run["run_id"].as_str().unwrap(),
            "--attempt",
            run["attempt_id"].as_str().unwrap(),
        ]);
        assert_eq!(ack["state"], "received");
    }
}

#[test]
fn native_prepare_sets_agent_path_and_run_failures_are_logged() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    let bin = harness.0.path().join("prepared-bin");
    let workspace = harness.0.path().join("workspace");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py");
    std::os::unix::fs::symlink(fixture, bin.join("rein-prepared-pi")).unwrap();
    let prepare = format!(
        "export PATH=\"{}:$PATH\"; export REIN_TEST_SECRET=PRIVATE_PREPARE_VALUE",
        bin.display()
    );
    let run = harness.json(&[
        "native",
        "run",
        "pi",
        "hello",
        "--workspace",
        workspace.to_str().unwrap(),
        "--native-config",
        workspace.to_str().unwrap(),
        "--executable",
        "rein-prepared-pi",
        "--prepare",
        &prepare,
    ]);
    assert_eq!(
        harness.wait_state(&run, &["completed", "failed"])["state"],
        "completed"
    );
    let failed = harness.json(&[
        "native",
        "run",
        "pi",
        "hello",
        "--workspace",
        workspace.to_str().unwrap(),
        "--executable",
        "rein-nonexistent-agent-for-test",
    ]);
    harness.wait_state(&failed, &["failed"]);
    let log = std::fs::read_to_string(harness.0.path().join("daemon.log")).unwrap();
    assert!(log.contains(run["run_id"].as_str().unwrap()));
    assert!(log.contains("state=RUN_STATE_COMPLETED"));
    assert!(log.contains("reind: run error"));
    assert!(log.contains("cannot spawn agent executable 'rein-nonexistent-agent-for-test'"));
    assert!(log.contains("state=RUN_STATE_FAILED"));
    assert!(!log.contains("PRIVATE_PREPARE_VALUE"));
}

#[test]
fn native_agents_execute_stream_and_resume_over_stdio() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    for provider in ["codex", "pi"] {
        let run = harness.native(provider, provider, "hello", None);
        let done = harness.wait_state(&run, &["completed", "failed"]);
        assert_eq!(done["state"], "completed", "{done}");
        assert!(done["native_session_id"].is_string());
        let events = harness.events(&run);
        assert!(
            events
                .iter()
                .any(|v| v["type"] == "text" && v["complete"] == false)
        );
        assert!(
            events
                .iter()
                .any(|v| v["type"] == "text" && v["complete"] == true && v["text"] == "Hello 1")
        );
        assert_eq!(events.last().unwrap()["type"], "result");
        assert_eq!(events.last().unwrap()["execution_stopped"], true);
        let followed = harness.ok(&[
            "runs",
            "events",
            run["run_id"].as_str().unwrap(),
            "--follow",
        ]);
        assert_eq!(followed.lines().count(), events.len());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(followed.lines().last().unwrap()).unwrap()["event"]
                ["type"],
            "result"
        );
        let resumed = harness.native(
            provider,
            provider,
            "again",
            Some(run["session_id"].as_str().unwrap()),
        );
        let next = harness.wait_state(&resumed, &["completed", "failed"]);
        assert_eq!(next["state"], "completed", "{next}");
        assert_eq!(done["native_session_id"], next["native_session_id"]);
        assert_ne!(run["run_id"], resumed["run_id"]);
        assert!(
            harness
                .events(&resumed)
                .iter()
                .any(|v| v["text"] == "Hello 2" && v["complete"] == true)
        );
    }
    assert_eq!(
        harness
            .json(&["sessions", "list"])
            .as_array()
            .unwrap()
            .len(),
        2
    );
    harness.assert_agent_processes_stopped();
    let trace = std::fs::read_to_string(harness.0.path().join("agent-trace.jsonl")).unwrap();
    assert!(trace.contains("stdio://"));
    assert!(trace.contains("thread/resume"));
    assert!(trace.contains("--session"));
    assert!(!trace.contains("http://") && !trace.contains("https://"));
}

#[test]
fn native_interactions_are_scoped_and_do_not_block_ipc() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    let codex = harness.native("codex", "codex", "approval", None);
    let pi = harness.native("pi", "pi", "approval", None);
    harness.wait_state(&codex, &["waiting_approval"]);
    harness.wait_state(&pi, &["waiting_input"]);
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
    let mut partial = UnixStream::connect(harness.0.path().join("reind.sock")).unwrap();
    partial.write_all(b"{").unwrap();
    let start = Instant::now();
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
    assert!(start.elapsed() < Duration::from_secs(1));
    for (run, response) in [
        (&codex, r#"{"decision":"accept"}"#),
        (&pi, r#"{"confirmed":true}"#),
    ] {
        let interaction = harness
            .events(run)
            .into_iter()
            .find(|v| v["type"] == "interaction")
            .unwrap();
        let id = run["run_id"].as_str().unwrap();
        let attempt = run["attempt_id"].as_str().unwrap();
        let interaction_id = interaction["interaction_id"].as_str().unwrap();
        for (bad_attempt, bad_interaction, bad_response) in [
            ("old-attempt", interaction_id, response),
            (attempt, "wrong-interaction", response),
            (attempt, interaction_id, "{}"),
        ] {
            assert!(
                !harness
                    .run(&[
                        "runs",
                        "reply",
                        id,
                        "--attempt",
                        bad_attempt,
                        "--interaction",
                        bad_interaction,
                        "--response",
                        bad_response
                    ])
                    .status
                    .success()
            );
        }
        assert!(
            harness
                .ok(&[
                    "runs",
                    "reply",
                    id,
                    "--attempt",
                    attempt,
                    "--interaction",
                    interaction_id,
                    "--response",
                    response
                ])
                .contains("received")
        );
        let done = harness.wait_state(run, &["completed", "failed"]);
        assert_eq!(done["state"], "completed", "{done}");
        assert!(
            !harness
                .run(&[
                    "runs",
                    "reply",
                    id,
                    "--attempt",
                    attempt,
                    "--interaction",
                    interaction_id,
                    "--response",
                    response
                ])
                .status
                .success()
        );
    }
}

#[test]
fn native_cancel_and_shutdown_wait_for_execution_cleanup() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    for provider in ["codex", "pi"] {
        let run = harness.native(provider, provider, "slow", None);
        harness.wait_state(&run, &["running"]);
        assert!(
            !harness
                .run(&[
                    "runs",
                    "cancel",
                    run["run_id"].as_str().unwrap(),
                    "--attempt",
                    "stale"
                ])
                .status
                .success()
        );
        harness.cancel(&run);
        let done = harness.wait_state(&run, &["cancelled", "failed"]);
        assert_eq!(done["state"], "cancelled", "{done}");
        assert_eq!(done["cancel_requested"], true);
        assert_eq!(
            harness.events(&run).last().unwrap()["execution_stopped"],
            true
        );
    }
    // turn/start/prompt 响应丢失时，外层取消超时仍能停止进程。
    let hanging = harness.native("codex", "hang", "hang-ack", None);
    harness.wait_state(&hanging, &["running"]);
    harness.cancel(&hanging);
    assert_eq!(
        harness.wait_state(&hanging, &["cancelled", "failed"])["state"],
        "cancelled"
    );
    let active = harness.native("pi", "shutdown", "slow", None);
    harness.wait_state(&active, &["running"]);
    harness.ok(&["daemon", "stop"]);
    harness.assert_agent_processes_stopped();
    harness.ok(&["daemon", "start"]);
    assert!(
        !harness
            .run(&["runs", "get", active["run_id"].as_str().unwrap()])
            .status
            .success()
    );
    assert_eq!(harness.json(&["sessions", "list"]), serde_json::json!([]));
}

#[test]
fn native_protocol_errors_fail_and_agents_forward_tools_and_reasoning() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    for provider in ["codex", "pi"] {
        for prompt in ["crash", "crash-with-child", "malformed", "fail"] {
            let run = harness.native(provider, &format!("{provider}-{prompt}"), prompt, None);
            let done = harness.wait_state(&run, &["completed", "failed"]);
            assert_eq!(done["state"], "failed", "{done}");
            assert!(done["error"].is_string());
        }
    }
    for provider in ["pi", "codex"] {
        let run = harness.native(provider, &format!("{provider}-tools"), "execution", None);
        assert_eq!(
            harness.wait_state(&run, &["completed", "failed"])["state"],
            "completed"
        );
        let events = harness.events(&run);
        assert!(
            events
                .iter()
                .any(|v| v["type"] == "tool" && v["complete"] == true)
        );
        assert!(
            events
                .iter()
                .any(|v| v["type"] == "text" && v["reasoning"] == true)
        );
        if provider == "codex" {
            assert!(
                events
                    .iter()
                    .any(|v| v["type"] == "tool" && v["output"]["output"] == "文件A\n文件B\n")
            );
        }
    }
    harness.assert_agent_processes_stopped();
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
}

#[test]
fn sigterm_cleans_up_active_native_processes() {
    let harness = Harness::new();
    harness.ok(&["daemon", "start"]);
    let run = harness.native("codex", "signal", "slow", None);
    harness.wait_state(&run, &["running"]);
    let pid = harness.raw(b"{\"command\":\"status\"}\n")["pid"]
        .as_u64()
        .unwrap();
    assert!(
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while harness.0.path().join("reind.sock").exists() {
        assert!(
            Instant::now() < deadline,
            "daemon did not stop after SIGTERM"
        );
        thread::sleep(Duration::from_millis(20));
    }
    harness.assert_agent_processes_stopped();
    harness.ok(&["daemon", "start"]);
    assert_eq!(harness.json(&["sessions", "list"]), serde_json::json!([]));
}
