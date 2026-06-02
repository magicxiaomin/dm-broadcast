import { build } from "esbuild";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const config = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "0ead643bec90bb38a1f209ec3cec02bb",
  workerName: process.env.DM_WORKER_NAME || "dm-broadcast-api",
  d1DatabaseId: process.env.DM_D1_DATABASE_ID || "f07a0f16-c6c9-4162-87f7-1e4a68eb9a6f",
  kvNamespaceId: process.env.DM_KV_NAMESPACE_ID || "dfa94c2504bb4beba319ef8e0062a7d5",
  compatibilityDate: process.env.DM_WORKER_COMPATIBILITY_DATE || "2026-05-30",
  accessTeamDomain: process.env.DM_CF_ACCESS_TEAM_DOMAIN || "https://magicxiaomin.cloudflareaccess.com",
  accessAud: process.env.DM_CF_ACCESS_AUD || "989fa405194f68c6d93119018b92e881659ba28dafd8b4f787a8c2a02ad4d48d",
};

const dryRun = process.argv.includes("--dry-run") || process.env.DM_DEPLOY_DRY_RUN === "1";
const token = process.env.CLOUDFLARE_API_TOKEN;
const mainModule = "worker.mjs";

if (!token && !dryRun) {
  console.error("Missing CLOUDFLARE_API_TOKEN; not deploying.");
  console.error("Create an API token with Workers Scripts Write, then run:");
  console.error("  CLOUDFLARE_API_TOKEN=... npm run worker:deploy:api");
  process.exit(2);
}

const entryPoint = new URL("../apps/worker/src/index.ts", import.meta.url).pathname;

const bundle = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "silent",
});

const workerSource = bundle.outputFiles[0]?.text;
if (!workerSource) {
  throw new Error("esbuild did not return a bundled Worker module");
}

const metadata = {
  main_module: mainModule,
  compatibility_date: config.compatibilityDate,
  bindings: [
    {
      type: "d1",
      name: "DB",
      database_id: config.d1DatabaseId,
    },
    {
      type: "kv_namespace",
      name: "STATE",
      namespace_id: config.kvNamespaceId,
    },
    {
      type: "plain_text",
      name: "CF_ACCESS_TEAM_DOMAIN",
      text: config.accessTeamDomain,
    },
    {
      type: "plain_text",
      name: "CF_ACCESS_AUD",
      text: config.accessAud,
    },
    ...(process.env.DM_ADMIN_TOKEN
      ? [
          {
            type: "plain_text",
            name: "ADMIN_TOKEN",
            text: process.env.DM_ADMIN_TOKEN,
          },
        ]
      : []),
    ...(process.env.DM_DEVICE_TOKEN
      ? [
          {
            type: "plain_text",
            name: "DEVICE_TOKEN",
            text: process.env.DM_DEVICE_TOKEN,
          },
        ]
      : []),
  ],
};

if (dryRun) {
  const redactedMetadata = {
    ...metadata,
    bindings: metadata.bindings.map((binding) => binding.type === "plain_text" ? { ...binding, text: "<redacted>" } : binding),
  };
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    endpoint: deployUrl(config),
    workerName: config.workerName,
    workerBytes: Buffer.byteLength(workerSource),
    metadata: redactedMetadata,
  }, null, 2));
  process.exit(0);
}

const body = multipartBody([
  {
    name: "metadata",
    contentType: "application/json",
    value: JSON.stringify(metadata),
  },
  {
    name: mainModule,
    filename: mainModule,
    contentType: "application/javascript+module",
    value: workerSource,
  },
]);

const res = await fetch(deployUrl(config), {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": body.contentType,
  },
  body: body.buffer,
});

const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = { raw: text };
}

if (!res.ok || data.success === false) {
  console.error(JSON.stringify({
    ok: false,
    status: res.status,
    statusText: res.statusText,
    errors: data.errors,
    messages: data.messages,
    raw: data.raw,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  workerName: config.workerName,
  deploymentId: data.result?.id || data.result?.etag || null,
  compatibilityDate: data.result?.compatibility_date || config.compatibilityDate,
  workerBytes: Buffer.byteLength(workerSource),
  messages: data.messages || [],
}, null, 2));

function deployUrl({ accountId, workerName }) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
}

function multipartBody(parts) {
  const boundary = `----dm-broadcast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = [
      `form-data; name="${escapeMultipart(part.name)}"`,
      part.filename ? `filename="${escapeMultipart(part.filename)}"` : null,
    ].filter(Boolean).join("; ");
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
    chunks.push(Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    buffer: Buffer.concat(chunks),
  };
}

function escapeMultipart(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
