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

test("preserves text after invalid tag candidates while dropping declarations", () => {
  assert.equal(
    htmlToMarkdown("<p>left < b and right</p><p>Visible</p>"),
    "left \\< b and right\n\nVisible\n",
  );
  assert.equal(
    htmlToMarkdown("<p>1 < 2 and 3 > 1</p>"),
    "1 \\< 2 and 3 \\> 1\n",
  );
  assert.equal(htmlToMarkdown("<!doctype html><p>Visible</p>"), "Visible\n");
  assert.equal(htmlToMarkdown("<p>unterminated < text"), "unterminated \\< text\n");
});

test("follows HTML tokenization for invalid end-tag candidates", () => {
  assert.equal(
    htmlToMarkdown("<p>left < /p> and right</p><p>Visible</p>"),
    "left \\< /p\\> and right\n\nVisible\n",
  );
  assert.equal(
    htmlToMarkdown("<p>left </ p> and right</p><p>Visible</p>"),
    "left  and right\n\nVisible\n",
  );
  assert.equal(
    htmlToMarkdown(
      "<noscript>drop </ noscript><p>Leaked</p></noscript><main>Visible</main>",
    ),
    "Visible\n",
  );
});

test("preserves Unicode spacing while normalizing only HTML ASCII whitespace", () => {
  assert.equal(
    htmlToMarkdown("<p>10&nbsp;&nbsp;kg and  a&#9;b&#10;c&#12;d&#13;e</p>"),
    "10\u00a0\u00a0kg and a b c d e\n",
  );
  assert.equal(
    htmlToMarkdown("<p>wide&emsp;space&#8239;here <strong>bold&nbsp;&nbsp;text</strong></p>"),
    "wide\u2003space\u202fhere **bold\u00a0\u00a0text**\n",
  );
  assert.equal(
    htmlToMarkdown("<p>Hello<strong>&nbsp;world&nbsp;</strong>today</p>"),
    "Hello**\u00a0world\u00a0**today\n",
  );
  assert.equal(
    htmlToMarkdown("<p><code>a&nbsp;&nbsp;b&#9; c</code></p><pre>a&nbsp;&nbsp;b\nc</pre>"),
    "``a\u00a0\u00a0b c``\n\n```\na\u00a0\u00a0b\nc\n```\n",
  );
});

test("drops subtrees when the native hidden attribute is present", () => {
  assert.equal(
    htmlToMarkdown(
      '<main><p>Visible</p><div hidden>Secret panel</div>'
        + '<div hidden="false"><strong>Also hidden</strong></div><p>After</p></main>',
    ),
    "Visible\n\nAfter\n",
  );
});

test("preserves Unicode spaces in inline code and keeps dynamic fences", () => {
  assert.equal(
    htmlToMarkdown("<p><code>a&nbsp;&nbsp;`b`</code></p>"),
    "`` a\u00a0\u00a0`b` ``\n",
  );
});

test("renders preformatted br elements as newlines without exposing dropped content", () => {
  assert.equal(htmlToMarkdown("<pre>one<br>two</pre>"), "```\none\ntwo\n```\n");
  assert.equal(
    htmlToMarkdown("<pre>one<br><aside>secret<br>still secret</aside>two</pre>"),
    "```\none\ntwo\n```\n",
  );
});

test("preserves repeated blank lines inside fenced code blocks", () => {
  assert.equal(
    htmlToMarkdown("<pre>one\n\n\ntwo</pre>"),
    "```\none\n\n\ntwo\n```\n",
  );
});

test("preserves fenced code line endings while trimming structural line endings", () => {
  assert.equal(
    htmlToMarkdown("<p>before   </p><pre>one  \ntwo\t</pre><p>after\t</p>"),
    "before\n\n```\none  \ntwo\t\n```\n\nafter\n",
  );
});

