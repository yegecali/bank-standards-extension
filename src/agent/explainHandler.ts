import * as vscode from "vscode";
import { log, logError } from "../logger";

// ─── Constants ────────────────────────────────────────────────────────────────

const FILES_PER_BATCH = 5;
const MAX_CHARS_PER_FILE = 3_000;
const MAX_FILES = 80;

// Patterns that identify "important" files (controllers, services, entry points)
const PRIORITY_KEYWORDS = [
  "controller", "resource", "router", "handler", "service",
  "repository", "gateway", "usecase", "facade", "application",
  "main", "app", "index", "extension", "provider",
];

const EXCLUDE_GLOB = "{**/node_modules/**,**/target/**,**/dist/**,**/out/**,**/.git/**,**/__pycache__/**,**/build/**,.next/**}";

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handles @company /explain
 *
 * 1. Scans the workspace for key source files (controllers, services, entry points)
 * 2. Processes them in batches → each batch produces a "flow summary" (nodes + edges)
 * 3. Merges all summaries → Copilot generates a unified Mermaid flowchart
 * 4. Renders the final diagram with a brief description
 *
 * For large projects the batching ensures Copilot always gets an acotado context,
 * and the progressive merge builds the full picture incrementally.
 */
export async function handleExplainCommand(
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  stream.progress("Escaneando estructura del proyecto…");

  // ── Step 1: collect key files ──────────────────────────────────────────────
  const allFiles = await collectKeyFiles();
  if (allFiles.length === 0) {
    stream.markdown("ℹ️ No encontré archivos de código fuente en el workspace.");
    return;
  }

  // ── Step 2: read file tree summary (1 LLM call, very fast) ─────────────────
  const treeSummary = await readTreeSummary(folders[0].uri);

  log(`[ExplainHandler] ${allFiles.length} key files found, ${Math.ceil(allFiles.length / FILES_PER_BATCH)} batches`);
  stream.markdown(
    `## 🔍 Analizando el proyecto\n\n` +
    `Encontré **${allFiles.length}** archivos clave. ` +
    `Los procesaré en lotes para construir el diagrama de flujo.\n\n`
  );

  // ── Step 3: process each batch → partial flow summaries ────────────────────
  const batches = chunk(allFiles, FILES_PER_BATCH);
  const partialSummaries: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }
    stream.progress(`Analizando lote ${i + 1}/${batches.length}…`);

    const batchFiles = batches[i];
    const batchContent = await readBatchContents(batchFiles);

    const partialSummary = await extractFlowSummary(
      batchContent,
      treeSummary,
      resolvedModel,
      token
    );

    if (partialSummary) {
      partialSummaries.push(partialSummary);
      log(`[ExplainHandler] Batch ${i + 1}/${batches.length} summarized (${partialSummary.length} chars)`);
    }
  }

  if (partialSummaries.length === 0) {
    stream.markdown("❌ No se pudo analizar ningún archivo del proyecto.");
    return;
  }

  // ── Step 4: merge all summaries → unified Mermaid diagram ──────────────────
  stream.progress("Generando diagrama Mermaid unificado…");

  const diagram = await buildMermaidDiagram(
    partialSummaries,
    treeSummary,
    resolvedModel,
    token,
    stream
  );

  log(`[ExplainHandler] Diagram generated`);
}

// ─── Step 1: collect key files ────────────────────────────────────────────────

async function collectKeyFiles(): Promise<vscode.Uri[]> {
  const include = "**/*.{java,ts,js,kt,py,go,cs,rb,php,rs,swift}";

  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, MAX_FILES);
  } catch {
    return [];
  }

  // Score each file by priority
  const scored = files.map((uri) => {
    const name = uri.path.split("/").pop()?.toLowerCase() ?? "";
    const score = PRIORITY_KEYWORDS.reduce(
      (s, kw) => s + (name.includes(kw) ? 2 : 0),
      // Bonus: files closer to src root (fewer path segments) rank higher
      Math.max(0, 10 - uri.path.split("/").length)
    );
    return { uri, score };
  });

  // Sort by priority score DESC, take up to MAX_FILES
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_FILES).map((s) => s.uri);
}

// ─── Step 2: file tree summary ────────────────────────────────────────────────

async function readTreeSummary(root: vscode.Uri): Promise<string> {
  try {
    const lines: string[] = [];
    await walkDir(root, root, lines, 0, 3);
    return lines.slice(0, 120).join("\n");
  } catch {
    return "(file tree not available)";
  }
}

