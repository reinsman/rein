use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use rein::{Request, Response, daemon_pid, runtime_dir, send_request};
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Manage reind and query bridged agents")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Bring an Agent online; without options, reuse its saved configuration
    Up(RegisterAgentArgs),
    /// Take an Agent offline without deleting configuration or execution history
    Down { target: String },
    /// List locally configured Agents and their desired availability
    Ls,
    Register {
        #[command(subcommand)]
        command: RegisterCommand,
    },
    /// Execute a local Codex/Pi child through reind, without a Hub or A2A
    Native {
        #[command(subcommand)]
        command: NativeCommand,
    },
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

#[derive(Clone, Copy, ValueEnum)]
enum RegistrationProvider {
    Codex,
    Pi,
    A2a,
}
#[derive(Args)]
struct RegisterAgentArgs {
    #[arg(value_enum)]
    provider: RegistrationProvider,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    workspace: Option<PathBuf>,
    #[arg(long)]
    executable: Option<PathBuf>,
    #[arg(long)]
    native_config: Option<PathBuf>,
    #[arg(long)]
    model: Option<String>,
    /// Run Bash environment setup before starting a native agent
    #[arg(long)]
    prepare: Option<String>,
    #[arg(long)]
    url: Option<String>,
    #[arg(long)]
    token_env: Option<String>,
    #[arg(long)]
    hub: Option<String>,
    /// Trust this CA for Hub connections only; does not modify system roots
    #[arg(long)]
    ca: Option<PathBuf>,
    /// Keep TLS but skip Hub certificate chain and hostname verification
    #[arg(long, conflicts_with = "ca")]
    insecure_skip_verify: bool,
}

#[derive(Subcommand)]
enum RegisterCommand {
    Agent(RegisterAgentArgs),
}

#[derive(Subcommand)]
enum LoginCommand {
    Status,
}

