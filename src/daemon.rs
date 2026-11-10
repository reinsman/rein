use std::fs::{self, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::sync::Arc;
use std::time::Duration;

use rein_proto::hub::v1 as pb;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use anyhow::{Context, Result, bail};

use crate::{
    A2aService, Agent, IO_TIMEOUT, MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, Request, Response,
    Session,
};

/// The registry is intentionally empty until real agent adapters populate it.
#[derive(Default)]
pub struct State {
    pub agents: Vec<Agent>,
    pub sessions: Vec<Session>,
    pub a2a_services: Vec<A2aService>,
    // TODO: 在 daemon 后台运行 Hub Client；State 的对外查询不序列化连接凭据。
    pub hub: Option<crate::hub::HubClient>,
    pub execution: crate::execution::ExecutionManager,
    pub store: Option<crate::store::LocalStore>,
    pub hub_runtime: Option<crate::hub_runtime::HubRuntime>,
}

impl State {
    async fn respond(&self, request: Request) -> Response {
        match request {
            Request::Status => Response::Status {
                pid: std::process::id(),
            },
            Request::Stop => Response::Stopping,
            Request::AgentsList => {
                let mut agents = self.agents.clone();
                if let Some(hub) = &self.hub_runtime {
                    match hub.agents().await {
                        Ok(configured) => agents.extend(configured),
                        Err(error) => {
                            return Response::Error {
                                message: error.to_string(),
                            };
                        }
                    }
                }
                Response::Agents { agents }
            }
            Request::RegisterAgent {
                name,
                configuration,
                hub_url,
                ca,
                insecure_skip_verify,
            } => {
                let Some(hub) = &self.hub_runtime else {
                    return Response::Error {
                        message: "Hub runtime unavailable".into(),
                    };
                };
                match hub
                    .register(name, configuration, hub_url, ca, insecure_skip_verify)
                    .await
                {
                    Ok(registration) => Response::RegisteredAgent { registration },
                    Err(error) => Response::Error {
                        message: format!("{error:#}"),
                    },
                }
            }
            Request::BringAgentOnline { name, provider } => {
                let Some(hub) = &self.hub_runtime else {
                    return Response::Error {
                        message: "Hub runtime unavailable".into(),
                    };
                };
                match hub.bring_online(name, provider).await {
                    Ok(registration) => Response::RegisteredAgent { registration },
                    Err(error) => Response::Error {
                        message: format!("{error:#}"),
                    },
                }
            }
            Request::TakeAgentOffline { target } => {
                let Some(hub) = &self.hub_runtime else {
                    return Response::Error {
                        message: "Hub runtime unavailable".into(),
                    };
                };
                match hub.take_offline(target).await {
                    Ok((agent_id, name)) => Response::AgentOffline { agent_id, name },
                    Err(error) => Response::Error {
                        message: format!("{error:#}"),
                    },
                }
            }
            Request::SessionsList => Response::Sessions {
                sessions: self
                    .sessions
                    .iter()
                    .cloned()
                    .chain(self.execution.sessions())
                    .collect(),
            },
            Request::A2aList => Response::A2aServices {
                services: self.a2a_services.clone(),
            },
            Request::A2aInspect { name } => match self.a2a_services.iter().find(|s| s.name == name)
            {
                Some(service) => Response::A2aService {
                    service: service.clone(),
                },
                None => Response::Error {
                    message: format!("A2A service '{name}' not found"),
                },
            },
            // TODO: 投递到后台 Hub Client；登录/长执行不能占用 IPC 请求线程。
            // 只有真实认证完成后才保存凭据并注册 Runtime，IPC 永远不返回凭据。
            Request::LoginStart { .. } | Request::LoginStatus => Response::Error {
                message: "Hub login is not implemented (framework stage)".into(),
            },
            Request::StartNativeRun {
                options,
                session_id,
                prompt,
            } => match self.execution.start_native(options, session_id, prompt) {
                Ok(run) => Response::Run { run },
                Err(error) => Response::Error {
                    message: format!("{error:#}"),
                },
            },
            Request::GetRunEvents { run_id, after } => {
                match self.execution.events(&run_id, after) {
                    Ok(events) => Response::RunEvents { events },
                    Err(error) => Response::Error {
                        message: error.to_string(),
                    },
                }
            }
            Request::GetRun { run_id } if run_id.starts_with("local-") => {
                match self.execution.get(&run_id) {
                    Some(run) => Response::Run { run },
                    None => Response::Error {
                        message: "local run not found".into(),
                    },
                }
            }
            Request::CancelRun { run_id, attempt_id } if run_id.starts_with("local-") => self
                .control(
                    run_id,
                    attempt_id,
                    pb::control_command::Payload::Cancel(pb::CancelCommand {
                        reason: "local CLI".into(),
                    }),
                ),
            Request::ReplyInteraction {
                run_id,
                attempt_id,
                interaction_id,
                response,
            } if run_id.starts_with("local-") => self.control(
                run_id,
                attempt_id,
                pb::control_command::Payload::InteractionReply(pb::InteractionReplyCommand {
                    interaction_id,
                    response_json: serde_json::to_vec(&response).unwrap(),
                }),
            ),
            // 平台 Run 仍须经 Hub 授权和持久化；不能隐式变成本地任务。
            Request::CreateRun { .. }
            | Request::GetRun { .. }
            | Request::CancelRun { .. }
            | Request::ReplyInteraction { .. }
            | Request::SendInstruction { .. } => Response::Error {
                message: "Hub run operations are not implemented (framework stage)".into(),
            },
        }
    }

    fn control(
        &self,
        run_id: String,
        attempt_id: String,
        payload: pb::control_command::Payload,
    ) -> Response {
        let command = pb::ControlCommand {
            command_id: Uuid::new_v4().to_string(),
            attempt: Some(pb::AttemptRef { run_id, attempt_id }),
            payload: Some(payload),
        };
        match self.execution.command(command) {
            Ok(ack) => Response::ControlAccepted {
                command_id: ack.command_id,
            },
            Err(error) => Response::Error {
                message: format!("{error:#}"),
            },
        }
    }
}

struct SocketGuard(PathBuf);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn run() -> Result<()> {
    let dir = crate::runtime_dir()?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join("daemon.lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => bail!("reind is already running"),
        Err(TryLockError::Error(error)) => return Err(error.into()),
    }

    let path = dir.join("reind.sock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(&path)?,
        Ok(_) => bail!("refusing to replace non-socket {}", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(serve(path, lock))
}

async fn serve(path: PathBuf, lock: std::fs::File) -> Result<()> {
    let listener = UnixListener::bind(&path)
        .with_context(|| format!("bind Unix socket {}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let socket = SocketGuard(path);
    let store = crate::store::LocalStore::open(crate::runtime_dir()?.join("reind.sqlite")).await?;
    let execution = crate::execution::ExecutionManager::default();
    let hub_runtime = crate::hub_runtime::HubRuntime::new(store.clone(), execution.clone()).await?;
    hub_runtime.start().await;
    let state = Arc::new(State {
        execution,
        store: Some(store),
        hub_runtime: Some(hub_runtime),
        ..State::default()
    });
    let (stop_tx, mut stop_rx) = tokio::sync::mpsc::channel(1);
    let clients = Arc::new(tokio::sync::Semaphore::new(64));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    eprintln!(
        "reind: daemon started pid={} socket={}",
        std::process::id(),
        socket.0.display()
    );
    let stop_stream = loop {
        tokio::select! {
            biased;
            stream = stop_rx.recv() => break stream,
            _ = terminate.recv() => break None,
            _ = interrupt.recv() => break None,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = clients.clone().try_acquire_owned() else { continue; };
                let state = state.clone();
                let stop_tx = stop_tx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = handle_client(stream, state, stop_tx).await {
                        eprintln!("reind: {error:#}");
                    }
                });
            }
        }
    };
    eprintln!("reind: daemon stopping; cleaning up active executions");
    drop(listener);
    drop(socket);
    if let Some(hub) = &state.hub_runtime {
        hub.shutdown().await;
    }
    state.execution.shutdown().await;
    drop(lock);
    eprintln!("reind: daemon stopped");
    if let Some(mut stream) = stop_stream {
        write_response(&mut stream, &Response::Stopping).await?;
    }
    Ok(())
}

async fn handle_client(
    stream: UnixStream,
    state: Arc<State>,
    stop: tokio::sync::mpsc::Sender<UnixStream>,
) -> Result<()> {
    let mut reader = BufReader::new(stream.take(MAX_MESSAGE_BYTES + 1));
    let mut bytes = Vec::new();
    let request = tokio::time::timeout(IO_TIMEOUT, reader.read_until(b'\n', &mut bytes)).await;
    let mut stream = reader.into_inner().into_inner();
    let response = match request {
        Ok(Ok(_)) if bytes.len() as u64 > MAX_MESSAGE_BYTES => Response::Error {
            message: format!("message exceeds {MAX_MESSAGE_BYTES} bytes"),
        },
        Ok(Ok(_)) if bytes.last() == Some(&b'\n') => {
            match serde_json::from_slice::<Request>(&bytes) {
                Ok(Request::Stop) => {
                    let _ = stop.try_send(stream);
                    return Ok(());
                }
                Ok(request) => state.respond(request).await,
                Err(_) => Response::Error {
                    message: "invalid protocol message".into(),
                },
            }
        }
        _ => Response::Error {
            message: "incomplete message or IPC read timed out".into(),
        },
    };
    write_response(&mut stream, &response).await
}

async fn write_response(stream: &mut UnixStream, response: &Response) -> Result<()> {
    let mut bytes = serde_json::to_vec(response)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        bail!("IPC response too large");
    }
    tokio::time::timeout(Duration::from_secs(2), stream.write_all(&bytes)).await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn inspect_reads_the_registry_and_reports_missing_services() {
        let state = State {
            a2a_services: vec![A2aService {
                name: "coder".into(),
                agent_id: "agent-1".into(),
                url: "http://127.0.0.1:9000".into(),
            }],
            ..State::default()
        };
        assert!(matches!(
            state.respond(Request::A2aInspect { name: "coder".into() }).await,
            Response::A2aService { service } if service.agent_id == "agent-1"
        ));
        assert!(matches!(
            state
                .respond(Request::A2aInspect {
                    name: "missing".into()
                })
                .await,
            Response::Error { .. }
        ));
    }
}
