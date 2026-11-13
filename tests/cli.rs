use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
struct Harness(TempDir);
impl Harness {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rein"))
            .args(args)
            .env("REIND_HOME", self.0.path())
            .env("REIND_HTTP_ADDR", "127.0.0.1:0")
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
    fn raw(&self, bytes: &[u8]) -> Value {
        let mut stream = UnixStream::connect(self.0.path().join("reind.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(bytes).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }
    fn url(&self) -> String {
        self.raw(b"{\"command\":\"status\"}\n")["console_url"]
            .as_str()
            .unwrap()
            .into()
    }
    fn http(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let url = format!("{}{path}", self.url());
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let client = reqwest::Client::new();
            let mut request = client
                .request(method.parse().unwrap(), url)
                .timeout(Duration::from_secs(30));
            if !body.is_null() {
                request = request.json(&body);
            }
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (
                status,
                serde_json::from_str(&text).unwrap_or_else(|_| json!({"text":text})),
            )
        })
    }
    fn api(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, body) = self.http(method, path, body);
        assert!(status < 300, "{path}: {status} {body}");
        body
    }
    fn add_native(&self, provider: &str, name: &str) {
        let directory = self.0.path().join(name);
        std::fs::create_dir_all(&directory).unwrap();
        let config = self.0.path().join("native-config");
        std::fs::create_dir_all(&config).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py");
        self.ok(&[
            "agent",
            "add",
            provider,
            name,
            "--directory",
            directory.to_str().unwrap(),
            "--executable",
            fixture.to_str().unwrap(),
            "--native-config",
            config.to_str().unwrap(),
        ]);
        let saved: Value = serde_json::from_str(&self.ok(&["agent", "inspect", name])).unwrap();
        assert_eq!(saved["enabled"], false);
        self.ok(&["agent", "up", name]);
    }
    fn start(&self, name: &str, prompt: &str, session: Option<&str>) -> Value {
        self.api("POST","/api/runs",json!({"agent_id":name,"prompt":prompt,"session_id":session,"request_id":Uuid::new_v4()}))["run"].clone()
    }
    fn get(&self, run: &Value) -> Value {
        self.api(
            "GET",
            &format!("/api/runs/{}", run["run_id"].as_str().unwrap()),
            Value::Null,
        )
    }
    fn wait(&self, run: &Value, states: &[&str]) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let record = self.get(run);
            if states.contains(&record["run"]["state"].as_str().unwrap()) {
                return record;
            }
            assert!(
                Instant::now() < deadline,
                "waiting for {states:?}: {record}"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }
    fn control(&self, run: &Value, kind: &str, extra: Value) -> (u16, Value) {
        let mut body = json!({"attempt_id":run["attempt_id"],"command_id":Uuid::new_v4()});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.http(
            "POST",
            &format!("/api/runs/{}/{kind}", run["run_id"].as_str().unwrap()),
            body,
        )
    }
    fn processes_stopped(&self) {
        let trace = std::fs::read_to_string(self.0.path().join("agent-trace.jsonl")).unwrap();
        let mut pids: std::collections::HashSet<u64> = trace
            .lines()
            .map(|s| {
                serde_json::from_str::<Value>(s).unwrap()["pid"]
                    .as_u64()
                    .unwrap()
            })
            .collect();
        if let Ok(pid) = std::fs::read_to_string(self.0.path().join("tool.pid")) {
            pids.insert(pid.parse().unwrap());
        }
        for pid in pids {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let status = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "stat="])
                    .output()
                    .unwrap();
                let status = String::from_utf8(status.stdout).unwrap();
                if status.trim().is_empty() || status.trim().starts_with('Z') {
                    break;
                }
                assert!(Instant::now() < deadline, "process {pid} remains: {status}");
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.run(&["daemon", "stop"]);
    }
}

