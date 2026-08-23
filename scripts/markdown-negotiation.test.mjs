import assert from "node:assert/strict";
import { test } from "node:test";
import worker, {
  acceptsMarkdown,
  htmlToMarkdown,
  negotiateMarkdown,
} from "./pages-worker.mjs";

test("recognizes an explicit text/markdown preference in a comma-separated Accept header", () => {
  assert.equal(
    acceptsMarkdown("text/html, text/markdown; q=0.8, application/json"),
    true,
  );
});

test("does not select Markdown when text/markdown is explicitly disabled", () => {
  assert.equal(acceptsMarkdown("text/markdown; q=0, */*;q=1"), false);
});

test("keeps the existing response behavior without an explicit Markdown preference", () => {
  assert.equal(acceptsMarkdown("text/html, application/xhtml+xml, */*;q=0.8"), false);
  assert.equal(acceptsMarkdown(undefined), false);
});

test("converts meaningful HTML to Markdown and removes page chrome", () => {
  const markdown = htmlToMarkdown(
    `<!doctype html>
<html>
  <head><title>Ignored title</title><style>.hidden { display: none }</style></head>
  <body>
    <header><span class="badge">Chrome badge</span><h1>Guide</h1><p>Intro <strong>text</strong>.</p></header>
    <nav><a href="/ignored">Ignore navigation</a></nav>
    <main>
      <h2>Steps</h2>
      <p>Use <a href="/docs">the docs<small>/docs</small></a>.</p>
      <ul><li>First</li><li>Second</li></ul>
      <pre><code>const value = 1 &lt; 2;</code></pre>
    </main>
    <footer>Ignore footer</footer>
    <script>ignoreScript()</script>
  </body>
</html>`,
    "https://example.test/guide/",
  );

  assert.match(markdown, /^# Guide$/m);
  assert.match(markdown, /Intro \*\*text\*\*\./);
  assert.match(markdown, /^## Steps$/m);
  assert.match(markdown, /\[the docs\]\(https:\/\/example\.test\/docs\)/);
  assert.match(markdown, /- First\n- Second/);
  assert.match(markdown, /```[\s\S]*const value = 1 < 2;[\s\S]*```/);
  assert.doesNotMatch(markdown, /<(?:h1|h2|script|style|nav|footer)\b/i);
  assert.doesNotMatch(markdown, /(?:Chrome badge|the docs\/docs|Ignore (?:navigation|footer|script))/i);
});

test("keeps non-control form content while dropping form controls", () => {
  const markdown = htmlToMarkdown(
    `<form>
      <h1>Guide</h1>
      <p>Keep me</p>
      <input value="Do not keep">
      <button>Do not keep</button>
      <select><option>Do not keep</option></select>
      <textarea>Do not keep</textarea>
    </form>`,
  );

  assert.equal(markdown, "# Guide\n\nKeep me\n");
  assert.doesNotMatch(markdown, /Do not keep/);
});

test("separates adjacent generic block containers", () => {
  const markdown = htmlToMarkdown(
    "<div>First</div><div>Second</div><dl><dt>Term</dt><dd>Meaning</dd></dl>",
  );

  assert.equal(markdown, "First\n\nSecond\n\nTerm\n\nMeaning\n");
});

test("escapes Markdown-looking syntax from ordinary text nodes", () => {
  const markdown = htmlToMarkdown("<p># literal [label](target) ~~literal~~</p>");

  assert.equal(markdown, "\\# literal \\[label\\]\\(target\\) \\~\\~literal\\~\\~\n");
});

test("converts only successful HTML GET responses and preserves Vary dimensions", async () => {
  const original = new Response(
    "<main><h1>Welcome</h1><p>Readable content.</p></main>",
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        Vary: "Origin, Accept-Encoding",
        "Content-Length": "58",
        "Content-Encoding": "gzip",
        "Content-Range": "bytes 0-57/58",
        ETag: '"html-v1"',
        "Last-Modified": "Sat, 22 Aug 2026 00:00:00 GMT",
        "Transfer-Encoding": "chunked",
      },
    },
  );
  const converted = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/html, text/markdown" },
    }),
    original,
  );

  assert.equal(converted.status, 200);
  assert.equal(converted.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(converted.headers.get("Vary"), "Origin, Accept-Encoding, Accept");
  const bodySpecificHeaders = [
    "Content-Length",
    "Content-Encoding",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "Transfer-Encoding",
  ].filter((header) => converted.headers.has(header));
  assert.deepEqual(bodySpecificHeaders, []);
  assert.match(await converted.text(), /^# Welcome$/m);

  const unchangedCases = [
    [
      new Request("https://example.test/", {
        method: "POST",
        headers: { Accept: "text/markdown" },
      }),
      new Response("<h1>Post</h1>", { headers: { "Content-Type": "text/html" } }),
    ],
    [
      new Request("https://example.test/data.json", {
        headers: { Accept: "text/markdown" },
      }),
      new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }),
    ],
    [
      new Request("https://example.test/missing", {
        headers: { Accept: "text/markdown" },
      }),
      new Response("<h1>Missing</h1>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      }),
    ],
  ];

  for (const [request, response] of unchangedCases) {
    assert.strictEqual(await negotiateMarkdown(request, response), response);
    assert.equal(response.headers.get("Vary"), null);
  }
});

test("passes through partial HTML responses unchanged during Markdown negotiation", async () => {
  const partial = new Response("<h1>Partial</h1>", {
    status: 206,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Range": "bytes 0-15/16",
      Vary: "Origin",
    },
  });

  const returned = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    partial,
  );

  assert.strictEqual(returned, partial);
  assert.equal(returned.status, 206);
  assert.equal(returned.headers.get("Content-Range"), "bytes 0-15/16");
  assert.equal(returned.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(await returned.text(), "<h1>Partial</h1>");
});

test("adds Accept variation to successful HTML GET responses without Markdown selection", async () => {
  const defaultResponse = new Response("<h1>Default HTML</h1>", {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      Vary: "Origin",
    },
  });
  const defaultHtml = await negotiateMarkdown(
    new Request("https://example.test/"),
    defaultResponse,
  );
  assert.equal(defaultHtml.status, 200);
  assert.equal(defaultHtml.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(defaultHtml.headers.get("Vary"), "Origin, Accept");
  assert.equal(await defaultHtml.text(), "<h1>Default HTML</h1>");

  const browserResponse = new Response("<h1>Browser HTML</h1>", {
    headers: { "Content-Type": "text/html" },
  });
  const browserHtml = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }),
    browserResponse,
  );
  assert.equal(browserHtml.status, browserResponse.status);
  assert.equal(browserHtml.headers.get("Content-Type"), "text/html");
  assert.equal(browserHtml.headers.get("Vary"), "Accept");
  assert.equal(await browserHtml.text(), "<h1>Browser HTML</h1>");
});

test("the Pages worker negotiates the actual asset response", async () => {
  const request = new Request("https://example.test/tool/", {
    headers: { Accept: "text/markdown" },
  });
  let assetRequest;
  const response = await worker.fetch(request, {
    ASSETS: {
      fetch(receivedRequest) {
        assetRequest = receivedRequest;
        return new Response("<article><h1>Tool</h1><p>Actual asset.</p></article>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    },
  });

  assert.strictEqual(assetRequest, request);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.match(await response.text(), /Actual asset\./);
});
