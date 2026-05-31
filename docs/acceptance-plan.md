# dm-broadcast MVP 验收计划

## 已明确的 MVP 假设

- Cloudflare 免费账号优先：只使用 Worker、D1、KV；不启用 Queue。
- 任务队列先由 D1 `tasks` 表承载，安卓设备通过轮询拉取。
- Android 未登录前设备 ID 使用 `android-prototype`；扫码登录并读到 `self_jid` 后，设备 ID 自动切换为 `android-wa-<账号标识>`，避免多个测试号共享同一队列和 safety 状态。
- 积分入账规则：任务收到 `read` / `message_read` / `receipt_read` / `read_receipt`，或收到可关联到任务且 `ack_level >= 2` 的 `message_ack` 后，写入一条幂等 `read_reward` ledger。
- SDK 当前已验证会产生 `message_sent` / `message_failed` / `message_ack`；`wa` SDK 测试定义 `ack_level: 2` 为 read receipt。Worker 会按 `server_msg_id` 将 ack-only 事件反查到原任务。验收时支持经脚本/真机注入 `read` 事件验证入账逻辑，Web 注入已移除。
- Android 轮询前必须先读取 SDK safety status。若存在 `risk_stopped`、发送冷却或操作冷却，不向 Worker pull/claim 任务，避免云端任务被设备拿走后无法发送。
- Worker `/v1/tasks/pull` 同样强制执行设备 safety gate。即使客户端误调用 pull，`risk_stopped`、`cooldown`、`cooling_down` 设备也只会得到 `paused: true` 和空任务列表。
- Worker 会自动释放超过 10 分钟仍未回流结果的 `claimed` 任务，重新置为 `pending` 并记录 `task_claim_expired` 事件。

## 验收项

1. Cloudflare 基础设施
   - Worker `dm-broadcast-api` 可访问 `/health`。
   - D1 `dm_broadcast_mvp` 包含 devices、contacts、campaigns、tasks、im_events、ledger_entries。
   - KV `dm-broadcast-mvp-kv` 可被 Worker 写入健康检查/设备事件。

2. Worker API
   - `POST /v1/devices/register` 可注册安卓设备。
   - `POST /v1/contacts/sync` 可同步联系人。
   - `POST /v1/campaigns` 可创建 campaign 和 tasks。
   - `GET /v1/tasks/pull` 可按 deviceId claim pending task。
   - 若设备上报 `risk_stopped` 或冷却状态，`GET /v1/tasks/pull` 返回空任务并带 `paused: true`，不 claim pending task。
   - 云端按 `safety_updated_at + safety_retry_after_seconds` 保持暂停，不只依赖最近心跳窗口。
   - 超过 10 分钟的 stale `claimed` 会在下一次 pull 前自动回到 `pending`。
   - `POST /v1/events` 可处理 `message_sent`、`message_failed`、`read`。
   - `POST /v1/events` 可将只带 `server_msg_id` 的 `message_ack` 关联到此前的 `message_sent` 任务；`ack_level >= 2` 触发 read 状态和积分入账。
   - `POST /v1/tasks/requeue` 可将 `failed` / `claimed` 任务重置为 `pending`，用于设备恢复后的运营重试。
   - `GET /v1/dashboard` 可返回 Web 后台所需汇总、任务、事件、ledger。

3. Web 后台
   - 可配置 Worker API 地址。
   - 可查看设备、任务、事件、积分。
   - 可查看设备发送安全状态，例如 `可发送`、`risk stop`、`冷却`。
   - 可创建广播任务。
   - sent/claimed 任务的 read 入账通过脚本/真机注入验收；Web 注入已移除。
   - 可对 failed/claimed 任务点击 `重新排队`，恢复为 pending。

4. Android 原型客户端
   - 真机启动后能恢复已扫码 session。
   - 可按当前登录账号注册独立设备到 Worker。
   - 可同步联系人到 Worker。
   - 可轮询云端任务。
   - 轮询和发送前会检查 `getSafetyStatus()`。
   - 拉到任务后调用 `wa-sdk-release.aar` 的 `sendText`。
   - `message_sent` / `message_failed` / read 类 IM 事件回流 Worker。

5. 真机端到端
   - 在 Web 创建发给测试小号 `+85255804693` 的任务。
   - Android 轮询拉取任务并发送。
   - Worker 记录发送事件。
   - 产生或注入 read 事件后，任务状态变为 `read`，ledger 增加对应积分。

## 当前真实联系人状态

- MVP 真实发信目标已改为用户小号 `+85255804693`。
- 默认验收收件人 JID：`85255804693@s.whatsapp.net`。
- 当前 Android 发送账号为 `8618205924392:8@s.whatsapp.net`，云端设备 ID 为 `android-wa-8618205924392-8`。
- Android 原型已用该账号完成扫码登录；只读 readiness preflight 已验证 `state: connected` 且 `retryAfterSeconds: 0`。
- 已完成一次真实小号发送：任务 `task_caee6635-8a76-4751-bc2e-f0591653b68b` 发往 `+85255804693`，SDK 实际使用 LID `125001483219165@lid`，Worker 记录 `message_sent`。
- 自动 SDK 已读回执已观测到：真实发送后，SDK 回流 `message_ack`，payload 包含 `server_msg_id: 3EB0B7DCFFA3B1ED0E7715` 和 `ack_level: 2`。
- Worker 已补齐并部署 `server_msg_id -> task` 归因和 `ack_level >= 2 -> read_reward` 入账逻辑；线上 ack 回放已返回真实 task id，写入 `acked_at`，并保持 ledger 幂等不重复入账。
- 旧的“萝卜胡”测试仅作为历史记录：`resolveJID("8618205924392")` 曾成功，但真实发送返回 `server returned error 463`，因此不再作为 MVP 真实收件人。