#[test]
fn local_cli_lifecycle_files_and_console_are_real() {
    let h = Harness::new();
    let help = h.ok(&["--help"]);
    assert!(help.contains("agent") && help.contains("daemon"));
    for old in [
        "register", "native", "login", "run", "runs", "sessions", "a2a", "up", "down", "ls",
        "agents",
    ] {
        assert!(
            !h.run(&[old]).status.success(),
            "old command {old} still exposed"
        );
    }
    assert!(!h.run(&["agent", "add", "pi"]).status.success());
    assert!(!h.run(&["agent", "add", "other", "coder"]).status.success());
    assert!(h.ok(&["daemon", "status"]).contains("stopped"));
    assert!(
        h.ok(&["daemon", "start"])
            .contains("Console: http://127.0.0.1:")
    );
    assert!(h.ok(&["daemon", "start"]).contains("already running"));
    assert_eq!(h.ok(&["agent", "ls"]).trim(), "[]");
    assert_eq!(h.http("GET", "/", Value::Null).0, 200);
    assert_eq!(h.raw(b"invalid\n")["type"], "error");
    assert_eq!(
        h.raw(&[vec![b'x'; 65537], vec![b'\n']].concat())["type"],
        "error"
    );
    let api_agent = h.api(
        "POST",
        "/api/agents",
        json!({
            "name":"api-agent", "provider":"pi", "directory":h.0.path(), "enabled":true
        }),
    );
    assert_eq!(
        api_agent["agent"]["enabled"], false,
        "add must not bring an agent online even when requested by an API client"
    );
    assert_eq!(
        h.http(
            "POST",
            "/api/runs",
            json!({"agent_id":"api-agent","prompt":"hi","request_id":Uuid::new_v4()})
        )
        .0,
        400
    );
    h.ok(&["agent", "rm", "api-agent"]);
    h.add_native("pi", "helper");
    assert!(
        !h.0.path().join("agent-trace.jsonl").exists(),
        "up must not start an idle process"
    );
    let path = h.0.path().join("agents/helper.json");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(h.0.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!h.run(&["agent", "add", "pi", "helper"]).status.success());
    let mut config: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    config["model"] = json!("manual-model");
    std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&h.ok(&["agent", "inspect", "helper"])).unwrap()["model"],
        "manual-model"
    );
    h.ok(&["agent", "down", "helper"]);
    assert_eq!(
        h.http(
            "POST",
            "/api/runs",
            json!({"agent_id":"helper","prompt":"hi","request_id":Uuid::new_v4()})
        )
        .0,
        400
    );
    h.ok(&["agent", "up", "helper"]);
    h.ok(&[
        "agent",
        "add",
        "codex",
        "remote",
        "-a2a",
        "http://127.0.0.1:9999",
    ]);
    assert_eq!(
        h.api("GET", "/api/agents", Value::Null)["agents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        !h.run(&["agent", "add", "codex", "../unsafe"])
            .status
            .success()
    );
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        serde_json::from_str::<Value>(&h.ok(&["agent", "inspect", "helper"])).unwrap()["enabled"],
        true
    );
    assert_eq!(
        serde_json::from_str::<Value>(&h.ok(&["agent", "inspect", "remote"])).unwrap()["enabled"],
        false
    );
    assert_eq!(
        serde_json::from_str::<Value>(&h.ok(&["agent", "ls"]))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    h.ok(&["agent", "rm", "helper"]);
    assert!(!path.exists());
    h.ok(&["daemon", "stop"]);
    assert!(!h.0.path().join("reind.sock").exists());
}

