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
    fn sql(&self, statement: &str) {
        use sqlx::Connection;
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let mut connection = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(self.0.path().join("reind.sqlite")),
            )
            .await
            .unwrap();
            sqlx::query(statement)
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
        });
    }
    fn workflow_agent(&self, provider: &str, name: &str) {
        self.add_native(provider, name);
        let path = self.0.path().join("agents").join(format!("{name}.json"));
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        config["executable"] = json!(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/workflow_agent.py")
        );
        std::fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    }
    fn workflow(&self) -> Value {
        self.api("GET", "/api/workflow", Value::Null)
    }
    fn wait_workflow(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let state = self.workflow();
            if predicate(&state) {
                return state;
            }
            assert!(Instant::now() < deadline, "workflow timeout: {state}");
            thread::sleep(Duration::from_millis(80));
        }
    }
    fn set_spec_phase(&self, id: &str, phase: &str) {
        let state = self.workflow();
        let spec = state["specs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["id"] == id)
            .unwrap();
        let path = self
            .0
            .path()
            .join("specs")
            .join(spec["directory"].as_str().unwrap())
            .join(".spec-state.json");
        std::fs::write(path, serde_json::to_vec(&json!({"phase":phase,"decisions":[],"blocking":null,"context":{"template":spec["kind"]}})).unwrap()).unwrap();
        self.wait_workflow(|state| {
            state["specs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|spec| spec["id"] == id && spec["phase"] == phase)
        });
    }
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rein"))
            .args(args)
            .env("HOME", self.0.path())
            .env("REIND_HOME", self.0.path())
            .env("REIND_HTTP_ADDR", "127.0.0.1:0")
            .env_remove("CODEX_HOME")
            .env_remove("PI_CODING_AGENT_DIR")
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

fn planned_spec(h: &Harness) -> (String, std::path::PathBuf) {
    let project = Uuid::new_v4().to_string();
    let requirement = Uuid::new_v4().to_string();
    h.api("POST","/api/projects",json!({"previous":null,"project":{"id":project,"name":"Runtime project","description":"","directories":[h.0.path()],"preferred_directory":h.0.path(),"requirements":[{"id":requirement,"title":"Runtime requirement","description":""}]}}));
    let spec=h.api("POST","/api/specs",json!({"requirement_id":requirement,"title":"Spec runtime","description":"Sequential implementation and acceptance"}))["spec"].clone();
    let id = spec["id"].as_str().unwrap().to_string();
    let directory =
        h.0.path()
            .join("specs")
            .join(spec["directory"].as_str().unwrap());
    assert_eq!(
        spec["directory"]
            .as_str()
            .unwrap()
            .split('-')
            .next()
            .unwrap()
            .len(),
        12
    );
    for (file, content) in [
        (
            "requirements.md",
            "# Requirements\n\n## Acceptance Criteria\n- AC-01: First behaviour passes\n- AC-02: Second behaviour passes\n",
        ),
        ("design.md", "# Design\nTechnical constraints".into()),
        (
            "tasks.md",
            "- [ ] T-01 First coding task\n  Implement behaviour one\n  Acceptance: AC-01\n- [ ] T-02 Second coding task\n  Implement behaviour two\n  Acceptance: AC-02\n",
        ),
    ] {
        h.api(
            "POST",
            &format!("/api/artifacts/{id}/{file}"),
            json!({"content":content}),
        );
    }
    h.set_spec_phase(&id, "design");
    h.set_spec_phase(&id, "tasks");
    (id, directory)
}

#[test]
fn native_workspace_defaults_to_type_directory_and_projects_use_their_preferred_directory() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let executable =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workflow_agent.py");
    for provider in ["codex", "pi"] {
        h.ok(&[
            "agent",
            "add",
            provider,
            provider,
            "--executable",
            executable.to_str().unwrap(),
        ]);
        h.ok(&["agent", "up", provider]);
        let agent: Value = serde_json::from_str(&h.ok(&["agent", "inspect", provider])).unwrap();
        assert!(agent["directory"].is_null());
        let run = h.start(provider, "normal", None);
        assert_eq!(
            run["working_directory"],
            json!(
                h.0.path()
                    .join("agents")
                    .join(provider)
                    .canonicalize()
                    .unwrap()
            )
        );
        h.wait(&run, &["completed"]);
    }

    let first = h.0.path().join("first");
    let preferred = h.0.path().join("preferred");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&preferred).unwrap();
    let mut pi: Value = serde_json::from_str(&h.ok(&["agent", "inspect", "pi"])).unwrap();
    pi["directory"] = json!(first);
    h.api("PUT", "/api/agents/pi", pi);
    let standalone = h.start("pi", "normal", None);
    assert_eq!(
        standalone["working_directory"],
        json!(first.canonicalize().unwrap())
    );
    h.wait(&standalone, &["completed"]);
    let requirement = Uuid::new_v4();
    h.api("POST", "/api/projects", json!({"previous":null,"project":{
        "id":Uuid::new_v4(),"name":"Two workspaces","directories":[first,preferred],
        "preferred_directory":preferred,"requirements":[{"id":requirement,"title":"Workspace test"}]
    }}));
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"main_agent":"codex","coding_agents":["pi"],"automatic":false}),
    );
    let chat = h.api(
        "POST",
        &format!("/api/requirements/{requirement}/chat"),
        json!({"prompt":"添加任务：验证工作目录","request_id":Uuid::new_v4()}),
    )["run"]
        .clone();
    let expected = json!(preferred.canonicalize().unwrap());
    assert_eq!(chat["working_directory"], expected);
    h.wait(&chat, &["completed"]);

    let workflow = h.workflow();
    let task = workflow["tasks"][0]["id"].as_str().unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task}/action"),
        json!({"action":"start"}),
    );
    let done = h.wait_workflow(|state| state["tasks"][0]["status"] == "done");
    let run_id = done["tasks"][0]["last_run_id"].as_str().unwrap();
    assert_eq!(
        h.api("GET", &format!("/api/runs/{run_id}"), Value::Null)["run"]["working_directory"],
        expected
    );
}

#[test]
fn native_chat_forks_resume_at_the_anchor_for_both_providers() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for provider in ["codex", "pi"] {
        h.workflow_agent(provider, provider);
        let first = h.start(provider, "source prompt", None);
        h.wait(&first, &["completed"]);
        let session = first["session_id"].as_str().unwrap();
        let later = h.start(provider, "later main message", Some(session));
        h.wait(&later, &["completed"]);
        let source = first["run_id"].as_str().unwrap();
        if provider == "codex" {
            h.sql(&format!("UPDATE local_runs SET snapshot=json_remove(snapshot,'$.working_directory') WHERE id='{source}'"));
        }
        let submit = format!("/api/runs/{source}/fork");
        let list = format!("/api/sessions/{session}/forks");
        let context = h.api(
            "GET",
            &format!("/api/runs/{source}/fork-context"),
            Value::Null,
        );
        assert_eq!(context["runs"].as_array().unwrap().len(), 1);
        assert_eq!(context["runs"][0]["run"]["run_id"], first["run_id"]);
        assert_eq!(h.api("GET", &list, Value::Null), json!([]));
        assert_eq!(
            h.http(
                "POST",
                &submit,
                json!({"prompt":" ","request_id":Uuid::new_v4()})
            )
            .0,
            400
        );
        assert_eq!(h.api("GET", &list, Value::Null), json!([]));
        let prompt = json!({"prompt":"first fork prompt","request_id":Uuid::new_v4()});
        let created = h.api("POST", &submit, prompt.clone());
        let id = created["fork"]["id"].as_str().unwrap();
        let new_run = &created["run"];
        assert_ne!(id, session);
        assert_eq!(created["fork"]["title"], "first fork prompt");
        let retry = h.api("POST", &submit, prompt);
        assert_eq!(retry["fork"]["id"], id);
        assert_eq!(retry["run"]["run_id"], new_run["run_id"]);
        let completed = h.wait(new_run, &["completed"]);
        assert!(
            completed["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["event"]["complete"] == true
                    && event["event"]["text"] == "Hello 2")
        );
        let latest = h.start(provider, "main keeps going", Some(session));
        let completed = h.wait(&latest, &["completed"]);
        assert!(
            completed["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["event"]["complete"] == true
                    && event["event"]["text"] == "Hello 3")
        );
        assert_eq!(new_run["working_directory"], first["working_directory"]);
        h.ok(&["daemon", "restart"]);
        let forks = h.api("GET", &list, Value::Null);
        assert_eq!(forks[0]["title"], "first fork prompt");
        assert_eq!(forks[0]["message_count"], 2);
        let history = h.api(
            "GET",
            &format!("/api/agents/{provider}/history"),
            Value::Null,
        );
        assert!(
            history["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["id"] != id)
        );
        h.api("DELETE", &format!("/api/chat-forks/{id}"), Value::Null);
        assert_eq!(
            h.http(
                "POST",
                "/api/runs",
                json!({"agent_id":provider,
            "session_id":id,"prompt":"old ID","request_id":Uuid::new_v4()})
            )
            .0,
            400
        );
        let recreated = h.api(
            "POST",
            &submit,
            json!({"prompt":"new fork","request_id":Uuid::new_v4()}),
        );
        assert_ne!(recreated["fork"]["id"], id);
        h.wait(&recreated["run"], &["completed"]);
    }
}

