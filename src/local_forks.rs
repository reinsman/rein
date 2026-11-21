use super::{LocalRuntime, RunRecord};
use crate::execution::{
    LocalRun,
    fork::{self, ForkPoint},
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Serialize)]
pub(crate) struct ChatFork {
    pub id: String,
    pub source_session_id: String,
    pub source_run_id: String,
    pub title: Option<String>,
    pub message_count: i64,
}

impl LocalRuntime {
    pub(super) async fn fork_directory(&self, session: Option<&str>) -> Result<Option<PathBuf>> {
        let Some(session) = session else {
            return Ok(None);
        };
        let row: Option<(String, bool)> =
            sqlx::query_as("SELECT working_directory,deleted FROM local_chat_forks WHERE id=?")
                .bind(session)
                .fetch_optional(&self.store.pool)
                .await?;
        if let Some((directory, deleted)) = row {
            ensure!(!deleted, "侧边对话已删除");
            return Ok(Some(directory.into()));
        }
        Ok(None)
    }

    pub(crate) async fn chat_forks(&self, session: &str) -> Result<Vec<ChatFork>> {
        let rows: Vec<(String, String, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT f.id,f.source_session_id,f.source_run_id,
                (SELECT r.prompt FROM local_runs r WHERE r.session_id=f.id ORDER BY r.rowid LIMIT 1) AS title,
                (SELECT COALESCE(SUM(1 + EXISTS (SELECT 1 FROM local_events e
                    WHERE e.run_id=r.id AND json_extract(e.payload,'$.event.type')='text'
                    AND json_extract(e.payload,'$.event.complete')=1
                    AND COALESCE(json_extract(e.payload,'$.event.reasoning'),0)=0
                    AND length(json_extract(e.payload,'$.event.text'))>0)),0)
                 FROM local_runs r WHERE r.session_id=f.id) AS message_count
             FROM local_chat_forks f WHERE f.source_session_id=? AND f.deleted=0
             AND EXISTS (SELECT 1 FROM local_runs r WHERE r.session_id=f.id) ORDER BY f.rowid",
        ).bind(session).fetch_all(&self.store.pool).await?;
        Ok(rows
            .into_iter()
            .map(
                |(id, source_session_id, source_run_id, title, message_count)| ChatFork {
                    id,
                    source_session_id,
                    source_run_id,
                    title,
                    message_count,
                },
            )
            .collect())
    }

