import * as vscode from "vscode";
import { log, logError } from "../logger";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Files per LLM batch — kept small to avoid context saturation */
const FILES_PER_BATCH  = 4;
const MAX_CHARS_FILE   = 4_500;   // chars per source file
const MAX_FILES        = 100;

const EXCLUDE_GLOB = "{**/node_modules/**,**/target/**,**/dist/**,**/out/**,**/.git/**,**/__pycache__/**,**/build/**,**/.next/**}";
const SRC_EXTS     = [".java", ".ts", ".kt", ".py", ".cs", ".go", ".js"];

const OUTPUT_PATH  = "docs/code-documentation.md";

// Priority layer names for grouping output
const LAYER_ORDER = ["controller", "resource", "router", "service", "usecase", "repository", "gateway", "client", "util", "helper", "other"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceFile {
  uri:     vscode.Uri;
  relPath: string;
  name:    string;    // basename without extension, lowercase
  layer:   string;    // controller | service | repository | etc.
  content: string;
}

interface BatchResult {
  batchIndex: number;
  fileNames:  string[];
  rawDocs:    string;      // iteration 1 output
  enrichedDocs: string;   // iteration 2 output (cross-references added)
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleDocumentCommand(
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

  // ── Discovery ──────────────────────────────────────────────────────────────
  stream.progress("Buscando archivos fuente del proyecto…");

  const files = await collectSourceFiles();
  if (files.length === 0) {
    stream.markdown("ℹ️ No encontré archivos de código fuente en el workspace.");
    return;
  }

  // Group by layer for structured output
  const grouped = groupByLayer(files);
  const batches = chunk(files, FILES_PER_BATCH);

  stream.markdown(
    `## 📝 Documentando el proyecto\n\n` +
    `| | |\n|---|---|\n` +
    `| Archivos encontrados | **${files.length}** |\n` +
    `| Lotes | **${batches.length}** (${FILES_PER_BATCH} archivos c/u) |\n` +
    `| Capas | ${[...grouped.keys()].join(", ")} |\n\n` +
    `Se procesará en **2 iteraciones**: primero documenta cada método en detalle, luego enriquece con referencias cruzadas.\n\n`
  );

  log(`[DocumentHandler] ${files.length} files, ${batches.length} batches`);

  // ── Iteration 1: document each method ──────────────────────────────────────
  stream.markdown(`### Iteración 1 — Documentando métodos por lote…\n\n`);
  const batchResults: BatchResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }
    const batch = batches[i];
    const names = batch.map((f) => f.name);
    stream.progress(`Lote ${i + 1}/${batches.length}: ${names.join(", ")}…`);

    const rawDocs = await documentBatch(batch, resolvedModel, token);
    batchResults.push({ batchIndex: i, fileNames: names, rawDocs, enrichedDocs: "" });

    stream.markdown(`- ✅ Lote ${i + 1}: \`${names.join("`, `")}\`\n`);
    log(`[DocumentHandler] Batch ${i + 1} iteration 1 done (${rawDocs.length} chars)`);
  }

  // ── Iteration 2: add cross-references ──────────────────────────────────────
  stream.markdown(`\n### Iteración 2 — Agregando referencias cruzadas…\n\n`);

  // Build a global component index so Copilot knows who calls whom
  const componentIndex = buildComponentIndex(batchResults);

  for (let i = 0; i < batchResults.length; i++) {
    if (token.isCancellationRequested) { break; }
    const result = batchResults[i];
    stream.progress(`Enriqueciendo lote ${i + 1}/${batchResults.length}…`);

    const enriched = await enrichWithCrossRefs(
      result.rawDocs,
      batches[i],
      componentIndex,
      resolvedModel,
      token
    );
    result.enrichedDocs = enriched;

    stream.markdown(`- ✅ Lote ${i + 1} enriquecido\n`);
    log(`[DocumentHandler] Batch ${i + 1} iteration 2 done (${enriched.length} chars)`);
  }

  // ── Write output file ──────────────────────────────────────────────────────
  stream.progress("Escribiendo documentación…");
  const fileContent = buildOutputFile(batchResults, grouped);

  try {
    const root    = folders[0].uri;
    const docsDir = vscode.Uri.joinPath(root, "docs");
    const outFile = vscode.Uri.joinPath(root, OUTPUT_PATH);

    try { await vscode.workspace.fs.createDirectory(docsDir); } catch { /* exists */ }
    await vscode.workspace.fs.writeFile(outFile, Buffer.from(fileContent, "utf-8"));

    log(`[DocumentHandler] Written to ${OUTPUT_PATH}`);

    stream.markdown(
      `\n---\n` +
      `## ✅ Documentación generada\n\n` +
      `Archivo: \`${OUTPUT_PATH}\`\n\n` +
      `Contiene documentación detallada de cada método: descripción, parámetros, retorno, excepciones y referencias cruzadas.\n\n` +
      `**Vista previa del índice:**\n\n` +
      extractToc(fileContent)
    );
  } catch (err: unknown) {
    logError("[DocumentHandler] Failed to write file", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude escribir el archivo: \`${msg}\``);
  }
}