#[test]
fn native_agents_import_and_share_type_config_with_per_agent_model_and_effort() {
    use sha2::{Digest, Sha256};

    let h = Harness::new();
    let original_dir = h.0.path().join("native-config");
    std::fs::create_dir(&original_dir).unwrap();
    let original = "model = \"fixture-default\"\nnotify = [\"desktop\"]\n[mcp_servers.desktop]\ncommand = \"open\"\n";
    std::fs::write(original_dir.join("config.toml"), original).unwrap();
    std::fs::write(
        original_dir.join("settings.json"),
        r#"{"defaultModel":"pi-default","defaultProvider":"fixture","defaultThinkingLevel":"medium","theme":"dark","packages":["desktop"]}"#,
    )
    .unwrap();
    std::fs::write(
        original_dir.join("models.json"),
        r#"{"providers":{"fixture":{"models":[]}}}"#,
    )
    .unwrap();
    std::fs::write(original_dir.join("auth.json"), "{}").unwrap();
    let native_codex = h.0.path().join(".codex");
    std::fs::create_dir(&native_codex).unwrap();
    std::fs::write(
        native_codex.join("config.toml"),
        "model = \"native-default\"\n",
    )
    .unwrap();
    h.ok(&["daemon", "start"]);
    h.add_native("codex", "fast");
    h.add_native("codex", "deep");
    h.add_native("codex", "unrestricted");
    h.add_native("pi", "helper");
    let default = h.api("GET", "/api/agent-types/codex", Value::Null);
    assert_eq!(default["independent"], false);
    assert_eq!(default["files"], json!([]));
    assert_eq!(default["defaults"]["model"], "native-default");
    assert!(!h.0.path().join("agents/codex/config.toml").exists());
    let default_run = h.start("deep", "normal", None);
    let default_record = h.wait(&default_run, &["completed"]);
    let default_session = default_run["session_id"].as_str().unwrap();
    let files = h.api(
        "PUT",
        "/api/agent-types/codex/config-mode",
        json!({"independent":true}),
    );
    assert_eq!(files["independent"], true);
    let continued = h.start("deep", "normal", Some(default_session));
    let continued = h.wait(&continued, &["completed"]);
    assert_eq!(
        continued["run"]["native_session_id"],
        default_record["run"]["native_session_id"]
    );
    let trace = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl")).unwrap();
    let starts: Vec<Value> = trace
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &Value| entry["startup"].is_object())
        .collect();
    assert_eq!(starts.len(), 2);
    for entry in starts {
        assert_eq!(
            entry["startup"]["configHome"],
            native_codex.to_str().unwrap()
        );
    }
    let imported = files["files"][0]["content"].as_str().unwrap();
    assert!(imported.contains("fixture-default"));
    assert!(!imported.contains("desktop"));
    let endpoint = "/api/agent-types/codex/config.toml";
    for (previous, content) in [(imported, "invalid ["), ("stale", "")] {
        assert_eq!(
            h.http(
                "PUT",
                endpoint,
                json!({ "previous":previous,"content":content })
            )
            .0,
            400
        );
    }
    let changed = "model = \"shared-edited\"\nmodel_reasoning_effort = \"medium\"\nsandbox_mode = \"read-only\"\napproval_policy = \"never\"\n";
    let saved = h.api(
        "PUT",
        endpoint,
        json!({ "previous":imported,"content":changed }),
    );
    assert_eq!(saved["defaults"]["model"], "shared-edited");
    assert_eq!(saved["defaults"]["reasoning_effort"], "medium");
    assert_eq!(saved["defaults"]["permissions"], "full_access");
    assert_eq!(
        h.api("GET", "/api/agent-types/codex/defaults", Value::Null),
        saved["defaults"]
    );
    assert_eq!(
        h.api("GET", "/api/agent-types/codex", Value::Null)["files"][0]["content"],
        changed
    );
    assert_eq!(
        std::fs::read_to_string(original_dir.join("config.toml")).unwrap(),
        original
    );
    assert_eq!(
        h.api("GET", "/api/agent-types/pi", Value::Null)["independent"],
        false
    );
    let pi = h.api(
        "PUT",
        "/api/agent-types/pi/config-mode",
        json!({"independent":true}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(pi["files"][1]["content"].as_str().unwrap()).unwrap(),
        json!({"defaultModel":"pi-default","defaultProvider":"fixture","defaultThinkingLevel":"medium"})
    );
    assert_eq!(
        pi["defaults"],
        json!({"model":"pi-default","model_provider":"fixture","reasoning_effort":"medium","permissions":"full_access"})
    );
    assert!(
        pi["files"][0]["content"]
            .as_str()
            .unwrap()
            .contains("fixture")
    );
    assert!(!h.0.path().join("agents/pi/auth.json").exists());
    let prior = h.start("deep", "normal", None);
    let prior_native_id = h.wait(&prior, &["completed"])["run"]["native_session_id"].clone();
    let prior_session = prior["session_id"].as_str().unwrap();
    let previous = h.ok(&["agent", "inspect", "deep"]);
    let previous: rein::agents::AgentConfig = serde_json::from_str(&previous).unwrap();
    let base_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&previous).unwrap())
    );
    let old_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([base_hash, h.0.path().join("agents/codex")])).unwrap()
        )
    );
    h.sql(&format!(
        "UPDATE local_sessions SET config_hash='{old_hash}' WHERE id='{prior_session}'"
    ));
    assert_eq!(
        h.http(
            "PUT",
            "/api/agent-types/pi/permissions",
            json!({"permissions":"approve_for_me"})
        )
        .0,
        400
    );
    h.api(
        "PUT",
        "/api/agent-types/codex/permissions",
        json!({"permissions":"approve_for_me"}),
    );
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        h.api("GET", "/api/agent-types/codex/defaults", Value::Null)["permissions"],
        "approve_for_me"
    );
    for (name, model, effort, permissions, sandbox, approval, reviewer) in [
        (
            "fast",
            "fixture-fast",
            "low",
            Some("workspace_write"),
            "workspace-write",
            "on-request",
            "user",
        ),
        (
            "deep",
            "fixture-deep",
            "high",
            None,
            "workspace-write",
            "on-request",
            "auto_review",
        ),
        (
            "unrestricted",
            "fixture-full",
            "high",
            Some("full_access"),
            "danger-full-access",
            "never",
            "user",
        ),
        ("helper", "pi-model", "medium", None, "", "", ""),
    ] {
        let mut config: Value = serde_json::from_str(&h.ok(&["agent", "inspect", name])).unwrap();
        config["model"] = json!(model);
        config["reasoning_effort"] = json!(effort);
        config["permissions"] = json!(permissions);
        let saved = h.api("PUT", &format!("/api/agents/{name}"), config);
        assert_eq!(
            saved["agent"].get("permissions"),
            permissions.map(|p| json!(p)).as_ref()
        );
        let session = (name == "deep").then_some(prior_session);
        let run = h.start(name, "normal", session);
        let finished = h.wait(&run, &["completed", "failed"]);
        assert_eq!(finished["run"]["state"], "completed", "{finished}");
        if session.is_some() {
            assert_eq!(finished["run"]["native_session_id"], prior_native_id);
        }
        let trace: Vec<Value> = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let last = &trace
            .iter()
            .rev()
            .find(|entry| entry["startup"].is_object())
            .unwrap()["startup"];
        let provider = if name == "helper" { "pi" } else { "codex" };
        assert_eq!(
            std::path::Path::new(last["configHome"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            h.0.path()
                .join("agents")
                .join(provider)
                .canonicalize()
                .unwrap()
        );
        let args = last["args"].as_array().unwrap();
        if provider == "codex" {
            assert!(args.contains(&json!(format!("model_reasoning_effort=\"{effort}\""))));
            let method = if session.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            };
            let params = &trace
                .iter()
                .rev()
                .find(|entry| entry["request"]["method"] == method)
                .unwrap()["request"]["params"];
            assert_eq!(params["model"], model);
            assert_eq!(params["sandbox"], sandbox);
            assert_eq!(params["approvalPolicy"], approval);
            assert_eq!(params["approvalsReviewer"], reviewer);
        } else {
            assert!(
                args.windows(2)
                    .any(|pair| pair == [json!("--model"), json!(model)])
            );
            assert!(
                args.windows(2)
                    .any(|pair| pair == [json!("--thinking"), json!(effort)])
            );
        }
    }
    let disabled = h.api(
        "PUT",
        "/api/agent-types/codex/config-mode",
        json!({"independent":false}),
    );
    assert_eq!(disabled["files"], json!([]));
    assert_eq!(disabled["independent"], false);
    assert_eq!(disabled["defaults"]["model"], default["defaults"]["model"]);
    assert_eq!(disabled["defaults"]["permissions"], "approve_for_me");
    assert_eq!(
        h.http("PUT", endpoint, json!({"previous":changed,"content":""}))
            .0,
        400
    );
    let continued = h.start("deep", "normal", Some(prior_session));
    assert_eq!(
        h.wait(&continued, &["completed"])["run"]["native_session_id"],
        prior_native_id
    );
    let restored = h.api(
        "PUT",
        "/api/agent-types/codex/config-mode",
        json!({"independent":true}),
    );
    assert_eq!(restored["files"][0]["content"], changed);
    for changed in [
        json!({"name":"deep","provider":"pi"}),
        json!({"name":"deep","provider":"codex","a2a":{"url":"http://127.0.0.1:9/a2a"}}),
    ] {
        h.api("PUT", "/api/agents/deep", changed);
        let (status, error) = h.http(
            "POST", "/api/runs",
            json!({"agent_id":"deep","prompt":"continue","session_id":prior_session,"request_id":Uuid::new_v4()}),
        );
        assert_eq!(status, 400);
        assert!(error.to_string().contains("different execution backend"));
    }
}

