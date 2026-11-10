CREATE TABLE IF NOT EXISTS bridge_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registrations (name TEXT PRIMARY KEY, agent_id TEXT UNIQUE NOT NULL, runtime_id TEXT UNIQUE NOT NULL, configuration TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_attempts (run_id TEXT PRIMARY KEY, lease BLOB NOT NULL, phase TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_sessions (session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, native_id TEXT, a2a_context_id TEXT, blocked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS command_results (command_id TEXT PRIMARY KEY, ack BLOB NOT NULL);