#[test]
fn native_streams_resume_after_restart_and_idempotency() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for provider in ["pi", "codex"] {
        h.add_native(provider, provider);
        let key = Uuid::new_v4();
        let body = json!({"agent_id":provider,"prompt":"hello","request_id":key});
        let run = h.api("POST", "/api/runs", body.clone())["run"].clone();
        assert_eq!(
            h.api("POST", "/api/runs", body)["run"]["run_id"],
            run["run_id"]
        );
        assert_eq!(
            h.http(
                "POST",
                "/api/runs",
                json!({"agent_id":provider,"prompt":"changed","request_id":key})
            )
            .0,
            400
        );
        let record = h.wait(&run, &["completed", "failed"]);
        assert_eq!(record["run"]["state"], "completed", "{record}");
        assert!(record["run"]["finished_at"].as_u64().is_some());
        let events = record["events"].as_array().unwrap();
        for (i, event) in events.iter().enumerate() {
            assert_eq!(event["sequence"], i + 1);
        }
        assert!(
            events
                .iter()
                .any(|e| e["event"]["type"] == "text" && e["event"]["complete"] == false)
        );
        assert!(
            events
                .iter()
                .any(|e| e["event"]["text"] == "Hello 1" && e["event"]["complete"] == true)
        );
        assert_eq!(events.last().unwrap()["event"]["execution_stopped"], true);
        h.ok(&["daemon", "restart"]);
        assert_eq!(h.get(&run)["events"], record["events"]);
        assert_eq!(
            h.get(&run)["run"]["finished_at"],
            record["run"]["finished_at"]
        );
        let next = h.start(provider, "again", Some(run["session_id"].as_str().unwrap()));
        let next = h.wait(&next, &["completed", "failed"]);
        assert_eq!(next["run"]["state"], "completed", "{next}");
        assert_eq!(
            next["run"]["native_session_id"],
            record["run"]["native_session_id"]
        );
        assert!(
            next["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["event"]["text"] == "Hello 2")
        );
        let history = h.api(
            "GET",
            &format!("/api/agents/{provider}/history"),
            Value::Null,
        );
        assert_eq!(history["runs"].as_array().unwrap().len(), 2);
    }
    h.processes_stopped();
}

#[test]
fn native_approvals_validate_attempts_and_replies_without_blocking_ipc() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for provider in ["pi", "codex"] {
        h.add_native(provider, provider);
        let run = h.start(provider, "approval", None);
        let record = h.wait(&run, &["waiting_input", "waiting_approval"]);
        assert!(!h.run(&["agent", "rm", provider]).status.success());
        assert!(!h.run(&["agent", "down", provider]).status.success());
        let start = Instant::now();
        let mut partial = UnixStream::connect(h.0.path().join("reind.sock")).unwrap();
        partial.write_all(b"{").unwrap();
        assert!(h.ok(&["daemon", "status"]).contains("running"));
        assert!(start.elapsed() < Duration::from_secs(1));
        let interaction = record["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["event"]["type"] == "interaction")
            .unwrap()["event"]
            .clone();
        let response = if provider == "pi" {
            json!({"confirmed":true})
        } else {
            json!({"decision":"accept"})
        };
        for extra in [
            json!({"attempt_id":"stale","interaction_id":interaction["interaction_id"],"response":response}),
            json!({"interaction_id":"wrong","response":response}),
            json!({"interaction_id":interaction["interaction_id"],"response":{}}),
        ] {
            assert_eq!(h.control(&run, "reply", extra).0, 400);
        }
        let extra = json!({"interaction_id":interaction["interaction_id"],"response":response,"command_id":Uuid::new_v4()});
        assert_eq!(h.control(&run, "reply", extra.clone()).0, 200);
        assert_eq!(h.control(&run, "reply", extra).0, 200);
        assert_eq!(
            h.wait(&run, &["completed", "failed"])["run"]["state"],
            "completed"
        );
    }
}

