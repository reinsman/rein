//! Hub 桥接：注册、领取、执行、事件 outbox 与控制 inbox。
use crate::{
    execution::{
        Backend, ExecutionManager,
        a2a::{A2aBackend, A2aControl, A2aRunOptions},
        native::{NativeBackend, NativeControl, NativeRunOptions},
    },
    hub::HubClient,
    store::LocalStore,
};
use anyhow::{Context, Result, bail, ensure};
use prost::Message;
use rein_proto::hub::v1::{
    self as pb, connect_request as req, connect_response as res, execution_event as ev,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify, mpsc},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "snake_case")]
pub enum RegisteredBackend {
    Native { options: NativeRunOptions },
    A2a { options: A2aRunOptions },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registration {
    pub name: String,
    pub agent_id: String,
    pub runtime_id: String,
    pub configuration: RegisteredBackend,
}
#[derive(Clone)]
enum ActiveControl {
    Native(NativeControl),
    A2a(A2aControl),
}
impl ActiveControl {
    fn cancel(&self) {
        match self {
            Self::Native(c) => c.cancel(),
            Self::A2a(c) => c.cancel(),
        }
    }
    async fn command(&self, c: &pb::ControlCommand) -> Result<pb::CommandAck> {
        match self {
            Self::Native(handle) => handle.command(c),
            Self::A2a(handle) => handle.command(c).await,
        }
    }
    fn references(&self) -> (Option<String>, Option<String>, Option<String>) {
        match self {
            Self::Native(c) => (c.native_id(), None, None),
            Self::A2a(c) => {
                let (ctx, task) = c.reference();
                (None, ctx, task)
            }
        }
    }
}
#[derive(Clone)]
pub struct HubRuntime {
    store: LocalStore,
    execution: ExecutionManager,
    daemon_id: String,
    stop: CancellationToken,
    wake: Arc<Notify>,
    reconnect: Arc<Notify>,
    active: Arc<Mutex<HashMap<String, ActiveControl>>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
    commands_inflight: Arc<Mutex<HashSet<String>>>,
    registration_lock: Arc<Mutex<()>>,
}
impl HubRuntime {
    pub async fn new(store: LocalStore, execution: ExecutionManager) -> Result<Self> {
        let daemon_id = match store.setting("daemon_id").await? {
            Some(id) => id,
            None => {
                let id = Uuid::new_v4().to_string();
                store.set_setting("daemon_id", &id).await?;
                id
            }
        };
        Ok(Self {
            store,
            execution,
            daemon_id,
            stop: CancellationToken::new(),
            wake: Arc::new(Notify::new()),
            reconnect: Arc::new(Notify::new()),
            active: Arc::new(Mutex::new(HashMap::new())),
            task: Arc::new(Mutex::new(None)),
            commands_inflight: Arc::new(Mutex::new(HashSet::new())),
            registration_lock: Arc::new(Mutex::new(())),
        })
    }
    pub async fn start(&self) {
        let runtime = self.clone();
        *self.task.lock().await = Some(tokio::spawn(async move { runtime.background().await }));
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        self.wake.notify_waiters();
        for control in self.active.lock().await.values() {
            control.cancel()
        }
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
    pub async fn registrations(&self) -> Result<Vec<Registration>> {
        let rows = sqlx::query(
            "SELECT name,agent_id,runtime_id,configuration FROM registrations r WHERE NOT EXISTS(SELECT 1 FROM agent_removals d WHERE d.name=r.name) ORDER BY name",
        )
        .fetch_all(&self.store.pool)
        .await?;
        rows.into_iter()
            .map(|r| {
                Ok(Registration {
                    name: r.get(0),
                    agent_id: r.get(1),
                    runtime_id: r.get(2),
                    configuration: serde_json::from_str(r.get::<&str, _>(3))?,
                })
            })
            .collect()
    }

    pub async fn agents(&self) -> Result<Vec<crate::Agent>> {
        let rows = sqlx::query("SELECT agent_id,name,EXISTS(SELECT 1 FROM agent_removals d WHERE d.name=r.name) FROM registrations r ORDER BY name").fetch_all(&self.store.pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| crate::Agent {
                id: row.get(0),
                name: row.get(1),
                disabled: row.get::<i64, _>(2) != 0,
            })
            .collect())
    }

