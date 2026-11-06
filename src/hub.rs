//! Hub gRPC/TLS 客户端。只有 daemon 使用；CLI 继续通过本地 IPC 操作。

use anyhow::{Context, Result, bail};
use rein_proto::hub::v1::{
    self as pb, auth_service_client::AuthServiceClient, daemon_service_client::DaemonServiceClient,
    run_service_client::RunServiceClient, runtime_service_client::RuntimeServiceClient,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint};

// 不派生 Debug，避免输出 Hub 连接凭据。
pub struct HubClient {
    channel: Channel,
    credential: Option<String>,
}

impl HubClient {
    pub async fn connect(url: &str, ca_pem: Option<Vec<u8>>) -> Result<Self> {
        if !url.starts_with("https://") {
            bail!("Hub connection requires https:// and TLS certificate validation");
        }
        let mut tls = ClientTlsConfig::new().with_webpki_roots();
        if let Some(pem) = ca_pem {
            tls = tls.ca_certificate(Certificate::from_pem(pem));
        }
        let channel = Endpoint::from_shared(url.to_owned())?
            .connect_timeout(std::time::Duration::from_secs(5))
            .tls_config(tls)?
            .connect()
            .await?;
        Ok(Self {
            channel,
            credential: None,
        })
    }

    pub fn set_credential(&mut self, credential: String) {
        self.credential = Some(credential);
    }

    fn authenticated<T>(&self, message: T) -> Result<tonic::Request<T>> {
        let credential = self
            .credential
            .as_ref()
            .context("daemon is not authenticated with Hub")?;
        let mut request = tonic::Request::new(message);
        let mut value: tonic::metadata::MetadataValue<_> =
            format!("Bearer {credential}")
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid Hub credential metadata"))?;
        value.set_sensitive(true);
        request.metadata_mut().insert("authorization", value);
        Ok(request)
    }

    pub async fn start_login(
        &self,
        message: pb::StartLoginRequest,
    ) -> Result<pb::StartLoginResponse> {
        let mut request = tonic::Request::new(message);
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(AuthServiceClient::new(self.channel.clone())
            .start_login(request)
            .await?
            .into_inner())
    }

    pub async fn get_login_status(
        &self,
        message: pb::GetLoginStatusRequest,
    ) -> Result<pb::GetLoginStatusResponse> {
        let mut request = tonic::Request::new(message);
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(AuthServiceClient::new(self.channel.clone())
            .get_login_status(request)
            .await?
            .into_inner())
    }

    pub async fn register_runtime(
        &self,
        message: pb::RegisterRuntimeRequest,
    ) -> Result<pb::RegisterRuntimeResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RuntimeServiceClient::new(self.channel.clone())
            .register_runtime(request)
            .await?
            .into_inner())
    }

    pub async fn claim_runs(&self, message: pb::ClaimRunsRequest) -> Result<pb::ClaimRunsResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .claim_runs(request)
            .await?
            .into_inner())
    }

    pub async fn get_run(&self, message: pb::GetRunRequest) -> Result<pb::GetRunResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .get_run(request)
            .await?
            .into_inner())
    }

    pub async fn create_run(&self, message: pb::CreateRunRequest) -> Result<pb::CreateRunResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .create_run(request)
            .await?
            .into_inner())
    }

    pub async fn request_cancel(
        &self,
        message: pb::RequestCancelRequest,
    ) -> Result<pb::RequestCancelResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .request_cancel(request)
            .await?
            .into_inner())
    }

    pub async fn reply_interaction(
        &self,
        message: pb::ReplyInteractionRequest,
    ) -> Result<pb::ReplyInteractionResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .reply_interaction(request)
            .await?
            .into_inner())
    }

    pub async fn send_instruction(
        &self,
        message: pb::SendInstructionRequest,
    ) -> Result<pb::SendInstructionResponse> {
        let mut request = self.authenticated(message)?;
        request.set_timeout(std::time::Duration::from_secs(10));
        Ok(RunServiceClient::new(self.channel.clone())
            .send_instruction(request)
            .await?
            .into_inner())
    }

    pub async fn event_stream(
        &self,
        outgoing: mpsc::Receiver<pb::ConnectRequest>,
    ) -> Result<tonic::Streaming<pb::ConnectResponse>> {
        // TODO: 后台任务先发送 Hello/恢复检查点；对账成功后才 claim 和执行。
        let request = self.authenticated(ReceiverStream::new(outgoing))?;
        Ok(DaemonServiceClient::new(self.channel.clone())
            .connect(request)
            .await?
            .into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_hub_is_rejected_without_connecting() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(HubClient::connect("http://127.0.0.1:1", None));
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("requires https://")
        );
    }
}
