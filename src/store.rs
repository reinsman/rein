//! daemon 的注册配置、执行检查点与持久化 inbox/outbox。
use anyhow::{Context, Result, ensure};
use prost::Message;
use rein_proto::hub::v1 as pb;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::path::PathBuf;

pub const SCHEMA: &str = include_str!("../migrations/0001_execution.sql");
#[derive(Clone)]
pub struct LocalStore {
    pub path: PathBuf,
    pub pool: SqlitePool,
}
impl LocalStore {
    pub async fn open(path: PathBuf) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        sqlx::raw_sql(include_str!("../migrations/0002_hub.sql"))
            .execute(&pool)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/0003_agent_availability.sql"))
            .execute(&pool)
            .await?;
        Ok(Self { path, pool })
    }
    pub async fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT value FROM bridge_settings WHERE key=?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query("INSERT INTO bridge_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).bind(value).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn prepare(&self, lease: &pb::RunLease, backend: &str) -> Result<bool> {
        let run = lease.run.as_ref().context("lease missing run")?;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query("INSERT OR IGNORE INTO bridge_attempts VALUES(?,?,'claimed')")
            .bind(&run.id)
            .bind(lease.encode_to_vec())
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO execution_mapping(run_id,attempt_id,session_id,backend) VALUES(?,?,?,?)",
        )
        .bind(&run.id)
        .bind(&run.attempt_id)
        .bind(&run.session_id)
        .bind(backend)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO bridge_sessions(session_id,agent_id) VALUES(?,?) ON CONFLICT DO NOTHING",
        )
        .bind(&run.session_id)
        .bind(&run.agent_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn append(
        &self,
        attempt: pb::AttemptRef,
        payload: pb::execution_event::Payload,
    ) -> Result<pb::ExecutionEvent> {
        let mut tx = self.pool.begin().await?;
        let sequence: i64 = sqlx::query_scalar(
            "SELECT next_sequence FROM execution_mapping WHERE run_id=? AND attempt_id=?",
        )
        .bind(&attempt.run_id)
        .bind(&attempt.attempt_id)
        .fetch_one(&mut *tx)
        .await?;
        let event = pb::ExecutionEvent {
            attempt: Some(attempt.clone()),
            sequence: sequence as u64,
            payload: Some(payload),
        };
        sqlx::query("INSERT INTO event_outbox VALUES(?,?,?,?)")
            .bind(&attempt.run_id)
            .bind(&attempt.attempt_id)
            .bind(sequence)
            .bind(event.encode_to_vec())
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE execution_mapping SET next_sequence=next_sequence+1 WHERE run_id=? AND attempt_id=?").bind(&attempt.run_id).bind(&attempt.attempt_id).execute(&mut *tx).await?;
        if matches!(event.payload, Some(pb::execution_event::Payload::Result(_))) {
            sqlx::query("UPDATE bridge_attempts SET phase='finished' WHERE run_id=?")
                .bind(&attempt.run_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(event)
    }
    pub async fn pending(&self) -> Result<Vec<pb::ExecutionEvent>> {
        let values: Vec<Vec<u8>> =
            sqlx::query_scalar("SELECT payload FROM event_outbox ORDER BY run_id,sequence")
                .fetch_all(&self.pool)
                .await?;
        values
            .iter()
            .map(|v| pb::ExecutionEvent::decode(v.as_slice()).map_err(Into::into))
            .collect()
    }
    pub async fn ack(&self, ack: &pb::EventAck) -> Result<()> {
        let a = ack.attempt.as_ref().context("ACK missing attempt")?;
        let mut tx = self.pool.begin().await?;
        let next: Option<i64> = sqlx::query_scalar(
            "SELECT next_sequence FROM execution_mapping WHERE run_id=? AND attempt_id=?",
        )
        .bind(&a.run_id)
        .bind(&a.attempt_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(next) = next {
            ensure!(
                ack.through_sequence < next as u64,
                "Hub ACK exceeds local event sequence"
            );
            sqlx::query("UPDATE execution_mapping SET last_acked_sequence=MAX(last_acked_sequence,?) WHERE run_id=? AND attempt_id=?").bind(ack.through_sequence as i64).bind(&a.run_id).bind(&a.attempt_id).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM event_outbox WHERE run_id=? AND attempt_id=? AND sequence<=?")
                .bind(&a.run_id)
                .bind(&a.attempt_id)
                .bind(ack.through_sequence as i64)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn acknowledged(&self, a: &pb::AttemptRef) -> Result<u64> {
        let n: i64 = sqlx::query_scalar(
            "SELECT last_acked_sequence FROM execution_mapping WHERE run_id=? AND attempt_id=?",
        )
        .bind(&a.run_id)
        .bind(&a.attempt_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(n as u64)
    }
    pub async fn checkpoints(&self) -> Result<Vec<pb::AttemptCheckpoint>> {
        let rows =
            sqlx::query("SELECT run_id,attempt_id,last_acked_sequence FROM execution_mapping")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| pb::AttemptCheckpoint {
                attempt: Some(pb::AttemptRef {
                    run_id: r.get(0),
                    attempt_id: r.get(1),
                }),
                last_acked_sequence: r.get::<i64, _>(2) as u64,
                execution: None,
            })
            .collect())
    }
    pub async fn phase(&self, run_id: &str, phase: &str) -> Result<()> {
        sqlx::query("UPDATE bridge_attempts SET phase=? WHERE run_id=?")
            .bind(phase)
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn outbox_sequences_acknowledgments_and_terminal_phase_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("daemon.sqlite");
        let store = LocalStore::open(path.clone()).await.unwrap();
        let run = pb::Run {
            id: "run".into(),
            attempt_id: "attempt".into(),
            agent_id: "agent".into(),
            session_id: "session".into(),
            ..Default::default()
        };
        let lease = pb::RunLease {
            run: Some(run),
            ..Default::default()
        };
        assert!(store.prepare(&lease, "native").await.unwrap());
        assert!(!store.prepare(&lease, "native").await.unwrap());
        let attempt = pb::AttemptRef {
            run_id: "run".into(),
            attempt_id: "attempt".into(),
        };
        let start = store
            .append(
                attempt.clone(),
                pb::execution_event::Payload::State(pb::StateEvent {
                    state: pb::RunState::Running as i32,
                }),
            )
            .await
            .unwrap();
        assert_eq!(start.sequence, 1);
        store.pool.close().await;
        let store = LocalStore::open(path).await.unwrap();
        assert_eq!(store.pending().await.unwrap(), vec![start]);
        store
            .append(
                attempt.clone(),
                pb::execution_event::Payload::Result(pb::ResultEvent {
                    state: pb::RunState::Completed as i32,
                    execution_stopped: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM bridge_attempts WHERE run_id='run'")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(phase, "finished");
        assert!(
            store
                .ack(&pb::EventAck {
                    attempt: Some(attempt.clone()),
                    through_sequence: 3
                })
                .await
                .is_err()
        );
        let ack = pb::EventAck {
            attempt: Some(attempt),
            through_sequence: 2,
        };
        store.ack(&ack).await.unwrap();
        store.ack(&ack).await.unwrap();
        assert!(store.pending().await.unwrap().is_empty());
        assert_eq!(store.checkpoints().await.unwrap()[0].last_acked_sequence, 2);
    }
}
