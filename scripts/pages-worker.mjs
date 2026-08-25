import { parse as parseHtmlDocument } from "parse5";

const MARKDOWN_MEDIA_TYPE = "text/markdown";
const HTML_MEDIA_TYPE = "text/html";
const HTML_ENCODING_SNIFF_LIMIT = 1024;
const QVALUE_PATTERN = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const DROPPED_ELEMENTS = new Set([
  "aside",
  "button",
  "canvas",
  "embed",
  "footer",
  "head",
  "iframe",
  "input",
  "link",
  "meta",
  "nav",
  "noembed",
  "noscript",
  "object",
  "script",
  "select",
  "small",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "dialog",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "hr",
  "li",
  "legend",
  "main",
  "menu",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "body",
  "ul",
]);
const NAVIGATION_MARKER = /(?:^|[\s_-])(?:nav|navigation|menu|breadcrumb|breadcrumbs|sidebar|cookie|consent|badge|dot|decorative)(?:$|[\s_-])/i;
const FENCED_BLOCK_START = "\u0000fenced-block-start\u0000";
const FENCED_BLOCK_END = "\u0000fenced-block-end\u0000";

function trimHtmlWhitespace(value) {
  return value.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
}

function hasHtmlText(value) {
  return /[^ \t\n\f\r]/.test(value);
}

function trimHtmlWhitespaceEnd(value) {
  return value.replace(/[ \t\n\f\r]+$/g, "");
}

function splitHeaderValue(value, separator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote || character;
      continue;
    }
    if (!quote && character === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function parseMarkdownAccept(acceptHeader) {
  if (typeof acceptHeader !== "string") return [];

  const preferences = [];
  for (const item of splitHeaderValue(acceptHeader, ",")) {
    const parameters = splitHeaderValue(item, ";");
    const mediaRange = parameters.shift()?.trim().toLowerCase();
    if (mediaRange !== MARKDOWN_MEDIA_TYPE) continue;

    let quality = 1;
    let valid = true;
    for (const parameter of parameters) {
      const equals = parameter.indexOf("=");
      if (equals < 0 || parameter.slice(0, equals).trim().toLowerCase() !== "q") {
        continue;
      }

      const rawQuality = parameter
        .slice(equals + 1)
        .trim()
        .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
      if (!QVALUE_PATTERN.test(rawQuality)) {
        valid = false;
        break;
      }
      quality = Number(rawQuality);
    }

    if (valid) preferences.push(quality);
  }

  return preferences;
}

export function acceptsMarkdown(acceptHeader) {
  return parseMarkdownAccept(acceptHeader).some((quality) => quality > 0);
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function adaptAttributes(sourceAttributes) {
  const attributes = Object.create(null);
  for (const attribute of sourceAttributes ?? []) {
    if (Object.hasOwn(attributes, attribute.name)) continue;
    attributes[attribute.name] = attribute.value;
  }
  return attributes;
}

function adaptNode(node) {
  if (node.nodeName === "#text") {
    return { type: "text", value: node.value };
  }
  if (node.nodeName === "#comment" || node.nodeName === "#documentType") return null;
  if (!node.tagName) return null;

  const childNodes = node.nodeName === "template" && node.content
    ? node.content.childNodes
    : node.childNodes;
  return {
    type: "element",
    name: node.tagName,
    namespace: node.namespaceURI,
    attributes: adaptAttributes(node.attrs),
    children: (childNodes ?? []).map(adaptNode).filter(Boolean),
  };
}

function parseHtml(html) {
  const document = parseHtmlDocument(html);
  return {
    type: "element",
    name: "root",
    namespace: null,
    attributes: Object.create(null),
    children: (document.childNodes ?? []).map(adaptNode).filter(Boolean),
  };
}

function shouldDrop(node) {
  if (DROPPED_ELEMENTS.has(node.name)) return true;
  const attributes = node.attributes;
  if (Object.hasOwn(attributes, "hidden")) return true;
  const marker = [attributes.id, attributes.class, attributes.role]
    .filter(Boolean)
    .join(" ");
  return NAVIGATION_MARKER.test(marker);
}

function textContent(node, preserveWhitespace = false) {
  if (node.type === "text") return node.value;
  if (shouldDrop(node)) return "";
  return node.children
    .map((child) => textContent(child, preserveWhitespace))
    .join(preserveWhitespace ? "" : " ");
}

function preformattedTextContent(node) {
  if (node.type === "text") return node.value;
  if (shouldDrop(node)) return "";
  if (node.name === "br") return "\n";
  return node.children.map((child) => preformattedTextContent(child)).join("");
}

function normalizeInlineText(value) {
  return value.replace(/[ \t\n\f\r]+/g, " ");
}

function escapeMarkdownText(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()<>!])/g, "\\$1")
    .replace(/~~/g, "\\~\\~");

  return escaped
    .replace(
      /(^|\n)([ \t]{0,3})(?=#{1,6}(?:\s|$)|>(?:[ \t]|$)|[+-](?:[ \t]|$)|-{3,}(?:\s|$))/g,
      (match, lineBreak, indentation) => `${lineBreak}${indentation}\\`,
    )
    .replace(
      /(^|\n)([ \t]{0,3}\d{1,9})\.(?=\s)/g,
      (match, lineBreak, prefix) => `${lineBreak}${prefix}\\.`,
    )
    .replace(/(^|\n)([ \t]{0,3})(?=={3,}(?:\s|$))/g, (match, lineBreak, indentation) => (
      `${lineBreak}${indentation}\\`
    ));
}

