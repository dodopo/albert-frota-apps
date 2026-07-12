#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collapseWhitespace,
  escapeTelegramDynamic,
  emailFromFromHeader,
  firstNameFromFromHeader,
  formatCardDate,
  formatListDate,
  htmlToText,
  normalizeEntriesByThreadId,
  renderCard,
  renderCardList,
  senderLabelFromFromHeader,
  threadToCardEntry,
  truncateWordBoundary
} from "../lib/card-format.js";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BIN_DIR, "..");
const DEFAULT_CONFIG = path.join(ROOT, "gmail-config-exemplo.json");
const LAST_SEARCH = path.join(ROOT, "state", "last-search.json");

function usage() {
  return [
    "usage: gmail.js <card|card-list|self-test> [options]",
    "",
    "commands:",
    "  card       render one Telegram-ready card from last search or a fixture",
    "  card-list  run Gmail search and render a Telegram-ready list",
    "  self-test  compare generated output against fixtures/expected",
    "",
    "options:",
    "  --fixture <path>  input JSON fixture; tests only",
    "  --config <path>   config JSON; default correio/gmail-config-exemplo.json",
    "  --query <q>       search echo used by card-list",
    "  --max-results <n> limit card-list after thread dedupe",
    "  --page <n>        page number used by card-list",
    "  --id <id>         select one message for card",
    "  --select <n>      select one item from last-search.json",
    "  --raw             render raw body for agent",
    "  --summary <t>     render final card using the given summary text",
    "  --omit-body       render card without body",
    "  --help"
  ].join("\n");
}

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

async function loadConfig() {
  const configPath = readArg("config", DEFAULT_CONFIG);
  return readJson(configPath);
}

function rawBodyFromMessage(message) {
  if (typeof message.textBody === "string") return collapseWhitespace(message.textBody);
  if (typeof message.htmlBody === "string") return collapseWhitespace(htmlToText(message.htmlBody));
  if (typeof message.snippet === "string") return collapseWhitespace(message.snippet);
  return "";
}

function attachmentsFromMessage(message) {
  const items = Array.isArray(message.attachments) ? message.attachments : [];
  return items.map((item) => collapseWhitespace(item.name || item.filename || item)).filter(Boolean);
}

function bodyStateFromMessage(message, bodyText, attachments) {
  if (bodyText) return "ok";
  if (typeof message.textBody === "string" && !collapseWhitespace(message.textBody)) return "empty";
  if (typeof message.htmlBody === "string" && !collapseWhitespace(htmlToText(message.htmlBody))) return "unreadable";
  if (attachments.length) return "unreadable";
  return "empty";
}

function normalizeMessage(message) {
  const from = String(message.from || "");
  const bodyText = rawBodyFromMessage(message);
  const attachments = attachmentsFromMessage(message);
  const state = bodyStateFromMessage(message, bodyText, attachments);
  const date = String(message.date || message.internalDate || "");
  const threadMessageCount = Number(message.threadMessageCount || (Array.isArray(message.messages) ? message.messages.length : 1)) || 1;
  const entry = {
    threadId: String(message.threadId || ""),
    messageId: String(message.id || ""),
    subject: collapseWhitespace(message.subject || "(sem assunto)"),
    from,
    senderLabel: senderLabelFromFromHeader(from),
    firstName: firstNameFromFromHeader(from),
    senderEmail: emailFromFromHeader(from),
    dateRaw: date,
    dateList: formatListDate(date),
    dateCard: formatCardDate(date),
    bodyState: state,
    bodyText,
    attachments,
    threadMessageCount
  };
  return entry;
}

function normalizeInput(input) {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input.entries)) return input.entries.map((entry) => normalizeMessage(entry));
  if (Array.isArray(input.messages)) return input.messages.map((message) => normalizeMessage(message));
  if (Array.isArray(input.threads)) return input.threads.map((thread) => threadToCardEntry(thread));
  if (input.message) return [normalizeMessage(input.message)];
  return [normalizeMessage(input)];
}

function queryEcho(input, fallbackConfig, rawQuery) {
  return collapseWhitespace(rawQuery || input?.query || input?.searchQuery || fallbackConfig?.gmail?.searchQuery || fallbackConfig?.gmail?.query || "");
}

function sourceModulePath(config) {
  const configured = process.env.CORREIO_GMAIL_SOURCE || config?.gmail?.sourceModule || config?.sourceModule || "";
  if (!configured) return "";
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

async function loadGmailSource(config) {
  const modulePath = sourceModulePath(config);
  if (!modulePath) return null;
  return import(pathToFileURL(modulePath).href);
}

async function searchGmail(config, { query, page, maxResults }) {
  const source = await loadGmailSource(config);
  if (!source) {
    throw new Error("card-list requires a configured Gmail source module when --fixture is not used");
  }
  const search = source.searchGmail || source.searchThreads || source.listThreads || source.default;
  if (typeof search !== "function") {
    throw new Error("configured Gmail source module must export searchGmail, searchThreads, listThreads, or default");
  }
  const result = await search({ query, page, maxResults, config });
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.threads)) return result.threads;
  if (Array.isArray(result?.messages)) return result.messages;
  if (Array.isArray(result?.entries)) return result.entries;
  throw new Error("configured Gmail source returned no threads, messages, or entries array");
}