#[test]
fn agents_default_to_rein_skills_and_can_opt_into_native_compatibility() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for provider in ["codex", "pi"] {
        h.add_native(provider, provider);
        h.api(
            "PUT",
            &format!("/api/agent-types/{provider}/config-mode"),
            json!({"independent":true}),
        );
        let native =
            h.0.path()
                .join(format!("agents/{provider}/skills/native-only"));
        let project =
            h.0.path()
                .join(provider)
                .join(".agents/skills/project-only");
        let managed = h.0.path().join("skills/rein-only");
        for (root, name) in [
            (&native, "native-only"),
            (&project, "project-only"),
            (&managed, "rein-only"),
        ] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(
                root.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: Test skill\n---\nTest"),
            )
            .unwrap();
        }
        let endpoint = format!("/api/agents/{provider}/skills");
        let status = h.api("GET", &endpoint, Value::Null);
        assert_eq!(status["names"], json!(["rein-only", "rein-spec"]));
        assert_eq!(status["rein_spec_installed"], false);
        let run = h.start(provider, "normal", None);
        h.wait(&run, &["completed"]);
        let trace: Vec<Value> = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        if provider == "codex" {
            let params = &trace
                .iter()
                .rev()
                .find(|record| record["request"]["method"] == "thread/start")
                .unwrap()["request"]["params"];
            let selection = params["config"]["skills.config"].as_array().unwrap();
            for (manifest, enabled) in [
                (native.join("SKILL.md"), false),
                (project.join("SKILL.md"), false),
                (managed.join("SKILL.md"), true),
            ] {
                assert!(
                    selection.iter().any(|skill| std::path::Path::new(
                        skill["path"].as_str().unwrap()
                    )
                    .canonicalize()
                    .unwrap()
                        == manifest.canonicalize().unwrap()
                        && skill["enabled"] == enabled),
                    "{selection:?}"
                );
            }
        } else {
            let args = trace
                .iter()
                .rev()
                .find_map(|record| record["startup"]["args"].as_array())
                .unwrap();
            assert!(args.contains(&json!("--no-skills")));
            assert!(args.contains(&json!(managed.join("SKILL.md").canonicalize().unwrap())));
            assert!(!args.contains(&json!(native.join("SKILL.md").canonicalize().unwrap())));
        }
        let mut config: Value =
            serde_json::from_str(&h.ok(&["agent", "inspect", provider])).unwrap();
        assert!(config.get("skill_directories").is_none());
        config["skill_source"] = json!("native");
        h.api("PUT", &format!("/api/agents/{provider}"), config);
        let status = h.api("GET", &endpoint, Value::Null);
        assert_eq!(status["names"], json!(["native-only", "project-only"]));
        let run = h.start(provider, "normal", None);
        h.wait(&run, &["completed"]);
        let trace: Vec<Value> = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        if provider == "codex" {
            assert!(
                trace
                    .iter()
                    .rev()
                    .find(|record| record["request"]["method"] == "thread/start")
                    .unwrap()["request"]["params"]
                    .get("config")
                    .is_none()
            );
        } else {
            assert!(
                !trace
                    .iter()
                    .rev()
                    .find_map(|record| record["startup"]["args"].as_array())
                    .unwrap()
                    .contains(&json!("--no-skills"))
            );
        }
    }
}

#[test]
fn native_skill_install_requires_consent_preserves_files_and_reports_shared_skills() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.add_native("pi", "helper");
    h.add_native("pi", "second");
    h.add_native("codex", "coder");
    let pi = "/api/agents/helper/skills";
    let before = h.api("GET", pi, Value::Null);
    let target = h.0.path().join(".pi/agent/skills/rein-spec");
    assert_eq!(before["install_path"], target.to_str().unwrap());
    assert_eq!(before["rein_spec_installed"], false);
    let source = h.0.path().join("skills/rein-spec");
    assert_eq!(before["source_path"], source.to_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(source.join("SKILL.md")).unwrap(),
        rein::agents::skills::REIN_SPEC
    );
    std::fs::create_dir_all(source.join("references")).unwrap();
    std::fs::write(source.join("references/SKILL.md"), "supporting resource").unwrap();
    for name in ["design-feature.md", "design-bugfix.md"] {
        assert!(source.join("references").join(name).is_file());
    }
    assert!(!target.exists());
    assert_eq!(h.http("POST", pi, json!({"confirmed":false})).0, 400);
    assert!(!target.exists());
    let installed = h.api("POST", pi, json!({"confirmed":true}));
    assert_eq!(installed["rein_spec_installed"], true);
    for name in ["design-feature.md", "design-bugfix.md"] {
        assert_eq!(
            std::fs::read(target.join("references").join(name)).unwrap(),
            std::fs::read(source.join("references").join(name)).unwrap()
        );
    }

    assert_eq!(
        std::fs::read_to_string(target.join("references/SKILL.md")).unwrap(),
        "supporting resource"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
        rein::agents::skills::REIN_SPEC
    );
    assert_eq!(
        h.api("GET", "/api/agents/second/skills", Value::Null)["names"],
        json!(["rein-spec"])
    );
    std::fs::write(
        target.join("SKILL.md"),
        "---\nname: rein-spec\ndescription: user edit\n---\nUser content",
    )
    .unwrap();
    h.api("POST", pi, json!({"confirmed":true}));
    assert!(
        std::fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains("User content")
    );

    // Codex's current user-level location is shared with Pi.
    std::fs::remove_dir_all(&target).unwrap();
    let edited_source = format!(
        "{}\nLocal source customization\n",
        rein::agents::skills::REIN_SPEC
    );
    std::fs::write(source.join("SKILL.md"), &edited_source).unwrap();
    h.ok(&["daemon", "restart"]);
    assert_eq!(
        std::fs::read_to_string(source.join("SKILL.md")).unwrap(),
        edited_source
    );
    let codex = h.api(
        "POST",
        "/api/agents/coder/skills",
        json!({"confirmed":true}),
    );
    assert_eq!(
        codex["install_path"],
        h.0.path()
            .join(".agents/skills/rein-spec")
            .to_str()
            .unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(h.0.path().join(".agents/skills/rein-spec/SKILL.md")).unwrap(),
        edited_source
    );
    let agents = h.api("GET", "/api/agents", Value::Null);
    assert!(
        agents["agents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["skills"]["rein_spec_installed"] == true)
    );

    h.ok(&[
        "agent",
        "add",
        "pi",
        "remote",
        "--a2a",
        "http://127.0.0.1:1",
    ]);
    let remote = h.api("GET", "/api/agents/remote/skills", Value::Null);
    assert!(remote["install_path"].is_null());
    assert!(remote["error"].as_str().unwrap().contains("远端"));
    assert_eq!(
        h.http(
            "POST",
            "/api/agents/remote/skills",
            json!({"confirmed":true})
        )
        .0,
        400
    );
}

#[test]
fn skill_install_refuses_existing_incomplete_or_symlinked_skill_directories() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.add_native("pi", "helper");
    h.api(
        "PUT",
        "/api/agent-types/pi/config-mode",
        json!({"independent":true}),
    );
    let target = h.0.path().join("agents/pi/skills/rein-spec");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("keep.txt"), "do not overwrite").unwrap();
    assert_eq!(
        h.http(
            "POST",
            "/api/agents/helper/skills",
            json!({"confirmed":true})
        )
        .0,
        400
    );
    assert_eq!(
        std::fs::read_to_string(target.join("keep.txt")).unwrap(),
        "do not overwrite"
    );
    std::fs::remove_file(target.join("keep.txt")).unwrap();
    std::fs::remove_dir(&target).unwrap();
    let elsewhere = h.0.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
    assert_eq!(
        h.http(
            "POST",
            "/api/agents/helper/skills",
            json!({"confirmed":true})
        )
        .0,
        400
    );
    assert!(!elsewhere.join("SKILL.md").exists());
    std::fs::remove_file(&target).unwrap();
    let resource = h.0.path().join("skills/rein-spec/external");
    std::os::unix::fs::symlink(&elsewhere, &resource).unwrap();
    assert_eq!(
        h.http(
            "POST",
            "/api/agents/helper/skills",
            json!({"confirmed":true})
        )
        .0,
        400
    );
    assert!(
        !target.exists(),
        "failed installs remove only their new directory"
    );
    assert!(!elsewhere.join("SKILL.md").exists());
}

