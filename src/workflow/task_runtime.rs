use super::*;
use crate::local::terminal;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const BROWSER_TEST_GUIDANCE: &str = "Run browser tests headlessly by default, including screenshot and visual checks. Use the project's headless test command or launch a separate headless browser process. Do not open or focus a desktop browser, connect to the user's running browser (for example via an extension or CDP), or use headed/debug test modes unless the user explicitly asks for a visible browser. If a check cannot run headlessly, report the limitation instead of switching to a visible browser.";

impl Workflow {
    pub async fn task_chat(
        &self,
        id: &str,
        run_id: &str,
        prompt: String,
        request_id: String,
    ) -> Result<crate::execution::LocalRun> {
        let state = self.state.lock().await;
        let task = state
            .tasks
            .iter()
            .find(|task| task.id == id)
            .context("task not found")?;
        ensure!(
            task.status != TaskStatus::Running && task.last_run_id.as_deref() == Some(run_id),
            "task session changed or is still executing"
        );
        let record = self.local.get(run_id, 0).await?;
        ensure!(
            terminal(&record.run.state),
            "task execution has not stopped"
        );
        let directory = match record.run.working_directory {
            Some(directory) => directory,
            None => {
                let (project, _) = self.requirement(&task.requirement_id)?;
                project
                    .preferred_directory
                    .or_else(|| project.directories.into_iter().next())
                    .context("configure a project working directory first")?
            }
        };
        self.local
            .start_in_directory(
                record.agent_id,
                Some(record.run.session_id),
                prompt,
                request_id,
                Some(directory),
            )
            .await
    }

