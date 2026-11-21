//! Loopback-only Console and same-origin JSON API, served by reind itself.
use crate::{
    agents::{AgentConfig, AgentType, Permissions},
    local::{LocalRuntime, Project},
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, convert::Infallible, net::SocketAddr, time::Duration};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

include!(concat!(env!("OUT_DIR"), "/console_assets.rs"));

#[derive(Clone)]
struct WebState {
    local: LocalRuntime,
    workflow: crate::workflow::Workflow,
    origin: String,
    stop: CancellationToken,
}
type ApiResult = std::result::Result<Json<Value>, ApiError>;
struct ApiError(anyhow::Error);
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":format!("{:#}", self.0)})),
        )
            .into_response()
    }
}
pub fn listen_address() -> Result<SocketAddr> {
    let address: SocketAddr = std::env::var("REIND_HTTP_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8920".into())
        .parse()
        .context("invalid REIND_HTTP_ADDR")?;
    ensure!(
        address.ip().is_loopback(),
        "REIND_HTTP_ADDR must be a loopback address"
    );
    Ok(address)
}
pub fn router(
    local: LocalRuntime,
    workflow: crate::workflow::Workflow,
    origin: String,
    stop: CancellationToken,
) -> Router {
    let state = WebState {
        local,
        workflow,
        origin,
        stop,
    };
    Router::new()
        .route("/api/agents", get(agents).post(add_agent))
        .route("/api/agent-types/{provider}", get(type_configs))
        .route("/api/agent-types/{provider}/defaults", get(type_defaults))
        .route(
            "/api/agent-types/{provider}/config-mode",
            axum::routing::put(set_type_config_mode),
        )
        .route(
            "/api/agent-types/{provider}/permissions",
            axum::routing::put(set_default_permissions),
        )
        .route(
            "/api/agent-types/{provider}/{name}",
            axum::routing::put(update_type_config),
        )
        .route(
            "/api/agents/{name}/skills",
            get(agent_skills).post(install_agent_skill),
        )
        .route("/api/agents/{name}/availability", post(availability))
        .route(
            "/api/agents/{name}",
            axum::routing::delete(remove_agent).put(update_agent),
        )
        .route("/api/agents/{name}/history", get(history))
        .route("/api/agents/{name}/events", get(events))
        .route("/api/events", get(state_events))
        .route("/api/runs", post(create_run))
        .route("/api/runs/{id}", get(run))
        .route("/api/runs/{id}/fork", post(create_chat_fork))
        .route("/api/sessions/{id}/forks", get(chat_forks))
        .route("/api/runs/{id}/fork-context", get(chat_fork_context))
        .route(
            "/api/chat-forks/{id}",
            axum::routing::delete(delete_chat_fork),
        )
        .route("/api/runs/{id}/file", post(run_file))
        .route("/api/runs/{id}/followup-ready", get(followup_ready))
        .route("/api/runs/{id}/cancel", post(cancel))
        .route("/api/runs/{id}/reply", post(reply))
        .route("/api/runs/{id}/instruction", post(instruction))
        .route("/api/projects", get(projects).post(save_project))
        .route("/api/workflow", get(workflow_snapshot))
        .route("/api/workflow/chat-mentions/read", post(read_chat_mentions))
        .route("/api/workflow/settings", post(workflow_settings))
        .route("/api/specs", post(create_spec))
        .route("/api/specs/{id}/action", post(spec_action))
        .route("/api/specs/{id}/chat", post(spec_chat))
        .route("/api/specs/{id}/start", post(start_spec))
        .route("/api/specs/{id}/plan", get(spec_plan))
        .route("/api/specs/{id}/tasks", post(submit_spec_task))
        .route(
            "/api/artifacts/{id}/{name}",
            get(workflow_file).post(save_workflow_file),
        )
        .route("/api/tasks", post(create_task))
        .route(
            "/api/requirements/{id}/conversation",
            get(requirement_conversation),
        )
        .route("/api/requirements/{id}/chat", post(requirement_chat))
        .route("/api/tasks/{id}", axum::routing::delete(delete_task))
        .route("/api/tasks/{id}/action", post(task_action))
        .route("/api/tasks/{id}/chat", post(task_chat))
        .route("/api/task-messages/{id}/retry", post(retry_task_update))
        .fallback(asset)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), same_origin))
        .with_state(state)
}
async fn workflow_snapshot(State(s): State<WebState>) -> ApiResult {
    Ok(Json(workflow_view(&s).await?))
}
async fn workflow_view(s: &WebState) -> Result<Value> {
    let snapshot = s.workflow.snapshot().await;
    let sessions: HashMap<_, _> = snapshot
        .specs
        .iter()
        .map(|spec| (&spec.session_id, &spec.id))
        .chain(
            snapshot
                .conversations
                .iter()
                .map(|conversation| (&conversation.session_id, &conversation.requirement_id)),
        )
        .collect();
    let updates: HashMap<_, _> = snapshot
        .messages
        .iter()
        .filter(|message| !message.update_done)
        .filter_map(|message| {
            Some((
                message.update_request_id.as_ref()?,
                message.spec_id.as_ref()?,
            ))
        })
        .collect();
    let mut states: HashMap<&String, Vec<String>> = HashMap::new();
    let mut executions: HashMap<&String, Vec<Value>> = HashMap::new();
    if !sessions.is_empty() || !updates.is_empty() {
        // Read only the latest runs linked to visible scopes; never send prompts or tool data.
        let runs: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id,session_id,request_id,json_extract(snapshot,'$.state'),
                CASE WHEN json_extract(snapshot,'$.state') IN ('waiting_input','waiting_approval')
                THEN (SELECT json_extract(payload,'$.event.interaction_id') FROM local_events
                      WHERE run_id=local_runs.id AND json_extract(payload,'$.event.type')='interaction'
                      ORDER BY sequence DESC LIMIT 1) END
             FROM local_runs WHERE rowid IN (SELECT MAX(rowid) FROM local_runs
                 WHERE session_id IN (SELECT value FROM json_each(?)) OR request_id IN (SELECT value FROM json_each(?))
                 GROUP BY session_id) ORDER BY rowid",
        ).bind(serde_json::to_string(&sessions.keys().collect::<Vec<_>>())?)
            .bind(serde_json::to_string(&updates.keys().collect::<Vec<_>>())?)
            .fetch_all(&s.local.store.pool).await?;
        for (id, session, request, state, interaction_id) in runs {
            if let Some(scope) = sessions.get(&session).or_else(|| updates.get(&request)) {
                states.entry(scope).or_default().push(state.clone());
                executions.entry(scope).or_default().push(json!({
                    "id": id, "state": state, "interaction_id": interaction_id,
                }));
            }
        }
    }
    let ready_specs: Vec<_> = snapshot
        .specs
        .iter()
        .filter(|spec| s.workflow.ready_for_next_phase(spec))
        .map(|spec| &spec.id)
        .collect();
    let mut view = json!(snapshot);
    view["ready_spec_ids"] = json!(ready_specs);
    view["execution_states"] = json!(states);
    view["execution_runs"] = json!(executions);
    view["chat_mentions"] = json!(chat_mentions(s, &snapshot, &sessions).await?);
    let read_mentions: Vec<String> =
        sqlx::query_scalar("SELECT message_key FROM chat_mention_reads ORDER BY message_key")
            .fetch_all(&s.local.store.pool)
            .await?;
    view["read_chat_mentions"] = json!(read_mentions);
    Ok(view)
}

