import * as vscode from "vscode";
import { log, logError } from "../logger";
import { BATCH, EXCLUDE_GLOB, SRC_EXTENSIONS } from "../config/defaults";

const OUTPUT_PATH = "docs/sequence-diagrams.md";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ControllerFile {
  uri:     vscode.Uri;
  relPath: string;
  content: string;
}

interface ServiceFile {
  uri:     vscode.Uri;
  relPath: string;
  name:    string;   // lowercase basename without extension
  content: string;
}

interface BatchResult {
  batchIndex: number;
  controllerNames: string[];
  rawDiagrams: string;   // iteration 1 output
  refinedDiagrams: string; // iteration 2 output
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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

  // ── Discovery ──────────────────────────────────────────────────────────────
  stream.progress("Buscando controladores y contratos OpenAPI…");

  const [controllers, services, openapiText] = await Promise.all([
    findControllers(),
    findServices(),
    findOpenApiContent(),
  ]);

  if (controllers.length === 0) {
    stream.markdown(
      `ℹ️ No encontré controladores en el workspace.\n\n` +
      `Busco archivos que contengan \`Controller\`, \`Resource\`, o \`Router\` en el nombre.`
    );
    return;
  }

  const batches = chunk(controllers, BATCH.CONTROLLERS_PER_BATCH);

  stream.markdown(
    `## 🔍 Generando diagramas de secuencia\n\n` +
    `| | |\n|---|---|\n` +
    `| Controladores | **${controllers.length}** |\n` +
    `| Servicios | **${services.length}** |\n` +
    `| Lotes | **${batches.length}** (${BATCH.CONTROLLERS_PER_BATCH} controladores c/u) |\n` +
    `| OpenAPI | ${openapiText ? "✅ encontrado" : "⚠️ no encontrado"} |\n\n` +
    `Se procesará en **2 iteraciones** para maximizar la calidad del diagrama.\n\n`
  );

  log(`[ExplainHandler] ${controllers.length} controllers, ${services.length} services, ${batches.length} batches`);

  // ── Iteration 1: generate raw diagrams ─────────────────────────────────────
  stream.markdown(`### Iteración 1 — Generando diagramas por lote…\n\n`);
  const batchResults: BatchResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }
    const batch = batches[i];
    const names = batch.map((c) => shortName(c.relPath));
    stream.progress(`Lote ${i + 1}/${batches.length}: ${names.join(", ")}…`);

    const raw = await generateRawDiagrams(batch, openapiText, resolvedModel, token);
    batchResults.push({ batchIndex: i, controllerNames: names, rawDiagrams: raw, refinedDiagrams: "" });

    stream.markdown(`- ✅ Lote ${i + 1}: \`${names.join("`, `")}\`\n`);
    log(`[ExplainHandler] Batch ${i + 1} iteration 1 done (${raw.length} chars)`);
  }

  // ── Iteration 2: refine with service implementations ───────────────────────
  stream.markdown(`\n### Iteración 2 — Refinando con implementaciones de servicios…\n\n`);

  for (let i = 0; i < batchResults.length; i++) {
    if (token.isCancellationRequested) { break; }
    const result = batchResults[i];
    const batch  = batches[i];

    stream.progress(`Refinando lote ${i + 1}/${batchResults.length}: ${result.controllerNames.join(", ")}…`);

    // Find services referenced by this batch's controllers
    const relevantServices = findRelevantServices(batch, services);
    const refined = await refineDiagrams(batch, relevantServices, result.rawDiagrams, resolvedModel, token);
    result.refinedDiagrams = refined;

    stream.markdown(`- ✅ Lote ${i + 1} refinado (${relevantServices.length} servicio(s) analizados)\n`);
    log(`[ExplainHandler] Batch ${i + 1} iteration 2 done (${refined.length} chars)`);
  }

  // ── Write output file ──────────────────────────────────────────────────────
  stream.progress("Escribiendo archivo de documentación…");
  const fileContent = buildOutputFile(batchResults);

  try {
    const root    = folders[0].uri;
    const docsDir = vscode.Uri.joinPath(root, "docs");
    const outFile = vscode.Uri.joinPath(root, OUTPUT_PATH);

    // Ensure docs/ dir exists
    try { await vscode.workspace.fs.createDirectory(docsDir); } catch { /* already exists */ }

    await vscode.workspace.fs.writeFile(outFile, Buffer.from(fileContent, "utf-8"));
    log(`[ExplainHandler] Written to ${OUTPUT_PATH}`);

    stream.markdown(
      `\n---\n` +
      `## ✅ Documentación generada\n\n` +
      `Archivo: \`${OUTPUT_PATH}\`\n\n` +
      `Contiene un diagrama de secuencia Mermaid por endpoint de cada controlador.\n\n` +
      `> Abre el archivo en VSCode con la extensión **Markdown Preview Mermaid Support** para visualizar los diagramas.\n\n` +
      `---\n\n` +
      `**Vista previa del índice:**\n\n` +
      extractToc(fileContent)
    );
  } catch (err: unknown) {
    logError("[ExplainHandler] Failed to write output file", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude escribir el archivo: \`${msg}\`\n\nMostrando resultado en el chat:\n\n${fileContent.slice(0, 3000)}…`);
  }
}

