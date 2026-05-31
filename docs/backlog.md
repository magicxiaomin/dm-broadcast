# Backlog — 审计发现 → 候选 ticket

由 Claude Code 对 `codex/mvp-full-stack-audit` 分支审计后整理。决策已定：**认代码为基线**。
每项落地前应先开正式 ticket（含验收标准 + 禁区）。

## 真缺口（功能层面，建议优先）

### B1 · redemptions 兑换审批
- 现状：spec 设想的 `redemptions` 表 + `/redeem/:id/approve|reject` 完全未实现，积分只增不可兑换。
- 目标：补兑换申请、人工审批、幂等扣分（`ledger_entries` entry_type=redeem，唯一约束防重复）。
- 验收（草案）：worker:safety-smoke 覆盖「余额不足拒绝 / 通过后幂等扣分 / 拒绝不扣分」；Web 有审批队列页。

### B2-min · 双钥匙最小鉴权（已完成）
- 现状：`/health` 公开；运营路由需 `ADMIN_TOKEN`；设备路由需共享 `DEVICE_TOKEN`；二者均通过 `Authorization: Bearer <token>` 传递。
- 覆盖：无 token / 错 token / 设备 token 调运营路由的拒绝断言已进入 `worker:safety-smoke`。

### B2-full · 每设备鉴权（per-device token）
- 现状：B2-min 仍是共享设备钥匙，没有 owner scope、每设备 token 或绑定证明。
- 目标：评估 spec 的 `/auth/bind` 弱证明 + device_token（KV 存 `dt:{token}`），设备路由强制校验每设备身份与作用域。
- 验收（草案）：无效 token 的 pull/register/events 返回 401；设备 A token 不能拉/报设备 B 任务；smoke 覆盖。

## 工程债（已决定暂留，到点再迁）

### B3 · Web 迁移 Next.js + shadcn/ui
- 现状：Vite + 原生 TS（单 `main.ts`），带 demo 口令门。原型够用。
- 触发条件：需要多路由 / 组件复用 / 团队协作时再迁。

### B4 · wa-sdk AAR 迁 GitHub Packages Maven
- 现状：13.2MB `apps/android/app/libs/wa-sdk-release.aar` 提交进 git。
- 触发条件：`magicxiaomin/wa` 发布到 GitHub Packages 后，改 `build.gradle` 用 Maven 依赖并从 git 移除 AAR。

## 测试与可复现性

### B5 · 验证脚本依赖声明（本 PR 已修）
- 已把 `miniflare` / `esbuild` 加入根 devDependencies，使 `worker:safety-smoke` 在干净环境（CI）可跑。

### B7 · 集成/真机脚本与 CI 的边界
- `worker:smoke` / `worker:online-safety-smoke` / `e2e:real` / `acceptance:check` 依赖线上 Worker 或真机/Android SDK，**不进主 CI**（会污染线上、需 secrets）。
- 它们是手动/夜间验收入口；主 CI 只跑 hermetic 的 `worker:check + web:build + worker:safety-smoke`。
- 后续可考虑：用专用 staging Worker + 定时 workflow 跑线上 smoke。

## 一致性

### B6 · spec 与代码命名差异（已认基线，仅记录）
- npm（非 pnpm）、apps/worker（非 apps/api）、手写路由（非 Hono）、/v1 路由、表名 campaigns/tasks/ledger_entries（非 broadcasts/deliveries/points_ledger）、KV binding=STATE、已读积分按 campaign points（非固定 +1）。
- 决定：以代码为准，AGENTS.md 已对齐。无需改代码。
