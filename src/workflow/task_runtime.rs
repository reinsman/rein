use super::*;
use crate::local::terminal;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

impl Workflow {
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
            if !terminal(&run.state) {
                continue;
            }
            if task.paused || run.state != "completed" {
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
            task.request_id = None;
            task.run_id = None;
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
                                    self.task_prompt(t, &next)?,
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
    fn task_prompt(&self, task: &QueueTask, state: &Snapshot) -> Result<String> {
        let dir = self.task_dir(task);
        let (handoff, result) = Self::artifact_names(task);
        let spec = task
            .spec_id
            .as_ref()
            .and_then(|id| state.specs.iter().find(|s| &s.id == id));
        let source = if let Some(spec) = spec {
            artifact_parent(&dir.join("task-index.json"))?;
            crate::agents::write_json(&dir.join("task-index.json"),&state.tasks.iter().filter(|t|t.spec_id==task.spec_id && t.role==Role::Coding).map(|t|serde_json::json!({"id":t.id,"plan_id":t.plan_id,"title":t.title,"handoffs":t.handoffs})).collect::<Vec<_>>())?;
            format!(
                "Spec: {}\nRead these files first in {}: requirements.md, design.md, tasks.md, plan.json and task-index.json. The task index lists coding task UUIDs and handoffs for responsibility analysis.",
                spec.title,
                dir.display()
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
            "REIN TASK RUNTIME\nTASK_ID: {}\nROLE: {:?}\nTITLE: {}\nDESCRIPTION: {}\n{}\n{}\nRead additional repair handoffs before doing any work: {:?}\nTask runtime owns ordering and status. Do not start other tasks or agents. Keep existing unrelated changes. Preserve native approval policy.\nWhen finished, write a Task Handoff Markdown of roughly 100–300 Chinese characters (or equivalent concise prose) to this EXACT path: {}. Include changes/checks, evidence, limitations and next owner.\nAlso write a JSON result to this EXACT path: {} with schema {{\"outcome\":\"passed|failed\",\"summary\":\"what happened\",\"evidence\":\"actual checks and results\",\"responsible_task_id\":null}}. Missing artifacts are NOT success. Never write task statuses or start the next task.\nARTIFACT_OUTPUT_JSON: {}",
            task.id,
            task.role,
            task.title,
            task.description,
            role,
            source,
            repairs,
            dir.join(&handoff).display(),
            dir.join(&result).display(),
            serde_json::json!({"handoff":dir.join(handoff),"result":dir.join(result),"task_id":task.id,"role":task.role})
        ))
    }
}
