//! A2A 1.0 JSON-RPC 方法名，复用 ra2a 协议类型；不重试可能产生副作用的提交。
use anyhow::{Context, Result, ensure};
use ra2a::types::{
    AgentCard, CancelTaskRequest, GetTaskRequest, SendMessageRequest, SendMessageResponse, Task,
};
use reqwest::header::HeaderMap;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) struct Client {
    http: reqwest::Client,
    url: String,
}
impl Client {
    pub fn new(url: &str, headers: HeaderMap) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .default_headers(headers)
                .build()?,
            url: url.into(),
        })
    }
    pub async fn get_agent_card(&self) -> Result<AgentCard> {
        let mut url = url::Url::parse(&self.url)?;
        url.set_path("/.well-known/agent-card.json");
        url.set_query(None);
        read_json(self.http.get(url).send().await?.error_for_status()?).await
    }
    async fn rpc<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<R> {
        let id = Uuid::new_v4().to_string();
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let response = self
            .http
            .post(&self.url)
            .json(&message)
            .send()
            .await?
            .error_for_status()?;
        let body: Value = read_json(response).await?;
        ensure!(body["id"].as_str() == Some(&id), "A2A response ID mismatch");
        if let Some(error) = body.get("error") {
            anyhow::bail!(
                "A2A {method} rejected: {}",
                error["message"].as_str().unwrap_or("remote protocol error")
            )
        }
        serde_json::from_value(
            body.get("result")
                .cloned()
                .context("A2A response missing result")?,
        )
        .context("invalid A2A 1.0 response")
    }
    pub async fn send_message(&self, r: &SendMessageRequest) -> Result<SendMessageResponse> {
        self.rpc("SendMessage", r).await
    }
    pub async fn get_task(&self, r: &GetTaskRequest) -> Result<Task> {
        self.rpc("GetTask", r).await
    }
    pub async fn cancel_task(&self, r: &CancelTaskRequest) -> Result<Task> {
        self.rpc("CancelTask", r).await
    }
}

async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    const LIMIT: usize = 8 * 1024 * 1024;
    ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= LIMIT as u64),
        "A2A response exceeds 8 MiB"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= LIMIT,
            "A2A response exceeds 8 MiB"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
