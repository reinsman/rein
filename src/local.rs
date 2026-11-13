//! Standalone execution: editable configuration files and durable chat/event history.
use crate::{
    agents::{AgentConfig, AgentFiles},
    execution::{
        Backend, ExecutionManager, LocalEvent, LocalRun,
        a2a::{A2aBackend, A2aControl},
        native::{NativeBackend, NativeControl},
    },
    store::LocalStore,
};
use anyhow::{Context, Result, ensure};
use rein_proto::hub::v1::{self as pb, execution_event};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone)]
enum Control {
    Native(NativeControl),
    A2a(A2aControl),
}
impl Control {
    fn cancel(&self) {
        match self {
            Self::Native(c) => c.cancel(),
            Self::A2a(c) => c.cancel(),
        }
    }
    fn references(&self) -> (Option<String>, Option<String>) {
        match self {
            Self::Native(c) => (c.native_id(), None),
            Self::A2a(c) => (None, c.reference().0),
        }
    }
    async fn command(&self, command: &pb::ControlCommand) -> Result<pb::CommandAck> {
        match self {
            Self::Native(c) => c.command(command),
            Self::A2a(c) => c.command(command).await,
        }
    }
}
struct Active {
    agent: String,
    control: Control,
    task: Option<JoinHandle<()>>,
}
#[derive(Clone)]
pub struct LocalRuntime {
    pub agents: AgentFiles,
    pub store: LocalStore,
    pub directory: PathBuf,
    execution: ExecutionManager,
    active: Arc<Mutex<HashMap<String, Active>>>,
    operations: Arc<Mutex<()>>,
    stopping: Arc<AtomicBool>,
}
#[derive(Debug, Clone, Serialize)]
pub struct RunRecord {
    pub run: LocalRun,
    pub agent_id: String,
    pub prompt: String,
    pub created_at: String,
    pub version: String,
    pub events: Vec<LocalEvent>,
    pub command_acks: Vec<Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub directories: Vec<PathBuf>,
    #[serde(default)]
    pub preferred_directory: Option<PathBuf>,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tasks: Vec<Task>,
}
pub use crate::sdd::Task;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Todo,
    Running,
    Done,
}