function escapeLinkLabel(value) {
  return value.replace(
    /(?<!\\)(`+)[\s\S]*?\1|(?<!\\)([\[\]])/g,
    (match, _fence, bracket) => (bracket ? `\\${bracket}` : match),
  );
}

function escapeLinkDestination(value) {
  return value.replace(/([()])/g, "\\$1");
}

function splitInlineBoundary(value) {
  const leading = value.match(/^[ \t\n\f\r]*/)[0];
  const remaining = value.slice(leading.length);
  const trailing = remaining.match(/[ \t\n\f\r]*$/)[0];
  const content = remaining.slice(0, remaining.length - trailing.length);
  return { leading, content, trailing };
}

function wrapInline(value, opening, closing) {
  const { leading, content, trailing } = splitInlineBoundary(value);
  return content ? `${leading}${opening}${content}${closing}${trailing}` : value;
}

function inlineWrapperMarker(node) {
  if (node.type !== "element") return null;
  if (node.name === "em" || node.name === "i") return "*";
  if (node.name === "strong" || node.name === "b") return "**";
  if (node.name === "del" || node.name === "s" || node.name === "strike") return "~~";
  return null;
}

function renderInlineCode(value) {
  const normalizedValue = normalizeInlineText(value);
  const { content } = splitInlineBoundary(normalizedValue);
  const run = Math.max(1, ...[...content.matchAll(/`+/g)].map((match) => match[0].length)) + 1;
  const fence = "`".repeat(run);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return wrapInline(normalizedValue, `${fence}${padding}`, `${padding}${fence}`);
}

function renderInlineSiblings(nodes, baseUrl) {
  let rendered = "";
  for (let index = 0; index < nodes.length;) {
    const child = nodes[index];
    if (child.type === "element" && child.name === "code") {
      let value = "";
      do {
        value += textContent(nodes[index], true);
        index += 1;
      } while (
        index < nodes.length
        && (
          (nodes[index].type === "element" && nodes[index].name === "code")
          || renderInline(nodes[index], baseUrl) === ""
        )
      );
      rendered += renderInlineCode(value);
      continue;
    }

    const marker = inlineWrapperMarker(child);
    if (marker) {
      let value = renderInline(child, baseUrl);
      let nextIndex = index + 1;
      while (value.endsWith(marker) && nextIndex < nodes.length) {
        const sibling = nodes[nextIndex];
        const siblingRendered = renderInline(sibling, baseUrl);
        if (siblingRendered === "") {
          nextIndex += 1;
          continue;
        }
        if (inlineWrapperMarker(sibling) !== marker || !siblingRendered.startsWith(marker)) break;
        value = value.slice(0, -marker.length) + siblingRendered.slice(marker.length);
        nextIndex += 1;
      }
      rendered += value;
      index = nextIndex;
      continue;
    }

    rendered += renderInline(child, baseUrl);
    index += 1;
  }
  return rendered;
}

