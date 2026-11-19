use super::{AgentFiles, AgentType, Permissions, write_file, write_json};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
pub struct TypeConfigFile {
    pub name: String,
    pub path: PathBuf,
    pub content: String,
}

#[derive(Serialize)]
pub struct TypeDefaults {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permissions: Permissions,
}

impl AgentFiles {
    pub fn type_defaults(
        &self,
        provider: AgentType,
        files: &[TypeConfigFile],
    ) -> Result<TypeDefaults> {
        let name = match provider {
            AgentType::Codex => "config.toml",
            AgentType::Pi => "settings.json",
        };
        let text = &files
            .iter()
            .find(|file| file.name == name)
            .context("managed defaults file is missing")?
            .content;
        let (model, model_provider, reasoning_effort) = match provider {
            AgentType::Codex => {
                let table: toml::Table = text.parse().context("invalid TOML configuration")?;
                let get = |key| {
                    table
                        .get(key)
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned)
                };
                (
                    get("model"),
                    get("model_provider"),
                    get("model_reasoning_effort"),
                )
            }
            AgentType::Pi => {
                let table = json_config(text)?;
                let get = |key| table.get(key).and_then(Value::as_str).map(str::to_owned);
                (
                    get("defaultModel"),
                    get("defaultProvider"),
                    get("defaultThinkingLevel"),
                )
            }
        };
        Ok(TypeDefaults {
            model,
            model_provider,
            reasoning_effort,
            permissions: self.default_permissions(provider)?,
        })
    }

    pub fn default_permissions(&self, provider: AgentType) -> Result<Permissions> {
        let path = self.type_directory(provider).join("permissions.json");
        let Some(content) = read_file(&path, true)? else {
            return Ok(Permissions::default());
        };
        let permissions =
            serde_json::from_str(&content).with_context(|| format!("parse {}", path.display()))?;
        provider.validate_permissions(permissions)?;
        Ok(permissions)
    }

    pub fn save_default_permissions(
        &self,
        provider: AgentType,
        permissions: Permissions,
    ) -> Result<()> {
        provider.validate_permissions(permissions)?;
        let directory = self.prepare_type(provider, None)?;
        write_json(&directory.join("permissions.json"), &permissions)
    }
}

impl AgentType {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    fn files(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &["config.toml"],
            Self::Pi => &["models.json", "settings.json"],
        }
    }

    fn source(self, explicit: Option<&Path>) -> Result<PathBuf> {
        if let Some(path) = explicit {
            if path.is_dir() {
                return Ok(path.into());
            }
            ensure!(
                path.is_file()
                    && self
                        .files()
                        .iter()
                        .any(|name| path.file_name().is_some_and(|file| file == *name)),
                "invalid original {} config path",
                self.name()
            );
            return Ok(path
                .parent()
                .context("original config has no parent")?
                .into());
        }
        let (key, fallback) = match self {
            Self::Codex => ("CODEX_HOME", ".codex"),
            Self::Pi => ("PI_CODING_AGENT_DIR", ".pi/agent"),
        };
        let path = match std::env::var_os(key) {
            Some(path) => PathBuf::from(path),
            None => {
                PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(fallback)
            }
        };
        ensure!(path.is_absolute(), "original config path must be absolute");
        Ok(path)
    }
}

impl AgentFiles {
    pub fn type_directory(&self, provider: AgentType) -> PathBuf {
        self.0.join(provider.name())
    }

    pub fn prepare_type(&self, provider: AgentType, explicit: Option<&Path>) -> Result<PathBuf> {
        let directory = self.type_directory(provider);
        fs::create_dir_all(&directory)?;
        ensure!(
            fs::symlink_metadata(&directory)?.file_type().is_dir(),
            "agent type directory must not be a symlink"
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        for name in provider.files() {
            let path = directory.join(name);
            if read_file(&path, true)?.is_some() {
                continue;
            }
            let source = provider.source(explicit)?;
            let original = read_file(&source.join(name), false)?.unwrap_or_default();
            let contents = minimal(name, &original)
                .with_context(|| format!("import {}", source.join(name).display()))?;
            write_file(&path, contents.as_bytes(), false)?;
        }
        Ok(directory)
    }

    pub fn type_files(&self, provider: AgentType) -> Result<Vec<TypeConfigFile>> {
        let directory = self.prepare_type(provider, None)?;
        provider
            .files()
            .iter()
            .map(|name| {
                let path = directory.join(name);
                let content = read_file(&path, true)?.context("managed config file is missing")?;
                Ok(TypeConfigFile {
                    name: (*name).to_owned(),
                    path,
                    content,
                })
            })
            .collect()
    }

    pub fn save_type_file(
        &self,
        provider: AgentType,
        name: &str,
        content: &str,
        previous: &str,
    ) -> Result<()> {
        ensure!(
            provider.files().contains(&name),
            "unknown agent type configuration file"
        );
        ensure!(
            content.len() as u64 <= MAX_BYTES,
            "configuration exceeds 256 KiB"
        );
        if name == "config.toml" {
            content
                .parse::<toml::Table>()
                .context("invalid TOML configuration")?;
        } else {
            json_config(content)?;
        }
        let directory = self.prepare_type(provider, None)?;
        let file = directory.join(name);
        ensure!(
            read_file(&file, true)?.as_deref() == Some(previous),
            "配置文件已变化，请重新读取后再保存"
        );
        write_file(&file, content.as_bytes(), true)
    }
}

fn read_file(path: &Path, managed: bool) -> Result<Option<String>> {
    let metadata = if managed {
        fs::symlink_metadata(path)
    } else {
        fs::metadata(path)
    };
    let metadata = match metadata {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_file(),
        "configuration must be a regular file: {}",
        path.display()
    );
    ensure!(
        metadata.len() <= MAX_BYTES,
        "configuration exceeds 256 KiB: {}",
        path.display()
    );
    Ok(Some(fs::read_to_string(path)?))
}

fn json_config(text: &str) -> Result<serde_json::Map<String, Value>> {
    serde_json::from_str(text).context("invalid JSON configuration")
}

fn minimal(name: &str, original: &str) -> Result<String> {
    if name == "config.toml" {
        let mut table: toml::Table = original.parse().context("invalid source TOML")?;
        table.retain(|key, _| {
            matches!(
                key,
                "model"
                    | "model_reasoning_effort"
                    | "model_provider"
                    | "model_providers"
                    | "openai_base_url"
            )
        });
        return Ok(toml::to_string_pretty(&table)?);
    }
    let mut object = if original.is_empty() {
        Default::default()
    } else {
        json_config(original)?
    };
    object.retain(|key, _| match name {
        "models.json" => key == "providers",
        _ => matches!(
            key.as_str(),
            "defaultModel" | "defaultProvider" | "defaultThinkingLevel"
        ),
    });
    if name == "models.json" {
        object
            .entry("providers")
            .or_insert_with(|| serde_json::json!({}));
    }
    Ok(serde_json::to_string_pretty(&object)? + "\n")
}
