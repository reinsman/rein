use anyhow::{Context, Result};
use hyper_util::rt::TokioIo;
use std::{io, sync::Arc, time::Duration};
use tokio_rustls::{
    TlsConnector,
    rustls::{
        self, DigitallySignedStruct, SignatureScheme,
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature},
        pki_types::{CertificateDer, ServerName, UnixTime},
    },
};
use tonic::transport::{Channel, Endpoint};

#[derive(Debug)]
struct SkipServerVerification(Arc<CryptoProvider>);

impl ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    // 只跳过证书身份校验，仍验证握手签名与服务端私钥持有证明。
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub(super) async fn connect_unverified(url: &str) -> Result<Channel> {
    let parsed = url::Url::parse(url)?;
    let host = parsed
        .host_str()
        .context("missing Hub host")?
        .trim_matches(['[', ']'])
        .to_owned();
    let port = parsed.port_or_known_default().context("missing Hub port")?;
    let server_name = ServerName::try_from(host.clone())?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SkipServerVerification(provider)))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    let connector = TlsConnector::from(Arc::new(config));
    let origin = Endpoint::from_shared(url.to_owned())?.uri().clone();
    // tonic 0.14.2 不开放自定义 verifier；TLS 由 connector 完成，避免框架再次包裹 TLS。
    let channel = Endpoint::from_shared(url.replacen("https://", "http://", 1))?
        .origin(origin)
        .connect_timeout(Duration::from_secs(5))
        .connect_with_connector(tower::service_fn(move |_| {
            let connector = connector.clone();
            let server_name = server_name.clone();
            let host = host.clone();
            async move {
                let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
                tcp.set_nodelay(true)?;
                let tls = connector.connect(server_name, tcp).await?;
                if tls.get_ref().1.alpn_protocol() != Some(b"h2") {
                    return Err(io::Error::other("Hub did not negotiate HTTP/2"));
                }
                Ok::<_, io::Error>(TokioIo::new(tls))
            }
        }))
        .await?;
    Ok(channel)
}
