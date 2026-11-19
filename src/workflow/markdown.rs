use super::*;

fn heading(line: &str) -> Option<(usize, &str)> {
    let text = line.trim_start();
    let level = text.chars().take_while(|c| *c == '#').count();
    (level > 0 && text.as_bytes().get(level) == Some(&b' '))
        .then(|| (level, text[level..].trim().trim_end_matches('#').trim()))
}

fn list_item(line: &str) -> Option<&str> {
    let text = line.trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(item) = text.strip_prefix(marker) {
            return Some(item.trim());
        }
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        return text[digits..]
            .strip_prefix(". ")
            .or_else(|| text[digits..].strip_prefix(") "))
            .map(str::trim);
    }
    None
}

fn checklist(line: &str) -> Option<&str> {
    let item = list_item(line)?;
    ["[ ]", "[x]", "[X]"]
        .iter()
        .find_map(|mark| item.strip_prefix(mark))
        .filter(|item| item.is_empty() || item.starts_with(char::is_whitespace))
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

fn label<'a>(text: &'a str, prefix: &str, fallback: String) -> (String, &'a str) {
    let text = text.trim().trim_start_matches(['[', '*', '`']);
    let end = text
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .unwrap_or(text.len());
    let key = &text[..end];
    if key.starts_with(prefix) && key.len() > prefix.len() {
        (
            key.into(),
            text[end..].trim_start_matches([']', '*', '`', ':', '：', ' ', '\t']),
        )
    } else {
        (fallback, text)
    }
}

fn outside_fence(line: &str, fence: &mut Option<(char, usize)>) -> bool {
    let text = line.trim_start();
    let marker = text.chars().next().unwrap_or(' ');
    let count = text.chars().take_while(|c| *c == marker).count();
    if let Some((open, length)) = *fence {
        if marker == open && count >= length && text[count..].trim().is_empty() {
            *fence = None;
        }
        return false;
    }
    if matches!(marker, '`' | '~') && count >= 3 {
        *fence = Some((marker, count));
        return false;
    }
    true
}

fn lines_outside_fences(text: &str) -> Vec<&str> {
    let mut fence = None;
    text.lines()
        .filter(|line| outside_fence(line, &mut fence))
        .collect()
}

pub(super) fn revision(requirements: &str, tasks: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut fence = None;
    let mut verification = false;
    let mut definitions = Vec::new();
    for line in tasks.lines() {
        let outside = outside_fence(line, &mut fence);
        if outside && let Some((level, title)) = heading(line) {
            if level <= 2 {
                verification = level == 2 && title == "Verification Results";
            }
        }
        let checkbox = outside && checklist(line).is_some();
        // Checklists remain task definitions even inside the verification display section.
        if verification && !checkbox {
            continue;
        }
        let mut line = line.to_owned();
        if checkbox && let Some(index) = line.find('[') {
            line.replace_range(index + 1..index + 2, " ");
        }
        definitions.push(line);
    }
    let mut hash = Sha256::new();
    hash.update((requirements.len() as u64).to_le_bytes());
    hash.update(requirements.as_bytes());
    hash.update(definitions.join("\n").trim_end().as_bytes());
    format!("{:x}", hash.finalize())
}

pub(super) fn artifact_revision(name: &str, content: &str) -> String {
    if name == "tasks.md" {
        revision("", content)
    } else {
        revision(content, "")
    }
}

pub(super) fn requirements(text: &str) -> Result<Vec<Criterion>> {
    let mut criteria: Vec<Criterion> = vec![];
    let mut section = None;
    let mut list_indent = None;
    for line in lines_outside_fences(text) {
        if let Some((level, title)) = heading(line) {
            if title.to_ascii_lowercase().contains("acceptance criteria")
                || title.starts_with("验收标准")
            {
                section = Some(level);
                list_indent = None;
                continue;
            }
            if section.is_some_and(|start| level <= start) {
                section = None;
            }
        }
        if section.is_none() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let item = checklist(line).or_else(|| list_item(line));
        let title = heading(line)
            .map(|(_, title)| title)
            .filter(|title| title.trim_start_matches(['[', '*', '`']).starts_with("AC-"));
        if let Some(item) =
            title.or_else(|| item.filter(|_| list_indent.is_none_or(|root| indent <= root)))
        {
            list_indent.get_or_insert(indent);
            let (id, text) = label(item, "AC-", format!("AC-{:02}", criteria.len() + 1));
            criteria.push(Criterion {
                id,
                text: text.into(),
            });
        } else if !line.trim().is_empty()
            && let Some(last) = criteria.last_mut()
        {
            last.text.push('\n');
            last.text.push_str(line.trim());
        }
    }
    Ok(criteria)
}

