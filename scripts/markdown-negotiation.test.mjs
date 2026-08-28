import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "./pages-worker.mjs";

function htmlResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers },
  });
}

function environment(response) {
  let receivedRequest;
  return {
    env: {
      ASSETS: {
        fetch(request) {
          receivedRequest = request;
          return response;
        },
      },
    },
    get receivedRequest() {
      return receivedRequest;
    },
  };
}

test("serves the default HTML asset body and content type", async () => {
  const request = new Request("https://example.test/", {
    headers: { Accept: "text/html" },
  });
  const original = htmlResponse("<h1>Default HTML</h1>");
  const assets = environment(original);

  const response = await worker.fetch(request, assets.env);

  assert.strictEqual(assets.receivedRequest, request);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(await response.text(), "<h1>Default HTML</h1>");
});

test("handles immutable Pages asset headers for HTML and Markdown variants", async () => {
  for (const [accept, expectedType] of [
    ["text/html", "text/html"],
    ["text/markdown", "text/markdown; charset=utf-8"],
  ]) {
    const request = new Request("https://example.test/", { headers: { Accept: accept } });
    const immutableAsset = await fetch(
      "data:text/html,<main><h1>Immutable Asset</h1><p>Readable content.</p></main>",
    );
    assert.throws(
      () => immutableAsset.headers.set("Vary", "Accept"),
      /immutable/i,
      "the fixture must reproduce the Pages immutable-header boundary",
    );
    const assets = environment(immutableAsset);

    const response = await worker.fetch(request, assets.env);
    const body = await response.text();

    assert.match(response.headers.get("Content-Type") ?? "", new RegExp(`^${expectedType}`));
    if (accept === "text/markdown") {
      assert.match(body, /^# Immutable Asset$/m);
    } else {
      assert.match(body, /<h1>Immutable Asset<\/h1>/);
    }
  }
});

test("converts a successful HTML GET through the public middleware", async () => {
  const request = new Request("https://example.test/tool/", {
    headers: { Accept: "TEXT/HTML, TEXT/MARKDOWN;Q=0.9" },
  });
  const original = htmlResponse(
    "<html><head><title>Tool</title></head><body><nav>Ignore nav</nav><main><h1>Tool</h1><p>Readable <strong>content</strong>. <a href=guide>Guide</a></p></main></body></html>",
  );
  const assets = environment(original);

  const response = await worker.fetch(request, assets.env);
  const responseBody = response.clone();
  const body = await response.text();

  assert.strictEqual(assets.receivedRequest, request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(
    response.headers.get("Content-Signal"),
    "ai-train=no, search=yes, ai-input=yes",
  );
  assert.match(response.headers.get("Vary") ?? "", /(?:^|, )Accept(?:,|$)/i);
  assert.match(response.headers.get("x-markdown-tokens") ?? "", /^\d+$/);
  assert.match(response.headers.get("ETag") ?? "", /^".+"$/);
  assert.match(body, /^# Tool$/m);
  assert.match(body, /Readable \*\*content\*\*/);
  assert.match(body, /\[Guide\]\(https:\/\/example\.test\/tool\/guide\)/);
  assert.doesNotMatch(body, /Ignore nav/);
  assert.equal(await responseBody.text(), body);
});

test("accepts a qvalue with an empty fractional part", async () => {
  const request = new Request("https://example.test/", {
    headers: { Accept: "text/markdown; q=1." },
  });
  const assets = environment(htmlResponse("<main><h1>Full quality Markdown</h1></main>"));

  const response = await worker.fetch(request, assets.env);

  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.match(await response.text(), /^# Full quality Markdown$/m);
});

test("keeps HTML when text/markdown is explicitly q=0", async () => {
  const request = new Request("https://example.test/", {
    headers: { Accept: "text/html, text/markdown; q=0" },
  });
  const original = htmlResponse("<h1>q-zero HTML</h1>");
  const assets = environment(original);

  const response = await worker.fetch(request, assets.env);

  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(await response.text(), "<h1>q-zero HTML</h1>");
});

test("keeps HTML when a quoted Accept parameter contains a comma before q=0", async () => {
  const request = new Request("https://example.test/", {
    headers: { Accept: 'text/markdown; profile="a,b"; q=0, text/html' },
  });
  const assets = environment(htmlResponse("<h1>Quoted q-zero HTML</h1>"));

  const response = await worker.fetch(request, assets.env);

  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(await response.text(), "<h1>Quoted q-zero HTML</h1>");
});

test("passes through methods, statuses, and non-HTML content types", async () => {
  const cases = [
    [
      new Request("https://example.test/", {
        method: "POST",
        headers: { Accept: "text/markdown" },
      }),
      htmlResponse("<h1>Posted HTML</h1>"),
    ],
    [
      new Request("https://example.test/missing", {
        headers: { Accept: "text/markdown" },
      }),
      htmlResponse("<h1>Missing HTML</h1>", { status: 404 }),
    ],
    [
      new Request("https://example.test/data.json", {
        headers: { Accept: "text/markdown" },
      }),
      new Response('{"ok":true}', {
        headers: { "Content-Type": "application/json" },
      }),
    ],
  ];

  for (const [request, original] of cases) {
    const assets = environment(original);
    const response = await worker.fetch(request, assets.env);
    const responseBody = response.clone();
    const body = await response.text();

    assert.strictEqual(response, original);
    assert.equal(body, await responseBody.text());
  }
});
