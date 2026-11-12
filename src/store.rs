//! Large, append-only chat and execution data. Configuration lives in JSON files.
use anyhow::Result;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::path::PathBuf;

#[derive(Clone)]
pub struct LocalStore {
    pub pool: SqlitePool,
}
impl LocalStore {
    pub async fn open(path: PathBuf) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/0004_local.sql"))
            .execute(&pool)
            .await?;
        Ok(Self { pool })
    }
}
