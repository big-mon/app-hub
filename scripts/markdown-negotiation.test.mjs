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

test("resolves links against the first valid document base", () => {
  assert.equal(
    htmlToMarkdown(
      '<head><base href="javascript:invalid"><base href="/docs/"><base href="/ignored/"></head>'
        + '<p><a href="guide">Guide</a></p>',
      "https://example.test/tool/",
    ),
    "[Guide](https://example.test/docs/guide)\n",
  );
});

test("decodes WHATWG character references in text and attributes", () => {
  const markdown = htmlToMarkdown(
    `<p>Common &copy; and multi-code-point &NotEqualTilde; and text &copy=1.</p>
     <p>Malformed &#x110000; &#xZZ; unknown &does-not-exist;</p>
     <p><img alt="&copy; &NotEqualTilde; &#x110000; &#xZZ; &does-not-exist; &copy=1"></p>`,
  );

  assert.equal(
    markdown,
    "Common © and multi-code-point ≂̸ and text ©=1.\n\n"
      + "Malformed � &#xZZ; unknown &does-not-exist;\n\n"
      + "© ≂̸ � &#xZZ; &does-not-exist; &copy=1\n",
  );
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

test("drops raw-text/RCDATA contents without swallowing following HTML", () => {
  for (const element of ["script", "style", "textarea", "title", "iframe"]) {
    const markdown = htmlToMarkdown(
      `<${element}>for (let i = 0; i < 10; i++) {}</${element}><main><h1>Visible</h1></main>`,
    );

    assert.equal(markdown, "# Visible\n", element);
  }
});

test("separates adjacent generic block containers", () => {
  const markdown = htmlToMarkdown(
    "<div>First</div><div>Second</div><dl><dt>Term</dt><dd>Meaning</dd></dl>",
  );

  assert.equal(markdown, "First\n\nSecond\n\nTerm\n\nMeaning\n");
});

test("preserves table cell and row boundaries", () => {
  assert.equal(
    htmlToMarkdown(
      "<table><tr><td>Alpha</td><td>Beta</td></tr><tr><td>Gamma</td><td>Delta</td></tr></table>",
    ),
    "Alpha\n\nBeta\n\nGamma\n\nDelta\n",
  );
});

test("preserves table caption, section, header, and footer boundaries", () => {
  assert.equal(
    htmlToMarkdown(
      "<table><caption>Caption</caption><thead><tr><th>Head A</th><th>Head B</th></tr></thead><tbody><tr><td>Body A</td><td>Body B</td></tr></tbody><tfoot><tr><td>Foot A</td><td>Foot B</td></tr></tfoot></table>",
    ),
    "Caption\n\nHead A\n\nHead B\n\nBody A\n\nBody B\n\nFoot A\n\nFoot B\n",
  );
});

test("applies supported HTML implied end tags before nesting", () => {
  assert.equal(htmlToMarkdown("<ul><li>one<li>two</ul>"), "- one\n- two\n");
  assert.equal(htmlToMarkdown("<p>one<p>two"), "one\n\ntwo\n");
  assert.equal(htmlToMarkdown("<p>one<div>two</div>"), "one\n\ntwo\n");
  assert.equal(
    htmlToMarkdown("<dl><dt>term one<dd>meaning one<dt>term two<dd>meaning two</dl>"),
    "term one\n\nmeaning one\n\nterm two\n\nmeaning two\n",
  );
});

test("preserves ordered-list numbering attributes and continuation", () => {
  assert.equal(
    htmlToMarkdown('<ol start="3"><li>three<li>four</ol>'),
    "3. three\n4. four\n",
  );
  assert.equal(
    htmlToMarkdown("<ol reversed><li>two<li>one</ol>"),
    "2. two\n1. one\n",
  );
  assert.equal(
    htmlToMarkdown('<ol start="8" reversed><li>eight<li>seven</ol>'),
    "8. eight\n7. seven\n",
  );
  assert.equal(
    htmlToMarkdown('<ol><li value="4">four<li>five</ol>'),
    "4. four\n5. five\n",
  );
  assert.equal(
    htmlToMarkdown('<ol start="not-an-integer"><li>one<li>two</ol>'),
    "1. one\n2. two\n",
  );
});

test("uses a visible-label fallback for oversized decimal ordered values", () => {
  assert.equal(
    htmlToMarkdown('<ol start="1000000000"><li>large</li></ol>'),
    "- 1000000000. large\n",
  );
});

test("preserves supported ordered-list type labels with valid Markdown markers", () => {
  assert.equal(
    htmlToMarkdown('<ol type="1" start="3"><li>three<li>four</ol>'),
    "3. three\n4. four\n",
  );
  assert.equal(
    htmlToMarkdown('<ol type="A" start="26"><li>zulu<li value="28">ab<li>ac</ol>'),
    "- Z. zulu\n- AB. ab\n- AC. ac\n",
  );
  assert.equal(
    htmlToMarkdown('<ol type="a"><li>one<li>two</ol>'),
    "- a. one\n- b. two\n",
  );
  assert.equal(
    htmlToMarkdown('<ol type="I" start="4" reversed><li>four<li>three</ol>'),
    "- IV. four\n- III. three\n",
  );
  assert.equal(
    htmlToMarkdown('<ol type="i" start="9"><li>nine<li>ten</ol>'),
    "- ix. nine\n- x. ten\n",
  );
});

test("preserves reversed numbering across dropped list items", () => {
  assert.equal(
    htmlToMarkdown(
      '<ol reversed><li>three</li><li class="navigation-marker">drop</li><li>one</li></ol>',
    ),
    "3. three\n1. one\n",
  );
});

test("keeps negative ordered values visible with valid Markdown markers", () => {
  assert.equal(
    htmlToMarkdown('<ol start="-1"><li>minus one<li>zero<li>one</ol>'),
    "- -1. minus one\n0. zero\n1. one\n",
  );
});

test("keeps large negative ordered values and nested indentation BigInt-safe", () => {
  assert.equal(
    htmlToMarkdown(
      '<ol><li value="-90071992547409931234567890">huge<ul><li>child</li></ul></li><li>next</li></ol>',
    ),
    "- -90071992547409931234567890. huge\n"
      + "  - child\n"
      + "- -90071992547409931234567889. next\n",
  );
});

test("emits a negative ordered marker before a first nested list", () => {
  assert.equal(
    htmlToMarkdown('<ol start="-1"><li><ul><li>child</li></ul>after</li></ol>'),
    "- -1.\n  - child\n  after\n",
  );
});

test("indents nested lists by the containing marker width", () => {
  assert.equal(
    htmlToMarkdown("<ul><li>parent<ul><li>child</li></ul></li></ul>"),
    "- parent\n  - child\n",
  );
  assert.equal(
    htmlToMarkdown("<ol><li>parent<ul><li>child</li></ul></li></ol>"),
    "1. parent\n   - child\n",
  );
  assert.equal(
    htmlToMarkdown('<ol start="10"><li>parent<ul><li>child</li></ul></li></ol>'),
    "10. parent\n    - child\n",
  );
});

test("preserves source order around nested lists", () => {
  assert.equal(
    htmlToMarkdown("<ul><li>before<ul><li>child</li></ul>after</li></ul>"),
    "- before\n  - child\n  after\n",
  );
});

test("preserves order across multiple nested and block children", () => {
  assert.equal(
    htmlToMarkdown(
      "<ul><li>before<p>middle</p><ul><li>child</li></ul>between<ol><li>second</li></ol>after</li></ul>",
    ),
    "- before\n\n  middle\n\n  - child\n  between\n  1. second\n  after\n",
  );
});

test("preserves paragraph boundaries within list items", () => {
  assert.equal(
    htmlToMarkdown("<ul><li><p>First</p><p>Second</p></li></ul>"),
    "- First\n\n  Second\n",
  );
});

test("escapes Markdown-looking syntax from ordinary text nodes", () => {
  const markdown = htmlToMarkdown("<p># literal [label](target) ~~literal~~</p>");

  assert.equal(markdown, "\\# literal \\[label\\]\\(target\\) \\~\\~literal\\~\\~\n");
});

test("escapes Markdown-looking syntax in image alt text", () => {
  const markdown = htmlToMarkdown('<p><img alt="[Click](https://evil.test)"></p>');

  assert.equal(markdown, "\\[Click\\]\\(https://evil.test\\)\n");
});

test("preserves link text when href is missing", () => {
  assert.equal(htmlToMarkdown("<p><a>Coming soon</a></p>"), "Coming soon\n");
});

test("does not escape brackets inside generated code-span link labels", () => {
  assert.equal(
    htmlToMarkdown('<p><a href="/x"><code>[x]</code></a></p>', "https://example.test/"),
    "[``[x]``](https://example.test/x)\n",
  );
});

test("preserves boundaries for invalid and whitespace-only links", () => {
  assert.equal(
    htmlToMarkdown("<p>Hello<a> world</a>today</p>"),
    "Hello worldtoday\n",
  );
  assert.equal(
    htmlToMarkdown('<p>Hello<a href="javascript:void(0)"> world</a>today</p>'),
    "Hello worldtoday\n",
  );
  assert.equal(
    htmlToMarkdown('<p>Before<a href="/x"> </a>after</p>'),
    "Before [https://example.invalid/x](https://example.invalid/x)after\n",
  );
  assert.equal(
    htmlToMarkdown('<p>Before<a href="/x"></a>after</p>'),
    "Before[https://example.invalid/x](https://example.invalid/x)after\n",
  );
});

test("escapes parentheses in Markdown link destinations", () => {
  assert.equal(
    htmlToMarkdown('<p><a href="https://example.test/report)">Report</a></p>'),
    "[Report](https://example.test/report\\))\n",
  );
});

test("preserves boundary whitespace around inline Markdown wrappers", () => {
  assert.equal(
    htmlToMarkdown('<p>Visit <a href="/x">this page </a>today</p>'),
    "Visit [this page](https://example.invalid/x) today\n",
  );

  for (const [tag, marker] of [
    ["strong", "**"],
    ["b", "**"],
    ["em", "*"],
    ["i", "*"],
    ["del", "~~"],
    ["s", "~~"],
    ["strike", "~~"],
  ]) {
    assert.equal(
      htmlToMarkdown(`<p>Hello<${tag}> world</${tag}></p>`),
      `Hello ${marker}world${marker}\n`,
      tag,
    );
  }
});

test("preserves edge backticks in inline code", () => {
  assert.equal(htmlToMarkdown("<p><code>`foo`</code></p>"), "`` `foo` ``\n");
});

test("preserves boundary whitespace around inline code", () => {
  assert.equal(
    htmlToMarkdown("<p>Hello<code> world </code>today</p>"),
    "Hello ``world`` today\n",
  );
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
