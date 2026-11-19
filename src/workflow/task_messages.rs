use super::*;
use crate::local::terminal;

impl TaskMessage {
    pub(super) fn new(task: &QueueTask, kind: &str, key: &str, content: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            event_key: format!("{}:{}:{kind}:{key}", task.id, task.attempt),
            requirement_id: task.requirement_id.clone(),
            spec_id: task.spec_id.clone(),
            task_id: task.id.clone(),
            run_id: task.run_id.clone().or(task.last_run_id.clone()),
            agent_id: task.agent_id.clone().unwrap_or_default(),
            kind: kind.into(),
            content,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            handoff: task.handoffs.last().map(|handoff| handoff.file.clone()),
            update_request_id: (kind == "completed" && task.spec_id.is_some())
                .then(|| Uuid::new_v4().to_string()),
            update_done: false,
            update_error: None,
        }
    }
}

impl Workflow {
    pub(super) fn publish_task_message(state: &mut Snapshot, message: TaskMessage) {
        if !state
            .messages
            .iter()
            .any(|existing| existing.event_key == message.event_key)
        {
            state.messages.push(message);
        }
    }

    pub async fn retry_task_update(&self, id: &str) -> Result<()> {
        self.edit(|state| {
            let message = state
                .messages
                .iter_mut()
                .find(|message| message.id == id)
                .context("Task message not found")?;
            ensure!(
                message.update_error.is_some() && message.update_request_id.is_some(),
                "document update has not failed"
            );
            message.update_request_id = Some(Uuid::new_v4().to_string());
            message.update_error = None;
            Ok(())
        })
        .await
    }

