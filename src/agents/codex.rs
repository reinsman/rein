use super::{AgentConfig, Permissions};
use crate::execution::native::NativeRunOptions;

pub fn options(config: &AgentConfig) -> NativeRunOptions {
    let (sandbox, policy, reviewer) = match config.permissions.unwrap_or_default() {
        Permissions::AskForApproval => ("workspace-write", "on-request", "user"),
        Permissions::ApproveForMe => ("workspace-write", "on-request", "auto_review"),
        Permissions::FullAccess => ("danger-full-access", "never", "user"),
        Permissions::ReadOnly => ("read-only", "on-request", "user"),
    };
    NativeRunOptions {
        provider: a2alinker::AgentKind::Codex,
        workspace: config.directory.clone().unwrap_or_default(),
        executable: config.executable.clone(),
        native_config: config.native_config.clone(),
        model: config.model.clone(),
        prepare: config.prepare.clone(),
        sandbox: Some(sandbox.into()),
        approval_policy: Some(policy.into()),
        approvals_reviewer: Some(reviewer.into()),
        ..Default::default()
    }
}
