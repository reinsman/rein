-- 原生路径、A2A 标识分别保存；平台状态仍以 reinhub 为准。
CREATE TABLE IF NOT EXISTS execution_mapping (
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    backend TEXT NOT NULL CHECK (backend IN ('native', 'a2a')),
    native_session_id TEXT,
    native_turn_id TEXT,
    a2a_context_id TEXT,
    a2a_task_id TEXT,
    last_acked_sequence INTEGER NOT NULL DEFAULT 0,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (run_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS event_outbox (
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    payload BLOB NOT NULL,
    PRIMARY KEY (run_id, attempt_id, sequence)
);

CREATE TABLE IF NOT EXISTS command_inbox (
    command_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    ack_state INTEGER NOT NULL
);
