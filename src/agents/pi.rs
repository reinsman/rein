use super::AgentConfig;
use crate::execution::native::NativeRunOptions;

pub fn options(config: &AgentConfig) -> NativeRunOptions {
    NativeRunOptions {
        provider: a2alinker::AgentKind::Pi,
        workspace: config.directory.clone().unwrap_or_default(),
        executable: config.executable.clone(),
        native_config: config.native_config.clone(),
        model: config.model.clone(),
        prepare: config.prepare.clone(),
        ..Default::default()
    }
}