    pub(super) async fn update_task_documents(&self) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let Some(index) = state.messages.iter().position(|message| {
            state.tasks.iter().any(|task| task.id == message.task_id)
                && message.update_request_id.is_some()
                && !message.update_done
                && message.update_error.is_none()
        }) else {
            return Ok(());
        };
        let message = state.messages[index].clone();
        let request_id = message.update_request_id.clone().unwrap();
        let spec = state
            .specs
            .iter()
            .find(|spec| Some(&spec.id) == message.spec_id.as_ref())
            .context("Spec not found")?
            .clone();
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM local_runs WHERE request_id=?")
                .bind(&request_id)
                .fetch_optional(&self.local.store.pool)
                .await?;
        let record = if let Some(id) = existing {
            self.local.get(&id, 0).await?
        } else {
            let selected = state.settings.main_agent.clone();
            let available = selected.as_ref().is_some_and(|agent| {
                self.local
                    .agents
                    .get(agent)
                    .is_ok_and(|agent| agent.enabled)
            });
            if !available {
                let task = state
                    .tasks
                    .iter()
                    .find(|task| task.id == message.task_id)
                    .context("Task not found")?;
                let mut report = TaskMessage::new(
                    task,
                    "document_waiting",
                    &request_id,
                    "@用户，tasks.md 等待同步，请先配置并上线主 Agent；可用后会自动继续。".into(),
                );
                report.event_key = format!("document_waiting:{request_id}");
                Self::publish_task_message(&mut state, report);
                if state.messages.len() != guard.messages.len() {
                    self.commit(&state).await?;
                    *guard = state;
                }
                return Ok(());
            }
            let agent = selected.unwrap();
            let busy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_runs WHERE agent_id=? AND json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled')")
                .bind(&agent).fetch_one(&self.local.store.pool).await?;
            if busy > 0 {
                return Ok(());
            }
            let (project, _) = self.requirement(&spec.requirement_id)?;
            let directory = project
                .preferred_directory
                .or(project.directories.first().cloned())
                .context("configure a project working directory first")?;
            let target = self.spec_dir(&spec).join("tasks.md");
            let task = state
                .tasks
                .iter()
                .find(|task| task.id == message.task_id)
                .context("Task not found")?;
            let checklist: Vec<_> = spec
                .plan
                .tasks
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let completed = state
                        .tasks
                        .iter()
                        .find(|task| {
                            task.spec_id.as_deref() == Some(&spec.id)
                                && task.plan_id.as_deref() == Some(&item.id)
                                && task.role == Role::Coding
                        })
                        .is_some_and(|task| {
                            task.status == TaskStatus::Done
                                && task
                                    .result
                                    .as_ref()
                                    .is_some_and(|result| result.outcome == "passed")
                        });
                    serde_json::json!({"id":item.id,"index":index+1,"checked":completed})
                })
                .collect();
            let verification: Vec<_> = if spec.round > 0 {
                spec.plan
                    .criteria
                    .iter()
                    .map(|criterion| {
                        let outcome = state
                            .tasks
                            .iter()
                            .find(|task| {
                                task.spec_id.as_deref() == Some(&spec.id)
                                    && task.criterion_id.as_deref() == Some(&criterion.id)
                                    && task.round == spec.round
                                    && task.role == Role::Review
                            })
                            .filter(|task| task.status == TaskStatus::Done)
                            .and_then(|task| task.result.as_ref())
                            .map_or("pending", |result| result.outcome.as_str());
                        serde_json::json!({"id":criterion.id,"outcome":outcome})
                    })
                    .collect()
            } else {
                vec![]
            };
            let payload = serde_json::json!({"tasks_file":target,"spec_id":spec.id,"definition_revision":self.document_revision(&spec)?,"report":message.content,"handoff":message.handoff.as_ref().map(|file| self.spec_dir(&spec).join(file)),"checklist":checklist,"verification":verification});
            let prompt = format!(
                "REIN SPEC TASK UPDATE\nUse the installed rein-spec skill. This is document synchronization, not execution or planning; this request supersedes older planning-only skill restrictions. The task runtime posted this executing Agent's report to the requirement group. Read requirements.md, tasks.md and the referenced handoff in {}. Update ONLY tasks.md, atomically. Synchronize checkbox states to the authoritative checklist snapshot below: count non-empty checklist items top to bottom outside fenced code blocks, verify each ID before changing it. This snapshot may be newer than the original report; never infer execution status from existing checkboxes. For each verification snapshot item, upsert '- AC-ID: passed|failed|pending — evidence' under a final '## Verification Results' section. Preserve task IDs, titles, order, descriptions and acceptance links. Do not change requirements, design, planning state or queue status. Do not run implementation or continue any task. Summarize actual document changes in the user's language.\nTASK_UPDATE_JSON: {}",
                self.spec_dir(&spec).display(),
                payload
            );
            match self
                .local
                .start_in_directory(
                    agent.clone(),
                    None,
                    prompt,
                    request_id.clone(),
                    Some(directory),
                )
                .await
            {
                Ok(run) => self.local.get(&run.run_id, 0).await?,
                Err(error)
                    if error.to_string().contains("active execution")
                        || error.to_string().contains("capacity reached")
                        || error.to_string().contains("agent is running") =>
                {
                    return Ok(());
                }
                Err(error) => {
                    state.messages[index].update_error = Some(format!("{error:#}"));
                    let mut report = TaskMessage::new(
                        task,
                        "update_failed",
                        &request_id,
                        format!("@用户，tasks.md 更新未能启动：{error:#}。可重试文档同步。"),
                    );
                    report.agent_id = agent;
                    Self::publish_task_message(&mut state, report);
                    self.commit(&state).await?;
                    *guard = state;
                    return Ok(());
                }
            }
        };
        if matches!(
            record.run.state.as_str(),
            "waiting_input" | "waiting_approval"
        ) {
            if let Some(event) = record
                .events
                .iter()
                .rev()
                .find(|event| event.event["type"] == "interaction")
            {
                let task = state
                    .tasks
                    .iter()
                    .find(|task| task.id == message.task_id)
                    .context("Task not found")?;
                let key = format!(
                    "{request_id}:{}",
                    event.event["interaction_id"].as_str().unwrap_or("")
                );
                let mut report = TaskMessage::new(
                    task,
                    "update_waiting",
                    &key,
                    "@用户，更新 tasks.md 需要审批或回复，请处理下方主 Agent 的交互请求。".into(),
                );
                report.agent_id = record.agent_id.clone();
                report.event_key = format!("update_waiting:{key}");
                report.run_id = Some(record.run.run_id.clone());
                Self::publish_task_message(&mut state, report);
            }
        }
        if terminal(&record.run.state) {
            let result = if record.run.state == "completed" {
                self.validate_task_update(&spec, &record.prompt)
            } else {
                Err(anyhow::anyhow!(record.run.error.unwrap_or_else(|| {
                    "main Agent execution did not complete".into()
                })))
            };
            let task = state
                .tasks
                .iter()
                .find(|task| task.id == message.task_id)
                .unwrap();
            let mut report = match result {
                Ok(()) => {
                    state.messages[index].update_done = true;
                    let summary = record
                        .events
                        .iter()
                        .filter(|event| {
                            event.event["type"] == "text"
                                && event.event["reasoning"] != true
                                && event.event["complete"] == true
                        })
                        .filter_map(|event| event.event["text"].as_str())
                        .last()
                        .unwrap_or("已根据执行结果更新 tasks.md。");
                    TaskMessage::new(task, "document_updated", &request_id, summary.to_owned())
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    state.messages[index].update_error = Some(error.clone());
                    TaskMessage::new(
                        task,
                        "update_failed",
                        &request_id,
                        format!("@用户，tasks.md 更新失败：{error}。可重试文档同步。"),
                    )
                }
            };
            report.agent_id = record.agent_id;
            Self::publish_task_message(&mut state, report);
        }
        if serde_json::to_vec(&*guard)? != serde_json::to_vec(&state)? {
            self.commit(&state).await?;
            *guard = state;
        }
        Ok(())
    }

    fn validate_task_update(&self, spec: &Spec, prompt: &str) -> Result<()> {
        let tasks = read_text(&self.spec_dir(spec).join("tasks.md"))?;
        let expected: serde_json::Value = serde_json::from_str(
            prompt
                .rsplit_once("\nTASK_UPDATE_JSON: ")
                .context("missing task update snapshot")?
                .1,
        )?;
        ensure!(
            Some(self.document_revision(spec)?.as_str())
                == expected["definition_revision"].as_str(),
            "main Agent changed the task definitions or acceptance criteria"
        );
        for item in expected["checklist"]
            .as_array()
            .context("missing checklist snapshot")?
        {
            let id = item["id"].as_str().context("missing checklist ID")?;
            ensure!(
                markdown::completed(&tasks, id) == item["checked"].as_bool(),
                "main Agent did not synchronize checklist item {id}"
            );
        }
        for item in expected["verification"]
            .as_array()
            .context("missing verification snapshot")?
        {
            let prefix = format!(
                "- {}: {}",
                item["id"].as_str().context("missing acceptance ID")?,
                item["outcome"]
                    .as_str()
                    .context("missing verification outcome")?
            );
            ensure!(
                tasks
                    .lines()
                    .any(|line| line.trim_start().starts_with(&prefix)),
                "main Agent did not record the verification result"
            );
        }
        Ok(())
    }
}
