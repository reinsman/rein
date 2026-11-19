//! Durable Spec state and a shared Todo queue. Agent execution remains in LocalRuntime.
mod markdown;
mod spec_chat;
pub use spec_chat::PlanningOptions;
mod spec_runtime;
mod task_messages;
mod task_runtime;

use crate::local::{LocalRuntime, TaskStatus};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecKind {
    #[default]
    Feature,
    Bugfix,
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
    #[serde(default)]
    pub kind: SpecKind,
    pub directory: String,
    pub phase: Phase,
    pub paused: bool,
    pub round: u32,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub plan: Plan,
    #[serde(default)]
    pub document_revision: Option<String>,
    #[serde(default)]
    pub document_approvals: Option<HashMap<String, String>>,
    #[serde(default)]
    pub document_run_id: Option<String>,
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
    #[serde(default)]
    pub messages: Vec<TaskMessage>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: String,
    pub event_key: String,
    pub requirement_id: String,
    pub spec_id: Option<String>,
    pub task_id: String,
    pub run_id: Option<String>,
    pub agent_id: String,
    pub kind: String,
    pub content: String,
    pub created_at: u64,
    pub update_request_id: Option<String>,
    pub handoff: Option<String>,
    pub update_done: bool,
    pub update_error: Option<String>,
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
        session_id: Option<&str>,
    ) -> Result<crate::execution::LocalRun> {
        bounded(&prompt, 32 * 1024)?;
        ensure!(
            Uuid::parse_str(&request_id).is_ok(),
            "request_id must be a UUID"
        );
        let conversation = self.conversation(id).await?;
        ensure!(
            session_id.is_none_or(|session| session == conversation.session_id),
            "需求会话已切换，请检查排队消息"
        );
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
        let workflow = Self {
            local,
            state: Arc::new(Mutex::new(state)),
        };
        workflow
            .edit(|state| {
                for spec in &mut state.specs {
                    workflow.initialize_spec_state(spec)?;
                    if spec.document_approvals.is_none() {
                        spec.document_approvals = Some(HashMap::new());
                        let confirmed = match spec.phase {
                            Phase::Requirements => 0,
                            Phase::Design => 1,
                            Phase::Tasks => 2,
                            _ => 3,
                        };
                        for name in ["requirements.md", "design.md", "tasks.md"]
                            .into_iter()
                            .take(confirmed)
                        {
                            if let Ok(content) = read_text(&workflow.spec_dir(spec).join(name))
                                && !content.trim().is_empty()
                            {
                                workflow.approve_document(spec, name, &content);
                            }
                        }
                    }
                }
                Ok(())
            })
            .await?;
        Ok(workflow)
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
        for role in [&settings.coding_agents, &settings.review_agents] {
            let mut assigned = HashSet::new();
            for name in role {
                ensure!(
                    names.contains(name.as_str()) && assigned.insert(name),
                    "unknown or duplicate agent in role"
                );
            }
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
        kind: SpecKind,
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
            kind,
            directory,
            phase: Phase::Requirements,
            paused: false,
            round: 0,
            session_id: Uuid::new_v4().to_string(),
            agent_id: None,
            plan: Plan::default(),
            document_revision: None,
            document_approvals: Some(HashMap::new()),
            document_run_id: None,
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
            self.initialize_spec_state(&spec)?;
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
            matches!(name, "requirements.md" | "design.md" | "tasks.md"),
            "file is read-only"
        );
        ensure!(content.len() <= 128 * 1024, "document too large");
        self.edit(|state| {
            let spec = state
                .specs
                .iter_mut()
                .find(|s| s.id == id)
                .context("Spec not found")?;
            let path = self.spec_dir(spec).join(name);
            if let Some(previous) = previous {
                let current = read_text(&path)?;
                ensure!(
                    current == previous || current == content,
                    "file changed by another editor or Agent; reload before saving"
                );
            }
            write_text(&path, content)?;
            if spec.document_revision.is_some() {
                spec.document_revision = Some(self.document_revision(spec)?);
            }
            Ok(())
        })
        .await
    }
    fn approve_document(&self, spec: &mut Spec, name: &str, content: &str) {
        spec.document_approvals
            .get_or_insert_with(HashMap::new)
            .insert(name.into(), markdown::artifact_revision(name, content));
    }
    pub async fn document_confirmed(&self, id: &str, name: &str, content: &str) -> bool {
        let spec = self
            .state
            .lock()
            .await
            .specs
            .iter()
            .find(|spec| spec.id == id)
            .cloned();
        let Some(mut spec) = spec else { return false };
        // Planning approvals can be published before the Agent finishes drafting the next document.
        let _ = self.sync_document_approvals(&mut spec);
        spec.document_approvals
            .as_ref()
            .and_then(|approvals| approvals.get(name))
            .is_some_and(|approved| {
                !content.trim().is_empty()
                    && *approved == markdown::artifact_revision(name, content)
            })
    }
    fn load_plan(&self, spec: &Spec) -> Result<Plan> {
        Ok(self.load_documents(spec)?.0)
    }
    fn load_documents(&self, spec: &Spec) -> Result<(Plan, String)> {
        let requirements = read_text(&self.spec_dir(spec).join("requirements.md"))?;
        let tasks = read_text(&self.spec_dir(spec).join("tasks.md"))?;
        Ok((
            markdown::plan(&requirements, &tasks)?,
            markdown::revision(&requirements, &tasks),
        ))
    }
    fn document_revision(&self, spec: &Spec) -> Result<String> {
        Ok(markdown::revision(
            &read_text(&self.spec_dir(spec).join("requirements.md"))?,
            &read_text(&self.spec_dir(spec).join("tasks.md"))?,
        ))
    }
    pub async fn document_plan(&self, id: &str) -> Result<Plan> {
        let state = self.state.lock().await;
        let spec = state
            .specs
            .iter()
            .find(|spec| spec.id == id)
            .context("Spec not found")?;
        if matches!(
            spec.phase,
            Phase::Requirements | Phase::Design | Phase::Tasks
        ) {
            self.load_plan(spec)
        } else {
            Ok(spec.plan.clone())
        }
    }
    fn enqueue_spec_task(state: &mut Snapshot, spec: &Spec, plan_id: &str) -> Result<QueueTask> {
        if let Some(task) = state.tasks.iter().find(|task| {
            task.spec_id.as_deref() == Some(&spec.id)
                && task.role == Role::Coding
                && task.plan_id.as_deref() == Some(plan_id)
        }) {
            return Ok(task.clone());
        }
        let item = spec
            .plan
            .tasks
            .iter()
            .find(|task| task.id == plan_id)
            .context("Spec checklist item not found")?;
        let mut task = QueueTask::new(
            spec.requirement_id.clone(),
            Some(spec),
            item.title.clone(),
            item.description.clone(),
            Role::Coding,
            spec.directory.clone(),
        );
        task.plan_id = Some(item.id.clone());
        state.tasks.push(task.clone());
        Ok(task)
    }
    pub async fn submit_spec_task(&self, id: &str, plan_id: &str) -> Result<QueueTask> {
        self.edit(|state| {
            let spec = state
                .specs
                .iter()
                .find(|spec| spec.id == id)
                .context("Spec not found")?
                .clone();
            ensure!(
                matches!(
                    spec.phase,
                    Phase::Building | Phase::Repairing | Phase::ReadyVerification
                ),
                "confirm the complete task plan before submitting a checklist item"
            );
            Self::enqueue_spec_task(state, &spec, plan_id)
        })
        .await
    }
    fn transition_spec(&self, state: &mut Snapshot, id: &str, action: &str) -> Result<()> {
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
                let requirements = read_text(&self.spec_dir(spec).join("requirements.md"))?;
                bounded(&requirements, 128 * 1024)?;
                let plan = Plan {
                    criteria: markdown::requirements(&requirements)?,
                    tasks: vec![],
                };
                plan.validate()?;
                ensure!(
                    !plan.criteria.is_empty(),
                    "add Acceptance Criteria to requirements.md first"
                );
                spec.plan = plan;
                self.approve_document(spec, "requirements.md", &requirements);
                spec.phase = Phase::Design;
            }
            "approve_design" => {
                ensure!(spec.phase == Phase::Design, "not in design stage");
                let design = read_text(&self.spec_dir(spec).join("design.md"))?;
                bounded(&design, 128 * 1024)?;
                self.approve_document(spec, "design.md", &design);
                spec.phase = Phase::Tasks;
            }
            "build" => {
                ensure!(
                    spec.phase == Phase::Tasks,
                    "construction already started; use resume"
                );
                let (plan, revision) = self.load_documents(spec)?;
                ensure!(
                    !plan.tasks.is_empty() && !plan.criteria.is_empty(),
                    "plan requires tasks and acceptance criteria"
                );
                bounded(
                    &read_text(&self.spec_dir(spec).join("tasks.md"))?,
                    128 * 1024,
                )?;
                spec.plan = plan;
                spec.document_revision = Some(revision);
                let tasks = read_text(&self.spec_dir(spec).join("tasks.md"))?;
                self.approve_document(spec, "tasks.md", &tasks);
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
                for t in state
                    .tasks
                    .iter_mut()
                    .filter(|t| t.spec_id.as_deref() == Some(id) && t.status != TaskStatus::Done)
                {
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
                    !state.tasks.iter().any(|t| t.spec_id.as_deref() == Some(id)),
                    "submitted Specs use the repair flow; only unsubmitted documents can reopen"
                );
                spec.phase = Phase::Requirements;
                spec.paused = true;
            }
            _ => bail!("unknown Spec action"),
        }
        Ok(())
    }
    pub async fn spec_action(&self, id: &str, action: &str) -> Result<()> {
        if action == "reopen" {
            self.chat(
                id,
                "请重新打开需求，修订后等待我重新审阅。".into(),
                Uuid::new_v4().to_string(),
            )
            .await?;
            return Ok(());
        }
        let planning = match action {
            "approve_requirements" => Some((Phase::Requirements, "确认需求，继续设计")),
            "approve_design" => Some((Phase::Design, "确认设计，拆分任务")),
            "build" => Some((Phase::Tasks, "确认任务，开始构建")),
            _ => None,
        };
        if let Some((phase, message)) = planning {
            let state = self.snapshot().await;
            ensure!(
                state
                    .specs
                    .iter()
                    .any(|spec| spec.id == id && spec.phase == phase),
                "not in the requested planning phase"
            );
            self.chat(id, message.into(), Uuid::new_v4().to_string())
                .await?;
            return Ok(());
        }
        self.edit(|state| self.transition_spec(state, id, action))
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
    pub async fn delete_task(&self, id: &str) -> Result<()> {
        // Hold the dispatch lock until deletion is durable, so an idle task cannot start midway.
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        let index = next
            .tasks
            .iter()
            .position(|task| task.id == id)
            .context("task not found")?;
        let task = &next.tasks[index];
        let runs: Vec<String> =
            sqlx::query_scalar("SELECT snapshot FROM local_runs WHERE id IN (?,?) OR request_id=? OR (session_id=(SELECT session_id FROM local_runs WHERE id=?) AND json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled'))")
                .bind(&task.run_id)
                .bind(&task.last_run_id)
                .bind(&task.request_id)
                .bind(&task.last_run_id)
                .fetch_all(&self.local.store.pool)
                .await?;
        for snapshot in runs {
            let run: crate::execution::LocalRun = serde_json::from_str(&snapshot)?;
            ensure!(
                crate::local::terminal(&run.state),
                "任务或会话仍在运行，请停止后再删除。"
            );
        }
        let task = next.tasks.remove(index);
        if let Some(spec) = next
            .specs
            .iter_mut()
            .find(|spec| Some(&spec.id) == task.spec_id.as_ref())
        {
            spec.paused = true;
            spec.error = Some(
                "Todo 任务已删除，自动推进已暂停；可从任务计划重新提交，或继续流程重新入队。"
                    .into(),
            );
        }
        self.commit(&next).await?;
        *guard = next;
        Ok(())
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
}
fn allowed_file(name: &str) -> Result<&str> {
    ensure!(
        name.len() <= 160
            && (!name.starts_with('.') || name == ".spec-state.json")
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

#[cfg(test)]
mod deletion_tests {
    use super::*;

    #[tokio::test]
    async fn deletion_checks_actual_run_even_with_stale_task_status() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::LocalStore::open(directory.path().join("test.sqlite"))
            .await
            .unwrap();
        let local = LocalRuntime::new(directory.path().to_path_buf(), store)
            .await
            .unwrap();
        let workflow = Workflow::new(local).await.unwrap();
        for state in [
            "running",
            "waiting_input",
            "waiting_approval",
            "failed",
            "cancelled",
            "completed",
        ] {
            let mut task = QueueTask::new(
                "requirement".into(),
                None,
                "test".into(),
                "".into(),
                Role::Coding,
                "test".into(),
            );
            // A paused flag or stale board column does not prove the process stopped.
            task.status = TaskStatus::Running;
            task.paused = true;
            task.request_id = Some(Uuid::new_v4().to_string());
            let run = crate::execution::LocalRun {
                run_id: Uuid::new_v4().to_string(),
                attempt_id: "attempt".into(),
                session_id: "session".into(),
                provider: "pi".into(),
                state: state.into(),
                cancel_requested: true,
                native_session_id: None,
                working_directory: None,
                last_sequence: 0,
                finished_at: None,
                error: None,
            };
            sqlx::query("INSERT INTO local_runs(id,request_id,agent_id,session_id,prompt,snapshot) VALUES(?,?,'agent','session','',?)")
                .bind(&run.run_id).bind(&task.request_id).bind(serde_json::to_string(&run).unwrap())
                .execute(&workflow.local.store.pool).await.unwrap();
            workflow
                .edit(|snapshot| {
                    snapshot.tasks.push(task.clone());
                    if crate::local::terminal(state) {
                        let mut message =
                            TaskMessage::new(&task, "completed", "test", "历史记录".into());
                        message.update_request_id = Some(Uuid::new_v4().to_string());
                        snapshot.messages.push(message);
                    }
                    Ok(())
                })
                .await
                .unwrap();
            let result = workflow.delete_task(&task.id).await;
            assert_eq!(result.is_ok(), crate::local::terminal(state), "{state}");
            assert_eq!(
                workflow
                    .snapshot()
                    .await
                    .tasks
                    .iter()
                    .any(|item| item.id == task.id),
                !crate::local::terminal(state)
            );
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_runs WHERE id=?")
                .bind(&run.run_id)
                .fetch_one(&workflow.local.store.pool)
                .await
                .unwrap();
            assert_eq!(count, 1, "deletion must preserve execution history");
            if crate::local::terminal(state) {
                workflow.update_task_documents().await.unwrap();
                assert!(
                    workflow
                        .snapshot()
                        .await
                        .messages
                        .iter()
                        .any(|message| message.task_id == task.id)
                );
            }
        }
        assert!(workflow.delete_task("missing").await.is_err());
    }
}
