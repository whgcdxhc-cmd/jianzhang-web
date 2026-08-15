import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceIndexUrl = new URL("../public/index.html", import.meta.url);
const builtIndexUrl = new URL("../dist/client/index.html", import.meta.url);

function assertJianzhangContent(html) {
  assert.match(html, /<title>简账/);
  assert.match(html, /placeholder="例如：这个月餐饮花了多少？"/);
  assert.match(html, /placeholder="例如：昨天晚上和朋友吃饭 68 元"/);
  assert.doesNotMatch(html, /刘兴昊/);
}

test("source and built pages use anonymous example copy", async () => {
  const [sourceHtml, builtHtml] = await Promise.all([
    readFile(sourceIndexUrl, "utf8"),
    readFile(builtIndexUrl, "utf8"),
  ]);

  assertJianzhangContent(sourceHtml);
  assertJianzhangContent(builtHtml);
});

test("worker serves the current Jianzhang page at the root", async () => {
  const builtHtml = await readFile(builtIndexUrl, "utf8");
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname !== "/index.html") {
            return new Response("Not found", { status: 404 });
          }
          return new Response(builtHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assertJianzhangContent(await response.text());
});
