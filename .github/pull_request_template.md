## 对应 Ticket

closes #

## 改了什么

<!-- 核心改动概述，不重复 diff -->

## 如何验证

<!-- 本地命令 / 真机步骤；真机相关请附日志或录屏 -->

```sh
npm run worker:check
npm run web:build
npm run worker:safety-smoke
```

## 验收标准是否满足

<!-- 逐条粘贴 ticket 验收标准并勾选 -->

- [ ] （逐条对照 ticket）

## 自查

- [ ] CI「Sanity Checks / build」全绿
- [ ] 未改 AGENTS.md「已验证规则」常量 / D1 schema（如改，已同步 migration + AGENTS.md）
- [ ] 未跨 ticket、未加 MVP 不实现清单中的功能
