import * as vscode from "vscode";
import { log, logError } from "../logger";
import { resolveModel } from "../utils/modelResolver";
import { getBranchDiff, getBranchChangedFiles, getBranchCommitLog, getCurrentBranch } from "../agent/gitHelper";

/**
 * Handles @company /pr-review — performs a full code review of the current branch diff vs. main.
 *
 * - Reads `git diff main...HEAD` (all changes introduced by this branch)
 * - Reads commit log for context
 * - LLM reviews: logic changes, test coverage, naming, potential bugs, standards violations
 * - Output: chat sections — summary, issues found, suggestions
 */
export async function handlePrReviewCommand(
  stream: vscode.ChatResponseStream,
  model:  vscode.LanguageModelChat,
  token:  vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  // ── Get branch info ──────────────────────────────────────────────────────
  const currentBranch = getCurrentBranch();

  // Ask user for base branch (default: main)
  const baseBranch = await vscode.window.showInputBox({
    title:       "PR Review — rama base",
    prompt:      "¿Contra qué rama comparar? (default: main)",
    value:       "main",
    placeHolder: "main",
  });

  if (baseBranch === undefined) {
    stream.markdown("_Revisión cancelada._");
    return;
  }

  const base = baseBranch.trim() || "main";

  // ── Get diff ─────────────────────────────────────────────────────────────
  stream.progress(`Obteniendo diff de \`${currentBranch ?? "HEAD"}\` vs \`${base}\`…`);

  const diff         = getBranchDiff(base);
  const changedFiles = getBranchChangedFiles(base);
  const commitLog    = getBranchCommitLog(base);

  if (!diff) {
    stream.markdown(
      `⚠️ No hay diferencias entre \`${currentBranch ?? "HEAD"}\` y \`${base}\`.\n\n` +
      `Verifica que:\n` +
      `- Tienes commits en tu rama\n` +
      `- La rama base \`${base}\` existe localmente\n` +
      `- Estás en la rama correcta`
    );
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Build header ─────────────────────────────────────────────────────────
  stream.markdown(`## 🔍 PR Review: \`${currentBranch ?? "HEAD"}\` → \`${base}\`\n\n`);
  stream.markdown(
    `| | |\n|---|---|\n` +
    `| Rama actual | \`${currentBranch ?? "HEAD"}\` |\n` +
    `| Rama base | \`${base}\` |\n` +
    `| Archivos cambiados | **${changedFiles.length}** |\n` +
    `| Commits | ${commitLog ? commitLog.split("\n").length : 0} |\n\n`
  );

  if (changedFiles.length > 0) {
    stream.markdown(`**Archivos modificados:**\n${changedFiles.map((f) => `- \`${f}\``).join("\n")}\n\n`);
  }

  if (commitLog) {
    stream.markdown(`**Commits en esta rama:**\n\`\`\`\n${commitLog}\n\`\`\`\n\n`);
  }

  // ── Generate review via LLM ───────────────────────────────────────────────
  stream.progress("Analizando cambios con IA…");

  const truncatedDiff = diff.slice(0, 8_000);
  const wasCut        = diff.length > 8_000;

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un revisor de código senior experto en calidad de software. Realiza una revisión de Pull Request completa y profesional.\n\n` +
    `**Rama:** \`${currentBranch ?? "HEAD"}\` → \`${base}\`\n` +
    `**Archivos cambiados:** ${changedFiles.length}\n` +
    (commitLog ? `**Commits:**\n\`\`\`\n${commitLog}\n\`\`\`\n\n` : "") +
    `**Diff:**\n${wasCut ? "_[truncado a 8000 chars — diff completo muy largo]_\n" : ""}` +
    `\`\`\`diff\n${truncatedDiff}\n\`\`\`\n\n` +
    `Genera una revisión estructurada con las siguientes secciones en español:\n\n` +
    `## 📋 Resumen\n` +
    `Qué hace este PR en 2-3 frases: objetivo, cambios principales, impacto.\n\n` +
    `## ✅ Puntos positivos\n` +
    `Aspectos bien implementados (mínimo 2 si los hay).\n\n` +
    `## 🐛 Issues encontrados\n` +
    `Por cada issue: **[TIPO]** descripción clara + archivo y línea si aplica.\n` +
    `Tipos: BUG, LOGIC, NAMING, MISSING_TEST, STANDARDS, PERFORMANCE, SECURITY\n` +
    `Si no hay issues, indica "Sin issues críticos encontrados".\n\n` +
    `## 💡 Sugerencias de mejora\n` +
    `Mejoras opcionales no bloqueantes (naming, refactoring, tests adicionales).\n\n` +
    `## 🧪 Cobertura de tests\n` +
    `¿Los cambios tienen tests? ¿Falta cobertura en algún caso? ¿Los tests siguen el patrón AAA?\n\n` +
    `## 🏁 Veredicto\n` +
    `Una de las opciones:\n` +
    `- ✅ **APROBADO** — listo para merge\n` +
    `- ⚠️ **APROBADO CON SUGERENCIAS** — puede mergearse, pero hay mejoras opcionales\n` +
    `- ❌ **REQUIERE CAMBIOS** — hay issues que deben resolverse antes del merge\n\n` +
    `Responde en español. Sé específico y constructivo.`
  );

  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const chunk of resp.text) {
      stream.markdown(chunk);
    }
    log(`[PrReviewHandler] Review completed for branch ${currentBranch}`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[PrReviewHandler] LLM error: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo: ${err.message}`);
      return;
    }
    throw err;
  }

  stream.markdown(
    `\n\n---\n_Branch: \`${currentBranch ?? "HEAD"}\` · Base: \`${base}\` · ${changedFiles.length} archivos · Diff: ${diff.length} chars_`
  );
}
