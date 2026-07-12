import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicError } from "./sanitize.mjs";

const execFileAsync = promisify(execFile);
const PS = "/bin/ps";

function bucketFor(date, now) {
  if (!date) return "desconhecido";
  const age = now - date.getTime();
  if (age < 0) return "desconhecido";
  if (age < 24 * 60 * 60 * 1000) return "hoje";
  if (age < 7 * 24 * 60 * 60 * 1000) return "esta-semana";
  return "mais-antigo";
}

function parsePs(stdout) {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function collectCofre(now = Date.now()) {
  const source = "cofre.ps";
  try {
    const { stdout } = await execFileAsync(PS, ["-axo", "user=,lstart="], {
      env: { PATH: "/bin:/usr/bin" },
      timeout: 750,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    const rows = parsePs(stdout);
    const cofreRows = rows.filter((line) => line.startsWith("cofre "));
    let latest = null;
    for (const row of cofreRows) {
      const dateText = row.replace(/^cofre\s+/, "");
      const date = new Date(dateText);
      if (!Number.isNaN(date.getTime()) && (!latest || date > latest)) latest = date;
    }
    return {
      cofre: {
        presenca: cofreRows.length > 0 ? "presente" : "ausente",
        ultimoUso: cofreRows.length > 0 ? bucketFor(latest, now) : "desconhecido"
      },
      freshness: {
        [source]: {
          source: "ps",
          timestamp: new Date(now).toISOString(),
          idadeDoDado: 0,
          status: "ok"
        }
      },
      errors: []
    };
  } catch {
    return {
      cofre: { presenca: "desconhecido", ultimoUso: "desconhecido" },
      freshness: {
        [source]: {
          source: "ps",
          timestamp: null,
          idadeDoDado: null,
          status: "error"
        }
      },
      errors: [publicError(source, "SOURCE_ERROR", "falha ao consultar processos")]
    };
  }
}