#[test]
fn single_agent_can_plan_code_and_review_sequentially() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "solo");
    let settings = json!({"main_agent":"solo","coding_agents":["solo"],"review_agents":["solo"],"automatic":true});
    h.api("POST", "/api/workflow/settings", settings.clone());
    let (id, _) = planned_spec(&h);
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_verification");
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"submit_verification"}),
    );
    let checked = h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_complete");
    assert_eq!(checked["settings"], settings);
    let tasks = checked["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 4);
    assert!(
        tasks
            .iter()
            .all(|t| t["agent_id"] == "solo" && t["status"] == "done" && t["attempt"] == 1)
    );
}

#[test]
fn spec_state_from_agent_controls_phases_without_matching_confirmation_words() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "planner");
    h.api("POST", "/api/workflow/settings", json!({"main_agent":"planner","coding_agents":["planner"],"review_agents":["planner"],"automatic":false}));
    let project = Uuid::new_v4();
    let requirement = Uuid::new_v4();
    h.api("POST", "/api/projects", json!({"previous":null,"project":{"id":project,"name":"Spec Builder","description":"","directories":[h.0.path()],"requirements":[{"id":requirement,"title":"Export","description":""}]}}));
    h.ok(&["agent", "down", "planner"]);
    let spec = h.api("POST", "/api/specs", json!({"requirement_id":requirement,"title":"Export repair","description":"大文件导出崩溃","kind":"bugfix","start":true}))["spec"].clone();
    let id = spec["id"].as_str().unwrap();
    assert_eq!(spec["kind"], "bugfix");
    assert!(spec["error"].as_str().unwrap().contains("agent is down"));
    assert!(spec["agent_id"].is_null());
    h.ok(&["agent", "up", "planner"]);
    let initial = h.api("POST", &format!("/api/specs/{id}/start"), Value::Null)["run"].clone();
    let record = h.wait(&initial, &["completed"]);
    assert!(record["prompt"].as_str().unwrap().contains("BUGFIX:"));
    assert!(
        record["prompt"]
            .as_str()
            .unwrap()
            .contains("Missing, empty or whitespace-only next documents are not generated yet")
    );
    assert!(
        record["prompt"]
            .as_str()
            .unwrap()
            .contains(&format!("WORKING_DIR: {}", h.0.path().display()))
    );
    assert_eq!(
        h.api("POST", &format!("/api/specs/{id}/start"), Value::Null)["run"]["run_id"],
        initial["run_id"]
    );
    assert!(h.workflow()["specs"][0]["error"].is_null());
    let chat = |prompt: &str, request: Uuid| {
        h.api(
            "POST",
            &format!("/api/specs/{id}/chat"),
            json!({"prompt":prompt,"request_id":request}),
        )["run"]
            .clone()
    };
    h.wait(&chat("先澄清", Uuid::new_v4()), &["completed"]);
    let directory =
        h.0.path()
            .join("specs")
            .join(spec["directory"].as_str().unwrap());
    let progress: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join(".spec-state.json")).unwrap())
            .unwrap();
    assert_eq!(progress["blocking"], "需要保留旧的导出格式吗？");
    h.wait(&chat("同意", Uuid::new_v4()), &["completed"]);
    assert_eq!(
        h.workflow()["specs"][0]["phase"],
        "requirements",
        "an answer to a clarification is not a stage approval"
    );
    let request = Uuid::new_v4();
    h.ok(&["agent", "down", "planner"]);
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/specs/{id}/chat"),
            json!({"prompt":"同意","request_id":request})
        )
        .0,
        400
    );
    assert_eq!(
        h.workflow()["specs"][0]["phase"],
        "requirements",
        "a failed continuation must not confirm the stage"
    );
    h.ok(&["agent", "up", "planner"]);
    std::fs::write(directory.join("hold-planning"), "").unwrap();
    let approved = chat("就按这个方案来吧", request);
    h.wait_workflow(|_| {
        let saved: Value =
            serde_json::from_slice(&std::fs::read(directory.join(".spec-state.json")).unwrap())
                .unwrap();
        saved["phase"] == "design"
    });
    assert_eq!(
        h.workflow()["specs"][0]["phase"],
        "requirements",
        "a still-running turn must not publish its state"
    );
    std::fs::remove_file(directory.join("hold-planning")).unwrap();
    h.wait(&approved, &["completed"]);
    h.wait_workflow(|state| state["specs"][0]["phase"] == "design");
    assert_eq!(
        chat("就按这个方案来吧", request)["run_id"],
        approved["run_id"]
    );
    assert_eq!(
        h.workflow()["specs"][0]["phase"],
        "design",
        "a network retry must not approve the next stage"
    );
    // The fixture records no approval for this wording; the daemon must not interpret it itself.
    h.wait(&chat("确认设计", Uuid::new_v4()), &["completed"]);
    assert_eq!(h.workflow()["specs"][0]["phase"], "design");
    h.wait(
        &chat("同意，但先补充权限要求", Uuid::new_v4()),
        &["completed"],
    );
    assert_eq!(h.workflow()["specs"][0]["phase"], "design");
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/specs/{id}/chat"),
            json!({"prompt":"确认设计","request_id":request})
        )
        .0,
        400
    );
    std::fs::write(directory.join("tasks.md"), " \n\t").unwrap();
    h.wait(
        &chat("这个设计可以，往下做吧", Uuid::new_v4()),
        &["completed"],
    );
    h.wait_workflow(|state| state["specs"][0]["phase"] == "tasks");
    h.wait(
        &chat("按这份任务计划执行吧", Uuid::new_v4()),
        &["completed"],
    );
    let queued = h.wait_workflow(|state| state["tasks"].as_array().unwrap().len() == 1);
    assert_eq!(queued["specs"][0]["phase"], "building");
    assert_eq!(queued["tasks"][0]["status"], "todo");
    let state: Value =
        serde_json::from_slice(&std::fs::read(directory.join(".spec-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["decisions"].as_array().unwrap().len(), 3);
    assert_eq!(state["context"]["template"], "bugfix");
    h.ok(&["daemon", "restart"]);
    assert_eq!(h.workflow()["specs"][0]["kind"], "bugfix");
}

#[test]
fn spec_json_migration_preserves_files_and_rejects_invalid_state_without_dispatch() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let (id, directory) = planned_spec(&h);
    let path = directory.join(".spec-state.json");
    let legacy = directory.join("spec-state.json");
    let original = r#"{"phase":"tasks","awaiting_approval":true,"blocking":null}"#;
    std::fs::write(&legacy, original).unwrap();
    std::fs::remove_file(&path).unwrap();
    h.ok(&["daemon", "restart"]);
    let migrated = h.api(
        "GET",
        &format!("/api/artifacts/{id}/.spec-state.json"),
        Value::Null,
    );
    let mut state: Value = serde_json::from_str(migrated["content"].as_str().unwrap()).unwrap();
    assert_eq!(state["phase"], "tasks");
    assert_eq!(state["blocking"], "User review of tasks.md");
    assert_eq!(state["context"]["template"], "feature");
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), original);
    state["blocking"] = json!("请确认兼容性要求");
    state["decisions"] = json!([{"document":"design.md","decision":"approved"}]);
    let saved = serde_json::to_string(&state).unwrap();
    std::fs::write(&path, &saved).unwrap();
    h.ok(&["daemon", "restart"]);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/artifacts/{id}/.spec-state.json"),
            json!({"content":"{}"})
        )
        .0,
        400
    );
    for invalid in [
        "{\"phase\":".to_owned(),
        serde_json::to_string(&json!({"phase":"complete","decisions":[],"blocking":null,"context":{"template":"feature"}})).unwrap(),
        serde_json::to_string(&json!({"phase":"building","decisions":[],"blocking":null,"context":{"template":"bugfix"}})).unwrap(),
    ] {
        std::fs::write(&path, invalid).unwrap();
        let snapshot = h.wait_workflow(|s| s["specs"][0]["error"].as_str().is_some_and(|error| error.starts_with(".spec-state.json:")));
        assert_eq!(snapshot["specs"][0]["phase"], "tasks");
        assert!(snapshot["tasks"].as_array().unwrap().is_empty());
        std::fs::write(&path, &saved).unwrap();
        h.wait_workflow(|s| s["specs"][0]["error"].is_null());
    }
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|s| s["tasks"].as_array().unwrap().len() == 1);
    let published: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(published["phase"], "building");
}