    pub fn spawn_tasks(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(400));
            loop {
                tokio::select! { _=stop.cancelled()=>break, _=tick.tick()=>if let Err(error)=runtime.task_tick().await {eprintln!("reind: task runtime: {error:#}");} }
            }
        })
    }
    async fn task_tick(&self) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        let before = serde_json::to_vec(&next)?;
        let mut messages = Vec::new();
        for task in &mut next.tasks {
            if task.status != TaskStatus::Running {
                continue;
            }
            let Some(id) = &task.run_id else {
                continue;
            };
            let snapshot: String = sqlx::query_scalar("SELECT snapshot FROM local_runs WHERE id=?")
                .bind(id)
                .fetch_one(&self.local.store.pool)
                .await?;
            let run: crate::execution::LocalRun = serde_json::from_str(&snapshot)?;
            task.execution_state = Some(run.state.clone());
            if task.paused {
                self.cancel_run(
                    &run,
                    task.request_id
                        .clone()
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                )
                .await?;
            }
            if matches!(run.state.as_str(), "waiting_input" | "waiting_approval") {
                let record = self.local.get(id, 0).await?;
                if let Some(event) = record
                    .events
                    .iter()
                    .rev()
                    .find(|event| event.event["type"] == "interaction")
                {
                    let params = &event.event["parameters"];
                    let request = params["reason"]
                        .as_str()
                        .or_else(|| params["message"].as_str())
                        .or_else(|| params["title"].as_str())
                        .unwrap_or("请查看任务 Agent 会话中的交互请求");
                    messages.push(TaskMessage::new(
                        task,
                        "waiting",
                        event.event["interaction_id"].as_str().unwrap_or(""),
                        format!(
                            "@用户，执行「{}」需要{}：{}",
                            task.title,
                            if run.state == "waiting_approval" {
                                "审批"
                            } else {
                                "回复"
                            },
                            request
                        ),
                    ));
                }
            }
            if !terminal(&run.state) {
                continue;
            }
            let stopped = task.paused || run.state != "completed";
            if stopped {
                let error = if task.paused {
                    None
                } else {
                    Some(run.error.unwrap_or_else(|| {
                        format!("Execution {}. Start explicitly to retry.", run.state)
                    }))
                };
                task.status = TaskStatus::Todo;
                task.paused = true;
                task.manual = false;
                task.error = error;
            } else {
                match self.read_task_result(task) {
                    Ok((result, file)) => {
                        if task.role == Role::Coding && result.outcome != "passed" {
                            task.status = TaskStatus::Todo;
                            task.paused = true;
                            task.error = Some(result.summary.clone());
                        } else {
                            task.status = TaskStatus::Done;
                            task.error = None;
                        }
                        task.handoffs.push(Handoff {
                            kind: if task.role == Role::Coding {
                                "coding"
                            } else {
                                "review"
                            }
                            .into(),
                            file,
                            agent_id: task.agent_id.clone().unwrap_or_default(),
                            run_id: task.run_id.clone(),
                        });
                        task.result = Some(result);
                        task.manual = false;
                    }
                    Err(error) => {
                        task.status = TaskStatus::Todo;
                        task.paused = true;
                        task.manual = false;
                        task.error = Some(format!(
                            "Execution ended but artifacts are invalid: {error:#}"
                        ));
                    }
                }
            }
            let report = if let Some(result) = &task.result {
                format!(
                    "{}{}「{}」：{}\n验证证据：{}",
                    if task.role == Role::Coding && result.outcome != "passed" {
                        "@用户，"
                    } else {
                        ""
                    },
                    if result.outcome == "passed" {
                        "已完成"
                    } else {
                        "未通过"
                    },
                    task.title,
                    result.summary,
                    result.evidence.chars().take(1000).collect::<String>()
                )
            } else {
                format!(
                    "@用户，「{}」{}：{}",
                    task.title,
                    if stopped {
                        "已停止"
                    } else {
                        "未通过结果校验"
                    },
                    task.error
                        .as_deref()
                        .unwrap_or("执行已停止，可在 Todo 中手动重试")
                )
            };
            messages.push(TaskMessage::new(
                task,
                if stopped { "stopped" } else { "completed" },
                "",
                report,
            ));
            task.request_id = None;
            task.run_id = None;
        }
        for message in messages {
            Self::publish_task_message(&mut next, message);
        }
        if serde_json::to_vec(&next)? != before {
            self.commit(&next).await?;
            *guard = next.clone();
        }
        let agents = self.local.agents.list()?;
        let busy:HashSet<String>=sqlx::query_scalar("SELECT DISTINCT agent_id FROM local_runs WHERE json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled')").fetch_all(&self.local.store.pool).await?.into_iter().collect();
        for index in 0..next.tasks.len() {
            let t = &next.tasks[index];
            let recovering =
                t.status == TaskStatus::Running && t.run_id.is_none() && t.request_id.is_some();
            if !recovering {
                if t.status != TaskStatus::Todo || t.paused || t.error.is_some() {
                    continue;
                }
                if !t.manual
                    && (!next.settings.automatic
                        || t.spec_id
                            .as_ref()
                            .is_some_and(|id| next.specs.iter().any(|s| &s.id == id && s.paused)))
                {
                    continue;
                }
            }
            let roles = if t.role == Role::Coding {
                &next.settings.coding_agents
            } else {
                &next.settings.review_agents
            };
            let candidate = if recovering {
                t.agent_id.clone()
            } else {
                roles
                    .iter()
                    .find(|name| {
                        agents.iter().any(|a| &a.name == *name && a.enabled)
                            && !busy.contains(*name)
                            && !next.tasks.iter().any(|other| {
                                other.status == TaskStatus::Running
                                    && other.agent_id.as_ref() == Some(*name)
                            })
                    })
                    .cloned()
            };
            let Some(agent) = candidate else {
                continue;
            };
            if !recovering {
                let t = &mut next.tasks[index];
                t.attempt += 1;
                t.status = TaskStatus::Running;
                t.agent_id = Some(agent.clone());
                t.request_id = Some(Uuid::new_v4().to_string());
                t.result = None;
                // Persist the dispatch identity before starting; restart reuses this request ID.
                self.commit(&next).await?;
                *guard = next.clone();
            }
            let t = &next.tasks[index];
            let existing: Option<String> =
                sqlx::query_scalar("SELECT id FROM local_runs WHERE request_id=?")
                    .bind(&t.request_id)
                    .fetch_optional(&self.local.store.pool)
                    .await?;
            let result = if let Some(id) = existing {
                let run = self.local.get(&id, 0).await?.run;
                if t.paused {
                    self.cancel_run(&run, t.request_id.clone().unwrap()).await?;
                }
                Ok(run)
            } else if t.paused {
                next.tasks[index].status = TaskStatus::Todo;
                next.tasks[index].request_id = None;
                self.commit(&next).await?;
                *guard = next.clone();
                continue;
            } else {
                async {
                    let (project, _) = self.requirement(&t.requirement_id)?;
                    let cwd = project
                        .preferred_directory
                        .or(project.directories.first().cloned());
                    match cwd {
                        Some(cwd) => {
                            self.local
                                .start_in_directory(
                                    agent,
                                    None,
                                    self.task_prompt(t, &next, &cwd)?,
                                    t.request_id.clone().unwrap(),
                                    Some(cwd),
                                )
                                .await
                        }
                        None => Err(anyhow::anyhow!(
                            "configure a project working directory first"
                        )),
                    }
                }
                .await
            };
            let t = &mut next.tasks[index];
            match result {
                Ok(run) => {
                    t.last_run_id = Some(run.run_id.clone());
                    t.execution_state = Some(run.state);
                    t.run_id = Some(run.run_id);
                    let message = TaskMessage::new(
                        t,
                        "started",
                        "",
                        format!(
                            "开始{}「{}」。",
                            if t.role == Role::Coding {
                                "执行"
                            } else {
                                "验证"
                            },
                            t.title
                        ),
                    );
                    Self::publish_task_message(&mut next, message);
                }
                Err(error) => {
                    let message = format!("{error:#}");
                    t.status = TaskStatus::Todo;
                    t.request_id = None;
                    if !(message.contains("agent is running")
                        || message.contains("active execution")
                        || message.contains("capacity reached"))
                    {
                        t.paused = true;
                        t.manual = false;
                        t.error = Some(message);
                        let report = TaskMessage::new(
                            t,
                            "dispatch_failed",
                            "",
                            format!(
                                "@用户，无法开始「{}」：{}",
                                t.title,
                                t.error.as_deref().unwrap_or("执行失败")
                            ),
                        );
                        Self::publish_task_message(&mut next, report);
                    } else {
                        t.attempt = t.attempt.saturating_sub(1);
                        t.agent_id = None;
                    }
                }
            }
            self.commit(&next).await?;
            *guard = next.clone();
        }
        Ok(())
    }
    fn artifact_names(task: &QueueTask) -> (String, String) {
        let role = if task.role == Role::Coding {
            "coding"
        } else {
            "review"
        };
        let stem = format!("task-{}-a{}-{role}", task.id, task.attempt);
        (format!("{stem}-handoff.md"), format!("{stem}-result.json"))
    }
    fn read_task_result(&self, task: &QueueTask) -> Result<(TaskResult, String)> {
        let (handoff, result) = Self::artifact_names(task);
        let dir = self.task_dir(task);
        let text = read_text(&dir.join(&handoff))?;
        bounded(&text, 12000)?;
        let result: TaskResult = serde_json::from_str(&read_text(&dir.join(result))?)?;
        ensure!(
            matches!(result.outcome.as_str(), "passed" | "failed"),
            "outcome must be passed or failed"
        );
        bounded(&result.summary, 3000)?;
        bounded(&result.evidence, 12000)?;
        if let Some(id) = &result.responsible_task_id {
            ensure!(id.len() <= 64, "responsible task ID too long");
        }
        Ok((result, handoff))
    }
    fn task_prompt(
        &self,
        task: &QueueTask,
        state: &Snapshot,
        working_dir: &std::path::Path,
    ) -> Result<String> {
        let dir = self.task_dir(task);
        let (handoff, result) = Self::artifact_names(task);
        let spec = task
            .spec_id
            .as_ref()
            .and_then(|id| state.specs.iter().find(|s| &s.id == id));
        let source = if let Some(spec) = spec {
            if let Some(expected) = &spec.document_revision {
                ensure!(
                    self.document_revision(spec)? == *expected,
                    "Spec documents differ from the approved execution snapshot; review the changed definitions before running"
                );
            }
            artifact_parent(&dir.join("task-index.json"))?;
            crate::agents::write_json(&dir.join("task-index.json"),&state.tasks.iter().filter(|t|t.spec_id==task.spec_id && t.role==Role::Coding).map(|t|serde_json::json!({"id":t.id,"plan_id":t.plan_id,"title":t.title,"handoffs":t.handoffs})).collect::<Vec<_>>())?;
            let item = spec
                .plan
                .tasks
                .iter()
                .position(|item| Some(&item.id) == task.plan_id.as_ref())
                .map(|index| format!("This is checklist item {}, counting non-empty checklist items from top to bottom and skipping fenced code blocks.", index + 1))
                .unwrap_or_else(|| format!("This is only acceptance criterion or repair task {}.", task.criterion_id.as_deref().unwrap_or(&task.id)));
            format!(
                "SINGLE TASK from spec '{}'. Work ONLY on this task from {}.\n{} Exact task/criterion: {}.\nRead these files first in {}: requirements.md (Acceptance Criteria), design.md, tasks.md and task-index.json. The task index lists coding task UUIDs and handoffs for responsibility analysis. These documents may contain newer manual edits; the saved TITLE and DESCRIPTION below plus this execution snapshot define this job's scope. Do not reinterpret the job from newer document content.\nEXECUTION_SNAPSHOT: {}",
                spec.title,
                dir.join("tasks.md").display(),
                item,
                task.title,
                dir.display(),
                serde_json::json!({"task":{"plan_id":task.plan_id,"criterion_id":task.criterion_id,"title":task.title,"description":task.description},"criteria":if task.role == Role::Review { vec![Criterion {id:task.criterion_id.clone().unwrap_or_default(),text:task.description.clone()}] } else { spec.plan.criteria.iter().filter(|criterion| task.criterion_id.as_ref() == Some(&criterion.id) || spec.plan.tasks.iter().any(|item| Some(&item.id) == task.plan_id.as_ref() && item.acceptance_ids.contains(&criterion.id))).cloned().collect() }})
            )
        } else {
            "Direct requirement task, not attached to a Spec.".into()
        };
        let repairs: Vec<_> = task
            .handoffs
            .iter()
            .filter(|h| h.kind == "repair")
            .map(|h| dir.join(&h.file))
            .collect();
        let role = if task.role == Role::Coding {
            "CODING: implement only this task. Run relevant checks; do not mark unrelated tasks complete."
        } else {
            "REVIEW: validate only this acceptance criterion against the requirements and actual implementation. Run checks and record evidence. Do not modify the code. If it fails, analyze which coding task is responsible; use its UUID as responsible_task_id when evidence supports the association. If no task can be associated, return null and describe the required fix. Do not invent a passing result."
        };
        Ok(format!(
            "REIN TASK RUNTIME\nTASK_ID: {}\nROLE: {:?}\nTITLE: {}\nDESCRIPTION: {}\n{}\n{}\nRead additional repair handoffs before doing any work: {:?}\nOperate inside {} (your shell already starts there; no cd needed). Task runtime owns ordering and status. Do not start other tasks or agents. Do NOT change tasks.md checkboxes; the main Agent will update that document after your validated report is posted to the group. Finish this one task, then STOP. Keep existing unrelated changes. Preserve native approval policy.\n{BROWSER_TEST_GUIDANCE}\nWhen finished, write a Task Handoff Markdown of roughly 100–300 Chinese characters (or equivalent concise prose) to this EXACT path: {}. Include changes/checks, evidence, limitations and next owner.\nAlso write a JSON result to this EXACT path: {} with schema {{\"outcome\":\"passed|failed\",\"summary\":\"what happened\",\"evidence\":\"actual checks and results\",\"responsible_task_id\":null}}. Missing artifacts are NOT success. Never write task statuses or start the next task.\nARTIFACT_OUTPUT_JSON: {}",
            task.id,
            task.role,
            task.title,
            task.description,
            role,
            source,
            repairs,
            working_dir.display(),
            dir.join(&handoff).display(),
            dir.join(&result).display(),
            serde_json::json!({"handoff":dir.join(handoff),"result":dir.join(result),"task_id":task.id,"role":task.role})
        ))
    }
}
