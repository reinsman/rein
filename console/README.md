# Rein Console

从原 rein-console 复制到 rein 仓库，作为单机版前端继续开发。由 reind 提供内嵌静态资源及同源 `/api`、SSE 接口，不依赖 Hub 或登录。

保留项目、需求、任务规划和独立 Pi/Codex 对话。移除工作空间、项目对话以及模拟数据。Agent 展示类型图标与名称。

```sh
npm ci
npm run dev
```

开发代理默认 `http://127.0.0.1:8920`，使用 `REIND_URL` 覆盖。生产资源由 rein 的 build.rs 自动构建并打包，重新编译后重启 daemon 即可更新。

```sh
npm run build
npm run lint
npm run typecheck
npm run test:e2e
```

浏览器测试先要求 `cargo build --bins`，会启动独立临时状态目录、18920 端口和确定性的 Agent fixture。通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 可指定 Chromium。

界面恢复原 rein-console 的主题、字体、296px 侧栏、聊天/任务双栏、详情抽屉和设置面板，`src/App.css` 与原前端保持一致。只移除工作空间相关界面和项目对话入口；项目与聊天历史继续使用 reind 数据。
