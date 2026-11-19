use super::*;
use serde_json::json;

const USER_MESSAGE: &str = "\nREIN_SPEC_USER_MESSAGE:\n";

#[derive(Serialize, Deserialize)]
struct PlanningState {
    phase: Phase,
    decisions: Vec<serde_json::Value>,
    blocking: Option<String>,
    context: PlanningContext,
}

#[derive(Serialize, Deserialize)]
struct PlanningContext {
    template: SpecKind,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PlanningOptions {
    pub edited_document: Option<String>,
    pub next_document: Option<NextDocument>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NextDocument {
    Modify,
    Keep,
}

impl Workflow {
    pub(crate) fn ready_for_next_phase(&self, spec: &Spec) -> bool {
        let document = match spec.phase {
            Phase::Requirements => "requirements.md",
            Phase::Design => "design.md",
            Phase::Tasks => "tasks.md",
            Phase::ReadyVerification | Phase::ReadyComplete => return true,
            _ => return false,
        };
        let Ok(state) = read_text(&self.spec_dir(spec).join(".spec-state.json")) else {
            return false;
        };
        let Ok(state) = serde_json::from_str::<PlanningState>(&state) else {
            return false;
        };
        state.phase == spec.phase
            && state.blocking.as_deref() == Some(format!("User review of {document}").as_str())
            && read_text(&self.spec_dir(spec).join(document))
                .is_ok_and(|text| !text.trim().is_empty())
    }
    pub(super) fn initialize_spec_state(&self, spec: &Spec) -> Result<()> {
        let dir = self.spec_dir(spec);
        let path = dir.join(".spec-state.json");
        if path.try_exists()? {
            return Ok(());
        }
        let legacy = dir.join("spec-state.json");
        let old: serde_json::Value = if legacy.try_exists()? {
            serde_json::from_str(&read_text(&legacy)?).unwrap_or_else(|_| json!({}))
        } else {
            json!({})
        };
        let document = match spec.phase {
            Phase::Requirements => "requirements.md",
            Phase::Design => "design.md",
            _ => "tasks.md",
        };
        let blocking = if old["awaiting_approval"] == true {
            Some(format!("User review of {document}"))
        } else {
            old["blocking"].as_str().map(str::to_owned)
        };
        crate::agents::write_json(
            &path,
            &PlanningState {
                phase: spec.phase,
                decisions: vec![],
                blocking,
                context: PlanningContext {
                    template: spec.kind,
                },
            },
        )
    }

    pub(super) fn sync_spec_state(&self, state: &mut Snapshot, id: &str) -> Result<()> {
        let spec = state
            .specs
            .iter()
            .find(|spec| spec.id == id)
            .context("Spec not found")?;
        let progress: PlanningState =
            serde_json::from_str(&read_text(&self.spec_dir(spec).join(".spec-state.json"))?)?;
        ensure!(
            progress.context.template == spec.kind,
            "Spec template does not match its type"
        );
        if progress.phase == spec.phase {
            return Ok(());
        }
        if !matches!(
            spec.phase,
            Phase::Requirements | Phase::Design | Phase::Tasks
        ) {
            ensure!(
                matches!(
                    progress.phase,
                    Phase::Requirements | Phase::Design | Phase::Tasks | Phase::Building
                ),
                "planning state cannot declare execution results"
            );
            return Ok(());
        }
        if matches!(
            (spec.phase, progress.phase),
            (Phase::Design | Phase::Tasks, Phase::Requirements) | (Phase::Tasks, Phase::Design)
        ) {
            let spec = state.specs.iter_mut().find(|spec| spec.id == id).unwrap();
            spec.phase = progress.phase;
            spec.error = None;
            return Ok(());
        }
        let action = match (spec.phase, progress.phase) {
            (Phase::Requirements, Phase::Design) => "approve_requirements",
            (Phase::Design, Phase::Tasks) => "approve_design",
            (Phase::Tasks, Phase::Building) => {
                ensure!(
                    progress.blocking.is_none(),
                    "task approval is still blocked"
                );
                "build"
            }
            _ => bail!(
                "invalid planning phase transition: {:?} -> {:?}",
                spec.phase,
                progress.phase
            ),
        };
        self.transition_spec(state, id, action)
    }

    pub(super) fn sync_document_approvals(&self, spec: &mut Spec) -> Result<()> {
        let progress: PlanningState =
            serde_json::from_str(&read_text(&self.spec_dir(spec).join(".spec-state.json"))?)?;
        for decision in progress.decisions {
            let Some(name) = decision["document"]
                .as_str()
                .filter(|name| matches!(*name, "requirements.md" | "design.md" | "tasks.md"))
            else {
                continue;
            };
            if decision["decision"] != "approved" {
                continue;
            }
            let content = read_text(&self.spec_dir(spec).join(name))?;
            if decision["revision"].as_str()
                == Some(markdown::artifact_revision(name, &content).as_str())
            {
                self.approve_document(spec, name, &content);
            }
        }
        Ok(())
    }

    pub async fn begin_spec(&self, id: &str) -> Result<crate::execution::LocalRun> {
        let spec = self
            .snapshot()
            .await
            .specs
            .into_iter()
            .find(|s| s.id == id)
            .context("Spec not found")?;
        let kind = if spec.kind == SpecKind::Bugfix {
            "修复 bug"
        } else {
            "构建新东西"
        };
        let prompt = format!(
            "请创建 Spec「{}」。\n工作类型：{}。\n我想要做什么：\n{}\n\n请先阅读项目，澄清会影响方案的问题，编写需求并等待我确认，再继续设计和任务计划。",
            spec.title, kind, spec.description
        );
        // The Spec UUID is also the initial request ID, so retries never start a second conversation.
        let result = self.chat(id, prompt, spec.id).await;
        if let Err(error) = &result {
            self.edit(|state| {
                let spec = state
                    .specs
                    .iter_mut()
                    .find(|s| s.id == id)
                    .context("Spec not found")?;
                spec.error = Some(format!("开始 Spec 对话失败：{error:#}"));
                Ok(())
            })
            .await?;
        }
        result
    }

    pub async fn chat(
        &self,
        id: &str,
        prompt: String,
        request_id: String,
    ) -> Result<crate::execution::LocalRun> {
        self.chat_with_options(id, prompt, request_id, PlanningOptions::default(), None)
            .await
    }

    pub async fn chat_with_options(
        &self,
        id: &str,
        prompt: String,
        request_id: String,
        options: PlanningOptions,
        session_id: Option<&str>,
    ) -> Result<crate::execution::LocalRun> {
        bounded(&prompt, 32 * 1024)?;
        ensure!(
            Uuid::parse_str(&request_id).is_ok(),
            "request_id must be a UUID"
        );
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        let index = next
            .specs
            .iter()
            .position(|s| s.id == id)
            .context("Spec not found")?;
        let spec = &next.specs[index];
        ensure!(
            session_id.is_none_or(|session| {
                session == spec.session_id && spec.agent_id == next.settings.main_agent
            }),
            "Spec 会话已切换，请检查排队消息"
        );
        let mut message = json!({"spec_id":id,"text":prompt});
        if let Some(name) = &options.edited_document {
            ensure!(
                matches!(name.as_str(), "requirements.md" | "design.md" | "tasks.md"),
                "invalid planning document"
            );
            message["edited_document"] = name.clone().into();
        }
        if let Some(choice) = options.next_document {
            message["next_document"] = serde_json::to_value(choice)?;
        }
        if let Some(row) = sqlx::query("SELECT prompt,snapshot FROM local_runs WHERE request_id=?")
            .bind(&request_id)
            .fetch_optional(&self.local.store.pool)
            .await?
        {
            use sqlx::Row;
            let stored: String = row.get("prompt");
            let mut original: Option<serde_json::Value> = stored
                .rsplit_once(USER_MESSAGE)
                .and_then(|(_, value)| serde_json::from_str(value).ok());
            if let Some(original) = original.as_mut().and_then(serde_json::Value::as_object_mut) {
                original.remove("keep_document");
                original.remove("keep_revision");
            }
            ensure!(
                original.as_ref() == Some(&message),
                "request_id reused with different Spec message"
            );
            return Ok(serde_json::from_str(row.get("snapshot"))?);
        }
        if let Some(choice) = options.next_document {
            let spec = &next.specs[index];
            let progress: PlanningState =
                serde_json::from_str(&read_text(&self.spec_dir(spec).join(".spec-state.json"))?)?;
            let name = match progress.phase {
                Phase::Requirements => "design.md",
                Phase::Design => "tasks.md",
                _ => bail!("no next planning document"),
            };
            if matches!(choice, NextDocument::Keep) {
                let content = read_text(&self.spec_dir(spec).join(name))?;
                ensure!(
                    !content.trim().is_empty(),
                    "next document has not been generated"
                );
                message["keep_document"] = name.into();
                message["keep_revision"] = markdown::artifact_revision(name, &content).into();
            }
        }
        let spec = &next.specs[index];
        let busy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_runs WHERE session_id=? AND json_extract(snapshot,'$.state') NOT IN ('completed','failed','cancelled')")
            .bind(&spec.session_id).fetch_one(&self.local.store.pool).await?;
        ensure!(
            busy == 0,
            "主 Agent 正在处理此 Spec，请等待完成后再确认或发送消息"
        );
        let previous: Option<String> = sqlx::query_scalar("SELECT json_extract(snapshot,'$.state') FROM local_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1")
            .bind(&spec.session_id).fetch_optional(&self.local.store.pool).await?;
        if previous.is_none_or(|state| state == "completed")
            && spec.error.is_none()
            && matches!(
                spec.phase,
                Phase::Requirements | Phase::Design | Phase::Tasks
            )
        {
            // Keep chat available so the Agent can repair an invalid state file.
            if let Err(error) = self.sync_spec_state(&mut next, id) {
                next.specs[index].error = Some(format!(".spec-state.json: {error:#}"));
            }
        }
        let agent = next
            .settings
            .main_agent
            .clone()
            .context("configure a main Agent in system settings first")?;
        let spec = &mut next.specs[index];
        if spec.agent_id.as_ref() != Some(&agent) {
            if spec.agent_id.is_some() {
                spec.session_id = Uuid::new_v4().to_string();
            }
            spec.agent_id = Some(agent.clone());
        }
        let validation_error = spec.error.take();
        let (project, requirement) = self.requirement(&spec.requirement_id)?;
        let directory = project
            .preferred_directory
            .or(project.directories.first().cloned())
            .context("configure a project working directory first")?;
        let dir = self.spec_dir(spec);
        let mut revisions = serde_json::Map::new();
        for name in ["requirements.md", "design.md", "tasks.md"] {
            let path = dir.join(name);
            let content = if path.try_exists()? {
                read_text(&path)?
            } else {
                String::new()
            };
            revisions.insert(
                name.into(),
                markdown::artifact_revision(name, &content).into(),
            );
        }
        let design_guide = if spec.kind == SpecKind::Bugfix {
            crate::agents::skills::BUGFIX_DESIGN
        } else {
            crate::agents::skills::FEATURE_DESIGN
        };
        let document_contract = format!(
            "\nDOCUMENT_REVISIONS: {}\n生成或实质修订 requirements.md 前，先区分用户观察到的症状、假设原因、提出的手段与真正目标，允许有依据地质疑问题定义；把问题抽象为输入、输出、参与者、资源和约束，跨领域广度搜索并核对一手资料，核实是否有经典问题变体及成熟解法，向用户说明来源、适用边界和未核实之处，不擅自替换目标。随后在 requirements 阶段融合 grilling：将未决决定组织成依赖树，每轮一次提出前提已经明确的全部独立问题，编号并提供推荐选项、简短取舍和自定义回答；依赖本轮答案的问题留到下一轮。事实自行读代码和资料核实，不问可查事实，不启动其他 Agent。原生提问工具可用时以原生选项请求收集答案：Codex 可提交同轮多题及选项说明，Pi 的 select 逐题收集；无工具时用普通中文编号问题等待用户回复。推荐不自动选中，回答澄清或接受推荐不等于阶段批准。每轮回复后更新已知决定并重算前沿；关键分支澄清完后总结共同理解，请用户明确确认，然后才创建或实质修改 requirements.md。澄清期间 blocking 写具体问题或需求理解确认，文档尚未生成时不能标记 User review of requirements.md；确认共同理解后生成需求，文档就绪后再邀请用户审阅，保持原有需求、设计、任务逐阶段确认。 In design, first assume the preferred solution is wrong: seek the strongest counterevidence, counterexamples and boundary failures, identify falsification conditions, then compare simpler/mature alternatives under the same constraints and reassess. Reuse unaffected verified findings on revisions; never claim unperformed searches or experiments. The preceding problem-framing, search and adversarial checks are analysis methods, not document outlines. Do not output thinking transcripts, search logs, a strongest-opponent section, or long falsification narratives. Deliver the selected technical solution with only concise decision-relevant evidence. Planning Markdown contains product content only, with stable feature titles. Omit Rein IDs, runtime paths, workflow phases and approval-status boilerplate. Keep product goals, scope, open product questions and acceptance criteria in requirements. This protocol overrides older amendment/regeneration rules: the JSON phase is the document currently being discussed, not an irreversible milestone. Users may edit the current or any earlier planning document in chat or manually. For a revision, set phase to that document's requirements/design/tasks stage and resolve its product questions there. If edited_document is provided, read the user's saved changes first; do not overwrite them with an older draft. Do not treat saving or answering clarifications as approval. When all material questions are resolved and the document is ready, set blocking to 'User review of <current-file>.md', ask whether to enter the next stage in a normal message, and stop. On explicit approval, append a decision with document, decision=approved, revision from DOCUMENT_REVISIONS and the user's actual message. Before advancing, inspect the immediate next document. Missing, empty or whitespace-only next documents are not generated yet: draft them normally without asking whether to preserve the empty file. Only if it has non-whitespace content and the user has not chosen to modify or keep it, ask that choice in chat, leave phase unchanged and wait; do not infer the choice from generic approval. A supplied next_document option is the user's explicit choice. With keep, preserve the next document and all later documents byte-for-byte, enter its stage, read it, and either ask needed questions or request its stage confirmation. With modify, update ONLY that next document using current upstream documents, enter its stage, and request review when ready. If the next document is missing, draft it normally. Never regenerate all downstream documents on save, and never skip a stage review. After task-plan confirmation set phase=building and blocking=null. Existing Coding/Review jobs, their approved execution standards, queues and results remain unchanged when planning documents are revised or reconfirmed; never claim that a document edit restarted execution. Native tool approvals remain separate.\n",
            serde_json::Value::Object(revisions)
        );
        let kind = if spec.kind == SpecKind::Bugfix {
            "BUGFIX: document reproduction, expected versus actual behaviour, the root cause, a minimal repair and regression coverage. Preserve unaffected behaviour."
        } else {
            "FEATURE: define observable requirements, a technical design and an ordered implementation plan."
        };
        let full = format!(
            "Use the installed rein-spec skill. You are the main Spec Agent.\nRequirement: {}\nSpec: {}\nDescription: {}\n{}\nWORKING_DIR: {}\nSPEC_DIR: {}\nPlanning artifacts:\n{}\n{}\n{}\n{}\nRead .spec-state.json first; it is the authority for planning phase and approvals. Its schema is {{\"phase\":\"requirements|design|tasks|building\",\"decisions\":[],\"blocking\":null,\"context\":{{\"template\":\"feature|bugfix\"}}}}. This contract overrides older installed skill instructions. Interpret the user's intent in context, including natural-language approvals, rejections and conditional edits; the daemon does not classify their words. On explicit approval of the ready current document, record the decision, advance phase, prepare the next document and stop for its review. Set blocking to 'User review of requirements.md', 'User review of design.md' or 'User review of tasks.md' only when that document is ready; use a concrete question while clarifying. After design approval enter tasks with blocking null while drafting; after task approval enter building with blocking null. Update the JSON atomically. Never approve on a clarification answer, quoted text, negation or requested edit. Never skip a document review or execute implementation. Requirements are the acceptance source: use '## Acceptance Criteria' and list '- AC-01: expected behaviour'. Tasks are the execution source: use non-empty Markdown checklist items '- [ ] T-01 Task title' with indented descriptions and 'Acceptance: AC-01' links. Keep IDs stable and list tasks in execution order, outside fenced code examples. Do not maintain a separate machine-readable plan file. Only the main Agent updates checkbox/verification projections on explicit runtime reports; Coding/Review never edit them. The daemon reads the state after successful turns, validates artifacts and owns Coding/Review execution and results. Execution phase currently observed by the daemon: {:?}. Daemon validation/status error: {}. If a proposed planning transition was rejected and the observed phase is still requirements/design/tasks, repair its artifacts or state and republish; a building flag alone does not prove dispatch. During actual execution, planning documents may still be revised under the document protocol below; do not alter execution queues, standards or results, and never claim success without evidence. Keep native tool approvals separate.\nUser input is the text field of the JSON below.{}{}",
            requirement.title,
            spec.title,
            spec.description,
            kind,
            directory.display(),
            dir.display(),
            dir.join("requirements.md").display(),
            dir.join("design.md").display(),
            dir.join("tasks.md").display(),
            dir.join(".spec-state.json").display(),
            spec.phase,
            validation_error.as_deref().unwrap_or("none"),
            format!("{document_contract}\nDESIGN_OUTPUT_GUIDE:\n{design_guide}\n{USER_MESSAGE}"),
            message
        );
        let run = self
            .local
            .start_in_directory(
                agent,
                Some(spec.session_id.clone()),
                full,
                request_id,
                Some(directory),
            )
            .await?;
        self.commit(&next).await?;
        *guard = next;
        Ok(run)
    }
}