#[test]
fn markdown_tasks_submit_idempotently_report_interactions_and_sync_through_main_agent() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    for (provider, name) in [("pi", "planner"), ("codex", "coder"), ("pi", "reviewer")] {
        h.workflow_agent(provider, name);
    }
    h.api("POST", "/api/workflow/settings", json!({"main_agent":"planner","coding_agents":["coder"],"review_agents":["reviewer"],"automatic":false}));
    let (id, directory) = planned_spec(&h);
    assert!(!directory.join("plan.json").exists());
    let submit = format!("/api/specs/{id}/tasks");
    assert_eq!(h.http("POST", &submit, json!({"plan_id":"T-02"})).0, 400);
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|state| state["tasks"].as_array().unwrap().len() == 1);
    let second = h.api("POST", &submit, json!({"plan_id":"T-02"}))["task"].clone();
    assert_eq!(
        h.api("POST", &submit, json!({"plan_id":"T-02"}))["task"]["id"],
        second["id"]
    );
    assert_eq!(h.workflow()["tasks"].as_array().unwrap().len(), 2);
    let task_id = second["id"].as_str().unwrap();
    let approved_tasks = std::fs::read_to_string(directory.join("tasks.md")).unwrap();
    std::fs::write(
        directory.join("tasks.md"),
        approved_tasks.replace("Second coding task", "Changed task scope"),
    )
    .unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task_id}/action"),
        json!({"action":"start"}),
    );
    h.wait_workflow(|state| {
        state["tasks"].as_array().unwrap().iter().any(|task| {
            task["id"] == task_id
                && task["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("approved execution snapshot"))
        })
    });
    std::fs::write(directory.join("tasks.md"), approved_tasks).unwrap();
    std::fs::write(directory.join("require-approval"), "").unwrap();
    std::fs::write(directory.join("skip-document-update-once"), "").unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task_id}/action"),
        json!({"action":"start"}),
    );
    let waiting = h.wait_workflow(|state| {
        state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["kind"] == "waiting")
    });
    let notice = waiting["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["kind"] == "waiting")
        .unwrap();
    assert_eq!(notice["agent_id"], "coder");
    assert!(notice["content"].as_str().unwrap().contains("@用户"));
    let task = waiting["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == task_id)
        .unwrap();
    let run_id = task["run_id"].as_str().unwrap();
    let record = h.api("GET", &format!("/api/runs/{run_id}"), Value::Null);
    let prompt = record["prompt"].as_str().unwrap();
    assert!(prompt.contains("Run browser tests headlessly by default"));
    assert!(prompt.contains("connect to the user's running browser"));
    let interaction = record["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event"]["type"] == "interaction")
        .unwrap();
    assert!(
        !std::fs::read_to_string(directory.join("tasks.md"))
            .unwrap()
            .contains("[x]")
    );
    h.api("POST", &format!("/api/runs/{run_id}/reply"), json!({"attempt_id":record["run"]["attempt_id"],"interaction_id":interaction["event"]["interaction_id"],"command_id":Uuid::new_v4(),"response":{"decision":"accept"}}));
    let failed =
        h.wait_workflow(|state| {
            state["messages"].as_array().unwrap().iter().any(|message| {
                message["kind"] == "completed" && message["update_error"].is_string()
            })
        });
    let finished = failed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["kind"] == "completed")
        .unwrap();
    assert_eq!(finished["agent_id"], "coder");
    h.api(
        "POST",
        &format!(
            "/api/task-messages/{}/retry",
            finished["id"].as_str().unwrap()
        ),
        Value::Null,
    );
    h.wait_workflow(|state| {
        state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["id"] == finished["id"] && message["update_done"] == true)
    });
    let tasks = std::fs::read_to_string(directory.join("tasks.md")).unwrap();
    assert!(tasks.contains("- [x] T-02"));
    assert!(tasks.contains("- [ ] T-01"));
    std::fs::remove_file(directory.join("require-approval")).unwrap();
    let first = h.workflow()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["plan_id"] == "T-01")
        .unwrap()
        .clone();
    h.api(
        "POST",
        &format!("/api/tasks/{}/action", first["id"].as_str().unwrap()),
        json!({"action":"start"}),
    );
    h.wait_workflow(|state| state["specs"][0]["phase"] == "ready_verification");
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"submit_verification"}),
    );
    h.api("POST", "/api/workflow/settings", json!({"main_agent":"planner","coding_agents":["coder"],"review_agents":["reviewer"],"automatic":true}));
    let complete = h.wait_workflow(|state| {
        state["specs"][0]["phase"] == "ready_complete"
            && state["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["kind"] == "completed")
                .all(|message| message["update_done"] == true)
    });
    let tasks = std::fs::read_to_string(directory.join("tasks.md")).unwrap();
    assert!(tasks.contains("- [x] T-01") && tasks.contains("- [x] T-02"));
    assert!(tasks.contains("- AC-01: passed") && tasks.contains("- AC-02: passed"));
    let messages = complete["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .any(|message| message["kind"] == "completed" && message["agent_id"] == "reviewer")
    );
    assert!(
        messages.iter().any(
            |message| message["kind"] == "document_updated" && message["agent_id"] == "planner"
        )
    );
    let keys: std::collections::HashSet<_> = messages
        .iter()
        .map(|message| message["event_key"].as_str().unwrap())
        .collect();
    assert_eq!(keys.len(), messages.len());
    h.ok(&["daemon", "restart"]);
    assert_eq!(h.workflow()["messages"], complete["messages"]);
}

#[test]
fn spec_chat_revisions_rewind_and_require_a_choice_for_existing_next_documents() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "planner");
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"main_agent":"planner","coding_agents":[],"review_agents":[],"automatic":false}),
    );
    let (id, directory) = planned_spec(&h);
    let original_tasks = std::fs::read_to_string(directory.join("tasks.md")).unwrap();
    let chat = |prompt: &str, options: Value| {
        let run = h.api(
            "POST",
            &format!("/api/specs/{id}/chat"),
            json!({"prompt":prompt,"request_id":Uuid::new_v4(),"options":options}),
        )["run"]
            .clone();
        h.wait(&run, &["completed"]);
        run
    };
    chat("fixture-edit-design", json!({}));
    h.wait_workflow(|s| s["specs"][0]["phase"] == "design");
    chat("确认设计，拆分任务", json!({}));
    let progress: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join(".spec-state.json")).unwrap())
            .unwrap();
    assert_eq!(progress["phase"], "design");
    assert!(
        progress["blocking"]
            .as_str()
            .unwrap()
            .starts_with("Choose next document:")
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("tasks.md")).unwrap(),
        original_tasks
    );
    chat("保留现有文档", json!({}));
    h.wait_workflow(|s| s["specs"][0]["phase"] == "tasks");
    chat("fixture-edit-requirements", json!({}));
    h.wait_workflow(|s| s["specs"][0]["phase"] == "requirements");
    chat("确认需求，继续设计", json!({"next_document":"modify"}));
    h.wait_workflow(|s| s["specs"][0]["phase"] == "design");
    assert!(
        std::fs::read_to_string(directory.join("design.md"))
            .unwrap()
            .contains("重新生成的设计")
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("tasks.md")).unwrap(),
        original_tasks
    );
    std::fs::write(directory.join("violate-keep-once"), "").unwrap();
    chat("确认设计，拆分任务", json!({"next_document":"keep"}));
    let rejected = h.wait_workflow(|s| {
        s["specs"][0]["error"]
            .as_str()
            .is_some_and(|error| error.contains("未按保留要求"))
    });
    assert_eq!(rejected["specs"][0]["phase"], "design");
    assert!(rejected["tasks"].as_array().unwrap().is_empty());
}

