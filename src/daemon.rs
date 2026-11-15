use std::fs::{self, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::sync::Arc;
use std::time::Duration;

use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use anyhow::{Context, Result, bail};

use crate::{IO_TIMEOUT, MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, Request, Response};

pub struct State {
    pub local: crate::local::LocalRuntime,
    pub console_url: String,
}
impl State {
    async fn respond(&self, request: Request) -> Response {
        let result: Result<Response> = async {
            Ok(match request {
                Request::Status => Response::Status {
                    pid: std::process::id(),
                    console_url: self.console_url.clone(),
                },
                Request::Stop => Response::Stopping,
                Request::AgentsList => Response::LocalAgents {
                    agents: self.local.agents.list()?,
                },
                Request::InspectAgent { name } => Response::LocalAgent {
                    agent: self.local.agents.get(&name)?,
                },
                Request::AddAgent { config } => Response::LocalAgent {
                    agent: self.local.add_agent(config).await?,
                },
                Request::SetAgentEnabled { name, enabled } => Response::LocalAgent {
                    agent: self.local.set_enabled(&name, enabled).await?,
                },
                Request::RemoveAgent { name } => {
                    self.local.remove_agent(&name).await?;
                    Response::AgentRemoved { name }
                }
            })
        }
        .await;
        result.unwrap_or_else(|e| Response::Error {
            message: format!("{e:#}"),
        })
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
    let local = crate::local::LocalRuntime::new(crate::runtime_dir()?, store).await?;
    let workflow = crate::workflow::Workflow::new(local.clone()).await?;
    let http = tokio::net::TcpListener::bind(crate::web::listen_address()?).await?;
    let console_url = format!("http://{}", http.local_addr()?);
    let state = Arc::new(State {
        local,
        console_url: console_url.clone(),
    });
    let http_stop = tokio_util::sync::CancellationToken::new();
    let stop_signal = http_stop.clone();
    let tasks = workflow.spawn_tasks(http_stop.clone());
    let specs = workflow.spawn_specs(http_stop.clone());
    let router = crate::web::router(
        state.local.clone(),
        workflow,
        console_url.clone(),
        http_stop.clone(),
    );
    let web = tokio::spawn(async move {
        axum::serve(http, router)
            .with_graceful_shutdown(stop_signal.cancelled_owned())
            .await
    });
    let (stop_tx, mut stop_rx) = tokio::sync::mpsc::channel(1);
    let clients = Arc::new(tokio::sync::Semaphore::new(64));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    eprintln!(
        "reind: daemon started pid={} socket={} console={console_url}",
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
    http_stop.cancel();
    tasks.await?;
    specs.await?;
    state.local.shutdown().await;
    web.await??;
    drop(lock);
    drop(socket);
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