#[test]
fn cancellation_shutdown_and_protocol_errors_clean_up_children() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for provider in ["pi", "codex"] {
        h.add_native(provider, provider);
        for prompt in [
            "execution",
            "crash",
            "crash-with-child",
            "malformed",
            "fail",
        ] {
            let run = h.start(provider, prompt, None);
            let record = h.wait(&run, &["completed", "failed"]);
            if prompt == "execution" {
                assert_eq!(record["run"]["state"], "completed");
                assert!(
                    record["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["event"]["type"] == "tool")
                );
                assert!(
                    record["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["event"]["reasoning"] == true)
                );
            } else {
                assert_eq!(record["run"]["state"], "failed");
                assert!(record["run"]["error"].is_string());
            }
        }
        let run = h.start(provider, "slow", None);
        h.wait(&run, &["running"]);
        assert_eq!(
            h.control(&run, "cancel", json!({"attempt_id":"stale"})).0,
            400
        );
        assert_eq!(h.control(&run, "cancel", json!({})).0, 200);
        let record = h.wait(&run, &["cancelled", "failed"]);
        assert_eq!(record["run"]["state"], "cancelled");
        assert_eq!(record["run"]["cancel_requested"], true);
    }
    let run = h.start("codex", "hang-ack", None);
    h.wait(&run, &["running"]);
    assert_eq!(h.control(&run, "cancel", json!({})).0, 200);
    assert_eq!(
        h.wait(&run, &["cancelled", "failed"])["run"]["state"],
        "cancelled"
    );
    let active = h.start("pi", "slow", None);
    h.wait(&active, &["running"]);
    h.ok(&["daemon", "stop"]);
    h.processes_stopped();
    h.ok(&["daemon", "start"]);
    assert_eq!(h.get(&active)["run"]["state"], "cancelled");
}

#[test]
fn projects_are_files_conflicting_edits_are_rejected_and_origins_are_checked() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let id = Uuid::new_v4();
    let project = json!({"id":id,"name":"本机项目","description":"persisted","directories":[],"preferred_directory":null,"requirements":[{"id":Uuid::new_v4(),"title":"需求","description":"","tasks":[{"id":Uuid::new_v4(),"title":"任务","status":"todo"}]}]});
    assert_eq!(
        h.api("POST", "/api/projects", json!({"project":project}))["project"],
        project
    );
    let mut changed = project.clone();
    changed["name"] = json!("changed");
    h.api(
        "POST",
        "/api/projects",
        json!({"project":changed,"previous":project}),
    );
    assert_eq!(
        h.http(
            "POST",
            "/api/projects",
            json!({"project":project,"previous":project})
        )
        .0,
        400
    );
    assert!(h.0.path().join(format!("projects/{id}.json")).exists());
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        h.api("GET", "/api/projects", Value::Null)["projects"][0]["name"],
        "changed"
    );
    let url = h.url();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let client = reqwest::Client::new();
        for (name, value) in [
            ("Origin", "https://evil.example"),
            ("Host", "evil.example"),
            ("Sec-Fetch-Site", "cross-site"),
        ] {
            assert_eq!(
                client
                    .get(format!("{url}/api/agents"))
                    .header(name, value)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        let response = client
            .get(format!("{url}/api/agents"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(response.headers().contains_key("content-security-policy"));
    });
}

#[test]
fn startup_preserves_non_socket_files_and_recovers_stale_sockets() {
    let h = Harness::new();
    let path = h.0.path().join("reind.sock");
    std::fs::write(&path, "keep me").unwrap();
    assert!(!h.run(&["daemon", "start"]).status.success());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");
    std::fs::remove_file(&path).unwrap();
    h.ok(&["daemon", "start"]);
    let pid = h.raw(b"{\"command\":\"status\"}\n")["pid"]
        .as_u64()
        .unwrap();
    Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = h.run(&["daemon", "status"]);
        if status.status.success() && String::from_utf8_lossy(&status.stdout).contains("stopped") {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(30));
    }
    h.ok(&["daemon", "start"]);
    assert!(h.ok(&["daemon", "status"]).contains("running"));
}

