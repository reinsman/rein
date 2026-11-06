use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use rein::{Request, Response, daemon_pid, runtime_dir, send_request};

#[derive(Parser)]
#[command(version, about = "Manage reind and query bridged agents")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Ask reind to authenticate with reinhub (framework stage)
    Login {
        #[arg(long, default_value = "https://localhost:9011")]
        hub: String,
        #[command(subcommand)]
        command: Option<LoginCommand>,
    },
    /// Submit a platform Run through reind
    Run {
        agent_id: String,
        #[arg(long)]
        session: Option<String>,
        prompt: String,
    },
    /// Query and control platform executions
    Runs {
        #[command(subcommand)]
        command: RunCommand,
    },
    /// Manage the local reind process
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
    /// Query bridged agents
    Agents {
        #[command(subcommand)]
        command: ListCommand,
    },
    /// Query agent sessions
    Sessions {
        #[command(subcommand)]
        command: ListCommand,
    },
    /// Query A2A services exposed by agents
    A2a {
        #[command(subcommand)]
        command: A2aCommand,
    },
}

#[derive(Subcommand)]
enum LoginCommand {
    Status,
}

#[derive(Subcommand)]
enum RunCommand {
    Get {
        run_id: String,
    },
    Cancel {
        run_id: String,
        #[arg(long)]
        attempt: String,
    },
    Reply {
        run_id: String,
        #[arg(long)]
        attempt: String,
        #[arg(long)]
        interaction: String,
        #[arg(long)]
        response: serde_json::Value,
    },
    Instruct {
        run_id: String,
        #[arg(long)]
        attempt: String,
        instruction: String,
    },
}

#[derive(Subcommand)]
enum DaemonCommand {
    Start,
    Status,
    Stop,
}

#[derive(Subcommand)]
enum ListCommand {
    List,
}

#[derive(Subcommand)]
enum A2aCommand {
    List,
    Inspect { name: String },
}

fn main() -> Result<()> {
    let command = match Cli::parse().command {
        Commands::Daemon { command } => return manage_daemon(command),
        Commands::Login { hub, command: None } => Request::LoginStart { hub_url: hub },
        Commands::Login {
            command: Some(LoginCommand::Status),
            ..
        } => Request::LoginStatus,
        Commands::Run {
            agent_id,
            session,
            prompt,
        } => Request::CreateRun {
            agent_id,
            session_id: session,
            prompt,
        },
        Commands::Runs { command } => match command {
            RunCommand::Get { run_id } => Request::GetRun { run_id },
            RunCommand::Cancel { run_id, attempt } => Request::CancelRun {
                run_id,
                attempt_id: attempt,
            },
            RunCommand::Reply {
                run_id,
                attempt,
                interaction,
                response,
            } => Request::ReplyInteraction {
                run_id,
                attempt_id: attempt,
                interaction_id: interaction,
                response,
            },
            RunCommand::Instruct {
                run_id,
                attempt,
                instruction,
            } => Request::SendInstruction {
                run_id,
                attempt_id: attempt,
                instruction,
            },
        },
        Commands::Agents { .. } => Request::AgentsList,
        Commands::Sessions { .. } => Request::SessionsList,
        Commands::A2a { command } => match command {
            A2aCommand::List => Request::A2aList,
            A2aCommand::Inspect { name } => Request::A2aInspect { name },
        },
    };
    let response = send_request(&command)?;
    let output = match response {
        Response::Agents { agents } => serde_json::to_string_pretty(&agents)?,
        Response::Sessions { sessions } => serde_json::to_string_pretty(&sessions)?,
        Response::A2aServices { services } => serde_json::to_string_pretty(&services)?,
        Response::A2aService { service } => serde_json::to_string_pretty(&service)?,
        _ => bail!("unexpected daemon response"),
    };
    println!("{output}");
    Ok(())
}

fn manage_daemon(command: DaemonCommand) -> Result<()> {
    let pid = daemon_pid()?;
    match command {
        DaemonCommand::Status => match pid {
            Some(pid) => println!("reind is running (pid {pid})"),
            None => println!("reind is stopped"),
        },
        DaemonCommand::Start => {
            if let Some(pid) = pid {
                println!("reind is already running (pid {pid})");
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
