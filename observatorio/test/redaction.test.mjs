import assert from "node:assert/strict";
import { sanitize, jsonSafe } from "../lib/sanitize.mjs";

const fake = {
  token: "sk-fakeTOKEN1234567890",
  nested: {
    text: "Authorization: Bearer abc.def.ghi and token=secret-value",
    path: "/Users/hermes/private/file.txt",
    ok: "snapshot"
  }
};

const out = jsonSafe(sanitize(fake));
assert.equal(out.includes("sk-fakeTOKEN1234567890"), false);
assert.equal(out.includes("secret-value"), false);
assert.equal(out.includes("/Users/hermes"), false);
assert.equal(out.includes("snapshot"), true);
console.log("redaction ok");