impl LocalRuntime {
    pub async fn new(directory: PathBuf, store: LocalStore) -> Result<Self> {
        for child in ["agents", "projects"] {
            let path = directory.join(child);
            fs::create_dir_all(&path)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
        let runtime = Self {
            agents: AgentFiles(directory.join("agents")),
            directory,
            store,
            execution: ExecutionManager::default(),
            active: Default::default(),
            operations: Default::default(),
            stopping: Default::default(),
        };
        let rows = sqlx::query("SELECT id,snapshot FROM local_runs WHERE json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled')").fetch_all(&runtime.store.pool).await?;
        for row in rows {
            let mut run: LocalRun = serde_json::from_str(row.get("snapshot"))?;
            run.state = "failed".into();
            run.error = Some("Daemon interrupted this execution; start a new conversation. Remote execution may still be running.".into());
            sqlx::query("UPDATE local_sessions SET blocked=1 WHERE id=?")
                .bind(&run.session_id)
                .execute(&runtime.store.pool)
                .await?;
            runtime.save_run(&mut run).await?;
        }
        Ok(runtime)
    }
    pub async fn add_agent(&self, mut config: AgentConfig) -> Result<AgentConfig> {
        let _guard = self.operations.lock().await;
        config.enabled = false;
        self.agents.add(&config)?;
        Ok(config)
    }
    pub async fn set_enabled(&self, name: &str, enabled: bool) -> Result<AgentConfig> {
        let _guard = self.operations.lock().await;
        if !enabled {
            self.ensure_idle(name).await?;
        }
        self.agents.set_enabled(name, enabled)
    }
    pub async fn remove_agent(&self, name: &str) -> Result<()> {
        let _guard = self.operations.lock().await;
        self.ensure_idle(name).await?;
        self.agents.remove(name)
    }
    async fn ensure_idle(&self, name: &str) -> Result<()> {
        ensure!(
            !self.active.lock().await.values().any(|a| a.agent == name),
            "agent is running; stop its execution in Console first"
        );
        Ok(())
    }
    pub async fn start(
        &self,
        agent_id: String,
        session_id: Option<String>,
        prompt: String,
        request_id: String,
    ) -> Result<LocalRun> {
        let _guard = self.operations.lock().await;
        ensure!(!self.stopping.load(Ordering::SeqCst), "daemon is stopping");
        ensure!(
            !prompt.trim().is_empty() && prompt.len() <= 48 * 1024,
            "prompt must contain 1–48 KiB"
        );
        ensure!(
            Uuid::parse_str(&request_id).is_ok(),
            "request_id must be a UUID"
        );
        if let Some(row) = sqlx::query(
            "SELECT agent_id,session_id,prompt,snapshot FROM local_runs WHERE request_id=?",
        )
        .bind(&request_id)
        .fetch_optional(&self.store.pool)
        .await?
        {
            ensure!(
                row.get::<String, _>("agent_id") == agent_id
                    && row.get::<String, _>("prompt") == prompt
                    && session_id
                        .as_ref()
                        .is_none_or(|id| id == row.get::<String, _>("session_id").as_str()),
                "request_id reused with different content"
            );
            return Ok(serde_json::from_str(row.get("snapshot"))?);
        }
        let config = self.agents.get(&agent_id)?;
        ensure!(config.enabled, "agent is down; run `rein agent up <name>`");
        self.ensure_idle(&agent_id).await?;
        let mut session_config = config.clone();
        session_config.enabled = true;
        let configuration = format!("{:x}", Sha256::digest(serde_json::to_vec(&session_config)?));
        let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        ensure!(
            Uuid::parse_str(&session_id).is_ok(),
            "session_id must be a UUID"
        );
        let existing = sqlx::query("SELECT * FROM local_sessions WHERE id=?")
            .bind(&session_id)
            .fetch_optional(&self.store.pool)
            .await?;
        let (native_id, context_id) = if let Some(row) = &existing {
            ensure!(
                row.get::<String, _>("agent_id") == agent_id,
                "session belongs to a different agent"
            );
            ensure!(
                row.get::<String, _>("config_hash") == configuration,
                "agent configuration changed; start a new conversation"
            );
            ensure!(
                row.get::<i64, _>("blocked") == 0,
                "previous execution could not confirm shutdown; start a new conversation"
            );
            (
                row.get::<Option<String>, _>("native_id"),
                row.get::<Option<String>, _>("context_id"),
            )
        } else {
            (None, None)
        };
        let busy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_runs WHERE session_id=? AND json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled')").bind(&session_id).fetch_one(&self.store.pool).await?;
        ensure!(busy == 0, "session is already running");
        let mut run = LocalRun {
            run_id: format!("local-{}", Uuid::new_v4()),
            attempt_id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            provider: match config.provider {
                crate::agents::AgentType::Pi => "pi",
                crate::agents::AgentType::Codex => "codex",
            }
            .into(),
            state: "dispatched".into(),
            cancel_requested: false,
            native_session_id: native_id.clone(),
            last_sequence: 0,
            finished_at: None,
            error: None,
        };
        let attempt = pb::AttemptRef {
            run_id: run.run_id.clone(),
            attempt_id: run.attempt_id.clone(),
        };
        let (backend, control, directory): (Box<dyn Backend>, Control, _) =
            if let Some(options) = &config.a2a {
                let backend = A2aBackend::new(options.clone(), attempt, context_id);
                let control = Control::A2a(backend.control_handle());
                (Box::new(backend), control, None)
            } else {
                let options = config.native_options().resolve()?;
                let directory = Some(options.agent.workspace.clone());
                let mut backend = NativeBackend::new(options);
                backend.restore_native_id(native_id);
                backend.prepare(attempt);
                let control = Control::Native(backend.control_handle());
                (Box::new(backend), control, directory)
            };
        let permit = self.execution.reserve(directory)?;
        let mut tx = self.store.pool.begin().await?;
        if existing.is_none() {
            sqlx::query("INSERT INTO local_sessions(id,agent_id,config_hash) VALUES(?,?,?)")
                .bind(&session_id)
                .bind(&agent_id)
                .bind(configuration)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO local_runs(id,request_id,agent_id,session_id,prompt,snapshot) VALUES(?,?,?,?,?,?)").bind(&run.run_id).bind(request_id).bind(&agent_id).bind(&session_id).bind(&prompt).bind(serde_json::to_string(&run)?).execute(&mut *tx).await?;
        tx.commit().await?;
        let initial = run.clone();
        let lease = pb::RunLease {
            run: Some(pb::Run {
                id: run.run_id.clone(),
                attempt_id: run.attempt_id.clone(),
                agent_id: agent_id.clone(),
                session_id,
                ..Default::default()
            }),
            prompt,
            ..Default::default()
        };
        let mut active = self.active.lock().await;
        active.insert(
            run.run_id.clone(),
            Active {
                agent: agent_id,
                control: control.clone(),
                task: None,
            },
        );
        let runtime = self.clone();
        let id = run.run_id.clone();
        let task = tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = runtime.execute(&mut run, backend, control, lease).await {
                eprintln!("reind: persistence/execution failure: {error:#}");
                run.state = "failed".into();
                run.error = Some(format!("{error:#}"));
                let _ = runtime.save_run(&mut run).await;
                let _ = sqlx::query("UPDATE local_sessions SET blocked=1 WHERE id=?")
                    .bind(&run.session_id)
                    .execute(&runtime.store.pool)
                    .await;
            }
            runtime.active.lock().await.remove(&run.run_id);
        });
        active.get_mut(&id).unwrap().task = Some(task);
        Ok(initial)
    }
    async fn save_run(&self, run: &mut LocalRun) -> Result<()> {
        stamp_finished(run)?;
        sqlx::query("UPDATE local_runs SET snapshot=json_set(?, '$.cancel_requested', json(CASE WHEN json_extract(snapshot,'$.cancel_requested') THEN 'true' ELSE 'false' END)),version=version+1 WHERE id=?")
            .bind(serde_json::to_string(run)?)
            .bind(&run.run_id)
            .execute(&self.store.pool)
            .await?;
        Ok(())
    }
    async fn execute(
        &self,
        run: &mut LocalRun,
        mut backend: Box<dyn Backend>,
        control: Control,
        lease: pb::RunLease,
    ) -> Result<()> {
        let (tx, mut rx) = mpsc::channel(32);
        let execute = backend.execute(&lease, tx);
        tokio::pin!(execute);
        let mut open = true;
        let mut persisted = true;
        let mut failure = None;
        let mut stopped = false;
        let result = loop {
            tokio::select! {
                event = rx.recv(), if open => match event {
                    Some(event) => {
                        if let Some(execution_event::Payload::Result(result)) = &event.payload { stopped = result.execution_stopped; }
                        if persisted && let Err(error) = self.record(run, event, &control).await {
                            persisted = false; failure = Some(error); control.cancel();
                        }
                    },
                    None => open = false,
                },
                result = &mut execute => {
                    while let Ok(event) = rx.try_recv() {
                        if let Some(execution_event::Payload::Result(result)) = &event.payload { stopped = result.execution_stopped; }
                        if persisted && let Err(error) = self.record(run, event, &control).await {
                            persisted = false; failure = Some(error); control.cancel();
                        }
                    }
                    break result;
                }
            }
        };
        let (native_id, context_id) = control.references();
        run.native_session_id = native_id.clone();
        if let Err(error) = result {
            run.state = "failed".into();
            run.error = Some(format!("{error:#}"));
        }
        if !terminal(&run.state) {
            run.state = "failed".into();
            run.error = Some("execution ended without a terminal result".into());
        }
        sqlx::query("UPDATE local_sessions SET native_id=?,context_id=?,blocked=? WHERE id=?")
            .bind(native_id)
            .bind(context_id)
            .bind(!stopped)
            .bind(&run.session_id)
            .execute(&self.store.pool)
            .await?;
        if let Some(error) = failure {
            return Err(error);
        }
        self.save_run(run).await
    }
    async fn record(
        &self,
        run: &mut LocalRun,
        event: pb::ExecutionEvent,
        control: &Control,
    ) -> Result<()> {
        crate::execution::log_execution_event(&event);
        let event = crate::execution::local_event(event);
        if matches!(event.event["type"].as_str(), Some("state" | "result")) {
            run.state = event.event["state"]
                .as_str()
                .context("state missing")?
                .into();
        }
        if event.event["type"] == "error" {
            run.error = event.event["message"].as_str().map(String::from);
        }
        stamp_finished(run)?;
        run.last_sequence = event.sequence;
        run.native_session_id = control.references().0;
        let mut tx = self.store.pool.begin().await?;
        sqlx::query("INSERT INTO local_events VALUES(?,?,?)")
            .bind(&run.run_id)
            .bind(event.sequence as i64)
            .bind(serde_json::to_string(&event)?)
            .execute(&mut *tx)
            .await?;
        if event.event["type"] == "result" {
            let (native_id, context_id) = control.references();
            sqlx::query("UPDATE local_sessions SET native_id=?,context_id=?,blocked=? WHERE id=?")
                .bind(native_id)
                .bind(context_id)
                .bind(event.event["execution_stopped"] != true)
                .bind(&run.session_id)
                .execute(&mut *tx)
                .await?;
        }
        // Preserve cancel intent written by a concurrent control request.
        let cancelled: bool = sqlx::query_scalar(
            "SELECT json_extract(snapshot,'$.cancel_requested') FROM local_runs WHERE id=?",
        )
        .bind(&run.run_id)
        .fetch_one(&mut *tx)
        .await?;
        run.cancel_requested |= cancelled;
        sqlx::query("UPDATE local_runs SET snapshot=?,version=version+1 WHERE id=?")
            .bind(serde_json::to_string(run)?)
            .bind(&run.run_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn get(&self, id: &str, events_after: u64) -> Result<RunRecord> {
        let row = sqlx::query("SELECT * FROM local_runs WHERE id=?")
            .bind(id)
            .fetch_optional(&self.store.pool)
            .await?
            .context("run not found")?;
        let events: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM local_events WHERE run_id=? AND sequence>? ORDER BY sequence",
        )
        .bind(id)
        .bind(events_after as i64)
        .fetch_all(&self.store.pool)
        .await?;
        let acks: Vec<String> = sqlx::query_scalar("SELECT ack FROM local_commands WHERE run_id=?")
            .bind(id)
            .fetch_all(&self.store.pool)
            .await?;
        Ok(RunRecord {
            run: serde_json::from_str(row.get("snapshot"))?,
            agent_id: row.get("agent_id"),
            prompt: row.get("prompt"),
            created_at: row.get("created_at"),
            version: row.get::<i64, _>("version").to_string(),
            events: events
                .iter()
                .map(|e| serde_json::from_str(e))
                .collect::<Result<_, _>>()?,
            command_acks: acks
                .iter()
                .map(|e| serde_json::from_str(e))
                .collect::<Result<_, _>>()?,
        })
    }
    pub async fn history(&self, agent: &str, session: &str, before: &str) -> Result<Value> {
        let sessions = sqlx::query("SELECT session_id,prompt FROM local_runs WHERE agent_id=? GROUP BY session_id HAVING rowid=MIN(rowid) ORDER BY MIN(rowid) DESC").bind(agent).fetch_all(&self.store.pool).await?;
        let session = if session.is_empty() {
            sessions
                .first()
                .map(|r| r.get::<String, _>("session_id"))
                .unwrap_or_default()
        } else {
            session.into()
        };
        let before = if before.is_empty() {
            i64::MAX
        } else {
            before.parse::<i64>().context("invalid history cursor")?
        };
        let rows = sqlx::query("SELECT rowid,id FROM local_runs WHERE agent_id=? AND session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21").bind(agent).bind(&session).bind(before).fetch_all(&self.store.pool).await?;
        let more = rows.len() > 20;
        let mut records = Vec::new();
        for row in rows.iter().take(20) {
            records.push(self.get(row.get("id"), 0).await?);
        }
        Ok(
            json!({ "runs": records, "sessions": sessions.iter().map(|r| json!({"id":r.get::<String,_>("session_id"),"prompt":r.get::<String,_>("prompt")})).collect::<Vec<_>>(), "session_id": session, "next_cursor": if more { rows[19].get::<i64,_>("rowid").to_string() } else { String::new() }, "stream_cursor": "local" }),
        )
    }
    pub async fn command(
        &self,
        id: &str,
        attempt_id: String,
        command_id: String,
        payload: pb::control_command::Payload,
    ) -> Result<Value> {
        let _guard = self.operations.lock().await;
        ensure!(
            Uuid::parse_str(&command_id).is_ok(),
            "command_id must be a UUID"
        );
        let command = pb::ControlCommand {
            command_id: command_id.clone(),
            attempt: Some(pb::AttemptRef {
                run_id: id.into(),
                attempt_id,
            }),
            payload: Some(payload),
        };
        use prost::Message;
        let fingerprint = format!("{:x}", Sha256::digest(command.encode_to_vec()));
        if let Some(row) = sqlx::query("SELECT payload,ack FROM local_commands WHERE id=?")
            .bind(&command_id)
            .fetch_optional(&self.store.pool)
            .await?
        {
            ensure!(
                row.get::<String, _>("payload") == fingerprint,
                "command_id reused with different content"
            );
            return Ok(serde_json::from_str(row.get("ack"))?);
        }
        let control = self
            .active
            .lock()
            .await
            .get(id)
            .context("execution is no longer active")?
            .control
            .clone();
        let ack = control.command(&command).await?;
        let value = json!({ "commandId":ack.command_id, "state":ack.state().as_str_name(), "errorCode":ack.error_code });
        sqlx::query("INSERT INTO local_commands VALUES(?,?,?,?)")
            .bind(&command_id)
            .bind(id)
            .bind(fingerprint)
            .bind(serde_json::to_string(&value)?)
            .execute(&self.store.pool)
            .await?;
        if matches!(
            command.payload,
            Some(pb::control_command::Payload::Cancel(_))
        ) {
            sqlx::query("UPDATE local_runs SET snapshot=json_set(snapshot,'$.cancel_requested',json('true')),version=version+1 WHERE id=?").bind(id).execute(&self.store.pool).await?;
        }
        Ok(value)
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _guard = self.operations.lock().await;
        let tasks: Vec<_> = self
            .active
            .lock()
            .await
            .values_mut()
            .filter_map(|a| {
                a.control.cancel();
                a.task.take()
            })
            .collect();
        for task in tasks {
            let _ = task.await;
        }
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let mut projects = Vec::new();
        for entry in fs::read_dir(self.directory.join("projects"))? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let project: Project = crate::agents::read_json(&path)?;
                ensure!(
                    path.file_stem().and_then(|s| s.to_str()) == Some(&project.id),
                    "project filename must match id"
                );
                projects.push(project);
            }
        }
        projects.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(projects)
    }
    pub async fn save_project(
        &self,
        mut project: Project,
        previous: Option<Project>,
    ) -> Result<Project> {
        let _guard = self.operations.lock().await;
        let current = self.projects()?.into_iter().find(|p| p.id == project.id);
        ensure!(
            current == previous,
            "project changed on disk; reload before saving"
        );
        ensure!(
            Uuid::parse_str(&project.id).is_ok(),
            "project id must be a UUID"
        );
        ensure!(
            !project.name.trim().is_empty()
                && project.name.len() <= 240
                && project.description.len() <= 12000,
            "invalid project name or description"
        );
        ensure!(
            !self
                .projects()?
                .iter()
                .any(|p| p.id != project.id && p.name == project.name),
            "project name already exists"
        );
        let mut directories = std::collections::HashSet::new();
        for directory in &project.directories {
            ensure!(
                directory.is_absolute() && directory.is_dir(),
                "working directory must be an existing absolute directory: {}",
                directory.display()
            );
            ensure!(
                directories.insert(directory),
                "duplicate working directory: {}",
                directory.display()
            );
        }
        if project.preferred_directory.is_none() {
            project.preferred_directory = project.directories.first().cloned();
        }
        ensure!(
            project
                .preferred_directory
                .as_ref()
                .is_none_or(|directory| project.directories.contains(directory)),
            "preferred directory must be one of the project working directories"
        );
        let mut ids = std::collections::HashSet::new();
        for requirement in &project.requirements {
            let old_tasks = current
                .as_ref()
                .and_then(|p| p.requirements.iter().find(|r| r.id == requirement.id))
                .map_or(&[][..], |r| r.tasks.as_slice());
            crate::sdd::validate(&requirement.tasks, old_tasks)?;
            ensure!(
                !requirement.title.trim().is_empty()
                    && requirement.title.len() <= 240
                    && requirement.description.len() <= 12000
                    && Uuid::parse_str(&requirement.id).is_ok()
                    && ids.insert(&requirement.id),
                "invalid or duplicate requirement"
            );
            for task in &requirement.tasks {
                ensure!(
                    !task.title.trim().is_empty()
                        && task.title.len() <= 240
                        && Uuid::parse_str(&task.id).is_ok()
                        && ids.insert(&task.id),
                    "invalid or duplicate task"
                );
            }
        }
        crate::agents::write_json(
            &self
                .directory
                .join("projects")
                .join(format!("{}.json", project.id)),
            &project,
        )?;
        Ok(project)
    }
}
fn stamp_finished(run: &mut LocalRun) -> Result<()> {
    if terminal(&run.state) && run.finished_at.is_none() {
        run.finished_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64,
        );
    }
    Ok(())
}

pub fn terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "cancelled")
}