## 常用命令

```sh
npm run worker:check
npm run worker:safety-smoke
npm run worker:online-safety-smoke
npm run web:build
npm run worker:deploy:api
npm run worker:smoke
npm run readiness:check
npm run account-isolation:check
npm run acceptance:check
DM_REAL_CONTACT_JID="..." npm run e2e:real
cd apps/android && JAVA_HOME="$HOME/.local/share/codex-wa-tools/jdk17/Contents/Home" ANDROID_HOME="$HOME/Library/Android/sdk" ANDROID_SDK_ROOT="$HOME/Library/Android/sdk" "$HOME/.local/share/codex-wa-tools/gradle-8.10.2/bin/gradle" --no-daemon :app:assembleDebug
```

`npm run acceptance:check` 是当前推荐的一键验收入口，会依次执行 Worker typecheck、Web build、Android debug build、本地 safety/requeue smoke、线上 safety smoke、线上 ack/read/ledger smoke、只读 readiness preflight。默认不会创建真实 IM 任务；只有显式设置 `DM_ACCEPTANCE_RUN_REAL_E2E=1` 时才会额外运行真实 Android E2E。若真实设备被 SDK safety 阻断，脚本接受 `e2e:real` 退出码 `3`，并确认没有创建真实 IM 任务。

`scripts/smoke-worker.sh` 保留为兼容入口，内部调用 `node scripts/worker-smoke.mjs`。

`npm run worker:deploy:api` 是非交互 Cloudflare 部署入口，直接调用 Workers Scripts API 上传模块 Worker。需要 `CLOUDFLARE_API_TOKEN`，且 token 至少具备 `Workers Scripts Write`；未设置 token 时脚本会在上传前安全退出。可先运行 `npm run worker:deploy:api -- --dry-run` 检查打包产物、绑定和目标 endpoint。

`npm run readiness:check` 是真实 E2E 前置检查，不会创建真实 IM 任务。它会检查 Worker `/health`、云端账号作用域设备 safety（未发现 `android-wa-*` 时回退到 `android-prototype`）、真实联系人 JID、Cloudflare API token、ADB 真机连接、Android 原型 app 是否安装，以及本机 `risk-stop.json` 是否仍有效。默认只报告状态；若需要在自动化里把未就绪视为失败，可运行 `npm run readiness:check -- --strict`。

换号扫码后，先在 Android 原型端点击 `读取身份` 或等待 `session_restored`，确认日志出现 `DEVICE scoped id=android-wa-...`。之后 Web 创建任务或运行 `npm run e2e:real` 时，不传 `DM_DEVICE_ID` 会优先选用这个账号作用域设备；需要指定时使用对应的 `android-wa-*` ID。

`npm run e2e:real` 会创建真实 Android 发送任务，必须显式设置 `DM_REAL_CONTACT_JID`，否则脚本会拒绝运行。若只想验证发送后入账逻辑，可加 `DM_INJECT_READ=1` 在任务达到 `sent` 后注入 read 事件。

真机继续验收前先确认 Android UI 的 `安全状态` 是 `可发送`，并运行 `npm run readiness:check -- --strict`；若显示 risk stop、冷却中或 bridge state 不是 `connected`，不运行真实 E2E。

`npm run worker:safety-smoke` 使用 Miniflare 本地验证 Worker 新调度规则：risk-stopped 设备不会 claim 任务，未过期 retry-after 持续暂停，过期 retry-after 和 ready 设备可正常 claim；同时验证 failed 任务可 requeue 回 pending 并再次被 claim，以及 stale claimed 任务可自动释放并再次 claim。

`npm run worker:online-safety-smoke` 通过线上 Worker API 验证已部署 safety gate：合成 risk-stopped 设备不会 claim 任务；脚本证明任务保持 pending 后会写入 `message_failed` 清理，避免反复验收堆积待发送任务。

当前线上补充验收：

- Cloudflare Worker 已部署 safety gate / retry-after / requeue / ack-correlation 版本，最新 `npm run worker:deploy:api` 成功，reported deployment id/name 为 `dm-broadcast-api`。
- 线上 Worker smoke：通过，ack-only `message_ack` 可按 `server_msg_id` 关联任务，任务最终 `read` 并产生一条幂等 `read_reward`。
- 线上 safety gate：通过，合成 `risk_stopped` 设备 pull 返回 `paused: true` 且 `tasks: []`。
- 线上 long retry safety：通过，手动将合成设备 `safety_updated_at` 老化 10 分钟后，未过期 retry-after 仍使 pull 返回 `paused: true`。
- 真实 E2E：已对 `+85255804693` 完成真实发送；Worker 记录 `message_sent`；SDK 之后回流 `message_ack ack_level=2`；部署后的线上 Worker 已通过 ack 回放验证自动关联任务并写入 `acked_at`，ledger 保持幂等。
