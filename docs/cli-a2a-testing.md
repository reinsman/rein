# CLI / A2A 验证

```sh
./build.sh
./rein.sh daemon start
./rein.sh agent add codex coder --directory "$PWD"
./rein.sh agent up coder
./rein.sh agent ls
./rein.sh agent inspect coder
./rein.sh agent down coder
./rein.sh agent up coder
./rein.sh agent add pi remote -a2a http://127.0.0.1:10100
./rein.sh agent up remote
```

在 daemon 输出的 Console 地址中选择 Agent，测试发送、续聊、审批和停止。

```sh
cargo test --locked
npm run test:e2e --prefix console
```

A2A 集成测试会自动启动 `tests/fixtures/a2a_server.py`，覆盖远端上下文恢复、类型保留、分页和取消。该服务仅用于测试。原生执行使用 a2alinker 自带的确定性 Pi/Codex 协议 fixture，不消耗模型额度。