    pub(crate) async fn submit_chat_fork(
        &self,
        source: &str,
        prompt: String,
        request_id: String,
    ) -> Result<(ChatFork, LocalRun)> {
        let _guard = self.operations.lock().await;
        self.validate_run_request(&prompt, &request_id)?;
        let record = self.get(source, 0).await?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM local_chat_forks WHERE source_session_id=? AND source_run_id=? AND deleted=0",
        ).bind(&record.run.session_id).bind(source).fetch_optional(&self.store.pool).await?;
        let new = existing.is_none();
        let id = match existing {
            Some(id) => id,
            None => self.create_chat_fork(&record).await?,
        };
        let run = self
            .start_in_directory_locked(record.agent_id, Some(id.clone()), prompt, request_id, None)
            .await;
        if run.is_err() && new {
            self.delete_chat_fork_locked(&id).await?;
        }
        let run = run?;
        let fork = self
            .chat_forks(&record.run.session_id)
            .await?
            .into_iter()
            .find(|fork| fork.id == id)
            .context("已提交侧边对话，但暂时无法读取状态")?;
        Ok((fork, run))
    }

    async fn create_chat_fork(&self, record: &RunRecord) -> Result<String> {
        let run = &record.run;
        let source = &run.run_id;
        ensure!(
            run.state == "completed" && !run.fork && run.native != Some(false),
            "只能从主栏中已经完成的原生 Agent 回复分叉"
        );
        let id = Uuid::new_v4().to_string();
        let native = run.native_session_id.as_ref().context("无法识别原生会话")?;
        let mut config = self.agents.get(&record.agent_id)?;
        ensure!(
            config.a2a.is_none() && config.provider.name() == run.provider,
            "原会话的 Agent 类型已更改"
        );
        ensure!(config.enabled, "Agent 已下线，请上线后再发送消息");
        self.ensure_idle(&record.agent_id).await?;
        let (saved_hash, started): (String, i64) = sqlx::query_as(
            "SELECT s.config_hash, CAST(strftime('%s',r.created_at) AS INTEGER)*1000 +
                CAST(substr(strftime('%f',r.created_at),4,3) AS INTEGER)
             FROM local_runs r JOIN local_sessions s ON s.id=r.session_id WHERE r.id=?",
        )
        .bind(source)
        .fetch_one(&self.store.pool)
        .await?;
        let provider = config.provider;
        let independent_key = format!("native:{}", provider.name());
        let default_key = format!("{independent_key}:default");
        let independent = if saved_hash == independent_key {
            true
        } else if saved_hash == default_key {
            false
        } else {
            self.agents.independent_config(provider)?
        };
        let hash = if independent {
            config.native_config = Some(
                self.agents
                    .prepare_type(provider, config.native_config.as_deref())?,
            );
            independent_key
        } else {
            config.native_config = None;
            default_key
        };
        // The startup directory for looking up a legacy thread is never used as its fork's workspace.
        config.directory = Some(
            run.working_directory
                .clone()
                .unwrap_or_else(|| self.directory.clone()),
        );
        if config.permissions.is_none() {
            config.permissions = Some(self.agents.default_permissions(provider)?);
        }
        let answer = record
            .events
            .iter()
            .rev()
            .map(|event| &event.event)
            .find(|event| {
                event["type"] == "text"
                    && event["complete"] == true
                    && event["reasoning"] != true
                    && event["text"].as_str().is_some_and(|text| !text.is_empty())
            })
            .context("原消息没有可以分叉的回复")?;
        let point = ForkPoint {
            native_session: native.clone(),
            item: answer["item_id"]
                .as_str()
                .context("原消息缺少定位标识")?
                .to_owned(),
            answer: answer["text"].as_str().unwrap().to_owned(),
            started: started.try_into()?,
            finished: run.finished_at,
            timestamp: record.created_at.clone(),
            directory: run.working_directory.clone(),
        };
        let (forked, workspace) = fork::create(
            config.native_options(&self.directory)?.resolve()?,
            point,
            self.directory.clone(),
            id.clone(),
        )
        .await?;
        let mut transaction = self.store.pool.begin().await?;
        sqlx::query(
            "INSERT INTO local_sessions (id,agent_id,config_hash,native_id) VALUES (?,?,?,?)",
        )
        .bind(&id)
        .bind(&record.agent_id)
        .bind(hash)
        .bind(forked)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("INSERT INTO local_chat_forks (id,source_session_id,source_run_id,working_directory) VALUES (?,?,?,?)")
            .bind(&id).bind(&run.session_id).bind(source).bind(workspace.to_str().context("工作目录必须为 UTF-8")?)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(id)
    }

    pub(crate) async fn fork_context(
        &self,
        source: &str,
        before: Option<i64>,
    ) -> Result<(Vec<RunRecord>, Option<i64>)> {
        let (session, cutoff): (String, i64) =
            sqlx::query_as("SELECT session_id,rowid FROM local_runs WHERE id=?")
                .bind(source)
                .fetch_optional(&self.store.pool)
                .await?
                .context("原消息不存在")?;
        let rows: Vec<(i64,String)> = sqlx::query_as(
            "SELECT rowid,id FROM local_runs WHERE session_id=? AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT 21",
        ).bind(session).bind(cutoff).bind(before.unwrap_or(i64::MAX)).fetch_all(&self.store.pool).await?;
        let next = (rows.len() > 20).then(|| rows[19].0);
        let mut context = Vec::new();
        for (_, id) in rows.iter().take(20).rev() {
            context.push(self.get(id, 0).await?);
        }
        Ok((context, next))
    }

    pub(crate) async fn delete_chat_fork(&self, id: &str) -> Result<()> {
        Uuid::parse_str(id).context("侧边对话 ID 无效")?;
        let _guard = self.operations.lock().await;
        self.delete_chat_fork_locked(id).await
    }

    async fn delete_chat_fork_locked(&self, id: &str) -> Result<()> {
        let mut transaction = self.store.pool.begin().await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_chat_forks WHERE id=?)")
                .bind(id)
                .fetch_one(&mut *transaction)
                .await?;
        ensure!(exists, "侧边对话不存在");
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_runs WHERE session_id=? AND json_extract(snapshot,'$.state') NOT IN ('completed','cancelled','failed'))")
            .bind(id).fetch_one(&mut *transaction).await?;
        ensure!(!active, "请先停止侧边对话中的执行，再删除");
        for statement in [
            "DELETE FROM local_commands WHERE run_id IN (SELECT id FROM local_runs WHERE session_id=?)",
            "DELETE FROM local_events WHERE run_id IN (SELECT id FROM local_runs WHERE session_id=?)",
            "DELETE FROM local_runs WHERE session_id=?",
            "DELETE FROM local_sessions WHERE id=?",
            "UPDATE local_chat_forks SET deleted=1 WHERE id=?",
        ] {
            sqlx::query(statement)
                .bind(id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        let native = self
            .directory
            .join("fork-sessions")
            .join(format!("{id}.jsonl"));
        let _ = std::fs::remove_file(native);
        Ok(())
    }
}
