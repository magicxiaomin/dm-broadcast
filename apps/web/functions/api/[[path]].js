const WORKER_API_BASE = "https://dm-broadcast-api.magicxiaomin.workers.dev";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const target = new URL(url.pathname.replace(/^\/api/, "") + url.search, WORKER_API_BASE);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}
