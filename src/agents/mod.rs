//! Small, editable agent configurations. Execution history belongs in SQLite.
pub mod codex;
pub mod pi;

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
                    && self.prepare.is_none(),
                "A2A agents cannot have local execution options"
            );
        } else {
            ensure!(
                self.directory
                    .as_ref()
                    .is_some_and(|p| p.is_absolute() && p.is_dir()),
                "directory must be an existing absolute directory"
            );
            ensure!(
                self.native_config
                    .as_ref()
                    .is_none_or(|p| p.is_absolute() && p.exists()),
                "native_config must be an existing absolute file or directory"
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
    pub fn native_options(&self) -> NativeRunOptions {
        match self.provider {
            AgentType::Pi => pi::options(self),
            AgentType::Codex => codex::options(self),
        }
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
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::File::open(path.parent().context("missing parent")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