#[test]
fn spec_edits_preserve_execution_standards_and_document_confirmation_versions() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    h.workflow_agent("codex", "reviewer");
    let settings = json!({"main_agent":"coder","coding_agents":["coder"],"review_agents":["reviewer"],"automatic":false});
    h.api("POST", "/api/workflow/settings", settings.clone());
    let (id, directory) = planned_spec(&h);
    let artifact = |name: &str| format!("/api/artifacts/{id}/{name}");
    assert_eq!(
        h.api("GET", &artifact("requirements.md"), Value::Null)["confirmed"],
        true
    );
    assert_eq!(
        h.api("GET", &artifact("design.md"), Value::Null)["confirmed"],
        true
    );
    assert_eq!(
        h.api("GET", &artifact("tasks.md"), Value::Null)["confirmed"],
        false
    );
    h.set_spec_phase(&id, "building");
    let frozen = h.workflow()["specs"][0]["plan"].clone();
    let original = std::fs::read_to_string(directory.join("requirements.md")).unwrap();
    let edited = original.replace(
        "First behaviour passes",
        "Document-only new acceptance wording",
    );
    h.api(
        "POST",
        &artifact("requirements.md"),
        json!({"content":edited,"previous":original}),
    );
    assert_eq!(h.workflow()["specs"][0]["plan"], frozen);
    assert_eq!(
        h.api("GET", &artifact("requirements.md"), Value::Null)["confirmed"],
        false
    );
    assert_eq!(
        h.http(
            "POST",
            &artifact("requirements.md"),
            json!({"content":"conflicting editor","previous":original})
        )
        .0,
        400
    );
    let mut automatic = settings.clone();
    automatic["automatic"] = true.into();
    h.api("POST", "/api/workflow/settings", automatic);
    h.wait_workflow(|state| state["specs"][0]["phase"] == "ready_verification");
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"submit_verification"}),
    );
    let verified = h.wait_workflow(|state| state["specs"][0]["phase"] == "ready_complete");
    assert!(verified["tasks"].as_array().unwrap().iter().any(|task| task["role"] == "review" && task["description"] == "First behaviour passes"));
    assert_eq!(verified["specs"][0]["plan"], frozen);
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"complete"}),
    );
    h.wait_workflow(|state| {
        state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["kind"] == "completed")
            .all(|message| message["update_done"] == true)
    });
    for name in ["design.md", "tasks.md"] {
        let previous = std::fs::read_to_string(directory.join(name)).unwrap();
        h.api(
            "POST",
            &artifact(name),
            json!({"content":format!("{previous}\nManual document note\n"),"previous":previous}),
        );
    }
    assert_eq!(h.workflow()["specs"][0]["phase"], "complete");
    let tasks = h.workflow()["tasks"].clone();
    let chat = |prompt: &str, options: Value, request_id: Uuid| {
        h.api(
            "POST",
            &format!("/api/specs/{id}/chat"),
            json!({"prompt":prompt,"request_id":request_id,"options":options}),
        )["run"]
            .clone()
    };
    let run = chat(
        "审阅手动保存的需求",
        json!({"edited_document":"requirements.md"}),
        Uuid::new_v4(),
    );
    h.wait(&run, &["completed"]);
    h.wait_workflow(|state| state["specs"][0]["document_run_id"] == run["run_id"]);
    let progress: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join(".spec-state.json")).unwrap())
            .unwrap();
    assert_eq!(progress["phase"], "requirements");
    let design_before = std::fs::read_to_string(directory.join("design.md")).unwrap();
    let keep_id = Uuid::new_v4();
    let keep = chat(
        "确认需求，继续设计",
        json!({"next_document":"keep"}),
        keep_id,
    );
    h.wait(&keep, &["completed"]);
    h.wait_workflow(|state| state["specs"][0]["document_run_id"] == keep["run_id"]);
    assert_eq!(
        chat(
            "确认需求，继续设计",
            json!({"next_document":"keep"}),
            keep_id
        )["run_id"],
        keep["run_id"]
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("design.md")).unwrap(),
        design_before
    );
    let modify = chat(
        "确认设计，拆分任务",
        json!({"next_document":"modify"}),
        Uuid::new_v4(),
    );
    h.wait(&modify, &["completed"]);
    let after = h.wait_workflow(|state| state["specs"][0]["document_run_id"] == modify["run_id"]);
    assert_eq!(after["specs"][0]["phase"], "complete");
    assert_eq!(after["specs"][0]["plan"], frozen);
    assert_eq!(after["tasks"], tasks);
    assert_eq!(
        std::fs::read_to_string(directory.join("requirements.md")).unwrap(),
        edited
    );
    assert!(
        std::fs::read_to_string(directory.join("tasks.md"))
            .unwrap()
            .contains("修订实现")
    );
    assert_eq!(
        h.api("GET", &artifact("tasks.md"), Value::Null)["confirmed"],
        false
    );
    h.ok(&["daemon", "restart"]);
    assert_eq!(h.workflow()["specs"][0]["plan"], frozen);
    assert_eq!(
        h.api("GET", &artifact("tasks.md"), Value::Null)["confirmed"],
        false
    );
}

#[test]
fn workflow_roles_sequence_handoffs_and_responsible_task_repair() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    h.workflow_agent("codex", "reviewer");
    let (id, directory) = planned_spec(&h);
    let settings = json!({"main_agent":"coder","coding_agents":["coder"],"review_agents":["reviewer"],"automatic":false});
    h.api("POST", "/api/workflow/settings", settings.clone());
    assert_eq!(
        h.http(
            "POST",
            "/api/workflow/settings",
            json!({"coding_agents":["coder","coder"],"review_agents":["coder"],"automatic":true})
        )
        .0,
        400
    );
    h.set_spec_phase(&id, "building");
    let state = h.wait_workflow(|s| s["tasks"].as_array().unwrap().len() == 1);
    assert_eq!(state["tasks"][0]["status"], "todo");
    assert!(state["tasks"][0]["agent_id"].is_null());
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/specs/{id}/action"),
            json!({"action":"build"})
        )
        .0,
        400
    );
    let mut enabled = settings;
    enabled["automatic"] = json!(true);
    h.api("POST", "/api/workflow/settings", enabled);
    let built = h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_verification");
    assert_eq!(built["tasks"].as_array().unwrap().len(), 2);
    assert!(
        built["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["status"] == "done" && t["agent_id"] == "coder")
    );
    let first_id = built["tasks"][0]["id"].clone();
    std::fs::write(directory.join("review-fail-once"), "").unwrap();
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"submit_verification"}),
    );
    let checked = h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_complete");
    let tasks = checked["tasks"].as_array().unwrap();
    let coding: Vec<_> = tasks.iter().filter(|t| t["role"] == "coding").collect();
    assert_eq!(coding.len(), 2);
    let repaired = coding.iter().find(|t| t["id"] == first_id).unwrap();
    assert_eq!(repaired["attempt"], 2);
    assert!(
        repaired["handoffs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["kind"] == "repair")
    );
    assert_eq!(checked["specs"][0]["round"], 2);
    assert!(
        tasks
            .iter()
            .filter(|t| t["role"] == "review")
            .all(|t| t["agent_id"] == "reviewer")
    );
    for task in tasks {
        for handoff in task["handoffs"].as_array().unwrap() {
            assert!(directory.join(handoff["file"].as_str().unwrap()).is_file());
        }
    }
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"complete"}),
    );
    h.ok(&["daemon", "restart"]);
    assert_eq!(h.workflow()["specs"][0]["phase"], "complete");
    assert_eq!(h.workflow()["tasks"].as_array().unwrap().len(), tasks.len());
}

#[test]
fn workflow_unlinked_acceptance_failure_creates_one_repair_task() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    h.workflow_agent("codex", "reviewer");
    let (id, directory) = planned_spec(&h);
    let tasks_path = directory.join("tasks.md");
    let tasks = std::fs::read_to_string(&tasks_path)
        .unwrap()
        .replace("  Acceptance: AC-01\n", "");
    std::fs::write(tasks_path, tasks).unwrap();
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"review_agents":["reviewer"],"automatic":true}),
    );
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_verification");
    std::fs::write(directory.join("review-fail-unlinked-once"), "").unwrap();
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"submit_verification"}),
    );
    let state = h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_complete");
    let coding: Vec<_> = state["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["role"] == "coding")
        .collect();
    assert_eq!(coding.len(), 3);
    let fix = coding.iter().find(|t| t["plan_id"].is_null()).unwrap();
    assert_eq!(fix["status"], "done");
    assert!(
        fix["handoffs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["kind"] == "repair")
    );
}

#[test]
fn workflow_artifact_conflicts_and_requirement_chat_creation_are_safe() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    let (id, directory) = planned_spec(&h);
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/specs/{id}/action"),
            json!({"action":"submit_verification"})
        )
        .0,
        400
    );
    let confirmed_requirements =
        std::fs::read_to_string(directory.join("requirements.md")).unwrap();
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/artifacts/{id}/requirements.md"),
            json!({"content":format!("{confirmed_requirements}\nManual document note\n"),"previous":confirmed_requirements})
        )
        .0,
        200
    );
    let original = h.api("GET", &format!("/api/artifacts/{id}/tasks.md"), Value::Null)["content"]
        .as_str()
        .unwrap()
        .to_string();
    std::fs::write(directory.join("tasks.md"), "Agent's newer draft").unwrap();
    assert_eq!(
        h.http(
            "POST",
            &format!("/api/artifacts/{id}/tasks.md"),
            json!({"content":"stale editor write","previous":original})
        )
        .0,
        400
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("tasks.md")).unwrap(),
        "Agent's newer draft"
    );
    let outside = h.0.path().join("outside.md");
    std::fs::write(&outside, "private outside content").unwrap();
    std::os::unix::fs::symlink(&outside, directory.join("symlink.md")).unwrap();
    assert_eq!(
        h.http(
            "GET",
            &format!("/api/artifacts/{id}/symlink.md"),
            Value::Null
        )
        .0,
        400
    );
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"main_agent":"coder","coding_agents":["coder"],"automatic":false}),
    );
    let requirement = h.workflow()["specs"][0]["requirement_id"]
        .as_str()
        .unwrap()
        .to_string();
    let request = Uuid::new_v4().to_string();
    let (status, _) = h.http(
        "POST",
        &format!("/api/requirements/{requirement}/chat"),
        json!({
            "prompt":"添加任务：过期会话不应创建任务",
            "request_id":Uuid::new_v4(),
            "session_id":Uuid::new_v4()
        }),
    );
    assert_eq!(status, 400);
    assert_eq!(h.workflow()["tasks"].as_array().unwrap().len(), 0);
    let body = json!({"prompt":"添加任务：需求对话中的直接任务","request_id":request});
    let first = h.api(
        "POST",
        &format!("/api/requirements/{requirement}/chat"),
        body.clone(),
    );
    let second = h.api(
        "POST",
        &format!("/api/requirements/{requirement}/chat"),
        body,
    );
    assert_eq!(first["run"]["run_id"], second["run"]["run_id"]);
    h.wait(&first["run"], &["completed"]);
    let state = h.workflow();
    assert_eq!(state["tasks"].as_array().unwrap().len(), 1);
    assert!(state["tasks"][0]["spec_id"].is_null());
    assert_eq!(state["tasks"][0]["status"], "todo");
    h.ok(&["daemon", "restart"]);
    assert_eq!(h.workflow()["conversations"], state["conversations"]);
}

