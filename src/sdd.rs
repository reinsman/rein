use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

use crate::local::TaskStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    Spec,
    Design,
    Tasks,
    Verification,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Criterion {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub criterion_id: String,
    pub status: CheckStatus,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Activity {
    pub at: u64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<TaskType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub document: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub criteria: Vec<Criterion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtasks: Vec<Subtask>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<Check>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Activity>,
}

pub fn validate(tasks: &[Task], previous: &[Task]) -> Result<()> {
    ensure!(tasks.len() <= 256, "too many tasks in one requirement");
    let order = [
        TaskType::Spec,
        TaskType::Design,
        TaskType::Tasks,
        TaskType::Verification,
    ];
    let mut kinds = HashSet::new();
    for task in tasks {
        ensure!(
            task.description.len() <= 12000
                && task.document.len() <= 64000
                && task.agent_id.len() <= 256,
            "task content is too long"
        );
        ensure!(
            task.criteria.len() <= 100
                && task.subtasks.len() <= 100
                && task.checks.len() <= 100
                && task.history.len() <= 200,
            "too many task items"
        );
        ensure!(
            task.history
                .iter()
                .all(|a| !a.message.trim().is_empty() && a.message.len() <= 1000),
            "invalid task activity"
        );
        let mut ids = HashSet::new();
        for criterion in &task.criteria {
            ensure!(
                Uuid::parse_str(&criterion.id).is_ok()
                    && ids.insert(&criterion.id)
                    && !criterion.text.trim().is_empty()
                    && criterion.text.len() <= 3000,
                "invalid or duplicate acceptance criterion"
            );
        }
        ids.clear();
        for item in &task.subtasks {
            ensure!(
                Uuid::parse_str(&item.id).is_ok()
                    && ids.insert(&item.id)
                    && !item.title.trim().is_empty()
                    && item.title.len() <= 1000,
                "invalid or duplicate development subtask"
            );
        }
        ids.clear();
        for check in &task.checks {
            ensure!(
                ids.insert(&check.criterion_id) && check.evidence.len() <= 12000,
                "invalid or duplicate verification result"
            );
            ensure!(
                tasks
                    .iter()
                    .filter(|t| t.kind == Some(TaskType::Spec))
                    .flat_map(|t| &t.criteria)
                    .any(|c| c.id == check.criterion_id),
                "verification result refers to a missing criterion"
            );
        }
        let old = previous.iter().find(|old| old.id == task.id);
        if let Some(old) = old {
            ensure!(
                old.kind == task.kind,
                "task type cannot be changed after creation"
            );
            if task.kind.is_some()
                && old.status == TaskStatus::Done
                && task.status == TaskStatus::Done
            {
                ensure!(
                    task.document == old.document
                        && task.criteria == old.criteria
                        && task.subtasks == old.subtasks
                        && task.checks == old.checks,
                    "reopen the task before changing a confirmed artifact"
                );
            }
        }
        let Some(kind) = task.kind else {
            ensure!(
                task.depends_on.is_empty()
                    && task.criteria.is_empty()
                    && task.subtasks.is_empty()
                    && task.checks.is_empty(),
                "SDD items require a typed task"
            );
            continue;
        };
        let index = order.iter().position(|value| *value == kind).unwrap();
        ensure!(
            kinds.insert(index),
            "each SDD task type may appear only once per requirement"
        );
        if index == 0 {
            ensure!(
                task.depends_on.is_empty(),
                "Spec cannot have a preceding stage"
            );
        } else {
            let predecessor = tasks
                .iter()
                .find(|t| t.kind == Some(order[index - 1]))
                .ok_or_else(|| anyhow::anyhow!("the preceding SDD stage is missing"))?;
            ensure!(
                task.depends_on == [predecessor.id.clone()],
                "SDD dependencies must follow Spec, Design, Tasks, Verification"
            );
            ensure!(
                task.status == TaskStatus::Todo || predecessor.status == TaskStatus::Done,
                "complete the preceding SDD stage before starting this task"
            );
            if kind == TaskType::Verification && predecessor.status != TaskStatus::Done {
                ensure!(
                    task.checks
                        .iter()
                        .all(|check| check.status == CheckStatus::Pending),
                    "verification results must be reset when development is reopened"
                );
            }
        }
        ensure!(
            kind == TaskType::Spec || task.criteria.is_empty(),
            "acceptance criteria belong to Spec"
        );
        ensure!(
            kind == TaskType::Tasks || task.subtasks.is_empty(),
            "development subtasks belong to Tasks"
        );
        ensure!(
            kind == TaskType::Verification || task.checks.is_empty(),
            "verification results belong to Verification"
        );
        if task.status == TaskStatus::Done {
            ensure!(
                old.is_some_and(|t| t.status != TaskStatus::Todo),
                "start the SDD task before completing it"
            );
            match kind {
                TaskType::Spec => ensure!(
                    !task.document.trim().is_empty() && !task.criteria.is_empty(),
                    "Spec requires a document and acceptance criteria"
                ),
                TaskType::Design => ensure!(
                    !task.document.trim().is_empty(),
                    "Design requires a document"
                ),
                TaskType::Tasks => ensure!(
                    !task.subtasks.is_empty() && task.subtasks.iter().all(|item| item.completed),
                    "complete all development subtasks first"
                ),
                TaskType::Verification => {
                    let count = tasks
                        .iter()
                        .find(|t| t.kind == Some(TaskType::Spec))
                        .map_or(0, |t| t.criteria.len());
                    ensure!(
                        count > 0
                            && task.checks.len() == count
                            && task
                                .checks
                                .iter()
                                .all(|check| check.status == CheckStatus::Passed
                                    && !check.evidence.trim().is_empty()),
                        "all acceptance criteria need a passing result and evidence"
                    );
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_tasks_round_trip_without_new_fields() {
        let value = json!({"id":Uuid::new_v4(),"title":"existing","status":"todo"});
        let task: Task = serde_json::from_value(value.clone()).unwrap();
        validate(std::slice::from_ref(&task), &[]).unwrap();
        assert_eq!(serde_json::to_value(task).unwrap(), value);
    }

    #[test]
    fn stage_dependencies_completion_and_evidence_are_enforced() {
        let criterion = Uuid::new_v4().to_string();
        let mut tasks: Vec<Task> = ["spec", "design", "tasks", "verification"]
            .iter()
            .map(|kind| {
                serde_json::from_value(
                    json!({"id":Uuid::new_v4(),"title":kind,"status":"todo","type":kind}),
                )
                .unwrap()
            })
            .collect();
        for index in 1..tasks.len() {
            tasks[index].depends_on = vec![tasks[index - 1].id.clone()];
        }
        validate(&tasks, &[]).unwrap();
        tasks[1].status = TaskStatus::Running;
        assert!(validate(&tasks, &tasks).is_err());
        tasks[1].status = TaskStatus::Todo;
        tasks[0].status = TaskStatus::Running;
        let previous = tasks.clone();
        tasks[0].status = TaskStatus::Done;
        assert!(validate(&tasks, &previous).is_err());
        tasks[0].document = "Expected behavior".into();
        tasks[0].criteria = vec![Criterion {
            id: criterion.clone(),
            text: "works".into(),
        }];
        validate(&tasks, &previous).unwrap();
        tasks[1].document = "Technical constraints".into();
        tasks[1].status = TaskStatus::Running;
        let previous = tasks.clone();
        tasks[1].status = TaskStatus::Done;
        validate(&tasks, &previous).unwrap();
        tasks[2].status = TaskStatus::Running;
        tasks[2].subtasks = vec![Subtask {
            id: Uuid::new_v4().to_string(),
            title: "implement".into(),
            completed: true,
        }];
        let previous = tasks.clone();
        tasks[2].status = TaskStatus::Done;
        tasks[3].status = TaskStatus::Running;
        tasks[3].checks = vec![Check {
            criterion_id: criterion,
            status: CheckStatus::Passed,
            evidence: String::new(),
        }];
        validate(&tasks, &previous).unwrap();
        let previous = tasks.clone();
        tasks[3].status = TaskStatus::Done;
        assert!(validate(&tasks, &previous).is_err());
        tasks[3].checks[0].evidence = "tests pass".into();
        validate(&tasks, &previous).unwrap();
        let previous = tasks.clone();
        tasks[0].document.push_str("changed");
        assert!(validate(&tasks, &previous).is_err());
    }
}
