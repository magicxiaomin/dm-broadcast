# dm-broadcast Cloudflare Worker

Minimal free-tier-first infrastructure for the MVP task cloud.

## Resources

- Worker: `dm-broadcast-api`
- D1: `dm_broadcast_mvp`
- KV: `dm-broadcast-mvp-kv`
- Queue: intentionally not enabled for the first MVP cut

The initial task queue is represented by the D1 `tasks` table. This keeps the MVP inside the most predictable free-tier shape and avoids another moving part until dispatch volume requires it.

## Commands

```sh
npm install
npm run dev
npm run db:migrate:remote
npm run deploy
```