#[test]
fn workflow_missing_handoff_manual_retry_pause_and_restart_do_not_skip_work() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    let (id, directory) = planned_spec(&h);
    std::fs::write(directory.join("missing-handoff-once"), "").unwrap();
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"automatic":true}),
    );
    h.set_spec_phase(&id, "building");
    let failed = h.wait_workflow(|s| s["tasks"][0]["error"].is_string());
    assert_eq!(failed["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(failed["tasks"][0]["status"], "todo");
    h.ok(&["daemon", "restart"]);
    let state = h.workflow();
    assert_eq!(state["tasks"][0]["paused"], true);
    let task = state["tasks"][0]["id"].as_str().unwrap();
    std::fs::write(directory.join("hold-running"), "").unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task}/action"),
        json!({"action":"start"}),
    );
    h.wait_workflow(|s| s["tasks"][0]["run_id"].is_string());
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"pause"}),
    );
    let stopped = h.wait_workflow(|s| s["tasks"][0]["status"] == "todo");
    assert_eq!(stopped["specs"][0]["paused"], true);
    assert_eq!(stopped["tasks"].as_array().unwrap().len(), 1);
    std::fs::remove_file(directory.join("hold-running")).unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task}/action"),
        json!({"action":"start"}),
    );
    h.wait_workflow(|s| s["tasks"][0]["status"] == "done");
    assert_eq!(h.workflow()["tasks"].as_array().unwrap().len(), 1);
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"resume"}),
    );
    h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_verification");
}

#[test]
fn workflow_dispatch_artifact_error_returns_to_pending_instead_of_leaving_a_false_running_claim() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    let (id, directory) = planned_spec(&h);
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"automatic":false}),
    );
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|s| s["tasks"].as_array().unwrap().len() == 1);
    let moved = directory.with_extension("moved");
    std::fs::rename(&directory, &moved).unwrap();
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"automatic":true}),
    );
    let state = h.wait_workflow(|s| s["tasks"][0]["error"].is_string());
    assert_eq!(state["tasks"][0]["status"], "todo");
    assert_eq!(state["tasks"][0]["paused"], true);
    assert!(state["tasks"][0]["run_id"].is_null());
    std::fs::rename(moved, &directory).unwrap();
    let task = state["tasks"][0]["id"].as_str().unwrap();
    h.api(
        "POST",
        &format!("/api/tasks/{task}/action"),
        json!({"action":"start"}),
    );
    h.wait_workflow(|s| s["specs"][0]["phase"] == "ready_verification");
}