// ─── Iteration 1: document each method ───────────────────────────────────────

async function documentBatch(
  batch: SourceFile[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const filesSection = batch
    .map((f) => `### ${f.name} (${f.relPath})\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un arquitecto de software documentando un proyecto. Analiza los siguientes archivos fuente.\n\n` +
    `Para CADA método/función pública o protegida que encuentres, genera documentación detallada.\n\n` +
    `FORMATO DE SALIDA OBLIGATORIO — usa exactamente estos marcadores:\n\n` +
    `## FILE: NombreArchivo\n` +
    `CAPA: controller|service|repository|gateway|util\n` +
    `DESCRIPCION_CLASE: qué hace esta clase en una línea\n\n` +
    `### METHOD: nombreMetodo\n` +
    `FIRMA: firma completa del método (incluyendo tipos)\n` +
    `DESCRIPCION: qué hace este método, su propósito de negocio\n` +
    `PARAMETROS:\n` +
    `- nombreParam (tipo): descripción\n` +
    `RETORNA: tipo — descripción de qué contiene el valor de retorno\n` +
    `LANZA:\n` +
    `- NombreExcepcion: cuándo se lanza\n` +
    `LLAMA_A:\n` +
    `- NombreClase.metodo(): para qué lo llama\n` +
    `NOTAS: observaciones importantes (lógica de negocio, efectos secundarios, comportamiento especial)\n\n` +
    `Reglas:\n` +
    `- Si no hay parámetros/excepciones/llamadas, escribe NINGUNO\n` +
    `- Documenta SOLO métodos públicos, protegidos o anotados con @Override/@RequestMapping/etc.\n` +
    `- No documentes getters/setters simples ni constructores triviales\n` +
    `- Sé preciso: describe el propósito de negocio, no solo lo que hace el código\n\n` +
    `${filesSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Iteration 2: add cross-references ───────────────────────────────────────

async function enrichWithCrossRefs(
  rawDocs: string,
  batch: SourceFile[],
  componentIndex: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const msg = vscode.LanguageModelChatMessage.User(
    `Tienes la documentación preliminar de un lote de archivos y un índice global de todos los componentes del proyecto.\n\n` +
    `Para cada método documentado, agrega una sección **LLAMADO_POR** que liste qué otros componentes del proyecto invocan ese método.\n` +
    `Usa el índice global para determinarlo — solo incluye referencias que aparezcan explícitamente en el índice.\n\n` +
    `También revisa y mejora la sección **LLAMA_A** si falta alguna dependencia evidente.\n\n` +
    `Si un método no es llamado por nadie en el proyecto (ej: entry points, event listeners, endpoints HTTP), escribe LLAMADO_POR: _Punto de entrada externo_\n\n` +
    `MANTÉN EL MISMO FORMATO DE SALIDA exactamente, solo agrega la línea LLAMADO_POR debajo de LLAMA_A:\n\n` +
    `### METHOD: nombreMetodo\n` +
    `...\n` +
    `LLAMA_A:\n` +
    `- ...\n` +
    `LLAMADO_POR:\n` +
    `- NombreClase.metodo(): contexto\n\n` +
    `--- DOCUMENTACIÓN PRELIMINAR ---\n${rawDocs}\n\n` +
    `--- ÍNDICE GLOBAL DE COMPONENTES ---\n${componentIndex}`
  );

  return await callModel(model, msg, token);
}

// ─── Build global component index ────────────────────────────────────────────

function buildComponentIndex(results: BatchResult[]): string {
  // Extract METHOD lines from all batch 1 results to give Copilot a compact map
  const lines: string[] = [];
  for (const r of results) {
    const source = r.rawDocs;
    const fileMatches = [...source.matchAll(/^## FILE: (.+)$/gm)];
    const methodMatches = [...source.matchAll(/^### METHOD: (.+)$/gm)];
    for (const m of fileMatches) { lines.push(`CLASS: ${m[1].trim()}`); }
    for (const m of methodMatches) { lines.push(`  METHOD: ${m[1].trim()}`); }
  }
  return lines.slice(0, 300).join("\n");
}

// ─── Build output markdown file ───────────────────────────────────────────────

function buildOutputFile(results: BatchResult[], grouped: Map<string, SourceFile[]>): string {
  const now   = new Date().toISOString().split("T")[0];
  const parts: string[] = [
    `# Documentación del Código`,
    ``,
    `> Generado por \`@company /document\` el ${now}`,
    `> Regenera en cualquier momento para reflejar cambios en el código.`,
    ``,
    `## Capas del sistema`,
    ``,
  ];

  // Layer summary table
  for (const [layer, files] of grouped) {
    parts.push(`- **${capitalize(layer)}**: ${files.map((f) => `\`${f.name}\``).join(", ")}`);
  }
  parts.push("", "---", "");

  // Content grouped by layer order
  const allContent = results.map((r) => r.enrichedDocs || r.rawDocs).join("\n\n");

  // Try to preserve layer grouping from the output
  parts.push(allContent.trim());
  parts.push("", "---", "");
  parts.push(`_Fin de la documentación — ${results.reduce((acc, r) => acc + r.fileNames.length, 0)} archivos documentados_`);

  return parts.join("\n");
}

function extractToc(markdown: string): string {
  const lines = markdown.split("\n");
  const toc: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## FILE:")) {
      toc.push(`- **${line.replace("## FILE:", "").trim()}**`);
    } else if (line.startsWith("### METHOD:")) {
      toc.push(`  - \`${line.replace("### METHOD:", "").trim()}\``);
    }
  }
  return toc.slice(0, 40).join("\n") || "_Sin métodos detectados._";
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function collectSourceFiles(): Promise<SourceFile[]> {
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      `**/*.{${SRC_EXTS.map((e) => e.slice(1)).join(",")}}`,
      EXCLUDE_GLOB,
      MAX_FILES
    );
  } catch { return []; }

  const scored: Array<{ uri: vscode.Uri; score: number }> = uris.map((uri) => {
    const name  = baseName(uri).toLowerCase();
    const score = LAYER_ORDER.reduce((s, kw, i) =>
      name.includes(kw) ? s + (LAYER_ORDER.length - i) * 3 : s, 0
    );
    return { uri, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const result: SourceFile[] = [];
  for (const { uri } of scored.slice(0, MAX_FILES)) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, MAX_CHARS_FILE);
      const name    = baseName(uri).replace(/\.[^.]+$/, "").toLowerCase();
      const layer   = detectLayer(name);
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), name, layer, content });
    } catch { /* skip */ }
  }

  log(`[DocumentHandler] Collected ${result.length} source files`);
  return result;
}

function detectLayer(name: string): string {
  for (const kw of LAYER_ORDER) {
    if (name.includes(kw)) { return kw; }
  }
  return "other";
}

function groupByLayer(files: SourceFile[]): Map<string, SourceFile[]> {
  const map = new Map<string, SourceFile[]>();
  for (const f of files) {
    const existing = map.get(f.layer) ?? [];
    existing.push(f);
    map.set(f.layer, existing);
  }
  // Sort by layer order
  const sorted = new Map<string, SourceFile[]>();
  for (const kw of LAYER_ORDER) {
    if (map.has(kw)) { sorted.set(kw, map.get(kw)!); }
  }
  return sorted;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
  return out;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? "";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function callModel(
  model: vscode.LanguageModelChat,
  msg: vscode.LanguageModelChatMessage,
  token: vscode.CancellationToken
): Promise<string> {
  let result = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { result += c; }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[DocumentHandler] LLM error: ${err.code}`, err);
    } else {
      logError("[DocumentHandler] Unexpected LLM error", err);
    }
  }
  return result;
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
