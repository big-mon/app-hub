import { markdownMiddleware } from "@markdown-for-agents/web";

const MARKDOWN_MEDIA_TYPE = "text/markdown";
const QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const MIDDLEWARE_OPTIONS = {
  extract: true,
  contentSignal: { aiTrain: false, search: true, aiInput: true },
};

function splitOutsideQuotedStrings(value, delimiter) {
  const items = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) return null;
  items.push(value.slice(start));
  return items;
}

function acceptsMarkdown(value) {
  if (typeof value !== "string") return false;
  const ranges = splitOutsideQuotedStrings(value, ",");
  if (ranges === null) return false;

  return ranges.some((range) => {
    const parts = splitOutsideQuotedStrings(range, ";");
    if (parts === null) return false;
    const [mediaType, ...parameters] = parts;
    if (mediaType.trim().toLowerCase() !== MARKDOWN_MEDIA_TYPE) return false;

    let quality = 1;
    for (const parameter of parameters) {
      const [name, rawValue] = parameter.split("=", 2);
      if (name?.trim().toLowerCase() !== "q") continue;
      const value = rawValue?.trim() ?? "";
      if (!QVALUE_PATTERN.test(value)) return false;
      quality = Number(value);
    }
    return quality > 0;
  });
}

function mentionsMarkdown(value) {
  return typeof value === "string" && value.toLowerCase().includes(MARKDOWN_MEDIA_TYPE);
}

function isSuccessfulHtml(response) {
  if (response.status !== 200) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/html";
}

function requestWithAccept(request, accept) {
  const headers = new Headers(request.headers);
  headers.set("Accept", accept);
  return new Request(request, { headers });
}

function mutableResponse(response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const accept = request.headers.get("accept");

    if (request.method !== "GET" || !isSuccessfulHtml(response)) {
      return response;
    }

    const middlewareRequest = acceptsMarkdown(accept)
      ? requestWithAccept(request, MARKDOWN_MEDIA_TYPE)
      : mentionsMarkdown(accept)
        ? requestWithAccept(request, "text/html")
        : request;

    return markdownMiddleware({
      ...MIDDLEWARE_OPTIONS,
      baseUrl: request.url,
    })(middlewareRequest, async () => mutableResponse(response));
  },
};
