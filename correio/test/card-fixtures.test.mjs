import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "gmail.js");
const LAST_SEARCH = path.join(ROOT, "state", "last-search.json");

const CASES = [
  ["card-list", ["card-list", "--fixture", "fixtures/input/card-list.json", "--query", "de Joanna · comprovantes"], "fixtures/expected/card-list.json"],
  ["O1-title-bold", ["card", "--fixture", "fixtures/input/original-title-bold.json"], "fixtures/expected/O1-title-bold.json"],
  ["O2-metadata-sender", ["card", "--fixture", "fixtures/input/original-metadata-sender.json"], "fixtures/expected/O2-metadata-sender.json"],
  ["O4-three-line-snippet", ["card", "--fixture", "fixtures/input/original-three-line-snippet.json"], "fixtures/expected/O4-three-line-snippet.json"],
  ["A1-no-external-client", ["card", "--fixture", "fixtures/input/a1-no-external-client.json"], "fixtures/expected/A1-no-external-client.json"],
  ["A2-html-sanitized", ["card", "--fixture", "fixtures/input/a2-html-sanitized.json"], "fixtures/expected/A2-html-sanitized.json"],
  ["A3-delete-confirm", ["card", "--fixture", "fixtures/input/a3-delete-confirm.json"], "fixtures/expected/A3-delete-confirm.json"],
  ["A4-reply-draft", ["card", "--fixture", "fixtures/input/a4-reply-draft.json"], "fixtures/expected/A4-reply-draft.json"],
  ["A5-search-scope", ["card", "--fixture", "fixtures/input/a5-search-scope.json"], "fixtures/expected/A5-search-scope.json"],
  ["A6-expired-state", ["card", "--fixture", "fixtures/input/a6-expired-state.json"], "fixtures/expected/A6-expired-state.json"],
  ["A7-telegram-escaping", ["card", "--fixture", "fixtures/input/a7-telegram-escaping.json"], "fixtures/expected/A7-telegram-escaping.json"],
  ["A8-missing-sender", ["card", "--fixture", "fixtures/input/a8-missing-sender.json"], "fixtures/expected/A8-missing-sender.json"],
  ["A9-timezone-dst", ["card", "--fixture", "fixtures/input/a9-timezone-dst.json"], "fixtures/expected/A9-timezone-dst.json"],
  ["A10-edge-cases", ["card", "--fixture", "fixtures/input/a10-edge-cases.json"], "fixtures/expected/A10-edge-cases.json"]
];

async function render(args) {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], { cwd: ROOT });
  return stdout;
}

export async function runFixtureTests({ quiet = true } = {}) {
  for (const [name, args, expectedRel] of CASES) {
    const actual = await render(args);
    const expected = await fs.readFile(path.join(ROOT, expectedRel), "utf8");
    assert.equal(actual, expected, `${name} output differs byte-for-byte from ${expectedRel}`);
    if (!quiet) console.log(`ok ${name}`);
  }
}

export async function runModeTests({ quiet = true } = {}) {
  let previousState = null;
  try {
    previousState = await fs.readFile(LAST_SEARCH, "utf8");
  } catch {}

  try {
    const raw = await render(["card", "--fixture", "fixtures/input/a2-html-sanitized.json", "--raw"]);
    assert.equal(raw, [
      "=== RAW CARD ===",
      "thread_id: thr-a2",
      "message_id: a2-html",
      "body_state: ok",
      "subject: HTML <perigoso>",
      "sender: HTML Bot",
      "first_name: HTML",
      "date: 12/07/2026, 09:00",
      "thread_messages: 1",
      "attachments: ",
      "body:",
      "Texto & seguro\nLink externo (https://example.test)",
      "=== END RAW CARD ===",
      ""
    ].join("\n"), "raw mode output differs");

    const summary = await render(["card", "--fixture", "fixtures/input/a2-html-sanitized.json", "--summary", "Resumo *final* [telegram]"]);
    assert.equal(summary, [
      "*HTML <perigoso>*",
      "12/07/2026, 09:00 - HTML Bot",
      "html@example.test",
      "Resumo \\*final\\* \\[telegram]",
      ""
    ].join("\n"), "summary mode output differs");

    const omitBody = await render(["card", "--fixture", "fixtures/input/a2-html-sanitized.json", "--omit-body"]);
    assert.equal(omitBody, [
      "*HTML <perigoso>*",
      "12/07/2026, 09:00 - HTML Bot",
      "html@example.test",
      "(corpo omitido)",
      ""
    ].join("\n"), "omit-body mode output differs");

    const selectState = await render(["card-list", "--fixture", "fixtures/input/card-list.json", "--query", "de Joanna · comprovantes"]);
    assert.ok(selectState.includes("Busca: de Joanna · comprovantes"));
    const selected = await render(["card", "--select", "1"]);
    assert.equal(selected, [
      "*Re: Obra Reforma Quarto Liz Monjope - Comprovantes PHC Interiores enviados para conferência*",
      "10/07/2026, 11:35 - JoannaFraga",
      "joannafragabrown@gmail.com",
      "Segue comprovante PHC Interiores.",
      "Pagamento anexado para conferência.",
      "Aguardo confirmação.",
      ""
    ].join("\n"), "selection mode output differs");

    const limited = await render(["card-list", "--fixture", "fixtures/input/card-list.json", "--query", "de Joanna · comprovantes", "--max-results", "1"]);
    assert.equal(limited, [
      "Busca: de Joanna · comprovantes",
      "1. Re: Obra Reforma Quarto Liz Monjope - Comprovantes PHC Inte… · 10/07 11:35 · JoannaFraga",
      ""
    ].join("\n"), "max-results output differs");
    const limitedState = JSON.parse(await fs.readFile(LAST_SEARCH, "utf8"));
    assert.equal(limitedState.entries.length, 1, "max-results should limit persisted selection state");
    assert.ok(!limited.includes("Página 1"), "page=1 should not render a Página line");
    assert.ok(!selected.includes("=== CARD ==="), "approved card format must not render card fences");
    assert.ok(selected.split("\n")[2].includes("@"), "approved card format requires sender email on line 3");

    if (!quiet) console.log("ok raw/summary/omit/select/approved-format");
  } finally {
    if (previousState === null) await fs.rm(LAST_SEARCH, { force: true });
    else await fs.writeFile(LAST_SEARCH, previousState, "utf8");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runFixtureTests({ quiet: false });
  await runModeTests({ quiet: false });
}