    async fn configured_registration(&self, target: &str) -> Result<Option<Registration>> {
        let row = sqlx::query("SELECT name,agent_id,runtime_id,configuration FROM registrations WHERE name=? OR agent_id=? ORDER BY name=? DESC LIMIT 1").bind(target).bind(target).bind(target).fetch_optional(&self.store.pool).await?;
        row.map(|row| {
            Ok(Registration {
                name: row.get(0),
                agent_id: row.get(1),
                runtime_id: row.get(2),
                configuration: serde_json::from_str(row.get::<&str, _>(3))?,
            })
        })
        .transpose()
    }

    pub async fn bring_online(&self, name: String, provider: String) -> Result<Registration> {
        let lock = self.registration_lock.lock().await;
        let reg = self.configured_registration(&name).await?.with_context(|| format!("Agent '{name}' is not configured; supply configuration options and --ca on its first up"))?;
        let actual = match &reg.configuration {
            RegisteredBackend::Native { options } => options.provider.as_str(),
            RegisteredBackend::A2a { .. } => "a2a",
        };
        ensure!(
            actual == provider,
            "saved Agent provider is {actual}, not {provider}"
        );
        let url = self
            .store
            .setting("hub_url")
            .await?
            .context("missing saved Hub URL")?;
        let insecure = self
            .store
            .setting("hub_insecure_skip_verify")
            .await?
            .as_deref()
            == Some("true");
        let ca = if insecure {
            None
        } else {
            self.store
                .setting("hub_ca")
                .await?
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        drop(lock);
        self.register(reg.name, reg.configuration, url, ca, insecure)
            .await
    }

    pub async fn take_offline(&self, target: String) -> Result<(String, String)> {
        let _lock = self.registration_lock.lock().await;
        ensure!(!self.stop.is_cancelled(), "daemon is stopping");
        let reg = self
            .configured_registration(&target)
            .await?
            .with_context(|| format!("Agent '{target}' is not configured"))?;
        let completed: Option<i64> =
            sqlx::query_scalar("SELECT completed FROM agent_removals WHERE name=?")
                .bind(&reg.name)
                .fetch_optional(&self.store.pool)
                .await?;
        if completed == Some(1) {
            return Ok((reg.agent_id, reg.name));
        }
        for row in sqlx::query("SELECT lease FROM bridge_attempts WHERE phase!='finished'")
            .fetch_all(&self.store.pool)
            .await?
        {
            let lease = pb::RunLease::decode(row.get::<&[u8], _>(0))?;
            ensure!(
                lease
                    .run
                    .as_ref()
                    .is_none_or(|run| run.agent_id != reg.agent_id),
                "Agent has unfinished executions; finish or cancel them before taking it offline"
            );
        }
        sqlx::query("INSERT INTO agent_removals(name,agent_id,request_id) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING").bind(&reg.name).bind(&reg.agent_id).bind(Uuid::new_v4().to_string()).execute(&self.store.pool).await?;
        self.reconnect.notify_one();
        let result = async {
            let url = self
                .store
                .setting("hub_url")
                .await?
                .context("missing saved Hub URL")?;
            let client = self.connect_saved_unlocked(&url).await?;
            self.sync_removal(&client, &reg.name).await
        }
        .await;
        result.with_context(|| format!("down for '{}' was not confirmed; temporary failures stay pending and are retried by reind", reg.name))?;
        Ok((reg.agent_id, reg.name))
    }

    async fn sync_removal(&self, client: &HubClient, name: &str) -> Result<()> {
        let Some(row) = sqlx::query(
            "SELECT agent_id,request_id FROM agent_removals WHERE name=? AND completed=0",
        )
        .bind(name)
        .fetch_optional(&self.store.pool)
        .await?
        else {
            return Ok(());
        };
        let agent_id: String = row.get(0);
        let request_id: String = row.get(1);
        let result = client
            .unregister_agent(pb::UnregisterAgentRequest {
                request_id: request_id.clone(),
                daemon_id: self.daemon_id.clone(),
                agent_id: agent_id.clone(),
            })
            .await;
        if let Err(error) = result {
            if error.downcast_ref::<tonic::Status>().is_some_and(|status| {
                matches!(
                    status.code(),
                    tonic::Code::FailedPrecondition
                        | tonic::Code::PermissionDenied
                        | tonic::Code::InvalidArgument
                        | tonic::Code::Unimplemented
                        | tonic::Code::AlreadyExists
                )
            }) {
                sqlx::query("DELETE FROM agent_removals WHERE name=? AND request_id=?")
                    .bind(name)
                    .bind(&request_id)
                    .execute(&self.store.pool)
                    .await?;
            }
            return Err(error);
        }
        sqlx::query("UPDATE agent_removals SET completed=1 WHERE name=? AND request_id=?")
            .bind(name)
            .bind(&request_id)
            .execute(&self.store.pool)
            .await?;
        eprintln!("reind: agent down name={name:?} agent_id={agent_id}");
        Ok(())
    }

    pub async fn register(
        &self,
        name: String,
        configuration: RegisteredBackend,
        url: String,
        ca: Option<PathBuf>,
        insecure_skip_verify: bool,
    ) -> Result<Registration> {
        let _registration = self.registration_lock.lock().await;
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_removals WHERE name=? AND completed=0")
                .bind(&name)
                .fetch_one(&self.store.pool)
                .await?;
        ensure!(
            pending == 0,
            "Agent has a pending down request; wait for Hub synchronization before bringing it online"
        );
        ensure!(
            ca.is_some() != insecure_skip_verify,
            "choose exactly one of --ca or --insecure-skip-verify"
        );
        let unfinished: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM bridge_attempts WHERE phase!='finished'")
                .fetch_one(&self.store.pool)
                .await?;
        ensure!(
            unfinished == 0,
            "wait for claimed Hub executions before changing registrations"
        );
        ensure!(!self.stop.is_cancelled(), "daemon is stopping");
        ensure!(
            !name.trim().is_empty()
                && name.chars().count() <= 80
                && !name.chars().any(char::is_control),
            "agent name must contain 1–80 visible characters"
        );
        let configuration = match configuration {
            RegisteredBackend::Native { options } => {
                let resolved = options.resolve()?;
                RegisteredBackend::Native {
                    options: NativeRunOptions {
                        provider: resolved.agent.kind,
                        workspace: resolved.agent.workspace,
                        executable: resolved.agent.executable,
                        native_config: resolved.agent.native_config,
                        model: resolved.agent.model,
                        prepare: resolved.agent.prepare,
                    },
                }
            }
            RegisteredBackend::A2a { options } => {
                options.validate()?;
                let card = options
                    .client()?
                    .get_agent_card()
                    .await
                    .context("cannot discover A2A Agent Card")?;
                ensure!(
                    card.supported_interfaces
                        .iter()
                        .any(|interface| interface.protocol_binding.is_jsonrpc()
                            && interface.protocol_version.starts_with("1.")),
                    "A2A registration requires a v1 JSON-RPC interface"
                );
                RegisteredBackend::A2a { options }
            }
        };
        if let Some(old) = self.store.setting("hub_url").await? {
            ensure!(old == url, "use a separate REIN_HOME for a different Hub")
        }
        let client = HubClient::connect_local(
            &url,
            match &ca {
                Some(path) => Some(tokio::fs::read(path).await.context("read Hub CA (--ca)")?),
                None => None,
            },
            insecure_skip_verify,
        )
        .await?;
        let existing = self.configured_registration(&name).await?;
        let registration = Registration {
            name,
            agent_id: existing
                .as_ref()
                .map(|r| r.agent_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            runtime_id: existing
                .as_ref()
                .map(|r| r.runtime_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            configuration,
        };
        ensure!(
            self.active.lock().await.is_empty(),
            "wait for active Hub executions before registering or updating agents"
        );
        let configuration = serde_json::to_string(&registration.configuration)?;
        let changed = existing.as_ref().is_some_and(|old| {
            serde_json::to_string(&old.configuration).ok().as_deref() != Some(&configuration)
        });
        let mut transaction = self.store.pool.begin().await?;
        for (key, value) in [
            ("hub_url", url),
            (
                "hub_ca",
                ca.map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
            ("hub_insecure_skip_verify", insecure_skip_verify.to_string()),
        ] {
            sqlx::query("INSERT INTO bridge_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
                .bind(key).bind(value).execute(&mut *transaction).await?;
        }
        sqlx::query("INSERT INTO registrations VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET configuration=excluded.configuration")
            .bind(&registration.name).bind(&registration.agent_id).bind(&registration.runtime_id).bind(configuration)
            .execute(&mut *transaction).await?;
        sqlx::query("DELETE FROM agent_removals WHERE name=? AND completed=1")
            .bind(&registration.name)
            .execute(&mut *transaction)
            .await?;
        if changed {
            // 配置切换不把旧原生/A2A 上下文悄悄交给另一套运行环境。
            sqlx::query("UPDATE bridge_sessions SET blocked=1 WHERE agent_id=?")
                .bind(&registration.agent_id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        self.publish(&client, &registration).await?;
        self.reconnect.notify_one();
        self.wake.notify_one();
        eprintln!(
            "reind: agent up name={:?} agent_id={}",
            registration.name, registration.agent_id
        );
        Ok(registration)
    }
    async fn connect_saved(&self, url: &str) -> Result<HubClient> {
        let _registration = self.registration_lock.lock().await;
        self.connect_saved_unlocked(url).await
    }

    async fn connect_saved_unlocked(&self, url: &str) -> Result<HubClient> {
        let insecure_skip_verify = self
            .store
            .setting("hub_insecure_skip_verify")
            .await?
            .map(|value| value.parse::<bool>())
            .transpose()?
            .unwrap_or(false);
        let ca = if insecure_skip_verify {
            None
        } else {
            let path = self
                .store
                .setting("hub_ca")
                .await?
                .filter(|path| !path.is_empty())
                .context("missing Hub CA (--ca)")?;
            Some(tokio::fs::read(path).await.context("read Hub CA (--ca)")?)
        };
        HubClient::connect_local(url, ca, insecure_skip_verify).await
    }
    async fn publish(&self, client: &HubClient, reg: &Registration) -> Result<()> {
        let (backend, provider, workspace, capabilities) = match &reg.configuration {
            RegisteredBackend::Native { options } => {
                let resolved = options.clone().resolve()?;
                (
                    pb::BackendKind::Native,
                    options.provider.as_str().to_string(),
                    format!(
                        "{:x}",
                        Sha256::digest(resolved.agent.workspace.to_string_lossy().as_bytes())
                    ),
                    NativeBackend::new(resolved).capabilities().to_vec(),
                )
            }
            RegisteredBackend::A2a { .. } => (
                pb::BackendKind::A2a,
                "a2a".into(),
                format!("a2a:{}", reg.runtime_id),
                vec![
                    "a2a.poll".into(),
                    "a2a.cancel".into(),
                    "a2a.context.resume".into(),
                ],
            ),
        };
        client
            .register_runtime(pb::RegisterRuntimeRequest {
                request_id: reg.runtime_id.clone(),
                runtime: Some(pb::Runtime {
                    id: reg.runtime_id.clone(),
                    daemon_id: self.daemon_id.clone(),
                    workspace_id: workspace,
                    backend: backend as i32,
                    provider,
                    capabilities,
                }),
            })
            .await?;
        client
            .register_agent(pb::RegisterAgentRequest {
                request_id: reg.agent_id.clone(),
                daemon_id: self.daemon_id.clone(),
                agent: Some(pb::Agent {
                    id: reg.agent_id.clone(),
                    name: reg.name.clone(),
                    runtime_id: reg.runtime_id.clone(),
                    ..Default::default()
                }),
            })
            .await?;
        Ok(())
    }
    async fn recover_interrupted(&self) -> Result<()> {
        let rows = sqlx::query("SELECT lease,phase FROM bridge_attempts WHERE phase!='finished'")
            .fetch_all(&self.store.pool)
            .await?;
        for row in rows {
            let lease = pb::RunLease::decode(row.get::<&[u8], _>(0))?;
            let run = lease.run.as_ref().unwrap();
            let phase: String = row.get(1);
            // 尚未进入 Backend 的任务可以确认未执行；其余保持未知且不重跑。
            if phase == "claimed" {
                self.failure(
                    run,
                    "daemon restarted before backend startup; execution was not replayed",
                    true,
                )
                .await?;
                continue;
            }
            self.store.set_setting(&format!("blocked_agent:{}",run.agent_id),"previous execution outcome unknown; inspect and clean up Agent processes before using a new REIN_HOME").await?;
            self.failure(
                run,
                "daemon restarted during execution; result unknown; execution was not replayed",
                false,
            )
            .await?;
        }
        Ok(())
    }
    async fn failure(&self, run: &pb::Run, message: &str, stopped: bool) -> Result<()> {
        let a = pb::AttemptRef {
            run_id: run.id.clone(),
            attempt_id: run.attempt_id.clone(),
        };
        let error = self
            .store
            .append(
                a.clone(),
                ev::Payload::Error(pb::ErrorEvent {
                    code: "daemon_execution".into(),
                    message: message.into(),
                }),
            )
            .await?;
        crate::execution::log_execution_event(&error);
        let result = self
            .store
            .append(
                a,
                ev::Payload::Result(pb::ResultEvent {
                    state: pb::RunState::Failed as i32,
                    execution_stopped: stopped,
                    ..Default::default()
                }),
            )
            .await?;
        crate::execution::log_execution_event(&result);
        self.store.phase(&run.id, "finished").await?;
        self.wake.notify_one();
        Ok(())
    }
    async fn background(&self) {
        if let Err(error) = self.recover_interrupted().await {
            eprintln!("reind: recovery failed: {error:#}");
            return;
        }
        let mut workers = JoinSet::new();
        while !self.stop.is_cancelled() {
            let result = async {
                let Some(url) = self.store.setting("hub_url").await? else {
                    return Ok(());
                };
                let client = self.connect_saved(&url).await?;
                {
                    let _registration = self.registration_lock.lock().await;
                    let removals: Vec<String> =
                        sqlx::query_scalar("SELECT name FROM agent_removals WHERE completed=0")
                            .fetch_all(&self.store.pool)
                            .await?;
                    for name in removals {
                        self.sync_removal(&client, &name).await?;
                    }
                    for reg in self.registrations().await? {
                        self.publish(&client, &reg).await?;
                    }
                }
                self.connected(client, &mut workers).await
            }
            .await;
            if let Err(error) = result {
                eprintln!("reind: Hub connection interrupted: {error:#}")
            }
            tokio::select! {_=self.stop.cancelled()=>break,_=self.wake.notified()=>{},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
        for control in self.active.lock().await.values() {
            control.cancel()
        }
        while let Some(result) = workers.join_next().await {
            if let Err(error) = result {
                eprintln!("reind: execution worker failed: {error}")
            }
        }
        // stop 前再尝试一次投递终态；失败时 outbox 留待下次重连。
        if let Ok(Some(url)) = self.store.setting("hub_url").await {
            let flush = async {
                let client = self.connect_saved(&url).await?;
                self.flush(client).await
            };
            let _: Result<_> = tokio::time::timeout(Duration::from_secs(3), flush)
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("shutdown event flush timed out")));
        }
    }
    async fn flush(&self, client: HubClient) -> Result<()> {
        let (tx, rx) = mpsc::channel(128);
        tx.send(pb::ConnectRequest {
            payload: Some(req::Payload::Hello(pb::Hello {
                daemon_id: self.daemon_id.clone(),
                attempts: self.store.checkpoints().await?,
                commands: vec![],
            })),
        })
        .await?;
        let mut stream = client.event_stream(rx).await?;
        stream.message().await?.context("Hub disconnected")?;
        let events = self.store.pending().await?;
        let count = events.len();
        for event in events {
            tx.send(pb::ConnectRequest {
                payload: Some(req::Payload::Event(event)),
            })
            .await?;
        }
        let mut received = 0;
        while received < count {
            if let Some(frame) = stream.message().await? {
                if let Some(res::Payload::EventAck(ack)) = frame.payload {
                    self.store.ack(&ack).await?;
                    received += 1
                }
            } else {
                break;
            }
        }
        Ok(())
    }
    async fn connected(&self, client: HubClient, workers: &mut JoinSet<()>) -> Result<()> {
        let (tx, rx) = mpsc::channel(128);
        send_frame(
            &tx,
            req::Payload::Hello(pb::Hello {
                daemon_id: self.daemon_id.clone(),
                attempts: self.store.checkpoints().await?,
                commands: vec![],
            }),
        )
        .await?;
        let mut incoming = client.event_stream(rx).await?;
        let first = incoming
            .message()
            .await?
            .context("Hub disconnected before reconciliation")?;
        let Some(res::Payload::Reconcile(reconcile)) = first.payload else {
            bail!("Hub did not reconcile first")
        };
        for ack in reconcile.event_acks {
            self.store.ack(&ack).await?;
        }
        for command in reconcile.pending_commands {
            self.schedule_command(command, tx.clone(), workers).await;
        }
        let mut sent = HashSet::new();
        let mut timer = tokio::time::interval(Duration::from_millis(250));
        let mut heartbeat = tokio::time::Instant::now() - Duration::from_secs(5);
        let mut claim = true;
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return Ok(()),
                _ = self.reconnect.notified() => return Ok(()),
                Some(worker) = workers.join_next(), if !workers.is_empty() => {
                    worker.context("execution worker panicked")?;
                    claim = true;
                }
                _ = timer.tick() => {
                    let mut batch = 0;
                    for event in self.store.pending().await? {
                        let attempt = event.attempt.as_ref().unwrap();
                        if sent.insert((attempt.run_id.clone(), event.sequence)) {
                            send_frame(&tx, req::Payload::Event(event)).await?;
                            batch += 1;
                            if batch == 32 { break; }
                        }
                    }
                    if heartbeat.elapsed() > Duration::from_secs(3) {
                        let regs = self.registrations().await?;
                        send_frame(&tx, req::Payload::Heartbeat(pb::Heartbeat {
                            runtime_ids: regs.iter().map(|r| r.runtime_id.clone()).collect(),
                            available_capacity: self.execution.available_capacity() as u32,
                        })).await?;
                        heartbeat = tokio::time::Instant::now();
                    }
                    if claim && self.execution.available_capacity() > 0 {
                        claim = false;
                        self.claim_available(&client, workers).await?;
                    }
                }
                frame = incoming.message() => {
                    let frame = frame?.context("Hub event stream closed")?;
                    match frame.payload {
                        Some(res::Payload::EventAck(ack)) => {
                            self.store.ack(&ack).await?;
                            if let Some(attempt) = &ack.attempt {
                                sent.retain(|(id, sequence)| id != &attempt.run_id || *sequence > ack.through_sequence);
                            }
                        }
                        Some(res::Payload::Command(command)) => self.schedule_command(command, tx.clone(), workers).await,
                        Some(res::Payload::WorkAvailable(_)) => claim = true,
                        Some(res::Payload::Reconcile(reconcile)) => {
                            for ack in reconcile.event_acks { self.store.ack(&ack).await?; }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    async fn claim_available(&self, client: &HubClient, workers: &mut JoinSet<()>) -> Result<()> {
        let _registration = self.registration_lock.lock().await;
        let regs = self.registrations().await?;
        if regs.is_empty() {
            return Ok(());
        }
        let pending = match self.store.setting("pending_claim").await? {
            Some(json) if !json.is_empty() => serde_json::from_str(&json)?,
            _ => {
                let request = pb::ClaimRunsRequest {
                    request_id: Uuid::new_v4().to_string(),
                    daemon_id: self.daemon_id.clone(),
                    runtime_ids: regs.iter().map(|r| r.runtime_id.clone()).collect(),
                    capacity: self.execution.available_capacity() as u32,
                };
                let bytes = request.encode_to_vec();
                self.store
                    .set_setting("pending_claim", &serde_json::to_string(&bytes)?)
                    .await?;
                bytes
            }
        };
        let request = pb::ClaimRunsRequest::decode(pending.as_slice())?;
        for lease in client.claim_runs(request).await?.leases {
            let run = lease
                .run
                .as_ref()
                .context("Hub returned lease without run")?;
            let reg = regs
                .iter()
                .find(|r| r.runtime_id == run.runtime_id)
                .cloned()
                .context("Hub returned unknown runtime")?;
            let backend = match reg.configuration {
                RegisteredBackend::Native { .. } => "native",
                RegisteredBackend::A2a { .. } => "a2a",
            };
            if !self.store.prepare(&lease, backend).await? {
                continue;
            }
            let runtime = self.clone();
            workers.spawn(async move {
                let id = run_id(&lease);
                if let Err(error) = runtime.execute(reg, lease.clone()).await
                    && let Some(run) = &lease.run
                    && let Err(save_error) =
                        runtime.failure(run, &format!("{error:#}"), false).await
                {
                    eprintln!("reind: cannot persist execution failure: {save_error:#}");
                }
                runtime.active.lock().await.remove(&id);
                runtime.wake.notify_one();
            });
        }
        self.store.set_setting("pending_claim", "").await?;
        Ok(())
    }

    async fn schedule_command(
        &self,
        command: pb::ControlCommand,
        tx: mpsc::Sender<pb::ConnectRequest>,
        workers: &mut JoinSet<()>,
    ) {
        if !self
            .commands_inflight
            .lock()
            .await
            .insert(command.command_id.clone())
        {
            return;
        }
        let runtime = self.clone();
        workers.spawn(async move {
            if let Err(error) = runtime.handle_command(command.clone(), &tx).await {
                eprintln!("reind: command delivery interrupted: {error:#}");
            }
            runtime
                .commands_inflight
                .lock()
                .await
                .remove(&command.command_id);
        });
    }

    async fn handle_command(
        &self,
        command: pb::ControlCommand,
        tx: &mpsc::Sender<pb::ConnectRequest>,
    ) -> Result<()> {
        let a = command
            .attempt
            .as_ref()
            .context("command missing attempt")?;
        let bytes = command.encode_to_vec();
        sqlx::query("INSERT OR IGNORE INTO command_inbox VALUES(?,?,?,?,0)")
            .bind(&command.command_id)
            .bind(&a.run_id)
            .bind(&a.attempt_id)
            .bind(&bytes)
            .execute(&self.store.pool)
            .await?;
        let original: Vec<u8> =
            sqlx::query_scalar("SELECT payload FROM command_inbox WHERE command_id=?")
                .bind(&command.command_id)
                .fetch_one(&self.store.pool)
                .await?;
        ensure!(original == bytes, "command_id conflict");
        let previous: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT ack FROM command_results WHERE command_id=?")
                .bind(&command.command_id)
                .fetch_optional(&self.store.pool)
                .await?;
        let ack = if let Some(bytes) = previous {
            pb::CommandAck::decode(bytes.as_slice())?
        } else {
            let control = self.active.lock().await.get(&a.run_id).cloned();
            let result = if let Some(control) = control {
                control.command(&command).await
            } else {
                Err(anyhow::anyhow!("execution is no longer active"))
            };
            let ack = match result {
                Ok(ack) => ack,
                Err(_) => pb::CommandAck {
                    command_id: command.command_id.clone(),
                    attempt: command.attempt.clone(),
                    state: pb::CommandAckState::Rejected as i32,
                    error_code: "control_rejected".into(),
                },
            };
            sqlx::query("INSERT INTO command_results VALUES(?,?)")
                .bind(&command.command_id)
                .bind(ack.encode_to_vec())
                .execute(&self.store.pool)
                .await?;

            ack
        };
        tx.send(pb::ConnectRequest {
            payload: Some(req::Payload::CommandAck(ack)),
        })
        .await?;
        Ok(())
    }
    async fn execute(&self, reg: Registration, lease: pb::RunLease) -> Result<()> {
        let run = lease.run.as_ref().context("missing run")?;
        let attempt = pb::AttemptRef {
            run_id: run.id.clone(),
            attempt_id: run.attempt_id.clone(),
        };
        if let Some(reason) = self
            .store
            .setting(&format!("blocked_agent:{}", run.agent_id))
            .await?
        {
            bail!("{reason}")
        }
        let row=sqlx::query("SELECT agent_id,native_id,a2a_context_id,blocked FROM bridge_sessions WHERE session_id=?").bind(&run.session_id).fetch_one(&self.store.pool).await?;
        ensure!(
            row.get::<String, _>(0) == run.agent_id,
            "session belongs to another agent"
        );
        ensure!(
            row.get::<i64, _>(3) == 0,
            "session cannot safely resume after an unknown execution or configuration change; start a new conversation"
        );
        let native_id: Option<String> = row.get(1);
        let context_id: Option<String> = row.get(2);
        let (mut backend, control, workspace): (Box<dyn Backend>, ActiveControl, Option<PathBuf>) =
            match reg.configuration {
                RegisteredBackend::Native { options } => {
                    let options = options.resolve()?;
                    let workspace = Some(options.agent.workspace.clone());
                    let mut backend = NativeBackend::new(options);
                    backend.restore_native_id(native_id);
                    backend.prepare(attempt.clone());
                    let control = ActiveControl::Native(backend.control_handle());
                    (Box::new(backend), control, workspace)
                }
                RegisteredBackend::A2a { options } => {
                    let backend = A2aBackend::new(options, attempt.clone(), context_id);
                    let control = ActiveControl::A2a(backend.control_handle());
                    (Box::new(backend), control, None)
                }
            };
        let _permit = self.execution.reserve(workspace)?;
        self.active
            .lock()
            .await
            .insert(run.id.clone(), control.clone());
        let start = self
            .store
            .append(
                attempt.clone(),
                ev::Payload::State(pb::StateEvent {
                    state: pb::RunState::Running as i32,
                }),
            )
            .await?;
        self.wake.notify_one();
        while self.store.acknowledged(&attempt).await? < start.sequence {
            if self.stop.is_cancelled() {
                control.cancel();
                return self
                    .failure(
                        run,
                        "daemon stopped before startup acknowledgement; execution was not started",
                        true,
                    )
                    .await;
            };
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.store.phase(&run.id, "executing").await?;
        crate::execution::log_execution_event(&start);
        let (tx, mut rx) = mpsc::channel(32);
        let mut ended = false;
        {
            let future = backend.execute(&lease, tx);
            tokio::pin!(future);
            let mut open = true;
            loop {
                tokio::select! {
                 biased;
                 event=rx.recv(),if open=>match event{Some(event)=>{ended|=event.result_terminal();self.save_event(run,&control,event).await?},None=>open=false},
                 result=&mut future=>{while let Ok(event)=rx.try_recv(){ended|=event.result_terminal();self.save_event(run,&control,event).await?}result?;break},
                }
            }
        }
        ensure!(ended, "backend returned without terminal result");
        self.store.phase(&run.id, "finished").await?;
        Ok(())
    }
    async fn save_event(
        &self,
        run: &pb::Run,
        control: &ActiveControl,
        event: pb::ExecutionEvent,
    ) -> Result<()> {
        let (native, context, task) = control.references();
        sqlx::query("UPDATE bridge_sessions SET native_id=COALESCE(?,native_id),a2a_context_id=COALESCE(?,a2a_context_id) WHERE session_id=?").bind(&native).bind(&context).bind(&run.session_id).execute(&self.store.pool).await?;
        sqlx::query("UPDATE execution_mapping SET native_session_id=?,a2a_context_id=?,a2a_task_id=? WHERE run_id=? AND attempt_id=?").bind(native).bind(context).bind(task).bind(&run.id).bind(&run.attempt_id).execute(&self.store.pool).await?;
        if let Some(result) = event.payload.as_ref().and_then(|p| match p {
            ev::Payload::Result(r) => Some(r),
            _ => None,
        }) && !result.execution_stopped
        {
            sqlx::query("UPDATE bridge_sessions SET blocked=1 WHERE session_id=?")
                .bind(&run.session_id)
                .execute(&self.store.pool)
                .await?;
        }
        let saved = self
            .store
            .append(
                pb::AttemptRef {
                    run_id: run.id.clone(),
                    attempt_id: run.attempt_id.clone(),
                },
                event.payload.context("backend emitted empty payload")?,
            )
            .await?;
        crate::execution::log_execution_event(&saved);
        self.wake.notify_one();
        Ok(())
    }
}
fn run_id(lease: &pb::RunLease) -> String {
    lease.run.as_ref().map(|r| r.id.clone()).unwrap_or_default()
}
trait EventExt {
    fn result_terminal(&self) -> bool;
}
impl EventExt for pb::ExecutionEvent {
    fn result_terminal(&self) -> bool {
        matches!(self.payload, Some(ev::Payload::Result(_)))
    }
}

async fn send_frame(tx: &mpsc::Sender<pb::ConnectRequest>, payload: req::Payload) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(5),
        tx.send(pb::ConnectRequest {
            payload: Some(payload),
        }),
    )
    .await
    .context("Hub writer stalled")??;
    Ok(())
}
