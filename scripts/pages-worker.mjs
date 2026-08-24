import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

const MARKDOWN_MEDIA_TYPE = "text/markdown";
const HTML_MEDIA_TYPE = "text/html";
const QVALUE_PATTERN = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
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
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "iframe"]);
const HEAD_METADATA_ELEMENTS = new Set([
  "base",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
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
const P_IMPLIED_END_TAG_STARTS = BLOCK_ELEMENTS;
const LIST_CONTAINERS = new Set(["ol", "ul"]);
const DEFINITION_LIST_CONTAINERS = new Set(["dl"]);
const LIST_ITEM_END_TAGS = new Set(["li"]);
const DEFINITION_ITEM_END_TAGS = new Set(["dt", "dd"]);
const NAVIGATION_MARKER = /(?:^|[\s_-])(?:nav|navigation|menu|breadcrumb|breadcrumbs|sidebar|cookie|consent|badge|dot|decorative)(?:$|[\s_-])/i;

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

function decodeHtmlEntities(value, mode = "text") {
  return mode === "attribute" ? decodeHTMLAttribute(value) : decodeHTML(value);
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

function parseAttributes(source) {
  const attributes = Object.create(null);
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(attributePattern)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
      "attribute",
    );
  }
  return attributes;
}

function parseTag(source) {
  const closing = source.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>$/);
  if (closing) return { closing: true, name: closing[1].toLowerCase() };

  const opening = source.match(/^<\s*([A-Za-z][\w:-]*)([\s\S]*?)>$/);
  if (!opening) return null;

  const rawAttributes = opening[2];
  const selfClosing = /\/\s*$/.test(rawAttributes);
  return {
    closing: false,
    name: opening[1].toLowerCase(),
    attributes: parseAttributes(rawAttributes.replace(/\/\s*$/, "")),
    selfClosing,
  };
}

function findRawTextEnd(html, start, name) {
  const closingPattern = new RegExp(`<\\s*/\\s*${name}\\s*>`, "ig");
  closingPattern.lastIndex = start;
  const closing = closingPattern.exec(html);
  return closing ? closing.index + closing[0].length : html.length;
}

function closeImpliedElements(stack, name) {
  if (stack.at(-1)?.name === "head" && !HEAD_METADATA_ELEMENTS.has(name)) {
    stack.pop();
  }

  const impliedGroup = name === "li"
    ? LIST_ITEM_END_TAGS
    : name === "dt" || name === "dd"
      ? DEFINITION_ITEM_END_TAGS
      : null;
  const scopeBoundary = name === "li"
    ? LIST_CONTAINERS
    : name === "dt" || name === "dd"
      ? DEFINITION_LIST_CONTAINERS
      : null;

  if (impliedGroup) {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (scopeBoundary.has(stack[index].name)) break;
      if (impliedGroup.has(stack[index].name)) {
        stack.length = index;
        return;
      }
    }
  }

  if (P_IMPLIED_END_TAG_STARTS.has(name)) {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (stack[index].name === "p") {
        stack.length = index;
        return;
      }
    }
  }
}

function parseHtml(html) {
  const root = { type: "element", name: "root", attributes: {}, children: [] };
  const stack = [root];
  let cursor = 0;

  const appendText = (value) => {
    if (value.trim() && stack.at(-1)?.name === "head") stack.pop();
    if (value) stack.at(-1).children.push({ type: "text", value });
  };

  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) {
      appendText(html.slice(cursor));
      break;
    }
    if (opening > cursor) appendText(html.slice(cursor, opening));

    if (html.startsWith("<!--", opening)) {
      const commentEnd = html.indexOf("-->", opening + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, opening + 1);
    if (tagEnd < 0) {
      appendText(html.slice(opening));
      break;
    }

    const tag = parseTag(html.slice(opening, tagEnd + 1));
    cursor = tagEnd + 1;
    if (!tag) continue;
    if (tag.closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name === tag.name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    closeImpliedElements(stack, tag.name);
    const node = {
      type: "element",
      name: tag.name,
      attributes: tag.attributes,
      children: [],
    };
    stack.at(-1).children.push(node);
    if (!tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      cursor = findRawTextEnd(html, cursor, tag.name);
      continue;
    }
    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) stack.push(node);
  }

  return root;
}