async function walkDir(
  root: vscode.Uri,
  dir: vscode.Uri,
  lines: string[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth) { return; }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch { return; }

  const indent = "  ".repeat(depth);
  for (const [name, type] of entries) {
    if (name.startsWith(".") || ["node_modules", "target", "dist", "out", "build", "__pycache__"].includes(name)) {
      continue;
    }
    lines.push(`${indent}${name}${type === vscode.FileType.Directory ? "/" : ""}`);
    if (type === vscode.FileType.Directory) {
      await walkDir(root, vscode.Uri.joinPath(dir, name), lines, depth + 1, maxDepth);
    }
  }
}

// ─── Step 3: read batch contents ──────────────────────────────────────────────

async function readBatchContents(files: vscode.Uri[]): Promise<string> {
  const parts: string[] = [];
  for (const uri of files) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, MAX_CHARS_PER_FILE);
      const relPath = vscode.workspace.asRelativePath(uri);
      parts.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* skip unreadable */ }
  }
  return parts.join("\n\n");
}

// ─── Step 3b: extract flow summary from one batch ────────────────────────────

async function extractFlowSummary(
  batchContent: string,
  treeSummary: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const msg = vscode.LanguageModelChatMessage.User(
    `Estás analizando un proyecto de software. Aquí está la estructura del proyecto:\n` +
    `\`\`\`\n${treeSummary}\n\`\`\`\n\n` +
    `Y aquí hay un lote de archivos fuente:\n\n${batchContent}\n\n` +
    `Extrae el flujo de los archivos en este formato estructurado:\n` +
    `- COMPONENTE: <nombre del componente/clase>\n` +
    `- TIPO: <tipo: controller|service|repository|gateway|config|util|entrypoint|other>\n` +
    `- EXPONE: <qué endpoints, métodos públicos o eventos expone>\n` +
    `- LLAMA_A: <qué otros componentes, servicios externos, DBs llama>\n` +
    `- DESCRIPCION: <qué hace en una línea>\n` +
    `\n` +
    `Enumera un bloque por componente importante que encuentres. ` +
    `Omite clases de utilidad triviales. ` +
    `Sé conciso. No escribas código, solo el análisis.`
  );

  let result = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { result += c; }
  } catch (err) {
    logError("[ExplainHandler] Batch summary failed", err);
  }
  return result;
}

// ─── Step 4: build unified Mermaid diagram ────────────────────────────────────

async function buildMermaidDiagram(
  summaries: string[],
  treeSummary: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream
): Promise<void> {
  const allSummaries = summaries.join("\n\n---\n\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un arquitecto de software. Basándote en los siguientes análisis de componentes de un proyecto,\n` +
    `genera:\n\n` +
    `1. Un diagrama Mermaid \`flowchart TD\` que muestre los flujos principales del sistema.\n` +
    `   - Nodos: los componentes más importantes (entry points, controllers, services, repos, DBs externas)\n` +
    `   - Flechas con etiquetas breves que describan la interacción (ej: "HTTP GET /users", "SQL query", "Kafka event")\n` +
    `   - Agrupa visualmente por capas si es posible (API → Servicio → Repositorio → DB)\n` +
    `   - Máximo 20-25 nodos para mantener legibilidad\n` +
    `   - Usa subgraph para agrupar capas cuando ayude a la claridad\n\n` +
    `2. Una descripción breve del proyecto (3-5 líneas): qué hace, tecnologías clave, patrones usados.\n\n` +
    `Estructura del proyecto:\n\`\`\`\n${treeSummary}\n\`\`\`\n\n` +
    `Análisis de componentes por lotes:\n\n${allSummaries}\n\n` +
    `IMPORTANTE: El diagrama Mermaid debe estar dentro de un bloque de código \`\`\`mermaid ... \`\`\`. ` +
    `Primero escribe la descripción, luego el diagrama.`
  );

  stream.markdown(`## 📊 Diagrama de flujo del proyecto\n\n`);

  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) {
      stream.markdown(c);
    }
    stream.markdown(
      `\n\n---\n_Diagrama generado analizando **${summaries.length * FILES_PER_BATCH}** archivos clave. ` +
      `Ejecuta \`@company /explain\` de nuevo para regenerarlo si el workspace cambió._`
    );
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[ExplainHandler] Diagram generation failed", err);
      throw err;
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function resolveModel(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream
): Promise<vscode.LanguageModelChat | null> {
  if (model.id !== "auto") { return model; }
  stream.progress("Seleccionando modelo de lenguaje…");
  for (const selector of [
    { vendor: "copilot", family: "gpt-4o" },
    { vendor: "copilot", family: "gpt-4" },
    { vendor: "copilot", family: "claude-sonnet" },
    {},
  ]) {
    const models = await vscode.lm.selectChatModels(selector);
    if (models.length > 0) { return models[0]; }
  }
  stream.markdown("❌ No hay modelos de lenguaje disponibles. Activa GitHub Copilot.");
  return null;
}