async fn read_chat_mentions(State(s): State<WebState>, Json(keys): Json<Vec<String>>) -> ApiResult {
    if keys.len() > 128 {
        return Err(anyhow::anyhow!("每次最多标记 128 条消息").into());
    }
    let keys = keys
        .iter()
        .filter(|key| {
            let Some(parts) = key
                .strip_prefix("mention:")
                .filter(|value| value.len() <= 4096)
                .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            else {
                return false;
            };
            matches!(parts.as_slice(), [kind, run, item] if kind == "run" && !run.is_empty() && !item.is_empty())
                || matches!(parts.as_slice(), [kind, id] if kind == "task-message" && !id.is_empty())
        })
        .collect::<Vec<_>>();
    sqlx::query(
        "INSERT OR IGNORE INTO chat_mention_reads (message_key) SELECT value FROM json_each(?)",
    )
    .bind(serde_json::to_string(&keys).map_err(anyhow::Error::from)?)
    .execute(&s.local.store.pool)
    .await
    .map_err(anyhow::Error::from)?;
    Ok(Json(json!({"keys":keys})))
}

async fn chat_mentions(
    s: &WebState,
    snapshot: &crate::workflow::Snapshot,
    conversations: &HashMap<&String, &String>,
) -> Result<std::collections::BTreeMap<String, Vec<Value>>> {
    let mut scopes: HashMap<String, Vec<&str>> = conversations
        .iter()
        .map(|(session, scope)| ((*session).clone(), vec![scope.as_str()]))
        .collect();
    let tasks: HashMap<_, _> = snapshot
        .tasks
        .iter()
        .filter_map(|task| Some((task.run_id.as_ref().or(task.last_run_id.as_ref())?, task)))
        .collect();
    if !tasks.is_empty() {
        let task_sessions: Vec<(String, String)> = sqlx::query_as(
            "SELECT id,session_id FROM local_runs WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(serde_json::to_string(&tasks.keys().collect::<Vec<_>>())?)
        .fetch_all(&s.local.store.pool)
        .await?;
        for (id, session) in task_sessions {
            if let Some(task) = tasks.get(&id) {
                let recipients = scopes.entry(session).or_default();
                recipients.push(&task.requirement_id);
                recipients.extend(task.spec_id.as_deref());
            }
        }
    }
    let mut output = std::collections::BTreeMap::<_, Vec<_>>::new();
    if scopes.is_empty() {
        return Ok(output);
    }
    let runs: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id,session_id,json_extract(snapshot,'$.mentions') FROM local_runs
         WHERE session_id IN (SELECT value FROM json_each(?))
           AND json_type(snapshot,'$.mentions')='object'
         ORDER BY rowid",
    )
    .bind(serde_json::to_string(&scopes.keys().collect::<Vec<_>>())?)
    .fetch_all(&s.local.store.pool)
    .await?;
    for (run_id, session, mentions) in runs {
        let mentions: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_str(&mentions)?;
        if let Some(recipients) = scopes.get(&session) {
            for (item_id, names) in mentions {
                let entry = json!({"run_id":run_id,"item_id":item_id,"names":names});
                for &scope in recipients {
                    output.entry(scope.into()).or_default().push(entry.clone());
                }
            }
        }
    }
    Ok(output)
}
async fn requirement_conversation(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(json!(s.workflow.conversation(&id).await?)))
}
async fn requirement_chat(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<SpecChat>,
) -> ApiResult {
    Ok(Json(
        json!({"run":s.workflow.requirement_chat(&id,body.prompt,body.request_id,&s.origin,body.session_id.as_deref()).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskChat {
    run_id: String,
    prompt: String,
    request_id: String,
}
async fn task_chat(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<TaskChat>,
) -> ApiResult {
    let run = s
        .workflow
        .task_chat(&id, &body.run_id, body.prompt, body.request_id)
        .await?;
    Ok(Json(json!({"run":run})))
}
async fn workflow_settings(
    State(s): State<WebState>,
    Json(settings): Json<crate::workflow::Settings>,
) -> ApiResult {
    s.workflow.settings(settings).await?;
    workflow_snapshot(State(s)).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSpec {
    requirement_id: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    kind: crate::workflow::SpecKind,
    #[serde(default)]
    start: bool,
}
async fn create_spec(State(s): State<WebState>, Json(body): Json<CreateSpec>) -> ApiResult {
    if body.start {
        crate::workflow::bounded(&body.description, 12000)?;
    }
    let mut spec = s
        .workflow
        .create_spec(body.requirement_id, body.title, body.description, body.kind)
        .await?;
    if body.start {
        let _ = s.workflow.begin_spec(&spec.id).await;
        spec = s
            .workflow
            .snapshot()
            .await
            .specs
            .into_iter()
            .find(|s| s.id == spec.id)
            .context("Spec not found")?;
    }
    Ok(Json(json!({"spec":spec})))
}
async fn start_spec(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(json!({"run":s.workflow.begin_spec(&id).await?})))
}
async fn spec_plan(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(json!(s.workflow.document_plan(&id).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitSpecTask {
    plan_id: String,
}
async fn submit_spec_task(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<SubmitSpecTask>,
) -> ApiResult {
    Ok(Json(
        json!({"task": s.workflow.submit_spec_task(&id, &body.plan_id).await?}),
    ))
}
async fn retry_task_update(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    s.workflow.retry_task_update(&id).await?;
    workflow_snapshot(State(s)).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecAction {
    action: String,
}
async fn spec_action(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<SpecAction>,
) -> ApiResult {
    s.workflow.spec_action(&id, &body.action).await?;
    workflow_snapshot(State(s)).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecChat {
    prompt: String,
    request_id: String,
    session_id: Option<String>,
    #[serde(default)]
    options: crate::workflow::PlanningOptions,
}
async fn spec_chat(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<SpecChat>,
) -> ApiResult {
    Ok(Json(
        json!({"run":s.workflow.chat_with_options(&id,body.prompt,body.request_id,body.options,body.session_id.as_deref()).await?}),
    ))
}
async fn workflow_file(
    State(s): State<WebState>,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult {
    let content = s.workflow.file(&id, &name).await?;
    let confirmed = s.workflow.document_confirmed(&id, &name, &content).await;
    Ok(Json(json!({"content":content,"confirmed":confirmed})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileContent {
    content: String,
    previous: Option<String>,
}
async fn save_workflow_file(
    State(s): State<WebState>,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<FileContent>,
) -> ApiResult {
    s.workflow
        .save_file(&id, &name, &body.content, body.previous.as_deref())
        .await?;
    Ok(Json(json!({"saved":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTask {
    requirement_id: String,
    title: String,
    #[serde(default)]
    description: String,
    role: crate::workflow::Role,
}
async fn create_task(State(s): State<WebState>, Json(body): Json<CreateTask>) -> ApiResult {
    Ok(Json(
        json!({"task":s.workflow.create_task(body.requirement_id,body.title,body.description,body.role).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskAction {
    action: String,
    description: Option<String>,
    agent_id: Option<String>,
}
async fn delete_task(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    s.workflow.delete_task(&id).await?;
    workflow_snapshot(State(s)).await
}
async fn task_action(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<TaskAction>,
) -> ApiResult {
    s.workflow
        .task_action(&id, &body.action, body.description, body.agent_id)
        .await?;
    workflow_snapshot(State(s)).await
}
async fn same_origin(State(state): State<WebState>, request: Request, next: Next) -> Response {
    let expected_host = state.origin.strip_prefix("http://").unwrap_or_default();
    let headers = request.headers();
    let host_ok = headers.get(header::HOST).and_then(|v| v.to_str().ok()) == Some(expected_host);
    let origin_ok = headers
        .get(header::ORIGIN)
        .is_none_or(|v| v.to_str().ok() == Some(state.origin.as_str()));
    let site_ok = headers
        .get("sec-fetch-site")
        .is_none_or(|v| v != "cross-site");
    if !host_ok || !origin_ok || !site_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Console only accepts same-origin loopback requests"})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn agents(State(s): State<WebState>) -> ApiResult {
    Ok(Json(json!({"agents":agent_views(&s.local)?})))
}
async fn type_configs(State(s): State<WebState>, Path(provider): Path<AgentType>) -> ApiResult {
    Ok(Json(json!(s.local.type_configuration(provider).await?)))
}
async fn type_defaults(State(s): State<WebState>, Path(provider): Path<AgentType>) -> ApiResult {
    Ok(Json(json!(s.local.type_defaults(provider).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeConfigModeEdit {
    independent: bool,
}
async fn set_type_config_mode(
    State(s): State<WebState>,
    Path(provider): Path<AgentType>,
    Json(edit): Json<TypeConfigModeEdit>,
) -> ApiResult {
    Ok(Json(json!(
        s.local
            .set_type_config_mode(provider, edit.independent)
            .await?
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DefaultPermissionsEdit {
    permissions: Permissions,
}
async fn set_default_permissions(
    State(s): State<WebState>,
    Path(provider): Path<AgentType>,
    Json(edit): Json<DefaultPermissionsEdit>,
) -> ApiResult {
    s.local
        .set_default_permissions(provider, edit.permissions)
        .await?;
    Ok(Json(json!({"permissions": edit.permissions})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeConfigEdit {
    content: String,
    previous: String,
}
async fn update_type_config(
    State(s): State<WebState>,
    Path((provider, name)): Path<(AgentType, String)>,
    Json(edit): Json<TypeConfigEdit>,
) -> ApiResult {
    let defaults = s
        .local
        .update_type_config(provider, &name, &edit.content, &edit.previous)
        .await?;
    Ok(Json(json!({"saved": true, "defaults": defaults})))
}
fn agent_views(local: &LocalRuntime) -> Result<Vec<Value>> {
    local
        .agents
        .list()?
        .into_iter()
        .map(|agent| {
            let mut value = serde_json::to_value(&agent)?;
            value["skills"] = json!(crate::agents::skills::status(&agent, &local.directory));
            Ok(value)
        })
        .collect()
}
async fn agent_skills(State(s): State<WebState>, Path(name): Path<String>) -> ApiResult {
    Ok(Json(json!(crate::agents::skills::status(
        &s.local.agents.get(&name)?,
        &s.local.directory
    ))))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallSkill {
    confirmed: bool,
}
async fn install_agent_skill(
    State(s): State<WebState>,
    Path(name): Path<String>,
    Json(body): Json<InstallSkill>,
) -> ApiResult {
    body.confirmed
        .then_some(())
        .context("安装 rein-spec 需要用户明确确认")?;
    Ok(Json(json!(crate::agents::skills::install(
        &s.local.agents.get(&name)?,
        &s.local.directory
    )?)))
}
async fn add_agent(State(s): State<WebState>, Json(config): Json<AgentConfig>) -> ApiResult {
    Ok(Json(json!({"agent":s.local.add_agent(config).await?})))
}
async fn update_agent(
    State(s): State<WebState>,
    Path(name): Path<String>,
    Json(config): Json<AgentConfig>,
) -> ApiResult {
    Ok(Json(
        json!({"agent":s.local.update_agent(&name, config).await?}),
    ))
}
#[derive(Deserialize)]
struct Availability {
    enabled: bool,
}
async fn availability(
    State(s): State<WebState>,
    Path(name): Path<String>,
    Json(body): Json<Availability>,
) -> ApiResult {
    Ok(Json(
        json!({"agent":s.local.set_enabled(&name, body.enabled).await?}),
    ))
}
async fn remove_agent(State(s): State<WebState>, Path(name): Path<String>) -> ApiResult {
    s.local.remove_agent(&name).await?;
    Ok(Json(json!({"removed":name})))
}
#[derive(Default, Deserialize)]
struct HistoryQuery {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    before: String,
}
async fn history(
    State(s): State<WebState>,
    Path(name): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult {
    Ok(Json(
        s.local.history(&name, &q.session_id, &q.before).await?,
    ))
}
#[derive(Deserialize)]
struct CreateRun {
    agent_id: String,
    session_id: Option<String>,
    prompt: String,
    request_id: String,
}
async fn create_run(State(s): State<WebState>, Json(body): Json<CreateRun>) -> ApiResult {
    let run = s
        .local
        .start(
            body.agent_id,
            body.session_id.filter(|v| !v.is_empty()),
            body.prompt,
            body.request_id,
        )
        .await?;
    Ok(Json(json!({"run":run})))
}
async fn run(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        serde_json::to_value(s.local.get(&id, 0).await?).map_err(anyhow::Error::from)?,
    ))
}

async fn chat_forks(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(json!(s.local.chat_forks(&id).await?)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitChatFork {
    prompt: String,
    request_id: String,
}

async fn create_chat_fork(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<SubmitChatFork>,
) -> ApiResult {
    let (fork, run) = s
        .local
        .submit_chat_fork(&id, body.prompt, body.request_id)
        .await?;
    Ok(Json(json!({"fork":fork,"run":run})))
}

#[derive(Deserialize)]
struct ForkContextQuery {
    before: Option<i64>,
}

async fn chat_fork_context(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Query(query): Query<ForkContextQuery>,
) -> ApiResult {
    let (runs, next) = s.local.fork_context(&id, query.before).await?;
    Ok(Json(json!({"runs":runs,"next":next})))
}

async fn delete_chat_fork(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    s.local.delete_chat_fork(&id).await?;
    Ok(Json(json!({"deleted": true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunFile {
    path: std::path::PathBuf,
}

async fn run_file(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(file): Json<RunFile>,
) -> ApiResult {
    let snapshot: String = sqlx::query_scalar("SELECT snapshot FROM local_runs WHERE id=?")
        .bind(id)
        .fetch_optional(&s.local.store.pool)
        .await
        .map_err(anyhow::Error::from)?
        .context("执行记录不存在")?;
    let run: crate::execution::LocalRun =
        serde_json::from_str(&snapshot).map_err(anyhow::Error::from)?;
    run.native
        .unwrap_or_else(|| run.native_session_id.is_some())
        .then_some(())
        .context("该执行记录无法预览本地文件")?;
    let directory = run.working_directory.context("该执行记录没有工作目录")?;
    let content =
        tokio::task::spawn_blocking(move || crate::chat::preview_file(&directory, &file.path))
            .await
            .map_err(anyhow::Error::from)??;
    Ok(Json(json!({"content":content})))
}
async fn followup_ready(State(s): State<WebState>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(json!({"ready":s.local.followup_ready(&id).await?})))
}
#[derive(Deserialize)]
struct Cancel {
    attempt_id: String,
    command_id: String,
}
async fn cancel(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<Cancel>,
) -> ApiResult {
    Ok(Json(
        s.local
            .command(
                &id,
                body.attempt_id,
                body.command_id,
                rein_proto::hub::v1::control_command::Payload::Cancel(
                    rein_proto::hub::v1::CancelCommand {
                        reason: "Console".into(),
                    },
                ),
            )
            .await?,
    ))
}
#[derive(Deserialize)]
struct Reply {
    attempt_id: String,
    command_id: String,
    interaction_id: String,
    response: Value,
}
#[derive(Deserialize)]
struct Instruction {
    attempt_id: String,
    command_id: String,
    instruction: String,
}
async fn instruction(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<Instruction>,
) -> ApiResult {
    Ok(Json(
        s.local
            .command(
                &id,
                body.attempt_id,
                body.command_id,
                rein_proto::hub::v1::control_command::Payload::Instruction(
                    rein_proto::hub::v1::InstructionCommand {
                        instruction: body.instruction,
                    },
                ),
            )
            .await?,
    ))
}
async fn reply(
    State(s): State<WebState>,
    Path(id): Path<String>,
    Json(body): Json<Reply>,
) -> ApiResult {
    let bytes = serde_json::to_vec(&body.response).map_err(anyhow::Error::from)?;
    Ok(Json(
        s.local
            .command(
                &id,
                body.attempt_id,
                body.command_id,
                rein_proto::hub::v1::control_command::Payload::InteractionReply(
                    rein_proto::hub::v1::InteractionReplyCommand {
                        interaction_id: body.interaction_id,
                        response_json: bytes,
                    },
                ),
            )
            .await?,
    ))
}
async fn projects(State(s): State<WebState>) -> ApiResult {
    Ok(Json(json!({"projects":s.local.projects()?})))
}
#[derive(Deserialize)]
struct SaveProject {
    project: Project,
    previous: Option<Project>,
}
async fn save_project(State(s): State<WebState>, Json(body): Json<SaveProject>) -> ApiResult {
    Ok(Json(
        json!({"project":s.local.save_project(body.project, body.previous).await?}),
    ))
}
async fn state_events(State(s): State<WebState>) -> impl IntoResponse {
    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<Event, Infallible>>(8);
    tokio::spawn(async move {
        let mut previous = HashMap::new();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! { _ = s.stop.cancelled() => break, _ = tx.closed() => break, _ = interval.tick() => {} }
            // Include file edits made outside the API, just like the JSON agent list.
            let agents = match agent_views(&s.local) {
                Ok(agents) => json!({"agents": agents}),
                Err(error) => json!({"error": format!("{error:#}")}),
            };
            let workflow = match workflow_view(&s).await {
                Ok(view) => view,
                Err(error) => json!({"error": format!("{error:#}")}),
            };
            for (name, value) in [("agents", agents), ("workflow", workflow)] {
                let value = value.to_string();
                if previous.get(name) == Some(&value) {
                    continue;
                }
                let event = Event::default().event(name).data(value.clone());
                tokio::select! {
                    _ = s.stop.cancelled() => return,
                    result = tx.send(Ok(event)) => { if result.is_err() { return; } }
                }
                previous.insert(name, value);
            }
        }
    });
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
async fn events(State(s): State<WebState>, Path(name): Path<String>) -> impl IntoResponse {
    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<Event, Infallible>>(8);
    tokio::spawn(async move {
        let mut versions = HashMap::<String, (i64, u64)>::new();
        let mut interval = tokio::time::interval(Duration::from_millis(350));
        loop {
            tokio::select! { _ = s.stop.cancelled() => break, _ = tx.closed() => break, _ = interval.tick() => {} }
            let result: Result<()> = async {
                let rows = sqlx::query("SELECT id,version FROM local_runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 20").bind(&name).fetch_all(&s.local.store.pool).await?;
                for row in rows.into_iter().rev() {
                    let id: String = row.get("id");
                    let version: i64 = row.get("version");
                    let previous = versions.get(&id).copied();
                    if previous.is_some_and(|v| v.0 == version) { continue; }
                    let record = s.local.get(&id, previous.map_or(0,|v| v.1)).await?;
                    let event = Event::default().event("update").json_data(&record)?;
                    tokio::select! { _ = s.stop.cancelled() => return Ok(()), result = tx.send(Ok(event)) => { result?; } }
                    versions.insert(id, (record.version.parse()?, record.run.last_sequence));
                }
                Ok(())
            }.await;
            if let Err(error) = result {
                let _ = tx.try_send(Ok(Event::default()
                    .event("stream_error")
                    .data(format!("{error:#}"))));
                break;
            }
        }
    });
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
async fn asset(request: Request) -> Response {
    if request.uri().path().starts_with("/api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"API route not found"})),
        )
            .into_response();
    }
    if request.method() != axum::http::Method::GET && request.method() != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = if request.uri().path() == "/" {
        "/index.html"
    } else {
        request.uri().path()
    };
    match CONSOLE_ASSETS.iter().find(|(name, _, _)| *name == path) {
        Some((_, mime, bytes)) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
            (headers, Body::from(*bytes)).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
