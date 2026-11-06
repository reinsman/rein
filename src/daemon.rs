use std::fs::{self, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};

use crate::{A2aService, Agent, IO_TIMEOUT, Request, Response, Session};

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
}

impl State {
    fn respond(&self, request: Request) -> Response {
        match request {
            Request::Status => Response::Status {
                pid: std::process::id(),
            },
            Request::Stop => Response::Stopping,
            Request::AgentsList => Response::Agents {
                agents: self.agents.clone(),
            },
            Request::SessionsList => Response::Sessions {
                sessions: self.sessions.clone(),
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
            // TODO: 业务请求转交 reinhub 授权和持久化；只执行 claim 返回的租约。
            Request::CreateRun { .. }
            | Request::GetRun { .. }
            | Request::CancelRun { .. }
            | Request::ReplyInteraction { .. }
            | Request::SendInstruction { .. } => Response::Error {
                message: "Hub run operations are not implemented (framework stage)".into(),
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
    let listener = UnixListener::bind(&path)
        .with_context(|| format!("bind Unix socket {}", path.display()))?;
    let socket = SocketGuard(path);
    let state = State::default();

    // shortcut: one request at a time; add concurrent handling when adapters do blocking work.
    loop {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        };
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let response = match crate::read_message(&stream) {
            Ok(request) => state.respond(request),
            Err(error) => Response::Error {
                message: error.to_string(),
            },
        };
        if matches!(response, Response::Stopping) {
            // Acknowledge only after new clients can no longer reach this daemon.
            drop(listener);
            drop(socket);
            drop(lock);
            return crate::write_message(&mut stream, &response);
        }
        if let Err(error) = crate::write_message(&mut stream, &response) {
            eprintln!("reind: {error:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_reads_the_registry_and_reports_missing_services() {
        let state = State {
            a2a_services: vec![A2aService {
                name: "coder".into(),
                agent_id: "agent-1".into(),
                url: "http://127.0.0.1:9000".into(),
            }],
            ..State::default()
        };
        assert!(matches!(
            state.respond(Request::A2aInspect { name: "coder".into() }),
            Response::A2aService { service } if service.agent_id == "agent-1"
        ));
        assert!(matches!(
            state.respond(Request::A2aInspect {
                name: "missing".into()
            }),
            Response::Error { .. }
        ));
    }
}
