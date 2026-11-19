CREATE TABLE IF NOT EXISTS local_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    native_id TEXT,
    context_id TEXT,
    blocked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS local_runs (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS local_runs_agent ON local_runs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS local_runs_session ON local_runs(session_id);
CREATE TABLE IF NOT EXISTS local_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
);
CREATE TABLE IF NOT EXISTS local_commands (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    ack TEXT NOT NULL
);