function shouldDrop(node) {
  if (DROPPED_ELEMENTS.has(node.name)) return true;
  const attributes = node.attributes;
  const marker = [attributes.id, attributes.class, attributes.role]
    .filter(Boolean)
    .join(" ");
  return NAVIGATION_MARKER.test(marker);
}

function textContent(node, preserveWhitespace = false) {
  if (node.type === "text") return decodeHtmlEntities(node.value);
  if (shouldDrop(node)) return "";
  return node.children
    .map((child) => textContent(child, preserveWhitespace))
    .join(preserveWhitespace ? "" : " ");
}

function normalizeInlineText(value) {
  return value.replace(/\s+/g, " ");
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
  const leading = value.match(/^\s*/)[0];
  const remaining = value.slice(leading.length);
  const trailing = remaining.match(/\s*$/)[0];
  const content = remaining.slice(0, remaining.length - trailing.length);
  return { leading, content, trailing };
}

function wrapInline(value, opening, closing) {
  const { leading, content, trailing } = splitInlineBoundary(value);
  return content ? `${leading}${opening}${content}${closing}${trailing}` : value;
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
  if (node.type !== "element") return null;
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
    return escapeMarkdownText(normalizeInlineText(decodeHtmlEntities(node.value)));
  }
  if (shouldDrop(node)) return "";

  const children = () => node.children.map((child) => renderInline(child, baseUrl)).join("");
  switch (node.name) {
    case "a": {
      const renderedLabel = children();
      const { leading, content, trailing } = splitInlineBoundary(renderedLabel);
      const href = resolveLink(node.attributes.href, baseUrl);
      if (!href) return renderedLabel;
      return `${leading}[${escapeLinkLabel(content || href)}](${escapeLinkDestination(href)})${trailing}`;
    }
    case "br":
      return "\n";
    case "code": {
      const value = textContent(node, true).replace(/\s+/g, " ");
      const { content } = splitInlineBoundary(value);
      const run = Math.max(1, ...[...content.matchAll(/`+/g)].map((match) => match[0].length)) + 1;
      const fence = "`".repeat(run);
      const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
      return wrapInline(value, `${fence}${padding}`, `${padding}${fence}`);
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
  const value = textContent(node, true).replace(/\r\n?/g, "\n").replace(/^\n|\n$/g, "");
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${codeLanguage(node)}\n${value}\n${fence}`;
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
      const label = inline.join("").replace(/\s+/g, " ").trim();
      if (label) content.push({ type: "inline", value: label });
      inline.length = 0;
    };
    for (const item of child.children) {
      if (item.type === "element" && (item.name === "ul" || item.name === "ol")) {
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
        if (value.trim()) content.push({ type: "block", value });
      } else {
        inline.push(renderInline(item, baseUrl));
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
            lines.push(`${indent}${marker}${markerLabel}`.trimEnd());
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
            lines.push(`${indent}${marker}${firstContentLine}`.trimEnd());
            markerWritten = true;
          } else {
            lines.push(`${continuationIndent}${firstContentLine}`.trimEnd());
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
    return `\n${"#".repeat(level)} ${renderInline(node, baseUrl).trim()}\n\n`;
  }
  if (node.name === "p") {
    const value = renderInline(node, baseUrl).trim();
    return value ? `\n${value}\n\n` : "";
  }
  if (node.name === "pre") return `\n${renderCodeBlock(node)}\n\n`;
  if (node.name === "ul" || node.name === "ol") return renderList(node, baseUrl);
  if (node.name === "blockquote") {
    const value = renderChildren(node, baseUrl).trim();
    return value
      ? `\n${value
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")}\n\n`
      : "";
  }
  if (node.name === "hr") return "\n---\n\n";
  if (BLOCK_ELEMENTS.has(node.name)) {
    const value = renderChildren(node, baseUrl).trim();
    return value ? `\n${value}\n\n` : "";
  }
  return renderInline(node, baseUrl);
}

function renderChildren(node, baseUrl) {
  return node.children.map((child) => renderBlock(child, baseUrl)).join("");
}

export function htmlToMarkdown(html, baseUrl = "https://example.invalid/") {
  const root = parseHtml(String(html));
  const documentBaseUrl = resolveDocumentBase(root, baseUrl) ?? baseUrl;
  const markdown = renderChildren(root, documentBaseUrl)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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

  const markdown = htmlToMarkdown(await response.text(), request.url);
  headers.set("Content-Type", `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Content-Range");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Transfer-Encoding");

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