#[derive(Subcommand)]
enum RunCommand {
    Events {
        run_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
        /// Print JSON events continuously until this local Run finishes
        #[arg(long)]
        follow: bool,
    },
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
        #[arg(long, value_parser = |value: &str| serde_json::from_str::<serde_json::Value>(value))]
        response: serde_json::Value,
    },
    Instruct {
        run_id: String,
        #[arg(long)]
        attempt: String,
        instruction: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum NativeProvider {
    Codex,
    Pi,
}

#[derive(Subcommand)]
enum NativeCommand {
    Run {
        #[arg(value_enum)]
        provider: NativeProvider,
        prompt: String,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        executable: Option<PathBuf>,
        #[arg(long)]
        native_config: Option<PathBuf>,
        #[arg(long)]
        model: Option<String>,
        /// Run Bash environment setup before starting the agent
        #[arg(long)]
        prepare: Option<String>,
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

fn registration_request(options: RegisterAgentArgs, reuse: bool) -> Result<Request> {
    let RegisterAgentArgs {
        provider,
        name,
        workspace,
        executable,
        native_config,
        model,
        prepare,
        url,
        token_env,
        hub,
        ca,
        insecure_skip_verify,
    } = options;
    if reuse
        && workspace.is_none()
        && executable.is_none()
        && native_config.is_none()
        && model.is_none()
        && prepare.is_none()
        && url.is_none()
        && token_env.is_none()
        && hub.is_none()
        && ca.is_none()
        && !insecure_skip_verify
    {
        let provider = match provider {
            RegistrationProvider::Pi => "pi",
            RegistrationProvider::Codex => "codex",
            RegistrationProvider::A2a => "a2a",
        };
        return Ok(Request::BringAgentOnline {
            name: name.unwrap_or_else(|| provider.into()),
            provider: provider.into(),
        });
    }
    if ca.is_none() && !insecure_skip_verify {
        bail!("--ca or --insecure-skip-verify is required when configuring an Agent")
    }
    if matches!(provider, RegistrationProvider::A2a) && prepare.is_some() {
        bail!("--prepare is only supported for native Codex/Pi agents")
    }
    if insecure_skip_verify {
        eprintln!(
            "WARNING: Hub TLS certificate verification is disabled; the server identity will not be verified."
        );
    }
    let (default_name, configuration) = match provider {
        RegistrationProvider::A2a => (
            "a2a",
            rein::hub_runtime::RegisteredBackend::A2a {
                options: rein::execution::a2a::A2aRunOptions {
                    url: url.context("A2A registration requires --url")?,
                    token_env,
                },
            },
        ),
        RegistrationProvider::Codex | RegistrationProvider::Pi => {
            if url.is_some() || token_env.is_some() {
                bail!("--url and --token-env are only supported for A2A")
            }
            let kind = if matches!(provider, RegistrationProvider::Codex) {
                a2alinker::AgentKind::Codex
            } else {
                a2alinker::AgentKind::Pi
            };
            (
                kind.as_str(),
                rein::hub_runtime::RegisteredBackend::Native {
                    options: rein::execution::native::NativeRunOptions {
                        provider: kind,
                        workspace: workspace
                            .unwrap_or_else(|| PathBuf::from("."))
                            .canonicalize()
                            .context("resolve workspace")?,
                        executable: executable
                            .map(|p| {
                                if p.components().count() > 1 {
                                    std::fs::canonicalize(&p)
                                } else {
                                    Ok(p)
                                }
                            })
                            .transpose()?,
                        native_config: native_config.map(std::fs::canonicalize).transpose()?,
                        model,
                        prepare,
                    },
                },
            )
        }
    };
    Ok(Request::RegisterAgent {
        name: name.unwrap_or_else(|| default_name.into()),
        configuration,
        hub_url: hub.unwrap_or_else(|| "https://localhost:9011".into()),
        ca: ca
            .map(|path| path.canonicalize().context("resolve Hub CA"))
            .transpose()?,
        insecure_skip_verify,
    })
}

fn main() -> Result<()> {
    let command = match Cli::parse().command {
        Commands::Up(options) => registration_request(options, true)?,
        Commands::Down { target } => Request::TakeAgentOffline { target },
        Commands::Register {
            command: RegisterCommand::Agent(options),
        } => registration_request(options, false)?,
        Commands::Runs {
            command:
                RunCommand::Events {
                    run_id,
                    after,
                    follow: true,
                },
        } => return follow_events(run_id, after),
        Commands::Native {
            command:
                NativeCommand::Run {
                    provider,
                    prompt,
                    workspace,
                    session,
                    executable,
                    native_config,
                    model,
                    prepare,
                },
        } => Request::StartNativeRun {
            options: rein::execution::native::NativeRunOptions {
                provider: match provider {
                    NativeProvider::Codex => a2alinker::AgentKind::Codex,
                    NativeProvider::Pi => a2alinker::AgentKind::Pi,
                },
                workspace: workspace.canonicalize().context("resolve workspace")?,
                executable: executable
                    .map(|p| {
                        if p.components().count() > 1 {
                            std::fs::canonicalize(&p)
                        } else {
                            Ok(p)
                        }
                    })
                    .transpose()
                    .context("resolve executable")?,
                native_config: native_config
                    .map(std::fs::canonicalize)
                    .transpose()
                    .context("resolve native config")?,
                model,
                prepare,
            },
            session_id: session,
            prompt,
        },
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
            RunCommand::Events { run_id, after, .. } => Request::GetRunEvents { run_id, after },
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
        Commands::Ls | Commands::Agents { .. } => Request::AgentsList,
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
        Response::RegisteredAgent { registration } => serde_json::to_string_pretty(&registration)?,
        Response::AgentOffline { agent_id, name } => serde_json::to_string_pretty(
            &serde_json::json!({"agent_id":agent_id,"name":name,"state":"down"}),
        )?,
        Response::Run { run } => serde_json::to_string_pretty(&run)?,
        Response::RunEvents { events } => serde_json::to_string_pretty(&events)?,
        Response::ControlAccepted { command_id } => serde_json::to_string_pretty(
            &serde_json::json!({"command_id":command_id,"state":"received"}),
        )?,
        _ => bail!("unexpected daemon response"),
    };
    println!("{output}");
    Ok(())
}

fn follow_events(run_id: String, mut after: u64) -> Result<()> {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    loop {
        let Response::RunEvents { events } = send_request(&Request::GetRunEvents {
            run_id: run_id.clone(),
            after,
        })?
        else {
            bail!("unexpected events response");
        };
        if !events.is_empty() {
            for event in events {
                after = event.sequence;
                serde_json::to_writer(&mut stdout, &event)?;
                writeln!(stdout)?;
            }
            stdout.flush()?;
            continue;
        }
        let Response::Run { run } = send_request(&Request::GetRun {
            run_id: run_id.clone(),
        })?
        else {
            bail!("unexpected run response");
        };
        if matches!(run.state.as_str(), "completed" | "failed" | "cancelled")
            && after >= run.last_sequence
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
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