#[test]
fn remote_a2a_preserves_provider_context_history_pages_and_cancellation() {
    use std::process::Stdio;
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut server = Server(
        Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/a2a_server.py"
            ))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut endpoint = String::new();
    BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut endpoint)
        .unwrap();
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.ok(&["agent", "add", "codex", "remote", "--a2a", endpoint.trim()]);
    h.ok(&["agent", "up", "remote"]);
    let config: Value = serde_json::from_str(&h.ok(&["agent", "inspect", "remote"])).unwrap();
    assert_eq!(config["provider"], "codex");
    let first = h.start("remote", "hello", None);
    let record = h.wait(&first, &["completed", "failed"]);
    assert_eq!(record["run"]["state"], "completed", "{record}");
    assert!(
        record["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event"]["text"] == "Remote 1")
    );
    h.ok(&["daemon", "restart"]);
    for turn in 2..=22 {
        let run = h.start(
            "remote",
            "again",
            Some(first["session_id"].as_str().unwrap()),
        );
        let record = h.wait(&run, &["completed", "failed"]);
        assert_eq!(record["run"]["state"], "completed", "{record}");
        assert!(
            record["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["event"]["text"] == format!("Remote {turn}"))
        );
    }
    let page = h.api("GET", "/api/agents/remote/history", Value::Null);
    assert_eq!(page["runs"].as_array().unwrap().len(), 20);
    let older = h.api(
        "GET",
        &format!(
            "/api/agents/remote/history?session_id={}&before={}",
            page["session_id"].as_str().unwrap(),
            page["next_cursor"].as_str().unwrap()
        ),
        Value::Null,
    );
    assert_eq!(older["runs"].as_array().unwrap().len(), 2);
    let run = h.start("remote", "slow", None);
    h.wait(&run, &["running"]);
    assert_eq!(h.control(&run, "cancel", json!({})).0, 200);
    assert_eq!(
        h.wait(&run, &["cancelled", "failed"])["run"]["state"],
        "cancelled"
    );
}

#[test]
fn project_directories_default_to_first_validate_and_survive_restart() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let first = h.0.path().join("repo-a");
    let second = h.0.path().join("repo-b");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let input = json!({"id":Uuid::new_v4(),"name":"multiple directories","description":"","requirements":[],"directories":[first,second]});
    let saved = h.api("POST", "/api/projects", json!({"project":input}))["project"].clone();
    assert_eq!(saved["preferred_directory"], json!(first));
    assert_eq!(saved["directories"], json!([first, second]));
    let mut changed = saved.clone();
    changed["preferred_directory"] = json!(second);
    let edited = h.api(
        "POST",
        "/api/projects",
        json!({"project":changed,"previous":saved}),
    )["project"]
        .clone();
    assert_eq!(edited["preferred_directory"], json!(second));
    for paths in [
        json!(["relative/path"]),
        json!([h.0.path().join("missing")]),
        json!([first, first]),
    ] {
        let mut invalid = edited.clone();
        invalid["directories"] = paths;
        invalid["preferred_directory"] = Value::Null;
        assert_eq!(
            h.http(
                "POST",
                "/api/projects",
                json!({"project":invalid,"previous":edited})
            )
            .0,
            400
        );
    }
    let mut invalid = edited.clone();
    invalid["preferred_directory"] = json!(h.0.path());
    assert_eq!(
        h.http(
            "POST",
            "/api/projects",
            json!({"project":invalid,"previous":edited})
        )
        .0,
        400
    );
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        h.api("GET", "/api/projects", Value::Null)["projects"][0],
        edited
    );

    let legacy =
        json!({"id":Uuid::new_v4(),"name":"legacy project","description":"","requirements":[]});
    let path =
        h.0.path()
            .join(format!("projects/{}.json", legacy["id"].as_str().unwrap()));
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let listing = h.api("GET", "/api/projects", Value::Null);
    let restored = listing["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == legacy["id"])
        .unwrap();
    assert_eq!(restored["directories"], json!([]));
    assert_eq!(restored["preferred_directory"], Value::Null);
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
        legacy
    );
    let mut updated = legacy.clone();
    updated["description"] = json!("still editable");
    assert_eq!(
        h.api(
            "POST",
            "/api/projects",
            json!({"project":updated,"previous":legacy})
        )["project"]["description"],
        "still editable"
    );
}

