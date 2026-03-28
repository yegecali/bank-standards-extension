import * as vscode from "vscode";
import { execSync }  from "child_process";
import { log, logError } from "../logger";
import { resolveModel } from "../utils/modelResolver";

/**
 * Handles @company /commit — suggests a Conventional Commits message based on:
 * 1. The staged git diff
 * 2. Jira issue key detected from the current branch name
 * 3. Company scope derived from the project name or Jira project key
 */
export async function handleCommitCommand(
  stream: vscode.ChatResponseStream,
  model:  vscode.LanguageModelChat,
  token:  vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  const cwd = folders[0].uri.fsPath;

  // ── Get staged diff ───────────────────────────────────────────────────────
  const diff = getStagedDiff(cwd);
  if (!diff) {
    stream.markdown(
      `⚠️ No hay cambios staged.\n\n` +
      `Ejecuta \`git add <archivos>\` antes de usar \`@company /commit\`.`
    );
    return;
  }

  // ── Detect branch name and extract Jira issue key ─────────────────────────
  const branchName = getBranchName(cwd);
  const issueKey   = extractIssueKey(branchName);

  // ── Get list of changed files for scope hint ──────────────────────────────
  const changedFiles = getChangedFiles(cwd);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Generate commit message via LLM ──────────────────────────────────────
  stream.progress("Generando mensaje de commit…");

  const truncatedDiff = diff.slice(0, 5_000);
  const wasCut        = diff.length > 5_000;

  const issueCtx = issueKey
    ? `\nIssue de Jira detectada en el branch: **${issueKey}** (incluir al final del mensaje)`
    : "";

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un experto en Conventional Commits. Genera el mejor mensaje de commit para estos cambios staged.\n\n` +
    `**Formato obligatorio:**\n` +
    `\`\`\`\n<tipo>(<scope>): <descripción corta en imperativo>\n\n[cuerpo opcional: qué cambia y por qué, máx 3 líneas]\n\n[footer: BREAKING CHANGE o issue key]\n\`\`\`\n\n` +
    `**Tipos válidos:** feat, fix, refactor, perf, test, docs, chore, ci, build, style\n\n` +
    `**Reglas:**\n` +
    `- Descripción en minúsculas, imperativo, sin punto final, máx 72 chars\n` +
    `- Scope: módulo, paquete o área afectada (ej: auth, jira, checkstyle)\n` +
    `- Si hay issue Jira, añadir al footer: \`Refs: ${issueKey ?? "PROJ-XX"}\`\n` +
    `- Si es un breaking change, indicar con \`BREAKING CHANGE:\` en el footer\n` +
    `- Responde SOLO con el bloque de código del mensaje, sin explicación\n\n` +
    `**Branch actual:** \`${branchName ?? "desconocido"}\`${issueCtx}\n\n` +
    `**Archivos modificados:**\n${changedFiles.map((f) => `- ${f}`).join("\n")}\n\n` +
    `**Diff staged:**\n${wasCut ? "_[truncado a 5000 chars]_\n" : ""}\`\`\`diff\n${truncatedDiff}\n\`\`\``
  );

  stream.markdown(`## 💬 Mensaje de commit sugerido\n\n`);

  let raw = "";
  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const chunk of resp.text) {
      stream.markdown(chunk);
      raw += chunk;
    }
    log(`[CommitHandler] Commit message generated: ${raw.length} chars`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[CommitHandler] LLM error: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo: ${err.message}`);
      return;
    }
    throw err;
  }

  if (branchName) {
    stream.markdown(`\n\n---\n_Branch: \`${branchName}\`${issueKey ? ` · Issue: \`${issueKey}\`` : ""}_`);
  }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function getStagedDiff(cwd: string): string | null {
  try {
    const diff = execSync("git diff --cached", { cwd, encoding: "utf8" });
    log(`[CommitHandler] Staged diff: ${diff.length} chars`);
    return diff.trim() || null;
  } catch (err: unknown) {
    logError("[CommitHandler] Failed to get staged diff", err);
    return null;
  }
}

function getBranchName(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
  } catch { return null; }
}

function getChangedFiles(cwd: string): string[] {
  try {
    const out = execSync("git diff --cached --name-only", { cwd, encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

/** Extracts a Jira issue key from a branch name.
 *  Handles: feature/BANK-42-description, BANK-42/feature, bugfix/PROJ-123 */
function extractIssueKey(branch: string | null): string | null {
  if (!branch) { return null; }
  const match = branch.match(/([A-Z][A-Z0-9]+-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}
