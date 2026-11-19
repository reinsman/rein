//! Small, editable agent configurations. Execution history belongs in SQLite.
pub mod codex;
pub mod pi;
pub mod skills;
pub mod type_config;

use crate::execution::{a2a::A2aRunOptions, native::NativeRunOptions};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum AgentType {
    Pi,
    Codex,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permissions {
    #[default]
    FullAccess,
    WorkspaceWrite,
    ReadOnly,
}
impl AgentType {
    fn validate_permissions(self, permissions: Permissions) -> Result<()> {
        ensure!(
            self != Self::Pi || permissions == Permissions::FullAccess,
            "Pi has no native permission sandbox; only full_access is supported"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    #[default]
    Rein,
    Native,
}
impl SkillSource {
    fn is_rein(&self) -> bool {
        *self == Self::Rein
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub name: String,
    pub provider: AgentType,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub a2a: Option<A2aRunOptions>,
    #[serde(default)]
    pub directory: Option<PathBuf>,
    #[serde(default)]
    pub executable: Option<PathBuf>,
    #[serde(default)]
    pub native_config: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prepare: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skill_directories: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "SkillSource::is_rein")]
    pub skill_source: SkillSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_skills: Vec<PathBuf>,
}
impl AgentConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.name.is_empty()
                && self.name.chars().count() <= 64
                && self
                    .name
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_'),
            "agent name must contain 1–64 letters, digits, '-' or '_'"
        );
        if let Some(remote) = &self.a2a {
            remote.validate()?;
            ensure!(
                self.directory.is_none()
                    && self.executable.is_none()
                    && self.native_config.is_none()
                    && self.model.is_none()
                    && self.prepare.is_none()
                    && self.permissions.unwrap_or_default() == Permissions::FullAccess
                    && self.reasoning_effort.is_none()
                    && self.skill_directories.is_empty()
                    && self.skill_source == SkillSource::Rein
                    && self.disabled_skills.is_empty(),
                "A2A agents cannot have local execution options"
            );
        } else {
            self.provider
                .validate_permissions(self.permissions.unwrap_or_default())?;
            if let Some(effort) = &self.reasoning_effort {
                let allowed: &[&str] = match self.provider {
                    AgentType::Codex => &["none", "minimal", "low", "medium", "high", "xhigh"],
                    AgentType::Pi => &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
                };
                ensure!(
                    allowed.contains(&effort.as_str()),
                    "unsupported reasoning_effort for this provider"
                );
            }
            for path in &self.skill_directories {
                ensure!(
                    path.is_absolute() && path.is_dir(),
                    "skill directory must be an existing absolute directory"
                );
            }
            for path in &self.disabled_skills {
                ensure!(
                    path.is_absolute() && path.file_name().is_some_and(|name| name == "SKILL.md"),
                    "disabled skill must be an absolute SKILL.md path"
                );
            }
            ensure!(
                self.directory
                    .as_ref()
                    .is_none_or(|p| p.is_absolute() && p.is_dir()),
                "directory must be an existing absolute directory"
            );
            ensure!(
                self.native_config.as_ref().is_none_or(|p| p.is_absolute()),
                "native_config must be an absolute file or directory"
            );
            ensure!(
                self.executable
                    .as_ref()
                    .is_none_or(|p| p.components().count() == 1 || p.is_absolute()),
                "executable must be a command name or an absolute path"
            );
        }
        Ok(())
    }
    pub fn native_options(&self, directory: &Path) -> Result<NativeRunOptions> {
        self.validate()?;
        let mut options = match self.provider {
            AgentType::Pi => pi::options(self),
            AgentType::Codex => codex::options(self),
        };
        options.skill_directories = self.skill_directories.clone();
        options.only_explicit_skills = self.skill_source == SkillSource::Rein;
        if options.only_explicit_skills {
            options
                .skill_directories
                .insert(0, directory.join("skills"));
        }
        match self.provider {
            AgentType::Codex => {
                let permissions = self.permissions.unwrap_or_default();
                options.approval_policy = Some(
                    match permissions {
                        Permissions::FullAccess => "never",
                        _ => "on-request",
                    }
                    .into(),
                );
                match permissions {
                    Permissions::FullAccess => options.sandbox = Some("danger-full-access".into()),
                    Permissions::WorkspaceWrite => options.sandbox = Some("workspace-write".into()),
                    Permissions::ReadOnly => options.sandbox = Some("read-only".into()),
                }
                if let Some(effort) = &self.reasoning_effort {
                    options.args.extend([
                        "-c".into(),
                        format!("model_reasoning_effort={}", serde_json::to_string(effort)?),
                    ]);
                }
                if !self.disabled_skills.is_empty() {
                    let entries = self
                        .disabled_skills
                        .iter()
                        .map(|path| {
                            Ok(format!(
                                "{{path={},enabled=false}}",
                                serde_json::to_string(path)?
                            ))
                        })
                        .collect::<Result<Vec<_>>>()?;
                    options.args.extend([
                        "-c".into(),
                        format!("skills.config=[{}]", entries.join(",")),
                    ]);
                }
            }
            AgentType::Pi => {
                if let Some(effort) = &self.reasoning_effort {
                    options.args.extend(["--thinking".into(), effort.clone()]);
                }
                if options.only_explicit_skills || !self.disabled_skills.is_empty() {
                    options.args.push("--no-skills".into());
                    options.skill_directories.clear();
                    for skill in skills::discover(self, directory)? {
                        if skill.enabled {
                            options
                                .args
                                .extend(["--skill".into(), skill.path.to_string_lossy().into()]);
                        }
                    }
                }
            }
        }
        Ok(options)
    }
}

