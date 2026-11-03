use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

struct Harness(TempDir);

impl Harness {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rein"))
            .args(args)
            .env("REIN_HOME", self.0.path())
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn raw(&self, bytes: &[u8]) -> serde_json::Value {
        let mut stream = UnixStream::connect(self.0.path().join("reind.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(bytes).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.run(&["daemon", "stop"]);
    }
}

#[test]
fn lifecycle_and_queries_use_the_daemon() {
    let harness = Harness::new();
    assert!(harness.ok(&["daemon", "status"]).contains("stopped"));
    assert!(!harness.run(&["agents", "list"]).status.success());
    assert!(harness.ok(&["daemon", "start"]).contains("started"));
    assert!(harness.ok(&["daemon", "start"]).contains("already running"));
    assert!(harness.ok(&["daemon", "status"]).contains("running"));
    assert_eq!(
        std::fs::metadata(harness.0.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let duplicate = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("already running"));

    for args in [["agents", "list"], ["sessions", "list"], ["a2a", "list"]] {
        assert_eq!(harness.ok(&args).trim(), "[]");
    }
    let missing = harness.run(&["a2a", "inspect", "missing"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not found"));

    assert_eq!(harness.raw(b"invalid\n")["type"], "error");
    let oversized = vec![b'x'; 64 * 1024 + 1];
    assert!(
        harness.raw(&oversized)["message"]
            .as_str()
            .unwrap()
            .contains("exceeds")
    );
    assert_eq!(harness.ok(&["agents", "list"]).trim(), "[]");

    assert!(harness.ok(&["daemon", "stop"]).contains("stopped"));
    assert!(!harness.0.path().join("reind.sock").exists());
    assert!(harness.ok(&["daemon", "stop"]).contains("already stopped"));
    assert!(harness.ok(&["daemon", "start"]).contains("started"));
    harness.ok(&["daemon", "stop"]);
}

#[test]
fn abrupt_exit_releases_lock_and_stale_socket_is_recovered() {
    let harness = Harness::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !harness.0.path().join("reind.sock").exists() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("daemon did not bind its socket");
        }
        thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(harness.ok(&["daemon", "status"]).contains("stopped"));
    harness.ok(&["daemon", "start"]);
    harness.ok(&["daemon", "stop"]);
}

#[test]
fn startup_preserves_non_socket_files() {
    let harness = Harness::new();
    let path = harness.0.path().join("reind.sock");
    std::fs::write(&path, "keep me").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_reind"))
        .env("REIN_HOME", harness.0.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "keep me");
}

#[test]
fn command_help_and_required_arguments() {
    let harness = Harness::new();
    assert!(harness.ok(&["--help"]).contains("daemon"));
    assert!(harness.ok(&["a2a", "--help"]).contains("inspect"));
    assert!(!harness.run(&["a2a", "inspect"]).status.success());
    assert!(!harness.run(&["sessions", "unknown"]).status.success());
}
