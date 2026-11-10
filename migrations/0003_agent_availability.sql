-- completed=0 为待同步的下线意图；先持久化，避免重启后重新发布旧注册。
CREATE TABLE IF NOT EXISTS agent_removals (
    name TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
);
