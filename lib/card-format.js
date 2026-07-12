const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E]/g;

function normalizeText(value, { keepNewlines = true } = {}) {
  let text = String(value ?? "");
  text = text.normalize("NFC").replace(/\r\n?/g, "\n");
  text = text.replace(CONTROL_RE, "");
  text = text.replace(ZERO_WIDTH_RE, "");
  if (!keepNewlines) text = text.replace(/\n/g, " ");
  return text;
}

function collapseWhitespace(value) {
  return normalizeText(value, { keepNewlines: true })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeTelegramDynamic(value) {
  return normalizeText(value, { keepNewlines: false }).replace(/([\\*_[`])/g, "\\$1");
}

function truncateWordBoundary(value, maxChars) {
  const text = collapseWhitespace(value);
  const limit = Math.max(1, Number(maxChars) || 1);
  if (text.length <= limit) return text;
  const budget = Math.max(1, limit - 1);
  let cut = text.slice(0, budget);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"));
  if (lastBreak > 0) cut = cut.slice(0, lastBreak);
  cut = cut.replace(/[ \t\n\r\-.,;:!?]+$/u, "");
  return `${cut}…`;
}

function decodeHtmlEntities(value) {
  const text = String(value ?? "");
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower === "nbsp") return " ";
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos" || lower === "#39") return "'";
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    }
    return _;
  });
}

function htmlToText(value) {
  let html = normalizeText(value, { keepNewlines: true });
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n");

  html = html.replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, href, inner) => {
    const label = collapseWhitespace(decodeHtmlEntities(inner).replace(/<[^>]+>/g, " "));
    const url = collapseWhitespace(decodeHtmlEntities(href));
    if (!label) return url;
    if (!url) return label;
    if (label === url) return url;
    return `${label} (${url})`;
  });

  html = html.replace(/<[^>]+>/g, " ");
  html = decodeHtmlEntities(html);
  return collapseWhitespace(html);
}

function parseHeaders(message) {
  const headers = new Map();
  for (const header of message?.payload?.headers || []) {
    const name = String(header?.name || "").toLowerCase();
    if (!name) continue;
    headers.set(name, String(header?.value || ""));
  }
  return headers;
}

function displayNameFromFromHeader(fromHeader) {
  const text = collapseWhitespace(fromHeader);
  if (!text) return "";
  const quoted = text.match(/^"(.+)"\s*<[^<>]+>$/)?.[1];
  if (quoted) return collapseWhitespace(quoted);
  const beforeAngle = text.match(/^(.+?)\s*<[^<>]+>$/)?.[1];
  if (beforeAngle) return collapseWhitespace(beforeAngle);
  if (text.includes("@")) return "";
  return text;
}

function localPartFromFromHeader(fromHeader) {
  const text = collapseWhitespace(fromHeader);
  const email = text.match(/([^\s<>]+@[^<>]+)/)?.[1];
  if (!email) return "";
  return email.split("@")[0] || "";
}

function firstNameFromFromHeader(fromHeader) {
  const display = displayNameFromFromHeader(fromHeader);
  if (display) return display.split(/\s+/)[0] || display;
  const local = localPartFromFromHeader(fromHeader);
  if (local) return local.split(/\s+/)[0] || local;
  return "(desconhecido)";
}

function senderLabelFromFromHeader(fromHeader) {
  const display = displayNameFromFromHeader(fromHeader);
  if (display) return display;
  const local = localPartFromFromHeader(fromHeader);
  if (local) return local;
  return "(desconhecido)";
}

function formatDateParts(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let date = null;
  if (/^\d+$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) date = new Date(asNumber);
  } else {
    date = new Date(raw);
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

function datePartsWithFallback(dateInput) {
  const date = formatDateParts(dateInput);
  if (!date) return null;
  const options = [
    { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
    { timeZone: "UTC-3", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
  ];
  for (const option of options) {
    try {
      const parts = new Intl.DateTimeFormat("pt-BR", option).formatToParts(date);
      const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return {
        day: map.day || "",
        month: map.month || "",
        year: map.year || "",
        hour: map.hour || "",
        minute: map.minute || ""
      };
    } catch {
      continue;
    }
  }
  const fallback = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const iso = fallback.toISOString();
  return {
    day: iso.slice(8, 10),
    month: iso.slice(5, 7),
    year: iso.slice(0, 4),
    hour: iso.slice(11, 13),
    minute: iso.slice(14, 16)
  };
}

function formatListDate(input) {
  const parts = datePartsWithFallback(input);
  if (!parts) return "(data desconhecida)";
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

function formatCardDate(input) {
  const parts = datePartsWithFallback(input);
  if (!parts) return "(data desconhecida)";
  return `${parts.day}/${parts.month}/${parts.year}, ${parts.hour}:${parts.minute}`;
}

function collectTextParts(part, bucket = { plain: [], html: [], attachments: [], hasReadableBody: false, hasAnyBody: false }) {
  if (!part) return bucket;
  const mimeType = String(part.mimeType || "").toLowerCase();
  const filename = collapseWhitespace(part.filename || "");
  const bodyData = part.body?.data || "";
  const hasBodyData = Boolean(bodyData);
  if (mimeType.startsWith("text/") && hasBodyData) bucket.hasReadableBody = true;
  if (hasBodyData || filename) bucket.hasAnyBody = true;
  if (mimeType === "text/plain" && hasBodyData) bucket.plain.push(part.body.data);
  if (mimeType === "text/html" && hasBodyData) bucket.html.push(part.body.data);
  if (filename) {
    const attachmentId = part.body?.attachmentId ? String(part.body.attachmentId) : "";
    if (attachmentId || !mimeType.startsWith("multipart/")) {
      bucket.attachments.push(filename);
    }
  }
  for (const child of part.parts || []) collectTextParts(child, bucket);
  return bucket;
}

function decodeBase64Url(value) {
  if (!value) return "";
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractReadableBody(message) {
  const bucket = collectTextParts(message?.payload || null);
  const plain = bucket.plain.map(decodeBase64Url).map((value) => collapseWhitespace(value)).filter(Boolean);
  const html = bucket.html.map(decodeBase64Url).map((value) => htmlToText(value)).filter(Boolean);
  if (plain.length) {
    return { bodyState: "ok", bodyText: plain.join("\n\n"), attachments: [...new Set(bucket.attachments)] };
  }
  if (html.length) {
    return { bodyState: "ok", bodyText: html.join("\n\n"), attachments: [...new Set(bucket.attachments)] };
  }
  if (bucket.hasReadableBody) {
    return { bodyState: "unreadable", bodyText: "", attachments: [...new Set(bucket.attachments)] };
  }
  if (bucket.hasAnyBody) {
    return { bodyState: "unreadable", bodyText: "", attachments: [...new Set(bucket.attachments)] };
  }
  return { bodyState: "empty", bodyText: "", attachments: [...new Set(bucket.attachments)] };
}

function messageToCardEntry(message, { threadMessageCount = 1 } = {}) {
  const headers = parseHeaders(message);
  const from = headers.get("from") || "";
  const subject = collapseWhitespace(headers.get("subject") || "(sem assunto)");
  const dateRaw = headers.get("date") || message?.internalDate || "";
  const body = extractReadableBody(message);
  return {
    threadId: String(message?.threadId || ""),
    messageId: String(message?.id || ""),
    subject,
    from,
    senderLabel: senderLabelFromFromHeader(from),
    firstName: firstNameFromFromHeader(from),
    dateRaw,
    dateList: formatListDate(dateRaw),
    dateCard: formatCardDate(dateRaw),
    bodyState: body.bodyState,
    bodyText: body.bodyText,
    attachments: body.attachments,
    threadMessageCount: Number(threadMessageCount) || 1,
    linksText: body.bodyText
  };
}

function latestThreadMessage(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) return null;
  return messages.reduce((best, candidate) => {
    if (!best) return candidate;
    const bestDate = formatDateParts(best?.internalDate || parseHeaders(best).get("date") || "");
    const candidateDate = formatDateParts(candidate?.internalDate || parseHeaders(candidate).get("date") || "");
    if (!bestDate && candidateDate) return candidate;
    if (bestDate && !candidateDate) return best;
    if (!bestDate && !candidateDate) return candidate;
    return candidateDate.getTime() >= bestDate.getTime() ? candidate : best;
  }, null);
}

function threadToCardEntry(thread) {
  const latest = latestThreadMessage(thread);
  const entry = latest ? messageToCardEntry(latest, { threadMessageCount: Array.isArray(thread?.messages) ? thread.messages.length : 1 }) : {
    threadId: String(thread?.id || ""),
    messageId: "",
    subject: "(sem assunto)",
    from: "",
    senderLabel: "(desconhecido)",
    firstName: "(desconhecido)",
    dateRaw: "",
    dateList: "(data desconhecida)",
    dateCard: "(data desconhecida)",
    bodyState: "empty",
    bodyText: "",
    attachments: [],
    threadMessageCount: Array.isArray(thread?.messages) ? thread.messages.length : 1,
    linksText: ""
  };
  entry.threadId = String(thread?.id || entry.threadId || "");
  entry.threadMessageCount = Array.isArray(thread?.messages) ? thread.messages.length : entry.threadMessageCount;
  return entry;
}

function normalizeEntriesByThreadId(entries) {
  const byThread = new Map();
  for (const entry of entries || []) {
    if (!entry) continue;
    const key = String(entry.threadId || "");
    if (!key) continue;
    const current = byThread.get(key);
    if (!current) {
      byThread.set(key, entry);
      continue;
    }
    const currentDate = formatDateParts(current?.dateRaw || current?.dateCard || "");
    const nextDate = formatDateParts(entry?.dateRaw || entry?.dateCard || "");
    if (!currentDate && nextDate) {
      byThread.set(key, entry);
      continue;
    }
    if (currentDate && !nextDate) continue;
    if (!currentDate && !nextDate) {
      byThread.set(key, entry);
      continue;
    }
    if (nextDate.getTime() >= currentDate.getTime()) byThread.set(key, entry);
  }
  return [...byThread.values()];
}

function renderCardList({ query, page = 1, entries = [] }) {
  const humanQuery = escapeTelegramDynamic(collapseWhitespace(query));
  const deduped = normalizeEntriesByThreadId(entries);
  if (!deduped.length) return `Nada encontrado para: ${humanQuery}`;
  const lines = [`card-list para: ${humanQuery}`, `Página ${Number(page) || 1}`];
  for (const [index, entry] of deduped.entries()) {
    const title = escapeTelegramDynamic(truncateWordBoundary(entry.subject || "(sem assunto)", 60));
    const sender = escapeTelegramDynamic(entry.firstName || "(desconhecido)");
    const date = escapeTelegramDynamic(entry.dateList || "(data desconhecida)");
    lines.push(`${index + 1}. *${title}*`);
    lines.push(`   De: ${sender} · ${date}`);
  }
  return lines.join("\n");
}

function bodyLinesFromText(value, maxLines = 3) {
  const normalized = collapseWhitespace(value);
  if (!normalized) return [];
  const rawLines = normalizeText(normalized, { keepNewlines: true }).split("\n");
  const lines = [];
  for (const rawLine of rawLines) {
    const line = collapseWhitespace(rawLine);
    if (!line) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  if (!lines.length && normalized) lines.push(normalized);
  return lines.slice(0, maxLines);
}

function renderCard(entry, { summaryText = null, omitBody = false, raw = false } = {}) {
  const subject = escapeTelegramDynamic(truncateWordBoundary(entry.subject || "(sem assunto)", 200));
  const sender = escapeTelegramDynamic(entry.senderLabel || "(desconhecido)");
  const date = escapeTelegramDynamic(entry.dateCard || "(data desconhecida)");
  const threadNote = entry.threadMessageCount > 1 ? escapeTelegramDynamic(`(thread com ${entry.threadMessageCount} mensagens)`) : null;
  const attachments = Array.isArray(entry.attachments) && entry.attachments.length
    ? escapeTelegramDynamic(`Anexos (${entry.attachments.length}): ${entry.attachments.join(", ")}`)
    : null;
  const bodySource = raw ? entry.bodyText : (summaryText != null ? summaryText : entry.bodyText);
  const bodyState = entry.bodyState || "empty";
  const bodyLines = omitBody
    ? ["(corpo omitido)"]
    : bodyLinesFromText(bodySource || (bodyState === "ok" ? entry.bodyText : ""), 3);
  const resolvedBody = (bodyLines.length ? bodyLines : ["(sem corpo legível)"]).map((line) => escapeTelegramDynamic(line));

  if (raw) {
    const lines = [
      "=== RAW CARD ===",
      `thread_id: ${entry.threadId || "(desconhecido)"}`,
      `message_id: ${entry.messageId || "(desconhecido)"}`,
      `body_state: ${bodyState}`,
      `subject: ${entry.subject || "(sem assunto)"}`,
      `sender: ${entry.senderLabel || "(desconhecido)"}`,
      `first_name: ${entry.firstName || "(desconhecido)"}`,
      `date: ${entry.dateCard || "(data desconhecida)"}`,
      `thread_messages: ${entry.threadMessageCount || 1}`,
      `attachments: ${Array.isArray(entry.attachments) ? entry.attachments.join(", ") : ""}`,
      "body:",
      bodyState === "ok" ? collapseWhitespace(entry.bodyText) : "(sem corpo legível)",
      "=== END RAW CARD ==="
    ];
    return lines.join("\n");
  }

  const lines = [
    "=== CARD ===",
    `*${subject}*`,
    `De: ${sender} · ${date}`,
    ...resolvedBody
  ];
  if (threadNote) lines.push(threadNote);
  if (attachments) lines.push(attachments);
  lines.push("=== END CARD ===");
  return lines.join("\n");
}

export {
  bodyLinesFromText,
  collapseWhitespace,
  decodeHtmlEntities,
  displayNameFromFromHeader,
  escapeTelegramDynamic,
  extractReadableBody,
  formatCardDate,
  formatListDate,
  firstNameFromFromHeader,
  htmlToText,
  latestThreadMessage,
  messageToCardEntry,
  normalizeEntriesByThreadId,
  normalizeText,
  renderCard,
  renderCardList,
  senderLabelFromFromHeader,
  threadToCardEntry,
  truncateWordBoundary
};