#[test]
fn sdd_workflow_rejects_bypassed_gates_and_persists_artifacts() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let ids: Vec<_> = (0..4).map(|_| Uuid::new_v4().to_string()).collect();
    let tasks: Vec<_> = ["spec", "design", "tasks", "verification"]
        .iter()
        .enumerate()
        .map(|(index, kind)| {
            let mut value = json!({"id":ids[index],"title":kind,"type":kind,"status":"todo"});
            if index > 0 {
                value["depends_on"] = json!([ids[index - 1]]);
            }
            value
        })
        .collect();
    let initial = json!({"id":Uuid::new_v4(),"name":"SDD","description":"","directories":[],"preferred_directory":null,"requirements":[{"id":Uuid::new_v4(),"title":"typed tasks","description":"","tasks":tasks}]});
    let mut project = h.api("POST", "/api/projects", json!({"project":initial}))["project"].clone();
    let save = |previous: &Value, next: Value| {
        h.api(
            "POST",
            "/api/projects",
            json!({"project":next,"previous":previous}),
        )["project"]
            .clone()
    };
    let reject = |previous: &Value, next: Value| {
        assert_eq!(
            h.http(
                "POST",
                "/api/projects",
                json!({"project":next,"previous":previous})
            )
            .0,
            400
        )
    };
    let mut invalid = project.clone();
    invalid["requirements"][0]["tasks"][1]["status"] = json!("running");
    reject(&project, invalid);
    let criterion = Uuid::new_v4();
    for index in 0..3 {
        let mut next = project.clone();
        next["requirements"][0]["tasks"][index]["status"] = json!("running");
        project = save(&project, next);
        let mut next = project.clone();
        let task = &mut next["requirements"][0]["tasks"][index];
        match index {
            0 => {
                // A real document can exceed the old 64 KiB HTTP body limit after JSON encoding.
                task["document"] = json!(format!("## 行为\n{}", "\"".repeat(40000)));
                task["criteria"] = json!([{"id":criterion,"text":"expected behavior"}]);
            }
            1 => task["document"] = json!("Implementation boundaries and failure paths"),
            _ => {
                task["subtasks"] =
                    json!([{"id":Uuid::new_v4(),"title":"implement","completed":false}])
            }
        }
        task["status"] = json!("done");
        if index == 2 {
            reject(&project, next.clone());
            next["requirements"][0]["tasks"][index]["subtasks"][0]["completed"] = json!(true);
        }
        project = save(&project, next);
    }
    let mut next = project.clone();
    next["requirements"][0]["tasks"][3]["status"] = json!("running");
    project = save(&project, next);
    let mut next = project.clone();
    next["requirements"][0]["tasks"][3]["status"] = json!("done");
    next["requirements"][0]["tasks"][3]["checks"] =
        json!([{"criterion_id":criterion,"status":"passed","evidence":""}]);
    reject(&project, next.clone());
    next["requirements"][0]["tasks"][3]["checks"][0]["evidence"] =
        json!("Manual acceptance and regression evidence");
    project = save(&project, next);
    let mut invalid = project.clone();
    invalid["requirements"][0]["tasks"][0]["document"] = json!("changed without reopening");
    reject(&project, invalid);
    let mut reopened = project.clone();
    reopened["requirements"][0]["tasks"][2]["status"] = json!("running");
    reopened["requirements"][0]["tasks"][3]["status"] = json!("todo");
    reject(&project, reopened.clone());
    reopened["requirements"][0]["tasks"][3]["checks"][0]["status"] = json!("pending");
    project = save(&project, reopened);
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        h.api("GET", "/api/projects", Value::Null)["projects"][0],
        project
    );
}