// ─── Iteration 1: generate raw diagrams ──────────────────────────────────────

async function generateRawDiagrams(
  batch: ControllerFile[],
  openapiText: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const controllerSection = batch
    .map((c) => `### ${shortName(c.relPath)}\n\`\`\`\n${c.content}\n\`\`\``)
    .join("\n\n");

  const openapiSection = openapiText
    ? `### Contrato OpenAPI\n\`\`\`yaml\n${openapiText}\n\`\`\``
    : "";

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un arquitecto de software. Analiza los siguientes controladores` +
    (openapiText ? " y su contrato OpenAPI" : "") + `.\n\n` +

    `Para CADA endpoint que encuentres, genera un diagrama de secuencia Mermaid detallado que muestre:\n` +
    `- El flujo completo desde el cliente hasta la respuesta\n` +
    `- Llamadas a servicios, repositorios, cache (Redis/Memcached), bases de datos\n` +
    `- Condicionales importantes (alt/else/opt) como validaciones, manejo de errores, casos de negocio\n` +
    `- Transformaciones o mapeos de datos relevantes\n\n` +

    `FORMATO DE SALIDA OBLIGATORIO — usa exactamente estos marcadores:\n` +
    `## CONTROLLER: NombreExactoDelControlador\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: qué hace este endpoint en una línea\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  participant Client\n` +
    `  ...\n` +
    "```\n\n" +

    `Reglas:\n` +
    `- Usa \`->>>\` para llamadas síncronas, \`-->>>\` para respuestas\n` +
    `- Usa \`alt\`/\`else\`/\`end\` para condicionales\n` +
    `- Usa \`opt\` para flujos opcionales\n` +
    `- No inventes componentes que no estén en el código\n` +
    `- Si el código llama a un método de servicio, muestra el nombre exacto del método\n\n` +

    `${controllerSection}\n\n${openapiSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Iteration 2: refine with service implementations ────────────────────────

async function refineDiagrams(
  batch: ControllerFile[],
  relevantServices: ServiceFile[],
  previousDiagrams: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const controllerSection = batch
    .map((c) => `### ${shortName(c.relPath)}\n\`\`\`\n${c.content}\n\`\`\``)
    .join("\n\n");

  const serviceSection = relevantServices.length > 0
    ? relevantServices
        .map((s) => `### ${s.name}\n\`\`\`\n${s.content}\n\`\`\``)
        .join("\n\n")
    : "_No se encontraron implementaciones de servicios._";

  const msg = vscode.LanguageModelChatMessage.User(
    `Tienes los diagramas de secuencia iniciales generados a partir de los controladores.\n` +
    `Ahora también tienes las implementaciones de los servicios que esos controladores invocan.\n\n` +

    `Revisa cada diagrama y MEJÓRALO si:\n` +
    `- Faltan llamadas a métodos específicos del servicio (incluye nombres exactos de métodos)\n` +
    `- No se muestran verificaciones de cache (Redis/Memcached/EhCache)\n` +
    `- No se muestran llamadas al repositorio/DB con el método exacto\n` +
    `- Hay lógica condicional en el servicio que no está representada (validaciones, reglas de negocio)\n` +
    `- Hay llamadas a servicios externos, APIs, colas (Kafka, SQS, RabbitMQ)\n` +
    `- Hay flujos de error/excepción relevantes\n\n` +

    `Si un diagrama ya está correcto y completo, devuélvelo sin cambios.\n\n` +

    `MISMO FORMATO DE SALIDA OBLIGATORIO:\n` +
    `## CONTROLLER: NombreExactoDelControlador\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: qué hace este endpoint en una línea\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  ...\n` +
    "```\n\n" +

    `--- DIAGRAMAS INICIALES (iteración 1) ---\n${previousDiagrams}\n\n` +
    `--- CONTROLADORES ---\n${controllerSection}\n\n` +
    `--- IMPLEMENTACIONES DE SERVICIOS ---\n${serviceSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Build output markdown file ───────────────────────────────────────────────

function buildOutputFile(results: BatchResult[]): string {
  const now   = new Date().toISOString().split("T")[0];
  const parts: string[] = [
    `# Diagramas de Secuencia`,
    ``,
    `> Generado por \`@company /explain\` el ${now}`,
    `> Regenera en cualquier momento para reflejar cambios en el código.`,
    ``,
    `---`,
    ``,
  ];

  for (const result of results) {
    const content = result.refinedDiagrams || result.rawDiagrams;
    if (content.trim()) {
      parts.push(content.trim());
      parts.push("");
      parts.push("---");
      parts.push("");
    }
  }

  return parts.join("\n");
}

