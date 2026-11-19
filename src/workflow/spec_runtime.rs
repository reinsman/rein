use super::*;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

impl Workflow {
    pub fn spawn_specs(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(400));
            loop {
                tokio::select! {_=stop.cancelled()=>break,_=tick.tick()=>{
                    if let Err(error)=runtime.spec_tick().await {eprintln!("reind: spec runtime: {error:#}");}
                    if let Err(error)=runtime.update_task_documents().await {eprintln!("reind: task document update: {error:#}");}
                }}
            }
        })
    }
    async fn spec_tick(&self) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        for index in 0..state.specs.len() {
            let spec = state.specs[index].clone();
            let latest: Option<(String, String)> = sqlx::query_as("SELECT snapshot,prompt FROM local_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1")
                .bind(&spec.session_id).fetch_optional(&self.local.store.pool).await?;
            let run = latest
                .as_ref()
                .map(|(snapshot, _)| serde_json::from_str::<crate::execution::LocalRun>(snapshot))
                .transpose()?;
            let completed = run.as_ref().is_some_and(|run| run.state == "completed");
            if completed {
                if state.specs[index].document_run_id.as_deref()
                    != run.as_ref().map(|run| run.run_id.as_str())
                {
                    let message = latest
                        .as_ref()
                        .and_then(|(_, prompt)| prompt.rsplit_once("\nREIN_SPEC_USER_MESSAGE:\n"))
                        .and_then(|(_, message)| {
                            serde_json::from_str::<serde_json::Value>(message).ok()
                        });
                    if let Some(message) = message
                        && let Some(name) = message["keep_document"].as_str()
                    {
                        let content = read_text(&self.spec_dir(&spec).join(name))?;
                        if message["keep_revision"].as_str()
                            != Some(markdown::artifact_revision(name, &content).as_str())
                        {
                            state.specs[index].error = Some(format!(
                                "{name} 未按保留要求保持原样，请让主 Agent 修正后继续。"
                            ));
                            continue;
                        }
                    }
                    if state.specs[index].document_revision.is_some() {
                        state.specs[index].document_revision = Some(self.document_revision(&spec)?);
                    }
                }
                if let Err(error) = self.sync_document_approvals(&mut state.specs[index]) {
                    state.specs[index].error = Some(format!(".spec-state.json: {error:#}"));
                    continue;
                }
                state.specs[index].document_run_id = run.as_ref().map(|run| run.run_id.clone());
                if !matches!(
                    spec.phase,
                    Phase::Requirements | Phase::Design | Phase::Tasks
                ) {
                    if let Err(error) = self.sync_spec_state(&mut state, &spec.id) {
                        state.specs[index].error = Some(format!(".spec-state.json: {error:#}"));
                        continue;
                    }
                }
            }
            if matches!(
                spec.phase,
                Phase::Requirements | Phase::Design | Phase::Tasks
            ) {
                if let Some(run) = &run {
                    if matches!(run.state.as_str(), "failed" | "cancelled") {
                        state.specs[index].error = Some(if run.state == "cancelled" {
                            "主 Agent 执行已取消，当前阶段文档可能尚未保存。可继续当前阶段，重新生成后再审阅。".into()
                        } else {
                            format!(
                                "主 Agent 执行失败：{}。可继续当前阶段。",
                                run.error.as_deref().unwrap_or("执行异常结束")
                            )
                        });
                        continue;
                    }
                    if state.specs[index]
                        .error
                        .as_deref()
                        .is_some_and(|error| error.starts_with("主 Agent 执行"))
                    {
                        state.specs[index].error = None;
                    }
                }
                if run.is_none_or(|run| run.state == "completed") {
                    if let Err(error) = self.sync_spec_state(&mut state, &spec.id) {
                        state.specs[index].error = Some(format!(".spec-state.json: {error:#}"));
                        continue;
                    }
                    if state.specs[index]
                        .error
                        .as_deref()
                        .is_some_and(|error| error.starts_with(".spec-state.json:"))
                    {
                        state.specs[index].error = None;
                    }
                }
            } else if let Some(run) = &run
                && matches!(run.state.as_str(), "failed" | "cancelled")
            {
                state.specs[index].error = Some(format!(
                    "主 Agent 执行未完成：{}。请重试文档审阅。",
                    run.error.as_deref().unwrap_or(&run.state)
                ));
            }
            let spec = state.specs[index].clone();
            if spec.paused {
                continue;
            }
            if let Err(error) = self.advance_spec(&mut state, &spec) {
                state.specs[index].paused = true;
                state.specs[index].error = Some(format!("{error:#}"));
            }
        }
        if serde_json::to_vec(&*guard)? != serde_json::to_vec(&state)? {
            self.commit(&state).await?;
            *guard = state;
        }
        Ok(())
    }
    fn advance_spec(&self, state: &mut Snapshot, spec: &Spec) -> Result<()> {
        let spec_index = state.specs.iter().position(|s| s.id == spec.id).unwrap();
        let coding: Vec<_> = state
            .tasks
            .iter()
            .filter(|t| t.spec_id.as_ref() == Some(&spec.id) && t.role == Role::Coding)
            .collect();
        match spec.phase {
            Phase::Building => {
                if coding.iter().any(|t| t.status != TaskStatus::Done) {
                    return Ok(());
                }
                if let Some(plan) = spec
                    .plan
                    .tasks
                    .iter()
                    .find(|p| !coding.iter().any(|t| t.plan_id.as_ref() == Some(&p.id)))
                {
                    let plan_id = plan.id.clone();
                    Self::enqueue_spec_task(state, spec, &plan_id)?;
                } else {
                    state.specs[spec_index].phase = Phase::ReadyVerification;
                }
            }
            Phase::Repairing => {
                if !coding.is_empty() && coding.iter().all(|t| t.status == TaskStatus::Done) {
                    state.specs[spec_index].round += 1;
                    state.specs[spec_index].phase = Phase::Verifying;
                }
            }
            Phase::Verifying => {
                let reviews: Vec<_> = state
                    .tasks
                    .iter()
                    .filter(|t| {
                        t.spec_id.as_ref() == Some(&spec.id)
                            && t.role == Role::Review
                            && t.round == spec.round
                    })
                    .collect();
                if let Some(failed) = reviews.iter().find(|t| {
                    t.status == TaskStatus::Done
                        && t.result.as_ref().is_some_and(|r| r.outcome == "failed")
                }) {
                    let failed = (*failed).clone();
                    let result = failed.result.as_ref().unwrap();
                    let mut responsible = if let Some(id) = &result.responsible_task_id {
                        coding
                            .iter()
                            .find(|t| &t.id == id || t.plan_id.as_ref() == Some(id))
                            .map(|task| task.id.clone())
                    } else {
                        None
                    };
                    if responsible.is_none() {
                        let linked: Vec<_> = coding
                            .iter()
                            .filter(|task| {
                                task.criterion_id.is_some()
                                    && task.criterion_id == failed.criterion_id
                                    || task.plan_id.as_ref().is_some_and(|id| {
                                        spec.plan.tasks.iter().any(|plan| {
                                            &plan.id == id
                                                && failed.criterion_id.as_ref().is_some_and(
                                                    |criterion| {
                                                        plan.acceptance_ids.contains(criterion)
                                                    },
                                                )
                                        })
                                    })
                            })
                            .collect();
                        if linked.len() == 1 {
                            responsible = Some(linked[0].id.clone());
                        }
                    }
                    let mut repair = if let Some(id) = responsible {
                        state.tasks.iter().find(|t| t.id == id).unwrap().clone()
                    } else {
                        QueueTask::new(
                            spec.requirement_id.clone(),
                            Some(spec),
                            format!("修复验收 {}", failed.criterion_id.as_deref().unwrap_or("")),
                            result.summary.clone(),
                            Role::Coding,
                            spec.directory.clone(),
                        )
                    };
                    let filename =
                        format!("task-{}-repair-r{}-{}.md", repair.id, spec.round, failed.id);
                    let content = format!(
                        "# 验收返修交接\n\n验收条目：{}\n责任任务：{}\n\n## 问题\n{}\n\n## 验证证据\n{}\n\n## 修改要求\n修复上述问题，覆盖对应验收行为，并补充回归验证。阅读 requirements.md、design.md 和相关 coding / review handoff。完成后写新的 Task Handoff 与结果文件。\n\n原 Review Handoff：{}\n",
                        failed.criterion_id.as_deref().unwrap_or(""),
                        repair.id,
                        result.summary,
                        result.evidence,
                        failed.handoffs.last().map_or("", |h| h.file.as_str())
                    );
                    write_text(&self.spec_dir(spec).join(&filename), &content)?;
                    repair.status = TaskStatus::Todo;
                    repair.paused = false;
                    repair.manual = false;
                    repair.error = None;
                    repair.result = None;
                    repair.run_id = None;
                    repair.request_id = None;
                    repair.agent_id = None;
                    if repair.plan_id.is_none() {
                        repair.criterion_id = failed.criterion_id.clone();
                    }
                    repair.handoffs.push(Handoff {
                        kind: "repair".into(),
                        file: filename,
                        agent_id: failed.agent_id.clone().unwrap_or_default(),
                        run_id: failed.handoffs.last().and_then(|h| h.run_id.clone()),
                    });
                    if let Some(existing) = state.tasks.iter_mut().find(|t| t.id == repair.id) {
                        *existing = repair;
                    } else {
                        state.tasks.push(repair);
                    }
                    state.specs[spec_index].phase = Phase::Repairing;
                } else if reviews.iter().any(|t| t.status != TaskStatus::Done) {
                    return Ok(());
                } else if let Some(criterion) = spec.plan.criteria.iter().find(|c| {
                    !reviews
                        .iter()
                        .any(|t| t.criterion_id.as_ref() == Some(&c.id))
                }) {
                    let mut task = QueueTask::new(
                        spec.requirement_id.clone(),
                        Some(spec),
                        format!("验收 {}", criterion.id),
                        criterion.text.clone(),
                        Role::Review,
                        spec.directory.clone(),
                    );
                    task.criterion_id = Some(criterion.id.clone());
                    state.tasks.push(task);
                } else {
                    state.specs[spec_index].phase = Phase::ReadyComplete;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
