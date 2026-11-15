//! Durable Spec state and a shared Todo queue. Agent execution remains in LocalRuntime.
mod spec_runtime;
mod task_runtime;

use crate::local::{LocalRuntime, TaskStatus};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub main_agent: Option<String>,
    pub coding_agents: Vec<String>,
    pub review_agents: Vec<String>,
    pub automatic: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Coding,
    Review,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Requirements,
    Design,
    Tasks,
    Building,
    ReadyVerification,
    Verifying,
    Repairing,
    ReadyComplete,
    Complete,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Criterion {
    pub id: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_ids: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Plan {
    pub criteria: Vec<Criterion>,
    pub tasks: Vec<PlanTask>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub id: String,
    pub project_id: String,
    pub requirement_id: String,
    pub title: String,
    pub description: String,
    pub directory: String,
    pub phase: Phase,
    pub paused: bool,
    pub round: u32,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub plan: Plan,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handoff {
    pub kind: String,
    pub file: String,
    pub agent_id: String,
    pub run_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskResult {
    pub outcome: String,
    pub summary: String,
    pub evidence: String,
    #[serde(default)]
    pub responsible_task_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueTask {
    pub id: String,
    pub requirement_id: String,
    pub spec_id: Option<String>,
    pub title: String,
    pub description: String,
    pub role: Role,
    pub status: TaskStatus,
    pub plan_id: Option<String>,
    pub criterion_id: Option<String>,
    pub round: u32,
    pub paused: bool,
    pub manual: bool,
    pub agent_id: Option<String>,
    pub request_id: Option<String>,
    pub run_id: Option<String>,
    #[serde(default)]
    pub last_run_id: Option<String>,
    #[serde(default)]
    pub execution_state: Option<String>,
    pub attempt: u32,
    pub error: Option<String>,
    pub result: Option<TaskResult>,
    pub handoffs: Vec<Handoff>,
    pub directory: String,
}
impl QueueTask {
    pub fn new(
        requirement_id: String,
        spec: Option<&Spec>,
        title: String,
        description: String,
        role: Role,
        directory: String,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            requirement_id,
            spec_id: spec.map(|s| s.id.clone()),
            title,
            description,
            role,
            status: TaskStatus::Todo,
            plan_id: None,
            criterion_id: None,
            round: spec.map_or(0, |s| s.round),
            paused: false,
            manual: false,
            agent_id: None,
            request_id: None,
            run_id: None,
            last_run_id: None,
            execution_state: None,
            attempt: 0,
            error: None,
            result: None,
            handoffs: vec![],
            directory,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub settings: Settings,
    pub specs: Vec<Spec>,
    pub tasks: Vec<QueueTask>,
    #[serde(default)]
    pub conversations: Vec<Conversation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub requirement_id: String,
    pub agent_id: String,
    pub session_id: String,
}
#[derive(Clone)]
pub struct Workflow {
    pub local: LocalRuntime,
    state: Arc<Mutex<Snapshot>>,
}
pub fn bounded(text: &str, max: usize) -> Result<()> {
    ensure!(
        !text.trim().is_empty() && text.len() <= max,
        "content must contain 1–{max} bytes"
    );
    Ok(())
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
}
impl Plan {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.criteria.len() <= 100 && self.tasks.len() <= 256,
            "too many plan items"
        );
        let mut ids = HashSet::new();
        for c in &self.criteria {
            ensure!(
                valid_key(&c.id) && ids.insert(&c.id),
                "invalid or duplicate acceptance ID"
            );
            bounded(&c.text, 3000)?;
        }
        let mut tasks = HashSet::new();
        for t in &self.tasks {
            ensure!(
                valid_key(&t.id) && tasks.insert(&t.id),
                "invalid or duplicate task ID"
            );
            bounded(&t.title, 240)?;
            ensure!(t.description.len() <= 12000, "task description too long");
            ensure!(
                t.acceptance_ids.len() <= 100 && t.acceptance_ids.iter().all(|id| ids.contains(id)),
                "task references unknown acceptance criterion"
            );
        }
        Ok(())
    }
}
impl Workflow {
    pub async fn conversation(&self, id: &str) -> Result<Conversation> {
        self.requirement(id)?;
        self.edit(|state| {
            let agent = state
                .settings
                .main_agent
                .clone()
                .context("configure the main Agent first")?;
            if let Some(conversation) = state
                .conversations
                .iter()
                .find(|c| c.requirement_id == id && c.agent_id == agent)
            {
                return Ok(conversation.clone());
            }
            let conversation = Conversation {
                id: format!("requirement-{id}"),
                requirement_id: id.into(),
                agent_id: agent,
                session_id: Uuid::new_v4().to_string(),
            };
            state.conversations.push(conversation.clone());
            Ok(conversation)
        })
        .await
    }
    pub async fn requirement_chat(
        &self,
        id: &str,
        prompt: String,
        request_id: String,
        origin: &str,
    ) -> Result<crate::execution::LocalRun> {
        bounded(&prompt, 32 * 1024)?;
        ensure!(
            Uuid::parse_str(&request_id).is_ok(),
            "request_id must be a UUID"
        );
        let conversation = self.conversation(id).await?;
        let (project, requirement) = self.requirement(id)?;
        let directory = project
            .preferred_directory
            .or(project.directories.first().cloned())
            .context("configure a project working directory first")?;
        let direct = ["添加任务：", "添加任务:", "新建任务：", "新建任务:"]
            .iter()
            .find_map(|prefix| prompt.trim().strip_prefix(prefix))
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let created = if let Some(title) = direct {
            ensure!(prompt.len() <= 12000, "task description is too long");
            let title: String = title.chars().take(80).collect();
            self.edit(|state| {
                if let Some(existing) = state.tasks.iter().find(|t| t.id == request_id) {
                    ensure!(
                        existing.requirement_id == id && existing.description == prompt,
                        "request_id reused with different task content"
                    );
                    return Ok(());
                }
                let mut task = QueueTask::new(
                    id.into(),
                    None,
                    title,
                    prompt.clone(),
                    Role::Coding,
                    request_id.clone(),
                );
                task.id = request_id.clone();
                let dir = self.task_dir(&task);
                fs::create_dir_all(&dir)?;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
                state.tasks.push(task);
                Ok(())
            })
            .await?;
            format!(
                "The daemon ALREADY created direct Coding task {request_id} from this message. Acknowledge it; do NOT create another task."
            )
        } else {
            "No task was created automatically.".into()
        };
        let full = format!(
            "You are the main Agent in this requirement discussion. Requirement: {}. Working directory: {}. {}\nDiscuss and clarify the user's request. When the user explicitly requests adding tasks, use the local Todo API to create them: POST {}/api/tasks with JSON {{\"requirement_id\":\"{}\",\"title\":\"task title\",\"description\":\"scope and acceptance\",\"role\":\"coding\"}} (or role review for validation). Check existing tasks via GET {}/api/workflow first; never duplicate an already-created task. Do not execute the implementation in this discussion; Coding and Review Agents are dispatched by the task runtime. Never claim a task was created unless the API succeeds. For a Spec, direct the user to its independent Spec discussion.\nUSER MESSAGE:\n{}",
            requirement.title,
            directory.display(),
            created,
            origin,
            id,
            origin,
            prompt
        );
        self.local
            .start_in_directory(
                conversation.agent_id,
                Some(conversation.session_id),
                full,
                request_id,
                Some(directory),
            )
            .await
    }
    pub async fn new(local: LocalRuntime) -> Result<Self> {
        sqlx::query("CREATE TABLE IF NOT EXISTS workflow_state (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)").execute(&local.store.pool).await?;
        let saved: Option<String> =
            sqlx::query_scalar("SELECT snapshot FROM workflow_state WHERE id=1")
                .fetch_optional(&local.store.pool)
                .await?;
        let state = saved
            .map(|v| serde_json::from_str(&v))
            .transpose()?
            .unwrap_or(Snapshot {
                settings: Settings {
                    automatic: true,
                    ..Default::default()
                },
                ..Default::default()
            });
        for child in ["specs", "tasks"] {
            let dir = local.directory.join(child);
            fs::create_dir_all(&dir)?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            local,
            state: Arc::new(Mutex::new(state)),
        })
    }
    async fn commit(&self, state: &Snapshot) -> Result<()> {
        sqlx::query("INSERT INTO workflow_state(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot").bind(serde_json::to_string(state)?).execute(&self.local.store.pool).await?;
        Ok(())
    }
    async fn edit<T>(&self, apply: impl FnOnce(&mut Snapshot) -> Result<T>) -> Result<T> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        let result = apply(&mut next)?;
        if serde_json::to_vec(&*guard)? != serde_json::to_vec(&next)? {
            self.commit(&next).await?;
            *guard = next;
        }
        Ok(result)
    }
    pub async fn snapshot(&self) -> Snapshot {
        self.state.lock().await.clone()
    }
    pub async fn settings(&self, settings: Settings) -> Result<()> {
        let agents = self.local.agents.list()?;
        let names: HashSet<_> = agents.iter().map(|a| a.name.as_str()).collect();
        ensure!(
            settings.coding_agents.len() <= 64 && settings.review_agents.len() <= 64,
            "too many role assignments"
        );
        let mut assigned = HashSet::new();
        for name in settings.coding_agents.iter().chain(&settings.review_agents) {
            ensure!(
                names.contains(name.as_str()) && assigned.insert(name),
                "unknown or duplicate agent; Coding and Review roles must be separate"
            );
        }
        ensure!(
            settings
                .main_agent
                .as_ref()
                .is_none_or(|name| names.contains(name.as_str())),
            "unknown main agent"
        );
        self.edit(|state| {
            state.settings = settings;
            Ok(())
        })
        .await
    }
    pub fn requirement(
        &self,
        id: &str,
    ) -> Result<(crate::local::Project, crate::local::Requirement)> {
        for project in self.local.projects()? {
            if let Some(r) = project.requirements.iter().find(|r| r.id == id) {
                return Ok((project.clone(), r.clone()));
            }
        }
        bail!("requirement not found")
    }
    pub async fn create_spec(
        &self,
        requirement_id: String,
        title: String,
        description: String,
    ) -> Result<Spec> {
        bounded(&title, 240)?;
        ensure!(description.len() <= 12000, "description too long");
        let (project, _) = self.requirement(&requirement_id)?;
        let stamp: String = sqlx::query_scalar("SELECT strftime('%Y%m%d%H%M','now','localtime')")
            .fetch_one(&self.local.store.pool)
            .await?;
        let id = Uuid::new_v4().to_string();
        let directory = format!("{stamp}-{id}");
        let spec = Spec {
            id,
            project_id: project.id,
            requirement_id,
            title: title.trim().into(),
            description,
            directory,
            phase: Phase::Requirements,
            paused: false,
            round: 0,
            session_id: Uuid::new_v4().to_string(),
            agent_id: None,
            plan: Plan::default(),
            error: None,
        };
        self.edit(|state| {
            ensure!(
                !state
                    .specs
                    .iter()
                    .any(|s| s.requirement_id == spec.requirement_id && s.title == spec.title),
                "Spec name already exists in this requirement"
            );
            let dir = self.spec_dir(&spec);
            fs::create_dir(&dir)?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            for file in ["requirements.md", "design.md", "tasks.md"] {
                write_text(&dir.join(file), "")?;
            }
            crate::agents::write_json(&dir.join("plan.json"), &spec.plan)?;
            state.specs.push(spec.clone());
            Ok(spec)
        })
        .await
    }
    fn spec_dir(&self, spec: &Spec) -> PathBuf {
        self.local.directory.join("specs").join(&spec.directory)
    }
    fn task_dir(&self, task: &QueueTask) -> PathBuf {
        if task.spec_id.is_some() {
            self.local.directory.join("specs").join(&task.directory)
        } else {
            self.local.directory.join("tasks").join(&task.directory)
        }
    }
    pub async fn file(&self, id: &str, name: &str) -> Result<String> {
        let state = self.state.lock().await;
        if let Some(spec) = state.specs.iter().find(|s| s.id == id) {
            let content = read_text(&self.spec_dir(spec).join(allowed_file(name)?))?;
            if name == "plan.json" {
                serde_json::from_str::<Plan>(&content)?.validate()?;
            }
            return Ok(content);
        }
        let task = state
            .tasks
            .iter()
            .find(|t| t.id == id)
            .context("Spec or task not found")?;
        ensure!(
            task.handoffs.iter().any(|h| h.file == name),
            "handoff not found"
        );
        read_text(&self.task_dir(task).join(allowed_file(name)?))
    }
    pub async fn save_file(
        &self,
        id: &str,
        name: &str,
        content: &str,
        previous: Option<&str>,
    ) -> Result<()> {
        ensure!(
            matches!(
                name,
                "requirements.md" | "design.md" | "tasks.md" | "plan.json"
            ),
            "file is read-only"
        );
        ensure!(content.len() <= 128 * 1024, "document too large");
        let state = self.state.lock().await;
        let spec = state
            .specs
            .iter()
            .find(|s| s.id == id)
            .context("Spec not found")?;
        ensure!(
            matches!(
                spec.phase,
                Phase::Requirements | Phase::Design | Phase::Tasks
            ),
            "reopen the planning stage before editing"
        );
        if name == "plan.json" {
            let plan = serde_json::from_str::<Plan>(content)?;
            plan.validate()?;
            ensure!(
                spec.phase == Phase::Requirements
                    || serde_json::to_string(&plan.criteria)?
                        == serde_json::to_string(&spec.plan.criteria)?,
                "confirmed acceptance criteria cannot be changed during design or implementation"
            );
        }
        ensure!(
            name != "requirements.md" || spec.phase == Phase::Requirements,
            "requirements were already confirmed"
        );
        ensure!(
            name != "design.md" || spec.phase != Phase::Tasks,
            "design was already confirmed"
        );
        let path = self.spec_dir(spec).join(name);
        if let Some(previous) = previous {
            let current = read_text(&path)?;
            ensure!(
                current == previous || current == content,
                "file changed by another editor or Agent; reload before saving"
            );
        }
        write_text(&path, content)
    }
    fn load_plan(&self, spec: &Spec) -> Result<Plan> {
        let plan: Plan = serde_json::from_str(&read_text(&self.spec_dir(spec).join("plan.json"))?)?;
        plan.validate()?;
        Ok(plan)
    }
    pub async fn spec_action(&self, id: &str, action: &str) -> Result<()> {
        self.edit(|state| {
            let index = state
                .specs
                .iter()
                .position(|s| s.id == id)
                .context("Spec not found")?;
            let spec = &mut state.specs[index];
            match action {
                "approve_requirements" => {
                    ensure!(
                        spec.phase == Phase::Requirements,
                        "not in requirements stage"
                    );
                    bounded(
                        &read_text(&self.spec_dir(spec).join("requirements.md"))?,
                        128 * 1024,
                    )?;
                    let plan = self.load_plan(spec)?;
                    ensure!(
                        !plan.criteria.is_empty(),
                        "add acceptance criteria to plan.json first"
                    );
                    spec.plan = plan;
                    spec.phase = Phase::Design;
                }
                "approve_design" => {
                    ensure!(spec.phase == Phase::Design, "not in design stage");
                    bounded(
                        &read_text(&self.spec_dir(spec).join("design.md"))?,
                        128 * 1024,
                    )?;
                    spec.phase = Phase::Tasks;
                }
                "build" => {
                    ensure!(
                        spec.phase == Phase::Tasks,
                        "construction already started; use resume"
                    );
                    let plan = self.load_plan(spec)?;
                    ensure!(
                        !plan.tasks.is_empty() && !plan.criteria.is_empty(),
                        "plan requires tasks and acceptance criteria"
                    );
                    ensure!(serde_json::to_string(&plan.criteria)?==serde_json::to_string(&spec.plan.criteria)?,"acceptance criteria changed after confirmation; review the requirements again");
                    bounded(
                        &read_text(&self.spec_dir(spec).join("tasks.md"))?,
                        128 * 1024,
                    )?;
                    spec.plan = plan;
                    spec.phase = Phase::Building;
                    spec.paused = false;
                }
                "submit_verification" => {
                    ensure!(
                        spec.phase == Phase::ReadyVerification,
                        "finish all coding tasks first"
                    );
                    spec.round += 1;
                    spec.phase = Phase::Verifying;
                    spec.paused = false;
                }
                "complete" => {
                    ensure!(
                        spec.phase == Phase::ReadyComplete,
                        "complete all acceptance checks first"
                    );
                    spec.phase = Phase::Complete;
                }
                "pause" => {
                    spec.paused = true;
                    for t in state.tasks.iter_mut().filter(|t| {
                        t.spec_id.as_deref() == Some(id) && t.status != TaskStatus::Done
                    }) {
                        t.paused = true;
                    }
                }
                "resume" => {
                    spec.paused = false;
                    spec.error = None;
                    for t in state.tasks.iter_mut().filter(|t| {
                        t.spec_id.as_deref() == Some(id)
                            && t.status != TaskStatus::Done
                            && t.error.is_none()
                    }) {
                        t.paused = false;
                    }
                }
                "reopen" => {
                    ensure!(
                        !state
                            .tasks
                            .iter()
                            .any(|t| t.spec_id.as_deref() == Some(id)),
                        "submitted Specs use the repair flow; only unsubmitted documents can reopen"
                    );
                    spec.phase = Phase::Requirements;
                    spec.paused = true;
                }
                _ => bail!("unknown Spec action"),
            }
            Ok(())
        })
        .await?;
        if action == "pause" {
            self.cancel_matching(Some(id), None).await?;
        }
        Ok(())
    }
    pub async fn create_task(
        &self,
        requirement_id: String,
        title: String,
        description: String,
        role: Role,
    ) -> Result<QueueTask> {
        self.requirement(&requirement_id)?;
        bounded(&title, 240)?;
        ensure!(description.len() <= 12000, "description too long");
        let mut task = QueueTask::new(
            requirement_id,
            None,
            title,
            description,
            role,
            Uuid::new_v4().to_string(),
        );
        task.paused = false;
        let dir = self.task_dir(&task);
        fs::create_dir_all(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        self.edit(|state| {
            state.tasks.push(task.clone());
            Ok(task)
        })
        .await
    }
    pub async fn task_action(
        &self,
        id: &str,
        action: &str,
        description: Option<String>,
        agent_id: Option<String>,
    ) -> Result<()> {
        self.edit(|state| {
            let t = state
                .tasks
                .iter_mut()
                .find(|t| t.id == id)
                .context("task not found")?;
            match action {
                "start" => {
                    ensure!(t.status != TaskStatus::Done, "task already completed");
                    t.paused = false;
                    t.manual = true;
                    t.error = None;
                }
                "stop" => {
                    t.paused = true;
                    t.manual = false;
                }
                "save" => {
                    ensure!(t.status != TaskStatus::Running, "task is executing");
                    if let Some(text) = description {
                        ensure!(text.len() <= 12000, "description too long");
                        t.description = text;
                    }
                    if let Some(agent) = agent_id {
                        ensure!(
                            agent == t.agent_id.as_deref().unwrap_or(""),
                            "task assignee is allocated from the configured role pool"
                        );
                    }
                }
                _ => bail!("task status is managed by execution; use start or stop"),
            }
            Ok(())
        })
        .await?;
        if action == "stop" {
            self.cancel_matching(None, Some(id)).await?;
        }
        Ok(())
    }
    async fn cancel_matching(&self, spec: Option<&str>, task: Option<&str>) -> Result<()> {
        let snapshot = self.snapshot().await;
        for t in snapshot.tasks.iter().filter(|t| {
            spec.is_some_and(|id| t.spec_id.as_deref() == Some(id)) || task == Some(t.id.as_str())
        }) {
            let id = if t.run_id.is_some() {
                t.run_id.clone()
            } else if let Some(request) = &t.request_id {
                sqlx::query_scalar("SELECT id FROM local_runs WHERE request_id=?")
                    .bind(request)
                    .fetch_optional(&self.local.store.pool)
                    .await?
            } else {
                None
            };
            if let Some(id) = id
                && let Ok(record) = self.local.get(&id, 0).await
            {
                self.cancel_run(
                    &record.run,
                    t.request_id
                        .clone()
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn cancel_run(&self, run: &crate::execution::LocalRun, command_id: String) -> Result<()> {
        if !crate::local::terminal(&run.state) && !run.cancel_requested {
            self.local
                .command(
                    &run.run_id,
                    run.attempt_id.clone(),
                    command_id,
                    rein_proto::hub::v1::control_command::Payload::Cancel(
                        rein_proto::hub::v1::CancelCommand {
                            reason: "Task paused".into(),
                        },
                    ),
                )
                .await?;
        }
        Ok(())
    }
    pub async fn chat(
        &self,
        id: &str,
        prompt: String,
        request_id: String,
    ) -> Result<crate::execution::LocalRun> {
        bounded(&prompt, 32 * 1024)?;
        let (spec, agent) = self
            .edit(|state| {
                let agent = state
                    .settings
                    .main_agent
                    .clone()
                    .context("configure a main Agent in system settings first")?;
                let spec = state
                    .specs
                    .iter_mut()
                    .find(|s| s.id == id)
                    .context("Spec not found")?;
                if spec.agent_id.as_ref() != Some(&agent) {
                    if spec.agent_id.is_some() {
                        spec.session_id = Uuid::new_v4().to_string();
                    }
                    spec.agent_id = Some(agent.clone());
                }
                Ok((spec.clone(), agent))
            })
            .await?;
        let (project, requirement) = self.requirement(&spec.requirement_id)?;
        let directory = project
            .preferred_directory
            .or(project.directories.first().cloned())
            .context("configure a project working directory first")?;
        let full = format!(
            "Use the installed rein-spec skill. You are the main Spec Agent. Work on ONE phase at a time and wait for explicit user approval before advancing. Current phase: {:?}.\nRequirement: {}\nSpec: {}\nDescription: {}\nWORKING_DIR: {}\nSPEC_DIR: {}\nWrite requirements.md, design.md and tasks.md only in SPEC_DIR; never put Spec documents into the source checkout. Keep the documents self-contained. Requirements must include testable acceptance criteria. Design constrains implementation. Tasks must be an ordered, non-DAG list. Also maintain plan.json with this exact structure: {{\"criteria\":[{{\"id\":\"AC-01\",\"text\":\"expected behaviour\"}}],\"tasks\":[{{\"id\":\"T-01\",\"title\":\"task\",\"description\":\"implementation scope\",\"acceptance_ids\":[\"AC-01\"]}}]}}. Keep IDs stable; no execution or status changes by the Spec Agent. The daemon submits and dispatches tasks. Do not claim success without evidence.\nUSER MESSAGE:\n{}",
            spec.phase,
            requirement.title,
            spec.title,
            spec.description,
            directory.display(),
            self.spec_dir(&spec).display(),
            prompt
        );
        self.local
            .start_in_directory(
                agent,
                Some(spec.session_id),
                full,
                request_id,
                Some(directory),
            )
            .await
    }
}
fn allowed_file(name: &str) -> Result<&str> {
    ensure!(
        name.len() <= 160
            && !name.starts_with('.')
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)),
        "invalid file name"
    );
    Ok(name)
}
fn read_text(path: &std::path::Path) -> Result<String> {
    artifact_parent(path)?;
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 128 * 1024,
        "artifact must be a regular file under 128 KiB"
    );
    Ok(fs::read_to_string(path)?)
}
fn write_text(path: &std::path::Path, text: &str) -> Result<()> {
    artifact_parent(path)?;
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(path.parent().context("missing artifact directory")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn artifact_parent(path: &std::path::Path) -> Result<()> {
    let parent = path.parent().context("missing artifact directory")?;
    for dir in [parent, parent.parent().context("missing artifact root")?] {
        let metadata = fs::symlink_metadata(dir)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "artifact directories must not be symlinks"
        );
    }
    Ok(())
}
