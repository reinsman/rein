//! User-level native skills; installing the bundled skill never runs an agent or a setup shell.
use super::{AgentConfig, AgentType, SkillSource};
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const REIN_SPEC: &str = include_str!("../../skills/rein-spec/SKILL.md");
pub const FEATURE_DESIGN: &str =
    include_str!("../../skills/rein-spec/references/design-feature.md");
pub const BUGFIX_DESIGN: &str = include_str!("../../skills/rein-spec/references/design-bugfix.md");

#[derive(Debug, Serialize)]
pub struct SkillStatus {
    pub names: Vec<String>,
    pub entries: Vec<SkillEntry>,
    pub rein_spec_installed: bool,
    pub install_path: Option<PathBuf>,
    pub source_path: PathBuf,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub path: PathBuf,
    pub enabled: bool,
}

pub fn prepare_source(directory: &Path) -> Result<()> {
    let source = directory.join("skills/rein-spec");
    for dir in [
        directory.join("skills"),
        source.clone(),
        source.join("references"),
    ] {
        fs::create_dir_all(&dir)?;
        let metadata = fs::symlink_metadata(&dir)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "skill source directories must not be symlinks"
        );
    }
    for (name, contents) in [
        ("references/design-feature.md", FEATURE_DESIGN),
        ("references/design-bugfix.md", BUGFIX_DESIGN),
        ("SKILL.md", REIN_SPEC),
    ] {
        let path = source.join(name);
        if !path.try_exists()? {
            publish(&path, contents.as_bytes())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_missing_design_guides_without_overwriting_custom_skill_resources() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("skills/rein-spec");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "user customization").unwrap();
        fs::write(
            source.join("references/design-feature.md"),
            "custom feature guide",
        )
        .unwrap();
        prepare_source(directory.path()).unwrap();
        assert_eq!(
            fs::read_to_string(source.join("SKILL.md")).unwrap(),
            "user customization"
        );
        assert_eq!(
            fs::read_to_string(source.join("references/design-feature.md")).unwrap(),
            "custom feature guide"
        );
        assert_eq!(
            fs::read_to_string(source.join("references/design-bugfix.md")).unwrap(),
            BUGFIX_DESIGN
        );
        fs::remove_file(source.join("references/design-feature.md")).unwrap();
        fs::remove_file(source.join("references/design-bugfix.md")).unwrap();
        fs::remove_dir(source.join("references")).unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), source.join("references")).unwrap();
        assert!(prepare_source(directory.path()).is_err());
        assert!(fs::read_dir(external.path()).unwrap().next().is_none());
    }

    #[test]
    fn discovers_manifest_names_and_ignores_incomplete_skills() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let skill = root.join("different-folder-name");
        fs::create_dir(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\r\nname: 'code-review'\r\ndescription: Review code\r\n---\r\nInstructions",
        )
        .unwrap();
        let invalid = root.join("rein-spec");
        fs::create_dir(&invalid).unwrap();
        fs::write(invalid.join("SKILL.md"), "unfinished").unwrap();
        std::os::unix::fs::symlink(root, root.join("cycle")).unwrap();
        let mut names = BTreeMap::new();
        scan(root, &mut names, &mut BTreeSet::new()).unwrap();
        assert_eq!(names.values().collect::<Vec<_>>(), vec!["code-review"]);
    }
}

// Publish complete contents without replacing an existing file, including a user's edited skill.
fn publish(path: &Path, contents: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        match fs::hard_link(&temp, path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

fn copy_resource(source: &Path, target: &Path) -> Result<()> {
    let kind = fs::symlink_metadata(source)?.file_type();
    if kind.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_resource(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        ensure!(
            kind.is_file(),
            "技能资源必须是普通文件或目录：{}",
            source.display()
        );
        fs::copy(source, target)?;
    }
    Ok(())
}

fn skill_name(path: &Path) -> Result<Option<String>> {
    let contents = fs::read_to_string(path)?;
    let mut lines = contents.lines();
    if lines.next() != Some("---") {
        return Ok(None);
    }
    let mut name = None;
    let mut description = false;
    for line in lines {
        if line == "---" {
            return Ok(if description { name } else { None });
        }
        // shortcut: accept standard scalar names; use a YAML parser if complex manifest names are needed.
        if let Some(value) = line.strip_prefix("name:") {
            let value = value.trim().trim_matches(['\'', '"']);
            if !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            {
                name = Some(value.to_owned());
            }
        }
        if let Some(value) = line.strip_prefix("description:") {
            description = !value.trim().is_empty();
        }
    }
    Ok(None)
}

fn home() -> Result<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").context("reind 的 HOME 未设置")?);
    ensure!(home.is_absolute(), "reind 的 HOME 必须是绝对路径");
    Ok(home)
}

fn roots(config: &AgentConfig) -> Result<Vec<PathBuf>> {
    ensure!(
        config.a2a.is_none(),
        "远程 A2A Agent 的技能需在远端安装，reind 无法检查"
    );
    let home = home()?;
    let mut options = a2alinker::Options::default();
    options.agent.kind = match config.provider {
        AgentType::Pi => a2alinker::AgentKind::Pi,
        AgentType::Codex => a2alinker::AgentKind::Codex,
    };
    options.agent.native_config = config.native_config.clone();
    let native = options.native_config_directory()?.unwrap_or_else(|| {
        let (key, default) = match config.provider {
            AgentType::Pi => ("PI_CODING_AGENT_DIR", ".pi/agent"),
            AgentType::Codex => ("CODEX_HOME", ".codex"),
        };
        std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(default))
    });
    ensure!(native.is_absolute(), "原生配置目录环境变量必须是绝对路径");
    let shared = home.join(".agents/skills");
    // shortcut: inspect reind's environment without executing prepare; custom HOME changes need explicit skill paths.
    Ok(match config.provider {
        AgentType::Pi => vec![native.join("skills"), shared],
        AgentType::Codex => vec![shared, native.join("skills")],
    })
}

