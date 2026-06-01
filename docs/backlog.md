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

### B18 · 后台登录 via Cloudflare Access（代码与 Access 配置已完成，DNS 待验证）
- 现状：运营后台人侧由 Cloudflare Access Email OTP 保护，Allow 邮箱 `magicxiaomin@gmail.com`；运营 Web 使用 `https://whatsapp.novelvela.com`，`/api/*` 同源代理到现有 Worker admin API。Pages custom domain 已创建，但仍等待 `whatsapp.novelvela.com` 的 CNAME 记录完成验证；过渡期 `dm-broadcast-web.pages.dev` 与 `*.dm-broadcast-web.pages.dev` 也被同一个 Access app 保护，避免无 demo 门的公开窗口。
- Worker 运营路由双接受：`ADMIN_TOKEN`（脚本/本地/CI 兜底）或合法 `Cf-Access-Jwt-Assertion`（jose 验签 + `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` 校验）。
- 设备路由继续只接受共享 `DEVICE_TOKEN`，仍走 `dm-broadcast-api.magicxiaomin.workers.dev`，不加交互式 Access。
- Web 已移除 demo 口令弹框；线上无需手填 ADMIN_TOKEN，本地开发仍可用顶栏 token 兜底。

### B2-full · 每设备鉴权（per-device token）
- 现状：B2-min 仍是共享设备钥匙，没有 owner scope、每设备 token 或绑定证明。
- 目标：评估 spec 的 `/auth/bind` 弱证明 + device_token（KV 存 `dt:{token}`），设备路由强制校验每设备身份与作用域。
- 验收（草案）：无效 token 的 pull/register/events 返回 401；设备 A token 不能拉/报设备 B 任务；smoke 覆盖。

## 工程债（已决定暂留，到点再迁）

### B3 · Web 模块化（原型阶段几乎不必做；不需要换 Next.js）
- 现状：纯客户端 Vite SPA（单 `main.ts` ~730 行），打 worker API，5 页 + E2E。
- 评估：后台是单运营者内部工具，**不需要 SSR/路由/RSC，迁 Next.js 属过度设计**。真实潜在痛点只是 `main.ts` 随 B14/B1/B15 变臃肿。
- 解法（增量、零迁移）：UI 长大时**在 Vite 内把 `main.ts` 拆模块 / 加轻量组件**，不换框架。
- 触发条件：仅当 UI 规模/团队协作显著增长，再评估是否需要框架。

### B4 · wa-sdk AAR 交付方式（暂不做；要动先 Git LFS，不是 Maven）
- 现状：13.2MB `apps/android/app/libs/wa-sdk-release.aar` 提交进 git，构建与真机都通。
- 评估：唯一代价是 **git 历史膨胀**（每更新一次 AAR，旧 13MB 永久留在历史里）。SDK 不常更新则完全可接受。
- 解法分级：更新频繁导致膨胀时，**优先 Git LFS**（把 .aar 移出常规历史，成本小）；GitHub Packages Maven 较重（需先在 `magicxiaomin/wa` 搭发布管线），仅在需要正式版本管理时再上。
- 触发条件：AAR 更新频繁、git 仓库明显变大。

### B16 · KV 免费额度 / 遥测写入策略（已完成）
- 已删除 KV 热路径写入：`/health`、`/v1/devices/register`、`/v1/events` 不再写 `last_seen`/`last_event` 死遥测。
- 代码复核：Worker 无 `STATE.get` / `STATE.list` / `STATE.put`；KV binding `STATE` 继续保留，留给未来低频配置或演示开关。
- Android 已将 register/safety 稳态上报降频到 60s；`risk_stopped` / 冷却 / 恢复等状态变化仍即时上报。业务事件 `message_sent` / `message_ack` 仍实时回流。

### B5 · 验证脚本依赖声明（本 PR 已修）
- 已把 `miniflare` / `esbuild` 加入根 devDependencies，使 `worker:safety-smoke` 在干净环境（CI）可跑。

### B7 · 集成/真机脚本与 CI 的边界
- `worker:smoke` / `worker:online-safety-smoke` / `e2e:real` / `acceptance:check` 依赖线上 Worker 或真机/Android SDK，**不进主 CI**（会污染线上、需 secrets）。
- 它们是手动/夜间验收入口；主 CI 只跑 hermetic 的 `worker:check + web:build + worker:safety-smoke`。
- 后续可考虑：用专用 staging Worker + 定时 workflow 跑线上 smoke。

### B8 · Web 行为 E2E（进 CI）
- 现状：Web 只有 `web:build`（编译级），无行为测试。
- 目标：headless 浏览器（Playwright）驱动 + 断言，至少覆盖：总览渲染、建广播、注入 read 后积分变化。
- 验收（草案）：新增 `web:e2e` 脚本进「Sanity Checks / build」；CI 绿。Codex 可附运行截图。

### B10 · 安卓真机验证脚本（Codex 本地跑，产出证据）
- 现状：Android 只有 `assembleDebug`（编译级），行为全靠手动。
- 目标：Codex 用 ADB 截屏 + 驱动一次 `pull → sendText` 流程，产出截图/日志附 PR。
- 边界：依赖物理真机，**不进 GitHub CI**；属 Codex 在挂设备的 Mac 上跑的证据项，Claude 审证据 + 人抽查。

### B9 · 测试节奏写进 AGENTS.md（本 PR 已做）
- AGENTS.md「测试责任」小节已明确 A / A+ / B+ / C 各区谁跑、何时跑、证据形式。

