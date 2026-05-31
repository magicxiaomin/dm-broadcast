# dm-broadcast

运营后台向多台创作者安卓设备下发 IM 私信广播任务；设备执行发送；已读回流加积分。**MVP 调试原型，不上产品。**

已在真机 + 真账号 + 真实收件人上端到端验证过完整链路（发送 → 已读回执 → 幂等积分）。

## 结构

- `apps/web` — Vite + TS 运营后台
- `apps/worker` — Cloudflare Workers 任务云（D1 + KV）
- `apps/android` — Kotlin 创作者客户端（依赖 `wa-sdk-release.aar`）

## 快速开始

```bash
npm install
npm run web:dev                                 # http://localhost:3000
npm --workspace @dm-broadcast/worker run dev    # wrangler dev
```

## 验证闸门

```bash
npm run worker:check          # 类型检查
npm run web:build             # 前端构建
npm run worker:safety-smoke   # Miniflare 本地冒烟（无需真 Cloudflare）
```

唯一真相源与协作规则见 [AGENTS.md](./AGENTS.md)。当前已验证状态见 [docs/current-status.md](./docs/current-status.md)，待办见 [docs/backlog.md](./docs/backlog.md)。
