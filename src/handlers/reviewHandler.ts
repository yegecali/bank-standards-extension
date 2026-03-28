import * as vscode from "vscode";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../notion/parser";
import { resolvePageId } from "../agent/specialtyResolver";
import { resolveModel } from "../utils/modelResolver";

/**
 * Handles @company /review — reviews the active editor file against
 * company standards: naming conventions, structure, tests, and code quality.
 */
export async function handleReviewCommand(
  stream:    vscode.ChatResponseStream,
  model:     vscode.LanguageModelChat,
  specialty: string,
  token:     vscode.CancellationToken
): Promise<void> {
  // ── Get active file ───────────────────────────────────────────────────────
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    stream.markdown(
      `⚠️ No hay ningún archivo abierto en el editor.\n\n` +
      `Abre el archivo que quieres revisar y vuelve a ejecutar \`@company /review\`.`
    );
    return;
  }

  const document  = editor.document;
  const fileText  = document.getText();
  const fileName  = document.fileName.split("/").pop() ?? "archivo";
  const langId    = document.languageId;  // "java", "typescript", "python", etc.
  const relPath   = vscode.workspace.asRelativePath(document.uri);

  if (!fileText.trim()) {
    stream.markdown(`⚠️ El archivo **${fileName}** está vacío.`);
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Load company standards ────────────────────────────────────────────────
  stream.progress("Cargando estándares de la compañía…");
  const standardsPageId = resolvePageId("standards", specialty);
  let standardsContext  = "";

  if (standardsPageId) {
    try {
      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(standardsPageId);
      standardsContext = blocksToMarkdown(page.blocks).slice(0, 4_000);
      log(`[ReviewHandler] Standards loaded: ${standardsContext.length} chars`);
    } catch (err: unknown) {
      logError("[ReviewHandler] Failed to load standards", err);
    }
  }

  // ── Load naming rules from settings ──────────────────────────────────────
  const config      = vscode.workspace.getConfiguration("companyStandards");
  const namingRules = config.get<unknown[]>("namingRules") ?? [];
  const namingCtx   = namingRules.length
    ? `\n\nReglas de nomenclatura configuradas:\n${JSON.stringify(namingRules, null, 2)}`
    : "";

  // ── LLM review ────────────────────────────────────────────────────────────
  stream.progress(`Revisando ${fileName}…`);
  stream.markdown(`## 🔍 Revisión de \`${relPath}\`\n\n`);

  const truncated = fileText.slice(0, 6_000);
  const wascut    = fileText.length > 6_000;

  const systemCtx = standardsContext
    ? `Estándares de la compañía:\n${standardsContext}${namingCtx}`
    : `Aplica buenas prácticas estándar para ${langId}.${namingCtx}`;

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un revisor de código experto que sigue los estándares de la compañía.\n\n` +
    `${systemCtx}\n\n` +
    `Revisa el siguiente archivo \`${relPath}\` (${langId}) y entrega feedback estructurado en estas secciones:\n\n` +
    `### ✅ / ❌ Nomenclatura\n` +
    `Evalúa si los nombres de clases, métodos, variables y constantes siguen las convenciones. Lista los que no cumplen con el nombre actual y el nombre correcto sugerido.\n\n` +
    `### ✅ / ❌ Estructura y organización\n` +
    `Evalúa la organización del código: capas, responsabilidades, separación de concerns, longitud de métodos.\n\n` +
    `### ✅ / ❌ Calidad del código\n` +
    `Detecta: código duplicado, métodos muy largos, complejidad ciclomática alta, magic numbers, manejo de errores.\n\n` +
    `### ✅ / ❌ Tests\n` +
    `¿El archivo tiene tests asociados o tests internos? ¿Los métodos públicos son testables? ¿Falta cobertura obvia?\n\n` +
    `### ✅ / ❌ Estándares de la compañía\n` +
    `Lista explícitamente qué estándares se cumplen y cuáles se violan con la línea de código específica.\n\n` +
    `### 📋 Resumen y prioridades\n` +
    `Lista los 3-5 cambios más importantes ordenados por impacto, con la acción concreta a tomar.\n\n` +
    `Sé específico: menciona nombres de métodos, líneas aproximadas o fragmentos de código cuando sea relevante.\n` +
    `Responde en el mismo idioma del código (comentarios/nombres).\n\n` +
    `${wascut ? "_Nota: el archivo fue truncado a los primeros 6000 caracteres._\n\n" : ""}` +
    `\`\`\`${langId}\n${truncated}\n\`\`\``
  );

  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const chunk of resp.text) {
      stream.markdown(chunk);
    }
    log(`[ReviewHandler] Review complete for ${fileName}`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[ReviewHandler] LLM error: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo: ${err.message}`);
    } else {
      throw err;
    }
  }
}