#[test]
fn workflow_stop_finds_execution_even_when_persisting_the_run_link_failed() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.workflow_agent("pi", "coder");
    let (id, directory) = planned_spec(&h);
    std::fs::write(directory.join("hold-running"), "").unwrap();
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"automatic":false}),
    );
    h.set_spec_phase(&id, "building");
    h.wait_workflow(|s| s["tasks"].as_array().unwrap().len() == 1);
    h.sql("CREATE TRIGGER fail_task_link BEFORE UPDATE ON workflow_state WHEN json_type(new.snapshot,'$.tasks[0].run_id')='text' BEGIN SELECT RAISE(ABORT,'injected run-link failure'); END");
    h.api(
        "POST",
        "/api/workflow/settings",
        json!({"coding_agents":["coder"],"automatic":true}),
    );
    let state = h.wait_workflow(|s| {
        s["tasks"][0]["request_id"].is_string() && s["tasks"][0]["run_id"].is_null()
    });
    let task = state["tasks"][0]["id"].as_str().unwrap();
    let (status, _) = h.http("DELETE", &format!("/api/tasks/{task}"), Value::Null);
    assert!(
        status >= 400,
        "active run with missing task link must block deletion"
    );

    h.api(
        "POST",
        &format!("/api/tasks/{task}/action"),
        json!({"action":"stop"}),
    );
    let run = h.api("GET", "/api/agents/coder/history", Value::Null)["runs"][0]["run"].clone();
    assert!(run["run_id"].is_string());
    h.wait(&run, &["cancelled"]);
    h.sql("DROP TRIGGER fail_task_link");
    let stopped = h.wait_workflow(|s| s["tasks"][0]["status"] == "todo");
    assert_eq!(stopped["tasks"][0]["paused"], true);
    assert_eq!(stopped["tasks"].as_array().unwrap().len(), 1);
    let document = std::fs::read(directory.join("tasks.md")).unwrap();
    let history = h.api("GET", "/api/agents/coder/history", Value::Null);
    h.api("DELETE", &format!("/api/tasks/{task}"), Value::Null);
    h.ok(&["daemon", "restart"]);
    thread::sleep(Duration::from_millis(900));
    let deleted = h.workflow();
    assert!(deleted["tasks"].as_array().unwrap().is_empty());
    assert_eq!(deleted["specs"][0]["paused"], true);
    assert_eq!(std::fs::read(directory.join("tasks.md")).unwrap(), document);
    assert_eq!(
        h.api("GET", "/api/agents/coder/history", Value::Null),
        history
    );
    assert!(directory.exists());
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
        let mut config: Value =
            serde_json::from_str(&h.ok(&["agent", "inspect", provider])).unwrap();
        config["model"] = json!("next-model");
        h.api("PUT", &format!("/api/agents/{provider}"), config);
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
        if provider == "codex" {
            let trace = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl")).unwrap();
            for method in ["thread/start", "thread/resume"] {
                let request = trace
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap())
                    .find(|entry| entry["request"]["method"] == method)
                    .unwrap()["request"]
                    .clone();
                assert_eq!(request["params"]["sandbox"], "danger-full-access");
                assert_eq!(request["params"]["approvalPolicy"], "never");
                if method == "thread/resume" {
                    assert_eq!(request["params"]["model"], "next-model");
                }
            }
        }
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
    let project = json!({"id":id,"name":"本机项目","description":"persisted","directories":[],"preferred_directory":null,"requirements":[{"id":Uuid::new_v4(),"title":"需求","description":""}]});
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
fn console_state_sse_sends_snapshots_changes_and_recovers_agent_file_errors() {
    async fn next_event(response: &mut reqwest::Response, buffer: &mut Vec<u8>) -> (String, Value) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(end) = buffer.windows(2).position(|bytes| bytes == b"\n\n") {
                    let bytes: Vec<_> = buffer.drain(..end + 2).collect();
                    let frame = std::str::from_utf8(&bytes).unwrap();
                    let name = frame.lines().find_map(|line| line.strip_prefix("event: "));
                    let data = frame.lines().find_map(|line| line.strip_prefix("data: "));
                    if let (Some(name), Some(data)) = (name, data) {
                        return (name.to_string(), serde_json::from_str(data).unwrap());
                    }
                } else {
                    buffer.extend_from_slice(&response.chunk().await.unwrap().expect("SSE closed"));
                }
            }
        })
        .await
        .expect("SSE event timeout")
    }

    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.add_native("pi", "helper");
    let url = h.url();
    let path = h.0.path().join("agents/helper.json");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let client = reqwest::Client::new();
        let mut response = client.get(format!("{url}/api/events")).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut buffer = Vec::new();
        let (name, agents) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "agents");
        assert_eq!(agents["agents"][0]["name"], "helper");
        let (name, workflow) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "workflow");
        assert!(workflow["tasks"].as_array().unwrap().is_empty());
        assert!(tokio::time::timeout(
            Duration::from_millis(1200),
            next_event(&mut response, &mut buffer),
        ).await.is_err(), "unchanged snapshots must not be resent");

        client.post(format!("{url}/api/agents/helper/availability"))
            .json(&json!({"enabled": false})).send().await.unwrap().error_for_status().unwrap();
        let (name, agents) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "agents");
        assert_eq!(agents["agents"][0]["enabled"], false);

        let saved = std::fs::read(&path).unwrap();
        std::fs::write(&path, "invalid JSON").unwrap();
        let (name, error) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "agents");
        assert!(error["error"].as_str().unwrap().contains("parse"));
        std::fs::write(&path, saved).unwrap();
        let (name, recovered) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "agents");
        assert_eq!(recovered, agents);

        client.post(format!("{url}/api/workflow/settings"))
            .json(&json!({"main_agent": "helper", "coding_agents": ["helper"], "review_agents": [], "automatic": false}))
            .send().await.unwrap().error_for_status().unwrap();
        let (name, workflow) = next_event(&mut response, &mut buffer).await;
        assert_eq!(name, "workflow");
        assert_eq!(workflow["settings"]["main_agent"], "helper");
        assert_eq!(workflow["settings"]["automatic"], false);

        drop(response);
        let mut response = client.get(format!("{url}/api/events")).send().await.unwrap();
        buffer.clear();
        assert_eq!(next_event(&mut response, &mut buffer).await, ("agents".into(), agents));
        assert_eq!(next_event(&mut response, &mut buffer).await, ("workflow".into(), workflow));
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
fn project_config_has_no_tasks_and_cannot_overwrite_sqlite_tasks() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let (spec_id, directory) = planned_spec(&h);
    let project = h.api("GET", "/api/projects", Value::Null)["projects"][0].clone();
    assert!(project["requirements"][0].get("tasks").is_none());
    let task = h.api("POST", "/api/tasks", json!({"requirement_id":project["requirements"][0]["id"],"title":"SQLite task","role":"coding"}));
    let workflow = h.workflow();
    let document = std::fs::read(directory.join("tasks.md")).unwrap();
    let mut invalid = project.clone();
    invalid["requirements"][0]["tasks"] = json!([]);
    assert!(
        h.http(
            "POST",
            "/api/projects",
            json!({"project":invalid,"previous":project})
        )
        .0 >= 400
    );
    let mut edited = project.clone();
    edited["requirements"][0]["description"] = json!("updated requirement");
    let saved = h.api(
        "POST",
        "/api/projects",
        json!({"project":edited,"previous":project}),
    )["project"]
        .clone();
    assert!(saved["requirements"][0].get("tasks").is_none());
    let disk: Value = serde_json::from_slice(
        &std::fs::read(
            h.0.path()
                .join("projects")
                .join(format!("{}.json", saved["id"].as_str().unwrap())),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(disk, saved);
    assert_eq!(h.workflow()["tasks"], workflow["tasks"]);
    assert_eq!(h.workflow()["tasks"][0]["id"], task["task"]["id"]);
    assert_eq!(std::fs::read(directory.join("tasks.md")).unwrap(), document);
    assert_eq!(h.workflow()["specs"][0]["id"], spec_id);
}

#[test]
fn agent_settings_persist_validate_isolate_and_reach_native_launch() {
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    h.add_native("codex", "settings-codex");
    h.add_native("pi", "settings-pi");
    let original: Value =
        serde_json::from_str(&h.ok(&["agent", "inspect", "settings-codex"])).unwrap();
    let pi: Value = serde_json::from_str(&h.ok(&["agent", "inspect", "settings-pi"])).unwrap();
    let skill_root = h.0.path().join("extra-skills");
    std::fs::create_dir_all(skill_root.join("review")).unwrap();
    let manifest = skill_root.join("review/SKILL.md");
    std::fs::write(
        &manifest,
        "---\nname: review\ndescription: Review code\n---\nReview",
    )
    .unwrap();
    let mut next = original.clone();
    next["permissions"] = json!("full_access");
    next["reasoning_effort"] = json!("high");
    next["model"] = json!("test-model");
    next["skill_directories"] = json!([skill_root]);
    next["disabled_skills"] = json!([manifest]);
    next["enabled"] = json!(false);
    let saved = h.api("PUT", "/api/agents/settings-codex", next.clone());
    assert_eq!(saved["agent"]["enabled"], true);
    assert_eq!(saved["agent"]["reasoning_effort"], "high");
    assert_eq!(
        serde_json::from_str::<Value>(&h.ok(&["agent", "inspect", "settings-pi"])).unwrap(),
        pi
    );
    let skills = h.api("GET", "/api/agents/settings-codex/skills", Value::Null);
    assert!(
        skills["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|skill| skill["name"] == "review" && skill["enabled"] == false)
    );
    let run = h.start("settings-codex", "normal", None);
    h.wait(&run, &["completed"]);
    let trace = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl")).unwrap();
    assert!(
        trace.contains("\"sandbox\": \"danger-full-access\""),
        "{trace}"
    );
    assert!(
        trace.contains("model_reasoning_effort=\\\"high\\\""),
        "{trace}"
    );
    assert!(trace.contains("skills.config="), "{trace}");
    assert!(trace.contains("test-model"), "{trace}");
    let mut invalid = next.clone();
    invalid["reasoning_effort"] = json!("injected; command");
    assert!(h.http("PUT", "/api/agents/settings-codex", invalid).0 >= 400);
    let mut invalid = next.clone();
    invalid["name"] = json!("renamed");
    assert!(h.http("PUT", "/api/agents/settings-codex", invalid).0 >= 400);
    let run = h.start("settings-codex", "slow", None);
    h.wait(&run, &["running"]);
    assert!(h.http("PUT", "/api/agents/settings-codex", next.clone()).0 >= 400);
    h.control(&run, "cancel", json!({}));
    h.wait(&run, &["cancelled"]);
    next["permissions"] = json!("read_only");
    h.api("PUT", "/api/agents/settings-codex", next);
    h.ok(&["daemon", "restart"]);
    let persisted: Value =
        serde_json::from_str(&h.ok(&["agent", "inspect", "settings-codex"])).unwrap();
    assert_eq!(persisted["permissions"], "read_only");
    assert_eq!(persisted["model"], "test-model");
    let run = h.start("settings-codex", "normal", None);
    h.wait(&run, &["completed"]);
    let trace = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl")).unwrap();
    assert!(trace.contains("\"sandbox\": \"read-only\""), "{trace}");
    let mut invalid_pi = pi.clone();
    invalid_pi["permissions"] = json!("read_only");
    assert!(h.http("PUT", "/api/agents/settings-pi", invalid_pi).0 >= 400);
    let mut pi = pi;
    pi["reasoning_effort"] = json!("medium");
    pi["skill_directories"] = json!([skill_root]);
    pi["disabled_skills"] = json!([manifest]);
    std::fs::create_dir_all(skill_root.join("testing")).unwrap();
    std::fs::write(
        skill_root.join("testing/SKILL.md"),
        "---\nname: testing\ndescription: Test code\n---\nTest",
    )
    .unwrap();
    h.api("PUT", "/api/agents/settings-pi", pi);
    let run = h.start("settings-pi", "normal", None);
    h.wait(&run, &["completed"]);
    let trace = std::fs::read_to_string(h.0.path().join("agent-trace.jsonl")).unwrap();
    let args = trace
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|record| record["startup"]["args"].as_array().cloned())
        .find(|args| args.iter().any(|arg| arg == "--mode"))
        .unwrap();
    assert!(args.contains(&json!("--no-skills")));
    assert!(args.contains(&json!("--thinking")));
    assert!(args.contains(&json!("medium")));
    assert!(args.contains(&json!(
        skill_root.join("testing/SKILL.md").canonicalize().unwrap()
    )));
    assert!(!args.contains(&json!(manifest.canonicalize().unwrap())));
}

#[test]
fn spec_next_phase_status_requires_review_ready_documents_even_when_automatic_execution_is_paused()
{
    let h = Harness::new();
    h.ok(&["daemon", "start"]);
    let (id, directory) = planned_spec(&h);
    assert!(
        h.workflow()["ready_spec_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let path = directory.join(".spec-state.json");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    state["blocking"] = json!("User review of tasks.md");
    std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    h.api(
        "POST",
        &format!("/api/specs/{id}/action"),
        json!({"action":"pause"}),
    );
    let snapshot = h.workflow();
    assert_eq!(snapshot["specs"][0]["paused"], true);
    assert_eq!(snapshot["ready_spec_ids"], json!([id]));
    let tasks = std::fs::read(directory.join("tasks.md")).unwrap();
    std::fs::write(directory.join("tasks.md"), "").unwrap();
    assert!(
        h.workflow()["ready_spec_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    std::fs::write(directory.join("tasks.md"), tasks).unwrap();
    state["blocking"] = json!("Please clarify the acceptance criteria");
    std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    assert!(
        h.workflow()["ready_spec_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
