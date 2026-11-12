//! Loopback-only Console and same-origin JSON API, served by reind itself.
use crate::{
    agents::AgentConfig,
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
pub fn router(local: LocalRuntime, origin: String, stop: CancellationToken) -> Router {
    let state = WebState {
        local,
        origin,
        stop,
    };
    Router::new()
        .route("/api/agents", get(agents).post(add_agent))
        .route("/api/agents/{name}/availability", post(availability))
        .route("/api/agents/{name}", axum::routing::delete(remove_agent))
        .route("/api/agents/{name}/history", get(history))
        .route("/api/agents/{name}/events", get(events))
        .route("/api/runs", post(create_run))
        .route("/api/runs/{id}", get(run))
        .route("/api/runs/{id}/cancel", post(cancel))
        .route("/api/runs/{id}/reply", post(reply))
        .route("/api/projects", get(projects).post(save_project))
        .fallback(asset)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), same_origin))
        .with_state(state)
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
    Ok(Json(json!({"agents":s.local.agents.list()?})))
}
async fn add_agent(State(s): State<WebState>, Json(config): Json<AgentConfig>) -> ApiResult {
    Ok(Json(json!({"agent":s.local.add_agent(config).await?})))
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