test("preserves meaningful Unicode spacing at rendered block boundaries", () => {
  assert.equal(htmlToMarkdown("<p>&nbsp;lead</p>"), "\u00a0lead\n");
  assert.equal(htmlToMarkdown("<p>trail&nbsp;</p>"), "trail\u00a0\n");
  assert.equal(htmlToMarkdown("<h1>&nbsp;title&nbsp;</h1>"), "# \u00a0title\u00a0\n");
  assert.equal(htmlToMarkdown("<ul><li>&nbsp;item&nbsp;</li></ul>"), "- \u00a0item\u00a0\n");
  assert.equal(
    htmlToMarkdown("<blockquote>&nbsp;quote&nbsp;</blockquote>"),
    "> \u00a0quote\u00a0\n",
  );
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

test("uses the HTML raw-text end-tag rules before rendering following content", () => {
  assert.equal(
    htmlToMarkdown("<script>ignored</script data-x><main>Visible</main>"),
    "Visible\n",
  );
});

test("does not use foreign SVG metadata as the HTML document base", () => {
  assert.equal(
    htmlToMarkdown(
      '<svg><base href="https://other.test/"></svg><a href="guide">Guide</a>',
      "https://example.test/docs/",
    ),
    "[Guide](https://example.test/docs/guide)\n",
  );
});

test("handles a malformed HTML comment before visible content", () => {
  assert.equal(htmlToMarkdown("<!--><p>Visible</p>"), "Visible\n");
});

test("ignores base elements inside inert templates", () => {
  assert.equal(
    htmlToMarkdown(
      '<template><base href="https://other.test/"></template><a href="guide">Guide</a>',
      "https://example.test/request/",
    ),
    "[Guide](https://example.test/request/guide)\n",
  );
});

test("keeps the first case-insensitive occurrence of duplicate attributes", () => {
  assert.equal(
    htmlToMarkdown('<p><a HREF="/safe" href="/other">Link</a></p>', "https://example.test/"),
    "[Link](https://example.test/safe)\n",
  );
  assert.equal(
    htmlToMarkdown('<p><img ALT="first" alt="second"></p>'),
    "first\n",
  );
});

test("preserves trailing slashes in unquoted URL attributes and separate self-closing markers", () => {
  assert.equal(
    htmlToMarkdown('<p><a href=/docs/>Home</a></p>', "https://example.test/"),
    "[Home](https://example.test/docs/)\n",
  );
  assert.equal(
    htmlToMarkdown('<base href=/docs/><p><a href=guide>Guide</a></p>', "https://example.test/"),
    "[Guide](https://example.test/docs/guide)\n",
  );
  assert.equal(
    htmlToMarkdown('<base href=/docs /><p><a href=guide>Guide</a><br/>Next</p>', "https://example.test/"),
    "[Guide](https://example.test/guide)\\\nNext\n",
  );
});

test("ignores non-void HTML self-closing markers but preserves foreign self-closing boundaries", () => {
  assert.equal(
    htmlToMarkdown('<p>Before <a href="/x" />Link</p>', "https://example.test/"),
    "Before [Link](https://example.test/x)\n",
  );
  assert.equal(htmlToMarkdown("<svg/><p>Visible</p>"), "Visible\n");
});

test("closes an unclosed head before attaching an explicit body", () => {
  assert.equal(
    htmlToMarkdown("<html><head><title>x</title><body><h1>Visible</h1>"),
    "# Visible\n",
  );
});

test("closes an unclosed head before attaching implicit body content", () => {
  assert.equal(
    htmlToMarkdown("<html><head><title>x</title><h1>Visible</h1>"),
    "# Visible\n",
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
  for (const element of ["script", "style", "textarea", "title", "iframe", "noscript"]) {
    const markdown = htmlToMarkdown(
      `<${element}>for (let i = 0; i < 10; i++) {}</${element}><main><h1>Visible</h1></main>`,
    );

    assert.equal(markdown, "# Visible\n", element);
  }
});

test("drops noembed fallback as raw text without swallowing following HTML", () => {
  assert.equal(
    htmlToMarkdown("<noembed>fallback < 3</noembed><main>Visible</main>"),
    "Visible\n",
  );
});

test("separates adjacent generic block containers", () => {
  const markdown = htmlToMarkdown(
    "<div>First</div><div>Second</div><dl><dt>Term</dt><dd>Meaning</dd></dl>",
  );

  assert.equal(markdown, "First\n\nSecond\n\nTerm\n\nMeaning\n");
});

test("separates adjacent dialog containers", () => {
  assert.equal(
    htmlToMarkdown("<dialog open>First</dialog><dialog open>Second</dialog>"),
    "First\n\nSecond\n",
  );
});

test("renders search as a block container", () => {
  assert.equal(
    htmlToMarkdown("<search><p>Find tools</p><p>Filters</p></search>"),
    "Find tools\n\nFilters\n",
  );
});

test("preserves details and fieldset boundaries", () => {
  assert.equal(
    htmlToMarkdown(
      "<details><summary>First summary</summary><p>First details</p></details>"
        + "<details><summary>Second summary</summary><p>Second details</p></details>"
        + "<fieldset><legend>First legend</legend><p>First fieldset</p></fieldset>"
        + "<fieldset><legend>Second legend</legend><p>Second fieldset</p></fieldset>",
    ),
    "First summary\n\nFirst details\n\n"
      + "Second summary\n\nSecond details\n\n"
      + "First legend\n\nFirst fieldset\n\n"
      + "Second legend\n\nSecond fieldset\n",
  );
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

test("renders menu as an unordered list with omitted and nested list items", () => {
  assert.equal(
    htmlToMarkdown("<menu><li>Cut</li><li>Copy</li></menu>"),
    "- Cut\n- Copy\n",
  );
  assert.equal(
    htmlToMarkdown("<menu><li>File<menu><li>New<li>Open</menu><li>Edit</menu>"),
    "- File\n  - New\n  - Open\n- Edit\n",
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

test("escapes exclamation marks before generated links", () => {
  assert.equal(
    htmlToMarkdown('<p>Alert!<a href="/warning">warning</a></p>'),
    "Alert\\![warning](https://example.invalid/warning)\n",
  );
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

test("merges adjacent generated inline wrappers without touching delimiter runs", () => {
  for (const [source, expected] of [
    ["<p><em>a</em><em>b</em></p>", "*ab*\n"],
    ["<p><strong>a</strong><b>b</b></p>", "**ab**\n"],
    ["<p><del>a</del><s>b</s></p>", "~~ab~~\n"],
    ["<p><em>a</em><span hidden>x</span><em>b</em></p>", "*ab*\n"],
    ["<p><em>a</em> <em>b</em></p>", "*a* *b*\n"],
  ]) {
    assert.equal(htmlToMarkdown(source), expected, source);
  }
});

test("preserves edge backticks in inline code", () => {
  assert.equal(htmlToMarkdown("<p><code>`foo`</code></p>"), "`` `foo` ``\n");
});

test("merges adjacent inline code spans without changing visible whitespace", () => {
  assert.equal(
    htmlToMarkdown("<p><code>a</code><code>b</code></p>"),
    "``ab``\n",
  );
  assert.equal(
    htmlToMarkdown(
      '<p><a href="/x"><code>a</code><code>b</code></a></p>',
      "https://example.test/",
    ),
    "[``ab``](https://example.test/x)\n",
  );
  assert.equal(
    htmlToMarkdown("<p><code>a </code><code> b</code></p>"),
    "``a b``\n",
  );
});

test("merges inline code spans across empty rendered siblings", () => {
  assert.equal(
    htmlToMarkdown("<p><code>a</code><span hidden>x</span><code>b</code></p>"),
    "``ab``\n",
  );
});

test("merges adjacent inline code spans in list items", () => {
  assert.equal(
    htmlToMarkdown("<ul><li><code>a</code><code>b</code></li></ul>"),
    "- ``ab``\n",
  );
});

test("merges adjacent inline code spans in root runs", () => {
  assert.equal(
    htmlToMarkdown("<code>a</code><code>b</code>"),
    "``ab``\n",
  );
});

test("preserves explicit HTML line breaks in paragraphs", () => {
  assert.equal(htmlToMarkdown("<p>First<br>Second</p>"), "First\\\nSecond\n");
});

test("preserves explicit HTML line breaks in list items", () => {
  assert.equal(
    htmlToMarkdown("<ul><li>First<br>Second</li></ul>"),
    "- First\\\n  Second\n",
  );
});

test("preserves boundary whitespace around inline code", () => {
  assert.equal(
    htmlToMarkdown("<p>Hello<code> world </code>today</p>"),
    "Hello ``world`` today\n",
  );
});

test("decodes raw windows-1252 HTML bytes before Markdown negotiation", async () => {
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(
      Uint8Array.from([
        0x3c, 0x6d, 0x61, 0x69, 0x6e, 0x3e, 0x3c, 0x70, 0x3e,
        0x43, 0x61, 0x66, 0xe9,
        0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x6d, 0x61, 0x69, 0x6e, 0x3e,
      ]),
      { headers: { "Content-Type": "text/html; charset=windows-1252" } },
    ),
  );

  assert.equal(await response.text(), "Café\n");
});

test("gives a leading UTF-8 BOM precedence over a conflicting transport charset", async () => {
  const originalBytes = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...new TextEncoder().encode("<main><p>Café</p></main>"),
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, {
      headers: { "Content-Type": "text/html; charset=windows-1252" },
    }),
  );

  assert.equal(await response.text(), "Café\n");
});

test("decodes quoted charset labels case-insensitively before Markdown negotiation", async () => {
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(
      Uint8Array.from([
        0x3c, 0x6d, 0x61, 0x69, 0x6e, 0x3e, 0x3c, 0x70, 0x3e,
        0x43, 0x61, 0x66, 0xe9,
        0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x6d, 0x61, 0x69, 0x6e, 0x3e,
      ]),
      { headers: { "Content-Type": 'TEXT/HTML; CHARSET="WINDOWS-1252"' } },
    ),
  );

  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "Café\n");
});

test("uses an early HTML meta charset when Content-Type omits charset", async () => {
  const originalBytes = Uint8Array.from([
    ...new TextEncoder().encode('<meta charset="windows-1252"><main><p>Caf'),
    0xe9,
    ...new TextEncoder().encode("</p></main>"),
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(await response.text(), "Café\n");
});

test("normalizes case-insensitive UTF-16 meta charset labels to UTF-8", async () => {
  for (const label of ["UtF-16Le", "uTf-16Be"]) {
    const response = await negotiateMarkdown(
      new Request("https://example.test/", {
        headers: { Accept: "text/markdown" },
      }),
      new Response(
        new TextEncoder().encode(
          `<meta charset="${label}"><main><p>Café</p></main>`,
        ),
        { headers: { "Content-Type": "text/html" } },
      ),
    );

    assert.equal(await response.text(), "Café\n", label);
  }
});

test("normalizes UTF-16 labels from http-equiv content-type meta declarations", async () => {
  for (const label of ["UTF-16LE", "UTF-16BE"]) {
    const response = await negotiateMarkdown(
      new Request("https://example.test/", {
        headers: { Accept: "text/markdown" },
      }),
      new Response(
        new TextEncoder().encode(
          `<meta HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=${label}">`
            + "<main><p>Café</p></main>",
        ),
        { headers: { "Content-Type": "text/html" } },
      ),
    );

    assert.equal(await response.text(), "Café\n", label);
  }
});

test("requires an exact HTML meta start tag when sniffing charset", async () => {
  const originalBytes = new TextEncoder().encode(
    '<meta-widget charset="windows-1252"><meta charset="utf-8"><p>Café</p>',
  );
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(await response.text(), "Café\n");
});

test("recognizes quoted greater-than delimiters while sniffing meta charset", async () => {
  const originalBytes = Uint8Array.from([
    ...new TextEncoder().encode('<meta data-note=">" charset="windows-1252"><main><p>Caf'),
    0xe9,
    ...new TextEncoder().encode("</p></main>"),
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "Café\n");
});

test("ignores meta charset declarations inside HTML comments", async () => {
  const originalBytes = new TextEncoder().encode(
    '<!-- <meta charset="x-unsupported"> --><main><p>Café</p></main>',
  );
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "Café\n");
});

test("keeps an open HTML comment inert through the encoding sniff window", async () => {
  const comment = '<!-- <meta charset="windows-1252">';
  const prefix = `${comment}${"x".repeat(1024 - comment.length)}`;
  const originalBytes = Uint8Array.from([
    ...new TextEncoder().encode(prefix),
    ...new TextEncoder().encode("--><main><p>Café</p></main>"),
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(await response.text(), "Café\n");
});

test("uses a BOM before an in-document charset declaration", async () => {
  const source = '<meta charset="windows-1252"><main><p>Café</p></main>';
  const originalBytes = new Uint8Array(2 + source.length * 2);
  originalBytes.set([0xff, 0xfe]);
  for (let index = 0; index < source.length; index += 1) {
    const codePoint = source.charCodeAt(index);
    originalBytes[2 + index * 2] = codePoint & 0xff;
    originalBytes[3 + index * 2] = codePoint >> 8;
  }
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(await response.text(), "Café\n");
});

test("passes through original bytes for an unsupported HTML meta charset", async () => {
  const originalBytes = new TextEncoder().encode(
    '<meta charset="x-unsupported"><main><p>Visible</p></main>',
  );
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, { headers: { "Content-Type": "text/html" } }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/html");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.deepEqual(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    Array.from(originalBytes),
  );
});

test("passes through original HTML bytes for an unsupported declared charset", async () => {
  const originalBytes = Uint8Array.from([
    0x3c, 0x6d, 0x61, 0x69, 0x6e, 0x3e, 0x3c, 0x70, 0x3e,
    0x55, 0x6e, 0x73, 0x75, 0x70, 0x70, 0x6f, 0x72, 0x74, 0x65, 0x64,
    0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x6d, 0x61, 0x69, 0x6e, 0x3e,
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, {
      headers: { "Content-Type": "text/html; charset=x-unsupported" },
    }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/html; charset=x-unsupported");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.deepEqual(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    Array.from(originalBytes),
  );
});

test("passes through original HTML bytes when a recognized fatal decoder rejects them", async () => {
  const originalBytes = Uint8Array.from([
    0x3c, 0x6d, 0x61, 0x69, 0x6e, 0x3e, 0x3c, 0x70, 0x3e,
    0x49, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0xc3, 0x28,
    0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x6d, 0x61, 0x69, 0x6e, 0x3e,
  ]);
  const response = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response(originalBytes, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/html; charset=UTF-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.deepEqual(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    Array.from(originalBytes),
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

test("removes Accept-Ranges from transformed Markdown responses", async () => {
  const converted = await negotiateMarkdown(
    new Request("https://example.test/", {
      headers: { Accept: "text/markdown" },
    }),
    new Response("<h1>Welcome</h1>", {
      headers: {
        "Content-Type": "text/html",
        "Accept-Ranges": "bytes",
      },
    }),
  );

  assert.equal(converted.headers.get("Accept-Ranges"), null);
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
