use a2alinker::{
    AgentKind, Options,
    native::{AdapterContext, JsonlProcess},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub(crate) struct ForkPoint {
    pub native_session: String,
    pub item: String,
    pub answer: String,
    pub started: u64,
    pub finished: Option<u64>,
    pub timestamp: String,
    pub directory: Option<PathBuf>,
}

pub(crate) async fn create(
    options: Options,
    point: ForkPoint,
    runtime: PathBuf,
    id: String,
) -> Result<(String, PathBuf)> {
    match options.agent.kind {
        AgentKind::Codex => tokio::time::timeout(Duration::from_secs(20), codex(options, &point))
            .await
            .context("Codex 创建侧边对话超时")?,
        AgentKind::Pi => tokio::task::spawn_blocking(move || pi(&point, &runtime, &id)).await?,
    }
}

async fn codex(options: Options, point: &ForkPoint) -> Result<(String, PathBuf)> {
    let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    args.extend(options.agent.args.clone());
    let context = AdapterContext {
        options: Arc::new(options),
    };
    let mut process = JsonlProcess::spawn(&context, &args)?;
    process
        .request(
            "initialize",
            json!({"clientInfo":{"name":"rein","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),
            false,
        )
        .await?;
    process
        .send(json!({"method":"initialized","params":{}}))
        .await?;
    let workspace = if let Some(directory) = &point.directory {
        workspace_path(directory)?
    } else {
        let result = process
            .request(
                "thread/read",
                json!({"threadId":point.native_session,"includeTurns":false}),
                false,
            )
            .await?;
        let directory = result["thread"]["cwd"]
            .as_str()
            .context("Codex 原生会话没有保存工作目录")?;
        workspace_path(Path::new(directory))?
    };
    let mut cursor = Value::Null;
    let anchor =
        loop {
            let page = process.request("thread/turns/list", json!({
            "threadId":point.native_session,"cursor":cursor,"limit":10,"itemsView":"full"
        }), false).await?;
            let turns = page["data"].as_array().context("Codex 未返回会话轮次")?;
            if let Some(turn) = turns.iter().find(|turn| {
                turn["items"].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["type"] == "agentMessage" && item["id"] == point.item)
                })
            }) {
                ensure!(turn["status"] == "completed", "只能从已完成的回复分叉");
                break turn["id"]
                    .as_str()
                    .context("Codex 回复缺少轮次 ID")?
                    .to_owned();
            }
            let next = &page["nextCursor"];
            ensure!(
                next.as_str().is_some_and(|value| !value.is_empty()) && *next != cursor,
                "Codex 无法定位这条回复"
            );
            cursor = next.clone();
        };
    let result = process
        .request(
            "thread/fork",
            json!({"threadId":point.native_session,
                "lastTurnId":anchor,"cwd":workspace,"excludeTurns":true,"deferGoalContinuation":true,
                "sandbox":context.options.agent.sandbox,
                "approvalPolicy":context.options.agent.approval_policy,
                "approvalsReviewer":context.options.agent.approvals_reviewer}),
            false,
        )
        .await?;
    let id = result["thread"]["id"]
        .as_str()
        .filter(|id| *id != point.native_session)
        .context("Codex 未创建独立会话")?
        .to_owned();
    let tail = process
        .request(
            "thread/turns/list",
            json!({"threadId":id,"limit":1,
        "sortDirection":"desc","itemsView":"notLoaded"}),
            false,
        )
        .await;
    if !tail
        .as_ref()
        .is_ok_and(|page| page["data"][0]["id"] == anchor)
    {
        let _ = process
            .request("thread/archive", json!({"threadId":id}), false)
            .await;
        anyhow::bail!("Codex 未能在所选回复处截断历史");
    }
    process.shutdown().await?;
    Ok((id, workspace))
}

fn workspace_path(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute() && path.is_dir(), "原会话工作目录不可用");
    Ok(path.canonicalize()?)
}

fn pi(point: &ForkPoint, runtime: &Path, id: &str) -> Result<(String, PathBuf)> {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let source = Path::new(&point.native_session);
    ensure!(
        source.is_absolute() && source.extension().is_some_and(|part| part == "jsonl"),
        "Pi 会话路径无效"
    );
    let file = File::from(rustix::fs::open(
        source,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= LIMIT,
        "Pi 会话文件不可读取或过大"
    );
    let mut lines = BufReader::new(file.take(LIMIT + 1)).lines();
    let mut header: Value = serde_json::from_str(&lines.next().context("Pi 会话为空")??)?;
    ensure!(
        header["type"] == "session" && matches!(header["version"].as_u64(), Some(2 | 3)),
        "Pi 会话格式不支持分叉"
    );
    let workspace = workspace_path(Path::new(
        header["cwd"].as_str().context("Pi 会话缺少工作目录")?,
    ))?;
    if let Some(directory) = &point.directory {
        ensure!(
            workspace_path(directory)? == workspace,
            "Pi 会话工作目录已变更"
        );
    }
    let finished = point.finished.context("原消息缺少结束时间")?;
    let mut entries = HashMap::new();
    let mut anchor = None;
    for line in lines {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: Value = serde_json::from_str(&line)?;
        let key = entry["id"]
            .as_str()
            .context("Pi 会话条目缺少 ID")?
            .to_owned();
        let message = &entry["message"];
        if entry["type"] == "message"
            && message["role"] == "assistant"
            && message["timestamp"]
                .as_u64()
                .is_some_and(|time| time >= point.started && time <= finished)
            && message["content"].as_array().is_some_and(|content| {
                content
                    .iter()
                    .filter(|part| part["type"] == "text")
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
                    == point.answer
            })
        {
            anchor = Some(key.clone());
        }
        ensure!(
            entries.insert(key, entry).is_none(),
            "Pi 会话的条目 ID 重复"
        );
    }
    let mut key = anchor.context("Pi 无法定位这条回复")?;
    let mut path = Vec::new();
    loop {
        let entry = entries.remove(&key).context("Pi 会话路径不完整")?;
        let parent = entry["parentId"].as_str().map(str::to_owned);
        path.push(entry);
        let Some(parent) = parent else { break };
        key = parent;
    }
    // Keep Pi's native entry tree and compaction metadata, changing only the session identity.
    header["id"] = json!(id);
    header["parentSession"] = json!(source);
    header["timestamp"] = json!(point.timestamp);
    let directory = runtime.join("fork-sessions");
    fs::create_dir_all(&directory)?;
    ensure!(
        fs::symlink_metadata(&directory)?.is_dir(),
        "侧边对话目录不可用"
    );
    let filename = directory.join(format!("{id}.jsonl"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&filename)?;
    let written = (|| -> Result<()> {
        for entry in std::iter::once(&header).chain(path.iter().rev()) {
            serde_json::to_writer(&mut file, entry)?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&filename);
    }
    written?;
    Ok((filename.to_string_lossy().into_owned(), workspace))
}
