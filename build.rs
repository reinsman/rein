use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
fn files(dir: &Path, result: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, result)
        } else {
            result.push(path)
        }
    }
}
fn npm(args: &[&str]) {
    let status = Command::new("npm")
        .args(args)
        .current_dir("console")
        .status()
        .expect("Console build requires Node.js and npm");
    assert!(
        status.success(),
        "Console build failed: npm {}",
        args.join(" ")
    );
}
fn main() {
    for path in [
        "console/src",
        "console/public",
        "console/index.html",
        "console/package.json",
        "console/package-lock.json",
        "console/vite.config.ts",
        "console/tsconfig.app.json",
        "console/tsconfig.node.json",
        "console/tsconfig.json",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    if !Path::new("console/node_modules").exists() {
        npm(&["ci", "--no-audit", "--no-fund"]);
    }
    npm(&["run", "build"]);
    let root = fs::canonicalize("console/dist").unwrap();
    let mut assets = Vec::new();
    files(&root, &mut assets);
    assets.sort();
    let mut source = String::from("const CONSOLE_ASSETS: &[(&str, &str, &[u8])] = &[\n");
    for path in assets {
        let name = format!("/{}", path.strip_prefix(&root).unwrap().display());
        let mime = match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "woff2" => "font/woff2",
            "woff" => "font/woff",
            "json" => "application/json",
            _ => "application/octet-stream",
        };
        source.push_str(&format!(
            "({name:?}, {mime:?}, include_bytes!({path:?})),\n",
            path = path.to_str().unwrap()
        ));
    }
    source.push_str("];\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("console_assets.rs"),
        source,
    )
    .unwrap();
}