### B12 · 多设备多账号测试赋能 + 隔离坑修复（已完成）
- 已修 Worker 隔离坑：campaign 创建必须显式传 `deviceId`；pull 必须显式传 `deviceId` 且只认领 `device_id = ?` 的任务。
- 已新增 `multi-device:preflight` 手动检查入口和 `docs/multi-device-testing.md` runbook。
- 边界：未做 B2-full；本项不引入 per-device token，隔离依赖显式 deviceId 指派。

### B13 · 前端打磨（apps/web，已完成）
来自对 `apps/web/src/main.ts` 的审计，均非功能 bug：
- **#1 文案不一致**：已统一 `sent` 为「待确认」。
- **#2 残留 android-prototype 兜底**：已移除兜底；零真实 ready 设备时禁止下发并提示。
- **#3 缺 ADMIN_TOKEN 的 UX 断点**：B18 后线上由 Cloudflare Access 登录；本地 401 明确提示填写 ADMIN_TOKEN 或线上走 Access。
- **#4 死代码（顺手清）**：`Dashboard.summary` 死类型已删除。

## 身份与反作弊（未来架构，较重）

### B14a · 用户账号系统后端（已完成）
- 已新增 `users` 表与 `devices.user_id` nullable 归属字段；一台设备最多归属一个运营维护的 user。
- 已新增 ADMIN_TOKEN 路由：`GET /v1/users`、`POST /v1/users`、`POST /v1/devices/assign`。
- 积分仍不重写、不回填：`ledger_entries.user_id` 继续存 device id，user 余额在查询时通过 `users ← devices ← ledger_entries` 聚合。
- `GET /v1/users` 同时返回已入账 `points` 与 per-user 待确认 `pending_points` / `pending_tasks`，供 B14b 前端诚实标签使用。
- migration 采用 `_dm_migrations` 跟踪表，`db:migrate` 与 Miniflare smoke 共用同一套“按文件名排序、仅应用未跑过 migration”的逻辑。

### B14b · 用户账号系统 Web 管理（已完成）
- 现状：现有 Vite Web 后台已新增「用户」页，可创建运营维护的 user，并展示 per-user 待确认/已入账聚合。
- 设备管理页已展示 `user_id` 归属，支持把设备分配给 user；未归属设备显示「未归属」。
- Ledger 页「用户汇总」已改为消费 B14a 的 `GET /v1/users`，按真实 User 聚合，而不是按 device_id 聚合。
- 边界：仍无用户登录/auth；不做 B2-full owner scope；不重写 ledger。

### B17a · 联系人归属设备/用户后端（已完成）
- 已新增 `device_contacts` 归属表，`PRIMARY KEY(device_id, wa_jid)`，允许同一联系人 JID 同时属于多台设备。
- `POST /v1/contacts/sync` 必须显式传 `deviceId`，同步结果写入 `device_contacts`；Android 客户端同步 body 已带现有 `deviceId`。
- `GET /v1/contacts?deviceId=...` 可按设备读联系人；`GET /v1/contacts?userId=...` 可按用户归属设备聚合联系人；无 filter 仍保留旧全局 `contacts` 兼容视图。
- 存量全局 `contacts` 不回填归属，避免伪造设备/用户所有权；设备重新同步后形成可信归属数据。
- 边界：不改 `createCampaign` 下发逻辑；不做 B15 去重；不做 B2-full。

### B14-full · 用户身份与 owner scope（未来重构）
- 现状：B14a 只有运营维护的 User 实体；IM 账号（self_jid）与设备仍是真实执行身份，`ledger.user_id` 仍是 device id。
- 目标：若后续产品化，再引入真实 User 注册/登录/资料、每设备 token、owner scope、`/auth/bind` 弱证明，并评估存量 ledger 迁移。
- 依赖/关联：**B1 兑换审批**（余额与兑换归 User）、**B2-full**（per-device token + owner scope）。

### B15 · 防刷积分 / 反作弊（**MVP 暂不做，已搁置**；B14 依赖已满足）
- 风险：一个 User 名下多台设备装**相同联系人**，对同一 recipient 重复发送，刷取重复 `read_reward`；真实触达没增加，积分虚高。
- 核心规则（目标）：**同一 User 下，相同联系人（recipient JID）跨多设备只算一个有效触达**——按 `(user, recipient)` 去重。
- **设计阻塞点（捡起前必读）**：今天 `createCampaign` 只接单 `deviceId`，即「一个 campaign = 一台设备」。多设备发同一联系人是**跨 campaign**的重复，"每广播内去重"按现模型抓不到。要让去重真正生效需先二选一：
  - **方案 B**：让 campaign 可一次 fan-out 到多设备（campaign = 广播活动，修正语义），去重键 `(user, recipient, campaign_id)` 自然生效；需改 `createCampaign` + 下发页多选设备。
  - **方案 C**：不改模型，退用按天去重 `(user, recipient)` 每日一次（不是"每广播"语义）。
- 关联 spec 未实现的防刷常量：`NEW_OWNER_COOLDOWN_DAYS`、`RECIPIENT_DAILY_CAP`（走方案 C 可复用）。
- 决定（owner）：**MVP 阶段不做去重**，原型期刷分非当前重点；需要时按方案 B/C 再定。
- 依赖：B14（已完成）。

## 一致性

### B6 · spec 与代码命名差异（已认基线，仅记录）
- npm（非 pnpm）、apps/worker（非 apps/api）、手写路由（非 Hono）、/v1 路由、表名 campaigns/tasks/ledger_entries（非 broadcasts/deliveries/points_ledger）、KV binding=STATE、已读积分按 campaign points（非固定 +1）。
- 决定：以代码为准，AGENTS.md 已对齐。无需改代码。