fn scan(
    root: &Path,
    names: &mut BTreeMap<PathBuf, String>,
    visited: &mut BTreeSet<PathBuf>,
) -> Result<()> {
    if !root.try_exists()? {
        return Ok(());
    }
    let root = root.canonicalize()?;
    if !visited.insert(root.clone()) {
        return Ok(());
    }
    ensure!(
        visited.len() <= 2048,
        "用户级技能目录过多，请检查目录中的符号链接"
    );
    if root.join("SKILL.md").is_file() {
        if let Some(name) = skill_name(&root.join("SKILL.md"))? {
            names.insert(root.join("SKILL.md"), name);
        }
        return Ok(());
    }
    for entry in fs::read_dir(&root).with_context(|| format!("读取技能目录 {}", root.display()))?
    {
        let path = entry?.path();
        if path.is_dir() {
            scan(&path, names, visited)?;
        }
    }
    Ok(())
}

pub fn discover(config: &AgentConfig, directory: &Path) -> Result<Vec<SkillEntry>> {
    let mut directories = if config.skill_source == SkillSource::Rein {
        vec![directory.join("skills")]
    } else {
        roots(config)?
    };
    directories.extend(config.skill_directories.clone());
    if config.skill_source == SkillSource::Native
        && let Some(workspace) = &config.directory
    {
        directories.push(workspace.join(".agents/skills"));
        if config.provider == AgentType::Pi {
            directories.push(workspace.join(".pi/skills"));
        }
    }
    let mut entries = BTreeMap::new();
    let mut visited = BTreeSet::new();
    for directory in directories {
        scan(&directory, &mut entries, &mut visited)?;
    }
    let disabled: BTreeSet<_> = config
        .disabled_skills
        .iter()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
        .collect();
    Ok(entries
        .into_iter()
        .map(|(path, name)| SkillEntry {
            enabled: !disabled.contains(&path),
            name,
            path,
        })
        .collect())
}

pub fn status(config: &AgentConfig, directory: &Path) -> SkillStatus {
    let mut status = SkillStatus {
        names: vec![],
        entries: vec![],
        rein_spec_installed: false,
        install_path: None,
        source_path: directory.join("skills/rein-spec"),
        error: None,
    };
    let result = (|| -> Result<()> {
        let mut config = config.clone();
        if config.a2a.is_none() {
            let type_directory =
                super::AgentFiles(directory.join("agents")).type_directory(config.provider);
            config.native_config = Some(type_directory.clone());
            config.directory.get_or_insert(type_directory);
        }
        let roots = roots(&config)?;
        status.install_path = Some(roots[0].join("rein-spec"));
        status.entries = discover(&config, directory)?;
        let names: BTreeSet<_> = status
            .entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect();
        for root in roots {
            let manifest = root.join("rein-spec/SKILL.md");
            if manifest.is_file() && skill_name(&manifest)?.as_deref() == Some("rein-spec") {
                status.rein_spec_installed = true;
            }
        }
        status.names = names.into_iter().collect();
        Ok(())
    })();
    if let Err(error) = result {
        status.error = Some(format!("{error:#}"));
    }
    status
}

pub fn install(config: &AgentConfig, directory: &Path) -> Result<SkillStatus> {
    let current = status(config, directory);
    if let Some(error) = current.error {
        bail!("{error}");
    }
    if current.rein_spec_installed {
        return Ok(current);
    }
    let contents = fs::read(current.source_path.join("SKILL.md"))
        .context("无法读取 Rein 技能源文件，请检查 ~/.reind/skills/rein-spec")?;
    ensure!(
        skill_name(&current.source_path.join("SKILL.md"))?.as_deref() == Some("rein-spec"),
        "Rein 技能源文件必须声明 name: rein-spec 及 description"
    );
    let target = current.install_path.context("无法确定技能安装目录")?;
    fs::create_dir_all(target.parent().context("缺少技能目录")?)?;
    fs::create_dir(&target).with_context(|| {
        format!(
            "无法创建 {}；已有目录不会被覆盖，请检查后重试",
            target.display()
        )
    })?;
    let result = (|| -> Result<()> {
        for entry in fs::read_dir(&current.source_path)? {
            let entry = entry?;
            if entry.file_name() != "SKILL.md" {
                copy_resource(&entry.path(), &target.join(entry.file_name()))?;
            }
        }
        publish(&target.join("SKILL.md"), &contents)?;
        fs::File::open(&target)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&target);
    }
    result.with_context(|| format!("安装 rein-spec 到 {} 失败", target.display()))?;
    Ok(status(config, directory))
}
