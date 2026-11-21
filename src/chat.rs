use anyhow::{Context, Result, ensure};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rustix::fs::{CWD, Mode, OFlags, openat};
use std::{
    collections::BTreeSet,
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

pub(crate) fn mention_names(text: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut skip = 0usize;
    for event in Parser::new_ext(text, Options::ENABLE_GFM) {
        match event {
            Event::Start(Tag::CodeBlock(_) | Tag::Link { .. } | Tag::Image { .. }) => skip += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::Link | TagEnd::Image) => skip -= 1,
            Event::Text(text) if skip == 0 => {
                for (index, _) in text.match_indices('@') {
                    if text[..index].chars().next_back().is_some_and(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '@')
                    }) {
                        continue;
                    }
                    let name: String = text[index + 1..]
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
                        .take(129)
                        .collect();
                    if !name.is_empty() && name.chars().count() <= 128 {
                        names.insert(name);
                    }
                }
            }
            _ => {}
        }
    }
    names.into_iter().collect()
}

pub(crate) fn preview_file(workspace: &Path, path: &Path) -> Result<String> {
    const LIMIT: u64 = 128 * 1024;
    let components = path.components();
    ensure!(
        workspace.is_absolute()
            && !path.as_os_str().is_empty()
            && components
                .clone()
                .all(|part| matches!(part, Component::Normal(_))),
        "只能预览工作目录内的文件"
    );
    let directory = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY;
    let mut parent = openat(CWD, "/", directory, Mode::empty())?;
    for part in workspace.components().skip(1) {
        let Component::Normal(name) = part else {
            anyhow::bail!("工作目录不可用");
        };
        parent = openat(&parent, name, directory, Mode::empty()).context("工作目录不可用")?;
    }
    let mut components = components.peekable();
    while let Some(Component::Normal(name)) = components.next() {
        if components.peek().is_some() {
            parent = openat(&parent, name, directory, Mode::empty())
                .context("文件不存在或路径含有符号链接")?;
        } else {
            let file = File::from(
                openat(
                    &parent,
                    name,
                    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                    Mode::empty(),
                )
                .context("文件不存在或路径含有符号链接")?,
            );
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= LIMIT,
                "仅可预览不超过 128 KiB、没有硬链接的普通文本文件"
            );
            let mut bytes = Vec::new();
            file.take(LIMIT + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 <= LIMIT && !bytes.contains(&0),
                "文件过大或不是文本"
            );
            return String::from_utf8(bytes).context("仅支持 UTF-8 文本预览");
        }
    }
    anyhow::bail!("只能预览工作目录内的文件")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn preview_is_confined_to_the_recorded_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = root.join("project");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/readme.md"), "ok\n").unwrap();
        fs::write(root.join("private.txt"), "private").unwrap();
        symlink(&root, workspace.join("linked-dir")).unwrap();
        symlink(root.join("private.txt"), workspace.join("linked.txt")).unwrap();
        fs::hard_link(root.join("private.txt"), workspace.join("hard.txt")).unwrap();
        assert_eq!(
            preview_file(&workspace, Path::new("src/readme.md")).unwrap(),
            "ok\n"
        );
        for path in [
            "../private.txt",
            "src/../../private.txt",
            "/etc/passwd",
            "linked-dir/private.txt",
            "linked.txt",
            "hard.txt",
            "src",
        ] {
            assert!(preview_file(&workspace, Path::new(path)).is_err(), "{path}");
        }
        fs::rename(&workspace, root.join("moved")).unwrap();
        symlink(&root, &workspace).unwrap();
        assert!(preview_file(&workspace, Path::new("private.txt")).is_err());
    }

    #[test]
    fn names_only_count_in_message_prose() {
        assert_eq!(
            mention_names(
                "请@Haibin，@用户。\n\u{60}@code\u{60} a@host.com [@link](https://example.com)\n\n~~~sh\n@script\n~~~"
            ),
            ["Haibin", "用户"]
        );
    }
}
