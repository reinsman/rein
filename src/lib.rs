//! Shared local protocol for `rein` and `reind` (Unix only).

pub mod daemon;
pub mod execution;
pub mod hub;
pub mod store;

use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const MAX_MESSAGE_BYTES: u64 = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Request {
    Status,
    Stop,
    AgentsList,
    SessionsList,
    A2aList,
    A2aInspect {
        name: String,
    },
    LoginStart {
        hub_url: String,
    },
    LoginStatus,
    CreateRun {
        agent_id: String,
        session_id: Option<String>,
        prompt: String,
    },
    GetRun {
        run_id: String,
    },
    CancelRun {
        run_id: String,
        attempt_id: String,
    },
    ReplyInteraction {
        run_id: String,
        attempt_id: String,
        interaction_id: String,
        response: serde_json::Value,
    },
    SendInstruction {
        run_id: String,
        attempt_id: String,
        instruction: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aService {
    pub name: String,
    pub agent_id: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Status { pid: u32 },
    Stopping,
    Agents { agents: Vec<Agent> },
    Sessions { sessions: Vec<Session> },
    A2aServices { services: Vec<A2aService> },
    A2aService { service: A2aService },
    Error { message: String },
}

pub fn runtime_dir() -> Result<PathBuf> {
    let path = if let Some(path) = env::var_os("REIN_HOME") {
        PathBuf::from(path)
    } else {
        PathBuf::from(env::var_os("HOME").context("HOME is not set; set REIN_HOME")?).join(".rein")
    };
    fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

pub fn send_request(request: &Request) -> Result<Response> {
    let path = runtime_dir()?.join("reind.sock");
    let mut stream = UnixStream::connect(&path)
        .with_context(|| format!("connect to {}; run `rein daemon start`", path.display()))?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    write_message(&mut stream, request)?;
    let response = read_message(&stream)?;
    if let Response::Error { message } = response {
        bail!("{message}");
    }
    Ok(response)
}

pub fn daemon_pid() -> Result<Option<u32>> {
    match send_request(&Request::Status) {
        Ok(Response::Status { pid }) => Ok(Some(pid)),
        Ok(_) => bail!("unexpected daemon status response"),
        Err(error) => {
            if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                )
            }) {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn read_message<T: DeserializeOwned>(stream: &UnixStream) -> Result<T> {
    use std::io::Read;

    let mut bytes = Vec::new();
    BufReader::new(stream.take(MAX_MESSAGE_BYTES + 1)).read_until(b'\n', &mut bytes)?;
    if bytes.len() as u64 > MAX_MESSAGE_BYTES {
        bail!("message exceeds {MAX_MESSAGE_BYTES} bytes");
    }
    if bytes.last() != Some(&b'\n') {
        bail!("incomplete message");
    }
    serde_json::from_slice(&bytes).context("invalid protocol message")
}

fn write_message(stream: &mut UnixStream, message: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_MESSAGE_BYTES {
        bail!("message exceeds {MAX_MESSAGE_BYTES} bytes");
    }
    stream.write_all(&bytes).context("write protocol message")
}