function extractToc(markdown: string): string {
  const lines = markdown.split("\n");
  const toc: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## CONTROLLER:")) {
      toc.push(`- **${line.replace("## CONTROLLER:", "").trim()}**`);
    } else if (line.startsWith("### ENDPOINT:")) {
      toc.push(`  - \`${line.replace("### ENDPOINT:", "").trim()}\``);
    }
  }
  return toc.slice(0, 30).join("\n") || "_Sin endpoints detectados._";
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function findControllers(): Promise<ControllerFile[]> {
  const patterns = [
    "**/*Controller.*",
    "**/*Resource.*",
    "**/*Router.*",
    "**/*Routes.*",
  ];

  const uris = await findFilesByPatterns(patterns);
  const result: ControllerFile[] = [];

  for (const uri of uris) {
    if (!SRC_EXTENSIONS.includes(extOf(uri))) { continue; }
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, BATCH.MAX_CHARS_CONTROLLER);
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), content });
    } catch { /* skip */ }
  }

  log(`[ExplainHandler] Found ${result.length} controller files`);
  return result;
}

async function findServices(): Promise<ServiceFile[]> {
  const patterns = [
    "**/*Service.*",
    "**/*ServiceImpl.*",
    "**/*UseCase.*",
    "**/*Usecase.*",
  ];

  const uris = await findFilesByPatterns(patterns);
  const result: ServiceFile[] = [];

  for (const uri of uris) {
    if (!SRC_EXTENSIONS.includes(extOf(uri))) { continue; }
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, BATCH.MAX_CHARS_SERVICE);
      const name    = baseName(uri).replace(/\.[^.]+$/, "").toLowerCase();
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), name, content });
    } catch { /* skip */ }
  }

  log(`[ExplainHandler] Found ${result.length} service files`);
  return result;
}

async function findOpenApiContent(): Promise<string> {
  const patterns = [
    "**/openapi.{yaml,yml,json}",
    "**/swagger.{yaml,yml,json}",
    "**/*.openapi.{yaml,yml,json}",
    "**/api-docs.{yaml,yml,json}",
    "**/api.{yaml,yml}",
  ];

  const uris = await findFilesByPatterns(patterns);
  const parts: string[] = [];

  for (const uri of uris.slice(0, 3)) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, BATCH.MAX_CHARS_OPENAPI);
      parts.push(`# ${vscode.workspace.asRelativePath(uri)}\n${content}`);
    } catch { /* skip */ }
  }

  return parts.join("\n\n---\n\n");
}

async function findFilesByPatterns(patterns: string[]): Promise<vscode.Uri[]> {
  const all: vscode.Uri[] = [];
  for (const pattern of patterns) {
    try {
      const found = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 50);
      all.push(...found);
    } catch { /* skip */ }
  }
  // Deduplicate by path
  const seen = new Set<string>();
  return all.filter((u) => {
    if (seen.has(u.path)) { return false; }
    seen.add(u.path);
    return true;
  });
}

// ─── Match services referenced in controller batch ───────────────────────────

function findRelevantServices(batch: ControllerFile[], services: ServiceFile[]): ServiceFile[] {
  const combined = batch.map((c) => c.content).join("\n").toLowerCase();
  return services.filter((s) => combined.includes(s.name));
}

// ─── LLM call helper ─────────────────────────────────────────────────────────

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
      logError(`[ExplainHandler] LLM error: ${err.code}`, err);
    } else {
      logError("[ExplainHandler] Unexpected LLM error", err);
    }
  }
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
  return out;
}

function extOf(uri: vscode.Uri): string {
  const name = uri.path.split("/").pop() ?? "";
  const dot  = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? "";
}

function shortName(relPath: string): string {
  return relPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? relPath;
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
