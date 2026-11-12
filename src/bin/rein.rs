use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use rein::{
    Request, Response,
    agents::{AgentConfig, AgentType},
    daemon_pid, runtime_dir, send_request,
};
use std::fs::OpenOptions;
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(version, about = "Local agents and Console, powered by reind")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// Manage named local or remote agents
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Manage the local daemon and its Console
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
}
#[derive(Subcommand)]
enum AgentCommand {
    /// Save an agent configuration without bringing it online
    Add(AddAgent),
    /// Bring a saved agent online to accept tasks; processes start on demand
    Up { name: String },
    /// Take an idle agent offline, keeping configuration and history
    Down { name: String },
    /// Remove an idle agent configuration, keeping chat history
    Rm { name: String },
    /// List configured agents and their availability
    Ls,
    /// Show the current on-disk configuration
    Inspect { name: String },
}
#[derive(Args)]
struct AddAgent {
    #[arg(value_enum)]
    provider: AgentType,
    name: String,
    /// Connect to a remote A2A agent of the specified type
    #[arg(long, conflicts_with_all = ["directory", "executable", "native_config", "model", "prepare"])]
    a2a: Option<String>,
    /// Environment variable containing the remote A2A bearer token
    #[arg(long, requires = "a2a")]
    token_env: Option<String>,
    /// Agent's working directory (defaults to the current directory)
    #[arg(long, visible_alias = "workspace")]
    directory: Option<PathBuf>,
    #[arg(long)]
    executable: Option<PathBuf>,
    #[arg(long)]
    native_config: Option<PathBuf>,
    #[arg(long)]
    model: Option<String>,
    /// Run Bash environment setup before starting the native agent
    #[arg(long)]
    prepare: Option<String>,
}
#[derive(Subcommand)]
enum DaemonCommand {
    Start,
    Status,
    Stop,
    Restart,
}
fn main() -> Result<()> {
    // Accept the requested Go-style spelling as well as the standard --a2a.
    let args = std::env::args_os().map(|arg| if arg == "-a2a" { "--a2a".into() } else { arg });
    let request = match Cli::parse_from(args).command {
        Commands::Daemon {
            command: DaemonCommand::Restart,
        } => {
            manage_daemon(DaemonCommand::Stop)?;
            return manage_daemon(DaemonCommand::Start);
        }
        Commands::Daemon { command } => return manage_daemon(command),
        Commands::Agent { command } => match command {
            AgentCommand::Ls => Request::AgentsList,
            AgentCommand::Inspect { name } => Request::InspectAgent { name },
            AgentCommand::Up { name } => Request::SetAgentEnabled {
                name,
                enabled: true,
            },
            AgentCommand::Down { name } => Request::SetAgentEnabled {
                name,
                enabled: false,
            },
            AgentCommand::Rm { name } => Request::RemoveAgent { name },
            AgentCommand::Add(options) => {
                let remote = options.a2a.is_some();
                let executable = options
                    .executable
                    .map(|p| {
                        if p.components().count() > 1 {
                            std::fs::canonicalize(p)
                        } else {
                            Ok(p)
                        }
                    })
                    .transpose()
                    .context("resolve executable")?;
                Request::AddAgent {
                    config: AgentConfig {
                        provider: options.provider,
                        name: options.name,
                        enabled: false,
                        a2a: options.a2a.map(|url| rein::execution::a2a::A2aRunOptions {
                            url,
                            token_env: options.token_env,
                        }),
                        directory: if remote {
                            None
                        } else {
                            Some(
                                options
                                    .directory
                                    .unwrap_or(std::env::current_dir()?)
                                    .canonicalize()
                                    .context("resolve directory")?,
                            )
                        },
                        executable,
                        native_config: options
                            .native_config
                            .map(std::fs::canonicalize)
                            .transpose()
                            .context("resolve native config")?,
                        model: options.model,
                        prepare: options.prepare,
                    },
                }
            }
        },
    };
    let response = send_request(&request)?;
    let output = match response {
        Response::LocalAgent { agent } => serde_json::to_value(agent)?,
        Response::LocalAgents { agents } => serde_json::to_value(agents)?,
        Response::AgentRemoved { name } => serde_json::json!({"removed":name}),
        _ => bail!("unexpected daemon response"),
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}
fn print_console() -> Result<()> {
    if let Response::Status { console_url, .. } = send_request(&Request::Status)? {
        println!("Console: {console_url}");
    }
    Ok(())
}

fn manage_daemon(command: DaemonCommand) -> Result<()> {
    let pid = daemon_pid()?;
    match command {
        DaemonCommand::Status => match pid {
            Some(pid) => {
                println!("reind is running (pid {pid})");
                print_console()?;
            }
            None => println!("reind is stopped"),
        },
        DaemonCommand::Start => {
            if let Some(pid) = pid {
                println!("reind is already running (pid {pid})");
                print_console()?;
                return Ok(());
            }
            let executable = std::env::current_exe()?.with_file_name("reind");
            let log_path = runtime_dir()?.join("daemon.log");
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&log_path)?;
            let mut child = Command::new(&executable)
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log)
                .process_group(0)
                .spawn()
                .with_context(|| {
                    format!(
                        "start {}; build/install both binaries",
                        executable.display()
                    )
                })?;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(pid) = daemon_pid()? {
                    println!("reind started (pid {pid})");
                    print_console()?;
                    break;
                }
                if let Some(status) = child.try_wait()? {
                    bail!("reind exited with {status}; see {}", log_path.display());
                }
                if Instant::now() >= deadline {
                    child.kill()?;
                    child.wait()?;
                    bail!("reind startup timed out; see {}", log_path.display());
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        DaemonCommand::Restart => unreachable!(),
        DaemonCommand::Stop => {
            if pid.is_none() {
                println!("reind is already stopped");
                return Ok(());
            }
            if !matches!(send_request(&Request::Stop)?, Response::Stopping) {
                bail!("unexpected daemon stop response");
            }
            println!("reind stopped");
        }
    }
    Ok(())
}