async function saveLastSearch(payload) {
  await fs.mkdir(path.dirname(LAST_SEARCH), { recursive: true });
  const safe = {
    query: payload.query,
    page: payload.page,
    entries: payload.entries.map((entry) => ({
      threadId: entry.threadId,
      messageId: entry.messageId,
      subject: entry.subject,
      from: entry.from,
      senderLabel: entry.senderLabel,
      firstName: entry.firstName,
      senderEmail: entry.senderEmail,
      dateRaw: entry.dateRaw,
      dateList: entry.dateList,
      dateCard: entry.dateCard,
      bodyState: entry.bodyState,
      bodyText: entry.bodyText,
      attachments: entry.attachments,
      threadMessageCount: entry.threadMessageCount
    }))
  };
  await fs.writeFile(LAST_SEARCH, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

async function loadLastSearch() {
  try {
    return JSON.parse(await fs.readFile(LAST_SEARCH, "utf8"));
  } catch {
    return null;
  }
}

function selectFromLastSearch(state, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid selection: ${index}`);
  const entry = state?.entries?.[n - 1];
  if (!entry) throw new Error(`selection #${n} is outside the ${state?.entries?.length || 0} stored result(s)`);
  return entry;
}

function dedupeByThread(entries) {
  return normalizeEntriesByThreadId(entries);
}

function resolveCardMode() {
  const raw = hasFlag("raw");
  const summary = readArg("summary", null);
  const omitBody = hasFlag("omit-body");
  const selected = [raw && "raw", summary && "summary", omitBody && "omit-body"].filter(Boolean);
  if (selected.length > 1) throw new Error(`mutually exclusive modes: ${selected.join(", ")}`);
  return { raw, summary, omitBody };
}

async function commandCardList() {
  const fixture = readArg("fixture");
  const config = await loadConfig();
  const page = Number(readArg("page", "1")) || 1;
  const maxResults = Number(readArg("max-results", "0")) || 0;
  const input = fixture ? await readJson(fixture) : null;
  const query = queryEcho(input, config, readArg("query", null));
  if (!query) throw new Error("card-list requires --query or a query in config");
  const sourceItems = fixture ? normalizeInput(input) : normalizeInput({ threads: await searchGmail(config, { query, page, maxResults }) });
  const entries = dedupeByThread(sourceItems).slice(0, maxResults > 0 ? maxResults : undefined);
  const output = entries.length
    ? renderCardList({ query, page, entries })
    : `Nada encontrado para: ${escapeTelegramDynamic(query)}`;
  await saveLastSearch({ query, page, entries });
  process.stdout.write(`${output}\n`);
}

function selectMessageFromFixture(input, id) {
  const entries = normalizeInput(input);
  const selected = entries.find((entry) => String(entry.messageId) === String(id) || String(entry.threadId) === String(id));
  if (!selected) throw new Error(`message not found: ${id}`);
  return selected;
}

async function commandCard() {
  const fixture = readArg("fixture");
  const mode = resolveCardMode();
  let entry = null;

  if (readArg("select", null)) {
    const state = await loadLastSearch();
    if (!state) throw new Error(`no local last-search state found at ${LAST_SEARCH}; run card-list first`);
    entry = selectFromLastSearch(state, readArg("select"));
  } else if (fixture) {
    const input = await readJson(fixture);
    const id = readArg("id", input.message?.id || input.id || input.messages?.[0]?.id);
    entry = selectMessageFromFixture(input, id);
  } else {
    throw new Error("card requires --fixture or --select");
  }

  process.stdout.write(`${renderCard(entry, {
    raw: mode.raw,
    summaryText: mode.summary,
    omitBody: mode.omitBody
  })}\n`);
}

async function commandSelfTest() {
  const { runFixtureTests, runModeTests } = await import("../test/card-fixtures.test.mjs");
  await runFixtureTests({ quiet: false });
  await runModeTests({ quiet: false });
}

const cmd = process.argv[2];
if (!cmd || hasFlag("help") || cmd === "help") {
  console.log(usage());
  process.exit(cmd ? 0 : 1);
}

try {
  if (cmd === "card") await commandCard();
  else if (cmd === "card-list") await commandCardList();
  else if (cmd === "self-test") await commandSelfTest();
  else throw new Error(`unknown command: ${cmd}`);
} catch (err) {
  console.error(err?.message || String(err));
  process.exitCode = 1;
}