#[derive(Clone)]
pub struct AgentFiles(pub PathBuf);
impl AgentFiles {
    pub fn list(&self) -> Result<Vec<AgentConfig>> {
        let mut configs = Vec::new();
        for entry in fs::read_dir(&self.0)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let config: AgentConfig = read_json(&path)?;
                config
                    .validate()
                    .with_context(|| format!("invalid agent config {}", path.display()))?;
                ensure!(
                    path.file_stem().and_then(|s| s.to_str()) == Some(&config.name),
                    "config filename must match agent name: {}",
                    path.display()
                );
                configs.push(config);
            }
        }
        configs.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(configs)
    }
    pub fn get(&self, name: &str) -> Result<AgentConfig> {
        self.list()?
            .into_iter()
            .find(|a| a.name == name)
            .context("agent not found")
    }
    pub fn add(&self, config: &AgentConfig) -> Result<()> {
        config.validate()?;
        let path = self.0.join(format!("{}.json", config.name));
        let temp = self.0.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        write_json(&temp, config)?;
        // An exclusive hard link publishes the whole file without replacing a saved agent.
        let result = fs::hard_link(&temp, &path)
            .with_context(|| format!("create {}; agent may already exist", path.display()));
        fs::remove_file(&temp)?;
        result?;
        fs::File::open(&self.0)?.sync_all()?;
        Ok(())
    }
    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<AgentConfig> {
        let mut config = self.get(name)?;
        config.enabled = enabled;
        write_json(&self.0.join(format!("{}.json", name)), &config)?;
        Ok(config)
    }
    pub fn update(&self, name: &str, mut config: AgentConfig) -> Result<AgentConfig> {
        let previous = self.get(name)?;
        ensure!(
            config.name == name,
            "agent name cannot change; history uses this identity"
        );
        config.enabled = previous.enabled;
        config.validate()?;
        write_json(&self.0.join(format!("{name}.json")), &config)?;
        Ok(config)
    }
    pub fn remove(&self, name: &str) -> Result<()> {
        self.get(name)?;
        fs::remove_file(self.0.join(format!("{}.json", name)))?;
        Ok(())
    }
}
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("read {}", path.display()))?)
        .with_context(|| format!("parse {}", path.display()))
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut contents = serde_json::to_vec_pretty(value)?;
    contents.push(b'\n');
    write_file(path, &contents, true)
}

fn write_file(path: &Path, contents: &[u8], replace: bool) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        if replace {
            fs::rename(&tmp, path)?;
        } else if let Err(error) = fs::hard_link(&tmp, path)
            && error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error.into());
        }
        fs::File::open(path.parent().context("missing parent")?)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}