pub(super) fn plan(requirements: &str, tasks: &str) -> Result<Plan> {
    let criteria = self::requirements(requirements)?;
    let mut items: Vec<PlanTask> = vec![];
    let mut continuing = false;
    for line in lines_outside_fences(tasks) {
        if let Some(item) = checklist(line) {
            let (id, title) = label(item, "T-", format!("T-{:02}", items.len() + 1));
            items.push(PlanTask {
                id,
                title: title.into(),
                description: String::new(),
                acceptance_ids: vec![],
            });
            continuing = true;
        } else if heading(line).is_some() {
            continuing = false;
        } else if continuing && let Some(last) = items.last_mut() {
            last.description.push_str(line);
            last.description.push('\n');
        }
    }
    for task in &mut items {
        let text = format!("{}\n{}", task.title, task.description);
        task.acceptance_ids = text
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .filter(|id| id.starts_with("AC-"))
            .map(str::to_owned)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        task.acceptance_ids.sort();
        task.description = task.description.trim().into();
    }
    let plan = Plan {
        criteria,
        tasks: items,
    };
    plan.validate()?;
    Ok(plan)
}

pub(super) fn completed(text: &str, id: &str) -> Option<bool> {
    lines_outside_fences(text)
        .into_iter()
        .filter_map(|line| checklist(line).map(|item| (line, item)))
        .enumerate()
        .find_map(|(index, (line, item))| {
            let (key, _) = label(item, "T-", format!("T-{:02}", index + 1));
            (key == id).then(|| {
                list_item(line)
                    .is_some_and(|item| item.starts_with("[x]") || item.starts_with("[X]"))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_allow_progress_but_preserve_task_definitions() {
        let tasks = "# Tasks\n- [ ] T-01 Work\n  Acceptance: AC-01\n```md\n- [ ] Example\n```\n";
        let original = revision("criteria", tasks);
        let done = tasks.replacen("[ ]", "[x]", 1);
        assert_eq!(
            original,
            revision(
                "criteria",
                &format!("{done}\n## Verification Results\n- AC-01: passed — tests\n")
            )
        );
        assert_ne!(original, revision("new criteria", tasks));
        assert_ne!(
            original,
            revision("criteria", &tasks.replace("Work", "Changed"))
        );
        assert_ne!(
            original,
            revision("criteria", &tasks.replace("[ ] Example", "[x] Example"))
        );
        assert_ne!(
            original,
            revision(
                "criteria",
                &format!("{done}\n## Verification Results\n- [ ] Extra task\n")
            )
        );
    }

    #[test]
    fn reads_checklists_in_order_ignores_fences_and_keeps_criteria_in_their_section() {
        let requirements = "# Spec\n- Outside\n## Acceptance Criteria\n- AC-01: Cancellation writes no files.\n  - Includes existing files.\n- AC-02: Repository is initialized.\n## Notes\n- Outside too";
        let tasks = "### 1.1 Initialize Project Structure\n- [ ] Create project root directory\n```md\n- [ ] Example only\n```\n- [x] T-02 Initialize git repository\n  Acceptance: AC-02\n~~~\n- [ ] Another example\n~~~\n- [ ] T-03 Create README.md\n  Acceptance: AC-01\n- [ ]\n";
        let plan = plan(requirements, tasks).unwrap();
        assert_eq!(plan.criteria.len(), 2);
        assert!(plan.criteria[0].text.contains("Includes existing files"));
        assert!(!plan.criteria[1].text.contains("Outside"));
        assert_eq!(
            plan.tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            ["T-01", "T-02", "T-03"]
        );
        assert_eq!(plan.tasks[1].title, "Initialize git repository");
        assert_eq!(plan.tasks[1].acceptance_ids, ["AC-02"]);
        assert!(self::plan(requirements, "- [ ] T-01 First\n- [ ] T-01 Duplicate").is_err());
        assert!(self::plan(requirements, "- [ ] Task\n  Acceptance: AC-99").is_err());
        let legacy =
            self::requirements("## 验收标准（草稿）\n### AC-01\n显示 0。\n\n验证方法：打开页面。")
                .unwrap();
        assert_eq!(legacy[0].id, "AC-01");
        assert!(legacy[0].text.contains("显示 0。"));
    }
}