function resolveLink(value, baseUrl) {
  const href = (value ?? "").trim();
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function resolveDocumentBase(node, requestUrl) {
  if (
    node.type !== "element"
    || (node.name !== "root" && node.namespace !== HTML_NAMESPACE)
  ) return null;
  if (node.name === "template") return null;
  if (node.name === "base") {
    const base = resolveLink(node.attributes.href, requestUrl);
    if (base) return base;
  }

  for (const child of node.children) {
    const base = resolveDocumentBase(child, requestUrl);
    if (base) return base;
  }

  return null;
}

function renderInline(node, baseUrl) {
  if (node.type === "text") {
    return escapeMarkdownText(normalizeInlineText(node.value));
  }
  if (shouldDrop(node)) return "";

  const children = () => renderInlineSiblings(node.children, baseUrl);
  switch (node.name) {
    case "a": {
      const renderedLabel = children();
      const { leading, content, trailing } = splitInlineBoundary(renderedLabel);
      const href = resolveLink(node.attributes.href, baseUrl);
      if (!href) return renderedLabel;
      return `${leading}[${escapeLinkLabel(content || href)}](${escapeLinkDestination(href)})${trailing}`;
    }
    case "br":
      return "\\\n";
    case "code": {
      return renderInlineCode(textContent(node, true));
    }
    case "del":
    case "s":
    case "strike":
      return wrapInline(children(), "~~", "~~");
    case "b":
    case "strong":
      return wrapInline(children(), "**", "**");
    case "em":
    case "i":
      return wrapInline(children(), "*", "*");
    case "img":
      return escapeMarkdownText(normalizeInlineText(node.attributes.alt ?? ""));
    default:
      return children();
  }
}

function codeLanguage(node) {
  const className = node.children
    .find((child) => child.type === "element" && child.name === "code")
    ?.attributes.class;
  return className?.match(/(?:^|\s)language-([\w+-]+)/i)?.[1] ?? "";
}

function renderCodeBlock(node) {
  const value = preformattedTextContent(node).replace(/\r\n?/g, "\n").replace(/^\n|\n$/g, "");
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${codeLanguage(node)}\n${value}\n${fence}`;
}

function normalizeStructuralWhitespace(value) {
  const normalizeOutsideFence = (segment) =>
    segment.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  let normalized = "";
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf(FENCED_BLOCK_START, cursor);
    if (start < 0) {
      normalized += normalizeOutsideFence(value.slice(cursor));
      break;
    }

    const contentStart = start + FENCED_BLOCK_START.length;
    const end = value.indexOf(FENCED_BLOCK_END, contentStart);
    if (end < 0) {
      normalized += normalizeOutsideFence(value.slice(cursor));
      break;
    }

    normalized += normalizeOutsideFence(value.slice(cursor, start));
    normalized += value.slice(start, end + FENCED_BLOCK_END.length);
    cursor = end + FENCED_BLOCK_END.length;
  }

  return normalized
    .replaceAll(FENCED_BLOCK_START, "")
    .replaceAll(FENCED_BLOCK_END, "");
}

function parseIntegerAttribute(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[+-]?\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function formatAlphabeticLabel(value, uppercase) {
  if (value < 1n) return null;

  let remaining = value;
  let label = "";
  while (remaining > 0n) {
    remaining -= 1n;
    label = String.fromCharCode(Number(remaining % 26n) + 65) + label;
    remaining /= 26n;
  }
  return uppercase ? label : label.toLowerCase();
}

function formatRomanLabel(value, uppercase) {
  if (value < 1n || value > 3999n) return null;

  const symbols = [
    [1000n, "M"],
    [900n, "CM"],
    [500n, "D"],
    [400n, "CD"],
    [100n, "C"],
    [90n, "XC"],
    [50n, "L"],
    [40n, "XL"],
    [10n, "X"],
    [9n, "IX"],
    [5n, "V"],
    [4n, "IV"],
    [1n, "I"],
  ];
  let remaining = value;
  let label = "";
  for (const [number, symbol] of symbols) {
    const count = Number(remaining / number);
    label += symbol.repeat(count);
    remaining %= number;
  }
  return uppercase ? label : label.toLowerCase();
}

function formatOrderedLabel(type, value) {
  if (type === "A" || type === "a") {
    return formatAlphabeticLabel(value, type === "A") ?? value.toString();
  }
  if (type === "I" || type === "i") {
    return formatRomanLabel(value, type === "I") ?? value.toString();
  }
  return value.toString();
}

function renderList(node, baseUrl, indent = "") {
  const ordered = node.name === "ol";
  const lines = [];
  const reversed = ordered && Object.hasOwn(node.attributes, "reversed");
  const type = ordered ? node.attributes.type : null;
  const listItems = node.children.filter(
    (child) => child.type === "element" && child.name === "li",
  ).length;
  let number = ordered
    ? parseIntegerAttribute(node.attributes.start) ?? (reversed ? BigInt(listItems) : 1n)
    : 1n;
  const step = reversed ? -1n : 1n;

  for (const child of node.children) {
    if (child.type !== "element" || child.name !== "li") continue;

    const itemNumber = ordered
      ? parseIntegerAttribute(child.attributes.value) ?? number
      : null;
    if (shouldDrop(child)) {
      if (ordered) number = itemNumber + step;
      continue;
    }
    const itemLabel = ordered ? formatOrderedLabel(type, itemNumber) : null;
    const nativeOrdered = ordered
      && itemNumber >= 0n
      && itemLabel === itemNumber.toString()
      && itemLabel.length <= 9;
    const marker = nativeOrdered ? `${itemNumber}. ` : "- ";
    const labelPrefix = ordered && !nativeOrdered ? `${itemLabel}. ` : "";
    const content = [];
    const inline = [];
    const flushInline = () => {
      const label = trimHtmlWhitespace(
        renderInlineSiblings(inline, baseUrl).replace(/[ \t]+/g, " "),
      );
      if (label) content.push({ type: "inline", value: label });
      inline.length = 0;
    };
    for (const item of child.children) {
      if (
        item.type === "element"
        && (item.name === "ul" || item.name === "ol" || item.name === "menu")
      ) {
        flushInline();
        const value = renderList(item, baseUrl, `${indent}${" ".repeat(marker.length)}`)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
        if (value) content.push({ type: "nested", value });
      } else if (item.type === "element" && BLOCK_ELEMENTS.has(item.name)) {
        flushInline();
        const value = renderBlock(item, baseUrl)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
        if (hasHtmlText(value)) content.push({ type: "block", value });
      } else {
        inline.push(item);
      }
    }

    flushInline();
    if (content.length > 0) {
      const continuationIndent = `${indent}${" ".repeat(marker.length)}`;
      let markerWritten = false;
      let labelWritten = !labelPrefix;
      let previousType = null;

      for (const part of content) {
        if (part.type === "nested") {
          if (previousType === "block") lines.push("");
          if (!markerWritten) {
            const markerLabel = labelPrefix;
            lines.push(trimHtmlWhitespaceEnd(`${indent}${marker}${markerLabel}`));
            markerWritten = true;
            if (markerLabel) labelWritten = true;
          }
          lines.push(part.value);
        } else {
          if (part.type === "block" || previousType === "block") lines.push("");
          const contentLines = part.value.split("\n");
          const firstLine = contentLines.shift();
          const firstContentLine = labelWritten ? firstLine : `${labelPrefix}${firstLine}`;
          if (!markerWritten) {
            lines.push(trimHtmlWhitespaceEnd(`${indent}${marker}${firstContentLine}`));
            markerWritten = true;
          } else {
            lines.push(trimHtmlWhitespaceEnd(`${continuationIndent}${firstContentLine}`));
          }
          labelWritten = true;
          for (const line of contentLines) {
            lines.push(line ? `${continuationIndent}${line}` : "");
          }
        }
        previousType = part.type;
      }
    }
    if (ordered) {
      number = itemNumber + step;
    }
  }

  return lines.length > 0 ? `\n${lines.join("\n")}\n\n` : "";
}

function renderBlock(node, baseUrl) {
  if (node.type === "text") return renderInline(node, baseUrl);
  if (shouldDrop(node)) return "";

  if (/^h[1-6]$/.test(node.name)) {
    const level = Number(node.name.slice(1));
    return `\n${"#".repeat(level)} ${trimHtmlWhitespace(renderInline(node, baseUrl))}\n\n`;
  }
  if (node.name === "p") {
    const value = trimHtmlWhitespace(renderInline(node, baseUrl));
    return value ? `\n${value}\n\n` : "";
  }
  if (node.name === "pre") {
    return `\n${FENCED_BLOCK_START}${renderCodeBlock(node)}${FENCED_BLOCK_END}\n\n`;
  }
  if (node.name === "ul" || node.name === "ol" || node.name === "menu") {
    return renderList(node, baseUrl);
  }
  if (node.name === "blockquote") {
    const value = trimHtmlWhitespace(renderChildren(node, baseUrl));
    return value
      ? `\n${value
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")}\n\n`
      : "";
  }
  if (node.name === "hr") return "\n---\n\n";
  if (BLOCK_ELEMENTS.has(node.name)) {
    const value = trimHtmlWhitespace(renderChildren(node, baseUrl));
    return value ? `\n${value}\n\n` : "";
  }
  return renderInline(node, baseUrl);
}

function renderChildren(node, baseUrl) {
  let rendered = "";
  const inline = [];
  const flushInline = () => {
    rendered += renderInlineSiblings(inline, baseUrl);
    inline.length = 0;
  };

  for (const child of node.children) {
    if (child.type === "element" && BLOCK_ELEMENTS.has(child.name)) {
      flushInline();
      rendered += renderBlock(child, baseUrl);
    } else {
      inline.push(child);
    }
  }
  flushInline();
  return rendered;
}

export function htmlToMarkdown(html, baseUrl = "https://example.invalid/") {
  const root = parseHtml(String(html));
  const documentBaseUrl = resolveDocumentBase(root, baseUrl) ?? baseUrl;
  const markdown = trimHtmlWhitespace(
    normalizeStructuralWhitespace(
      renderChildren(root, documentBaseUrl)
        .replace(/\r\n?/g, "\n"),
    ),
  );

  return markdown ? `${markdown}\n` : "";
}

function appendVary(headers, dimension) {
  const existing = headers.get("Vary");
  if (!existing || existing.trim() === "*") {
    if (!existing) headers.set("Vary", dimension);
    return;
  }

  const dimensions = existing.split(",").map((value) => value.trim());
  if (!dimensions.some((value) => value.toLowerCase() === dimension.toLowerCase())) {
    headers.set("Vary", `${existing}, ${dimension}`);
  }
}

function isHtmlResponse(response) {
  const contentType = response.headers.get("Content-Type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === HTML_MEDIA_TYPE;
}

function bytesStartWith(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiPrefix(bytes) {
  let value = "";
  for (const byte of bytes.subarray(0, HTML_ENCODING_SNIFF_LIMIT)) {
    value += String.fromCharCode(byte);
  }
  return value;
}

function attributeValue(source, name) {
  const match = source.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function sniffMetaCharset(bytes) {
  const prefix = asciiPrefix(bytes).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const match of prefix.matchAll(/<meta(?=[\t\n\f\r />])/gi)) {
    const tagEnd = findTagEnd(prefix, match.index + 1);
    if (tagEnd < 0) continue;
    const tag = prefix.slice(match.index, tagEnd + 1);
    const charset = attributeValue(tag, "charset");
    if (charset !== null) return charset;

    if (attributeValue(tag, "http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const content = attributeValue(tag, "content");
    const contentCharset = content?.match(
      /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i,
    );
    if (contentCharset) {
      return contentCharset[1] ?? contentCharset[2] ?? contentCharset[3] ?? "";
    }
  }

  return null;
}

function sniffHtmlCharset(bytes, transportCharset = null) {
  if (bytesStartWith(bytes, [0xef, 0xbb, 0xbf])) return "utf-8";
  if (bytesStartWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (bytesStartWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return transportCharset ?? sniffMetaCharset(bytes) ?? "utf-8";
}

export async function negotiateMarkdown(request, response) {
  if (
    request.method !== "GET" ||
    response.status !== 200 ||
    !isHtmlResponse(response)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  appendVary(headers, "Accept");

  if (!acceptsMarkdown(request.headers.get("Accept"))) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  const charsetMatch = contentType.match(/;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i);
  let html;
  try {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    const transportCharset = charsetMatch
      ? charsetMatch[1] ?? charsetMatch[2]
      : null;
    const charset = sniffHtmlCharset(bytes, transportCharset);
    html = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const markdown = htmlToMarkdown(html, request.url);
  headers.set("Content-Type", `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Content-Range");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Transfer-Encoding");
  headers.delete("Accept-Ranges");

  return new Response(markdown, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    return negotiateMarkdown(request, await env.ASSETS.fetch(request));
  },
};
