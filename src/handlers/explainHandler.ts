import * as vscode from "vscode";
import { log, logError } from "../logger";
import { BATCH, EXCLUDE_GLOB, SRC_EXTENSIONS } from "../config/defaults";
import { resolveModel } from "../utils/modelResolver";

const OUTPUT_PATH = "docs/sequence-diagrams.md";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ControllerFile {
  uri:       vscode.Uri;
  relPath:   string;
  content:   string;
  lineCount: number;
  charCount: number;
}

interface ServiceFile {
  uri:     vscode.Uri;
  relPath: string;
  name:    string;   // lowercase basename without extension
  content: string;
}

interface BatchResult {
  batchIndex:      number;
  controllerNames: string[];
  finalDiagram:    string;   // diagram after all layers
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

  const [controllers, services, repositories, infrastructure, openapiText, allSourceFiles] = await Promise.all([
    findControllers(),
    findServices(),
    findRepositories(),
    findInfrastructure(),
    findOpenApiContent(),
    findAllSourceFiles(),
  ]);

  if (controllers.length === 0) {
    stream.markdown(
      `ℹ️ No encontré controladores en el workspace.\n\n` +
      `Busco archivos que contengan \`Controller\`, \`Resource\`, o \`Router\` en el nombre.`
    );
    return;
  }

  const batches = chunk(controllers, BATCH.CONTROLLERS_PER_BATCH);

  const totalLines = controllers.reduce((s, c) => s + c.lineCount, 0);
  const totalChars = controllers.reduce((s, c) => s + c.charCount, 0);

  // ── Summary table ──────────────────────────────────────────────────────────
  const batchTableRows = batches.map((batch, i) => {
    const names     = batch.map((c) => shortName(c.relPath)).join(", ");
    const lines     = batch.reduce((s, c) => s + c.lineCount, 0);
    const kb        = Math.round(batch.reduce((s, c) => s + c.charCount, 0) / 1024 * 10) / 10;
    return `| ${i + 1} | ${names} | ${batch.length} | ${lines.toLocaleString()} | ${kb} KB |`;
  }).join("\n");

  stream.markdown(
    `## 🔍 Generando diagramas de secuencia\n\n` +
    `| | |\n|---|---|\n` +
    `| Controladores escaneados | **${controllers.length}** |\n` +
    `| Total líneas de código | **${totalLines.toLocaleString()}** |\n` +
    `| Total contexto | **${Math.round(totalChars / 1024)} KB** |\n` +
    `| Servicios | **${services.length}** |\n` +
    `| Repos/Gateways/Clientes | **${repositories.length}** |\n` +
    `| Infraestructura (Redis/Eventos/Async) | **${infrastructure.length}** |\n` +
    `| Total archivos fuente (Capa 5) | **${allSourceFiles.length}** |\n` +
    `| Lotes | **${batches.length}** (${BATCH.CONTROLLERS_PER_BATCH} controladores c/u) |\n` +
    `| OpenAPI | ${openapiText ? "✅ encontrado" : "⚠️ no encontrado"} |\n\n` +
    `### Plan de lotes\n\n` +
    `| Lote | Controladores | Archivos | Líneas | Contexto |\n` +
    `|------|---------------|----------|--------|----------|\n` +
    `${batchTableRows}\n\n` +
    `Se procesará en **2 iteraciones**: boceto inicial → diagrama detallado enriquecido.\n\n`
  );

  log(`[ExplainHandler] ${controllers.length} controllers (${totalLines} lines), ${services.length} services, ${repositories.length} repos, ${infrastructure.length} infra, ${batches.length} batches`);

  // ── Per-batch layer-by-layer processing ────────────────────────────────────
  const batchResults: BatchResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }

    const batch      = batches[i];
    const names      = batch.map((c) => shortName(c.relPath));
    const batchLines = batch.reduce((s, c) => s + c.lineCount, 0);
    const batchKb    = Math.round(batch.reduce((s, c) => s + c.charCount, 0) / 1024 * 10) / 10;

    stream.markdown(`\n---\n\n### 🗂 Lote ${i + 1}/${batches.length} — \`${names.join("`, `")}\`\n\n`);

    // ── Capa 1: Controladores ────────────────────────────────────────────────
    stream.markdown(
      `#### 🔵 Capa 1 — Controladores\n` +
      `📄 **${batch.length}** archivo(s) · **${batchLines.toLocaleString()} líneas** · **${batchKb} KB**\n\n`
    );
    stream.progress(`Lote ${i + 1} — Capa 1: escaneando ${names.join(", ")}…`);

    let diagram = await scanControllerLayer(batch, openapiText, resolvedModel, token);

    stream.markdown(`✅ Diagrama inicial generado (${countEndpoints(diagram)} endpoint(s))\n\n`);
    log(`[ExplainHandler] Batch ${i + 1} layer1 done — ${diagram.length} chars`);

    // ── Capa 2: Servicios ────────────────────────────────────────────────────
    const relevantServices = findRelevantServices(batch, services);
    if (relevantServices.length > 0 && !token.isCancellationRequested) {
      const svcLines = relevantServices.reduce((s, f) => s + f.content.split("\n").length, 0);
      const svcKb    = Math.round(relevantServices.reduce((s, f) => s + f.content.length, 0) / 1024 * 10) / 10;

      stream.markdown(
        `#### 🟡 Capa 2 — Servicios\n` +
        `📄 **${relevantServices.length}** archivo(s) · **${svcLines.toLocaleString()} líneas** · **${svcKb} KB**\n` +
        `📎 ${relevantServices.map((s) => `\`${s.name}\``).join(", ")}\n\n`
      );
      stream.progress(`Lote ${i + 1} — Capa 2: enriqueciendo con servicios…`);

      diagram = await enrichWithLayer(diagram, "SERVICIOS", relevantServices,
        `- Añade los nombres exactos de métodos del servicio en cada llamada\n` +
        `- Muestra lógica de negocio: validaciones, cálculos, transformaciones\n` +
        `- Si hay orquestación entre servicios, muéstrala con las llamadas exactas\n` +
        `- Añade alt/else para validaciones de negocio y manejo de errores del servicio\n` +
        `- Actualiza DESCRIPCION, PARAMETROS, RESPUESTA y FLUJO con lo que encontraste`,
        resolvedModel, token);

      stream.markdown(`✅ Diagrama actualizado con lógica de servicios\n\n`);
      log(`[ExplainHandler] Batch ${i + 1} layer2 done — ${diagram.length} chars`);
    } else if (relevantServices.length === 0) {
      stream.markdown(`#### 🟡 Capa 2 — Servicios\n⚠️ No se encontraron servicios referenciados por estos controladores\n\n`);
    }

    // ── Capa 3: Repositorios / Gateways ──────────────────────────────────────
    const relevantRepositories = findRelevantRepositories(relevantServices, repositories);
    if (relevantRepositories.length > 0 && !token.isCancellationRequested) {
      const repoLines = relevantRepositories.reduce((s, f) => s + f.content.split("\n").length, 0);
      const repoKb    = Math.round(relevantRepositories.reduce((s, f) => s + f.content.length, 0) / 1024 * 10) / 10;

      stream.markdown(
        `#### 🟠 Capa 3 — Repositorios / Gateways / DAOs\n` +
        `📄 **${relevantRepositories.length}** archivo(s) · **${repoLines.toLocaleString()} líneas** · **${repoKb} KB**\n` +
        `📎 ${relevantRepositories.map((r) => `\`${r.name}\``).join(", ")}\n\n`
      );
      stream.progress(`Lote ${i + 1} — Capa 3: enriqueciendo con repositorios…`);

      diagram = await enrichWithLayer(diagram, "REPOSITORIOS / GATEWAYS / DAOs", relevantRepositories,
        `- Añade las llamadas exactas al repositorio (findById, save, findAll, deleteById, etc.)\n` +
        `- Si hay queries personalizadas (@Query, JPQL, SQL nativo), mencionarlas como nota\n` +
        `- Muestra llamadas a APIs externas via gateway con el endpoint/método HTTP exacto\n` +
        `- Añade el participante DB, ExternalAPI o ambos si corresponde\n` +
        `- Muestra manejo de Optional, excepciones de BD (EntityNotFoundException, etc.)`,
        resolvedModel, token);

      stream.markdown(`✅ Diagrama actualizado con acceso a datos\n\n`);
      log(`[ExplainHandler] Batch ${i + 1} layer3 done — ${diagram.length} chars`);
    } else if (relevantRepositories.length === 0) {
      stream.markdown(`#### 🟠 Capa 3 — Repositorios\n⚠️ No se encontraron repositorios referenciados\n\n`);
    }

    // ── Capa 4: Infraestructura (Redis / Eventos / Async) ────────────────────
    const relevantInfrastructure = findRelevantInfrastructure(relevantServices, relevantRepositories, infrastructure);
    if (relevantInfrastructure.length > 0 && !token.isCancellationRequested) {
      const infraLines = relevantInfrastructure.reduce((s, f) => s + f.content.split("\n").length, 0);
      const infraKb    = Math.round(relevantInfrastructure.reduce((s, f) => s + f.content.length, 0) / 1024 * 10) / 10;
      const dedicated  = relevantInfrastructure.filter((f) => !f.name.includes("[inline:"));
      const inline     = relevantInfrastructure.filter((f) => f.name.includes("[inline:"));

      stream.markdown(
        `#### 🔴 Capa 4 — Infraestructura (Redis / Eventos / Async)\n` +
        `📄 **${relevantInfrastructure.length}** fuente(s) · **${infraLines.toLocaleString()} líneas** · **${infraKb} KB**\n` +
        (dedicated.length > 0 ? `📎 Archivos dedicados: ${dedicated.map((f) => `\`${shortName(f.relPath)}\``).join(", ")}\n` : "") +
        (inline.length > 0   ? `🔍 Uso inline detectado en: ${inline.map((f) => `\`${shortName(f.relPath)}\``).join(", ")}\n` : "") +
        `\n`
      );
      stream.progress(`Lote ${i + 1} — Capa 4: enriqueciendo con infraestructura…`);

      diagram = await enrichWithLayer(diagram, "INFRAESTRUCTURA (Redis, Eventos, Async, Clientes REST)", relevantInfrastructure,
        `- Redis/Cache: añade alt { cache hit → retornar } else { miss → consultar DB → set cache }\n` +
        `  Usa participant Redis. Muestra el método exacto (get, set, delete, expire)\n` +
        `- Eventos/Kafka/RabbitMQ: usa ->-) para publish fire-and-forget. Añade participant Kafka/EventBus\n` +
        `  Muestra el nombre del evento y el topic/exchange\n` +
        `- @Async / CompletableFuture: marca la llamada con Note right of X: @Async\n` +
        `- Clientes REST externos: añade participant ExternalAPI. Muestra el método HTTP y la URL\n` +
        `- @Transactional: añade Note over Service,DB: @Transactional al inicio del flujo\n` +
        `- Si hay listeners/consumers (@KafkaListener, @EventListener): muéstralos como participantes separados`,
        resolvedModel, token);

      stream.markdown(`✅ Diagrama final con infraestructura completa\n\n`);
      log(`[ExplainHandler] Batch ${i + 1} layer4 done — ${diagram.length} chars`);
    } else {
      stream.markdown(`#### 🔴 Capa 4 — Infraestructura\n⚠️ No se detectó infraestructura dedicada (Redis/Eventos/Async) para este lote\n\n`);
    }

    // ── Capa 5: Archivos no clasificados ─────────────────────────────────────
    const coveredPaths = new Set<string>([
      ...batch.map((c) => c.uri.path),
      ...relevantServices.map((f) => f.uri.path),
      ...relevantRepositories.map((f) => f.uri.path),
      ...relevantInfrastructure.filter((f) => !f.name.includes("[inline:")).map((f) => f.uri.path),
    ]);

    const relevantUncovered = findUncoveredFiles(
      batch,
      [...relevantServices, ...relevantRepositories],
      allSourceFiles,
      coveredPaths
    );

    if (relevantUncovered.length > 0 && !token.isCancellationRequested) {
      const uncovLines = relevantUncovered.reduce((s, f) => s + f.content.split("\n").length, 0);
      const uncovKb    = Math.round(relevantUncovered.reduce((s, f) => s + f.content.length, 0) / 1024 * 10) / 10;

      stream.markdown(
        `#### ⚪ Capa 5 — Archivos no clasificados\n` +
        `📄 **${relevantUncovered.length}** archivo(s) · **${uncovLines.toLocaleString()} líneas** · **${uncovKb} KB**\n` +
        `📎 ${relevantUncovered.map((f) => `\`${shortName(f.relPath)}\``).join(", ")}\n\n`
      );
      stream.progress(`Lote ${i + 1} — Capa 5: escaneando archivos no clasificados…`);

      diagram = await enrichWithLayer(diagram, "ARCHIVOS NO CLASIFICADOS (helpers, validators, exception handlers, config, etc.)", relevantUncovered,
        `- Si es un @ControllerAdvice o ExceptionHandler: añade los bloques alt/else de error que falten en los endpoints\n` +
        `- Si es un validator, converter o mapper: incorpóralo como paso intermedio en el flujo donde se llame\n` +
        `- Si es un helper o util: muéstralo solo si hay una llamada directa desde un participante ya en el diagrama\n` +
        `- Si es una clase de configuración (Security, CORS, etc.): añade Note sobre el controller si afecta el flujo\n` +
        `- Si es un filter, interceptor o middleware: colócalo antes del controller en el flujo HTTP\n` +
        `- Si no encuentras conexión directa con ningún endpoint del diagrama: omítelo (no inventes llamadas)\n` +
        `- No duplica participantes ya existentes — usa el alias exacto del diagrama actual`,
        resolvedModel, token);

      stream.markdown(`✅ Diagrama completado con componentes de soporte\n\n`);
      log(`[ExplainHandler] Batch ${i + 1} layer5 done — ${diagram.length} chars`);
    } else {
      stream.markdown(`#### ⚪ Capa 5 — Archivos no clasificados\n✅ No se encontraron archivos adicionales referenciados por este lote\n\n`);
    }

    batchResults.push({ batchIndex: i, controllerNames: names, finalDiagram: diagram });
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

// ─── Capa 1: Controladores — diagrama inicial ─────────────────────────────────

async function scanControllerLayer(
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
    `Eres un arquitecto de software senior. Analiza los siguientes controladores` +
    (openapiText ? " y su contrato OpenAPI" : "") + `.\n\n` +

    `Para CADA endpoint genera DOS cosas:\n\n` +

    `**A — Documentación inicial:**\n` +
    `DESCRIPCION, PARAMETROS (nombre, tipo), RESPUESTA (qué retorna en éxito), FLUJO (2-3 líneas en prosa)\n\n` +

    `**B — Diagrama de secuencia Capa 1 (solo controladores):**\n` +
    `Muestra el flujo desde el cliente hasta donde el controller delega. Incluye:\n` +
    `- La llamada HTTP entrante con sus parámetros\n` +
    `- Las llamadas que el controller hace (método del servicio, si se ve en el código)\n` +
    `- Un alt para el error más obvio (validación, 404, etc.)\n` +
    `- Si hay filter/interceptor visible, inclúyelo\n\n` +

    `FORMATO OBLIGATORIO:\n\n` +
    `## CONTROLLER: NombreExactoDelControlador\n\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: descripción en una línea\n` +
    `PARAMETROS: param (tipo), param2 (tipo)\n` +
    `RESPUESTA: qué retorna\n` +
    `FLUJO: descripción en prosa\n\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  participant Client\n` +
    `  participant Controller as NombreController\n` +
    `  participant Service as NombreService\n` +
    `  Client->>Controller: METHOD /ruta\n` +
    `  Controller->>Service: metodo(args)\n` +
    `  ...\n` +
    "```\n\n" +

    `REGLAS MERMAID:\n` +
    `- \`->>\` llamadas síncronas | \`-->>\` respuestas | \`->)\` async fire-and-forget\n` +
    `- \`alt\`/\`else\`/\`end\` condicionales | \`opt\` flujos opcionales\n` +
    `- \`Note over X,Y: texto\` para anotaciones importantes\n` +
    `- Alias de participant deben coincidir exactamente con las flechas\n` +
    `- No inventes clases ni métodos\n\n` +

    `${controllerSection}\n\n${openapiSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Capas 2-4: enriquecer el diagrama con una capa nueva ─────────────────────

async function enrichWithLayer(
  currentDiagram: string,
  layerName: string,
  layerFiles: ServiceFile[],
  layerInstructions: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const filesSection = layerFiles
    .map((f) => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un arquitecto de software senior.\n\n` +
    `Tienes el diagrama de secuencia ACTUAL (generado en la capa anterior) y ahora tienes las implementaciones\n` +
    `de la capa: **${layerName}**.\n\n` +

    `Tu tarea es ACTUALIZAR el diagrama incorporando el código de esta nueva capa. Debes:\n` +
    `${layerInstructions}\n\n` +

    `IMPORTANTE:\n` +
    `- El diagrama resultante REEMPLAZA al anterior — debe ser completo, no solo el delta\n` +
    `- Mantén todo lo que ya estaba correcto y añade/corrige con lo que encuentres en el código\n` +
    `- Actualiza también DESCRIPCION, PARAMETROS, RESPUESTA y FLUJO si encontraste más detalle\n` +
    `- Si no encuentras nada relevante en esta capa para un endpoint, devuelve ese endpoint sin cambios\n\n` +

    `MISMO FORMATO DE SALIDA OBLIGATORIO:\n\n` +
    `## CONTROLLER: NombreExactoDelControlador\n\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: ...\n` +
    `PARAMETROS: ...\n` +
    `RESPUESTA: ...\n` +
    `FLUJO: ...\n\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  ...\n` +
    "```\n\n" +

    `REGLAS MERMAID:\n` +
    `- \`->>\` llamadas síncronas | \`-->>\` respuestas | \`->)\` async fire-and-forget\n` +
    `- \`alt\`/\`else\`/\`end\` condicionales | \`opt\` flujos opcionales\n` +
    `- \`Note over X,Y: texto\` para @Transactional, async, retry, etc.\n` +
    `- Agrega participant para cada nueva capa descubierta (Redis, Kafka, DB, ExternalAPI, etc.)\n` +
    `- Alias de participant deben coincidir EXACTAMENTE con las flechas\n` +
    `- No inventes clases ni métodos que no estén en el código\n\n` +

    `--- DIAGRAMA ACTUAL (capa anterior) ---\n${currentDiagram}\n\n` +
    `--- IMPLEMENTACIONES DE ${layerName} ---\n${filesSection}`
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
    `> Cada endpoint incluye: documentación + diagrama de secuencia detallado por capas.`,
    ``,
    `---`,
    ``,
  ];

  for (const result of results) {
    const content = result.finalDiagram;
    if (!content.trim()) { continue; }

    // Normalize: ensure metadata fields (PARAMETROS, RESPUESTA, FLUJO) render
    // as bold key-value pairs instead of bare text lines
    const normalized = content
      .replace(/^PARAMETROS:/gm,  "**Parámetros:**")
      .replace(/^RESPUESTA:/gm,   "**Respuesta:**")
      .replace(/^FLUJO:/gm,       "**Flujo:**")
      .replace(/^DESCRIPCION:/gm, "**Descripción:**");

    parts.push(normalized.trim());
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  return parts.join("\n");
}

function countEndpoints(markdown: string): number {
  return (markdown.match(/^### ENDPOINT:/gm) ?? []).length;
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
    "**/*Controllers.*",
    "**/*Resource.*",
    "**/*Resources.*",
    "**/*Router.*",
    "**/*Routes.*",
    "**/*Endpoint.*",
    "**/*Endpoints.*",
    "**/*Api.*",
    "**/*REST.*",
    "**/*Rest.*",
  ];

  // Use higher limit per pattern to avoid missing files in large codebases
  const uris = await findFilesByPatterns(patterns, 300);
  const result: ControllerFile[] = [];

  for (const uri of uris) {
    if (!SRC_EXTENSIONS.includes(extOf(uri))) { continue; }
    try {
      const bytes      = await vscode.workspace.fs.readFile(uri);
      const full       = Buffer.from(bytes).toString("utf-8");
      const content    = full.slice(0, BATCH.MAX_CHARS_CONTROLLER);
      const lineCount  = full.split("\n").length;
      const charCount  = full.length;
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), content, lineCount, charCount });
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

async function findInfrastructure(): Promise<ServiceFile[]> {
  const patterns = [
    // REST clients (Feign, WebClient, RestTemplate wrappers)
    "**/*RestClient.*",
    "**/*FeignClient.*",
    "**/*WebClient.*",
    "**/*HttpClient.*",
    "**/*ApiClient.*",
    "**/*HttpAdapter.*",
    "**/*RestAdapter.*",
    "**/*ExternalClient.*",
    // Event producers / consumers / listeners
    "**/*Producer.*",
    "**/*Consumer.*",
    "**/*Listener.*",
    "**/*Publisher.*",
    "**/*EventHandler.*",
    "**/*EventBus.*",
    "**/*MessageSender.*",
    "**/*MessageHandler.*",
    "**/*Sender.*",
    "**/*Emitter.*",
    "**/*Dispatcher.*",
    // Redis / Cache
    "**/*Redis*.*",
    "**/*CacheManager.*",
    "**/*CacheService.*",
    "**/*CacheHelper.*",
    "**/*CacheAdapter.*",
    // Kafka/Rabbit/SQS/SNS wrappers
    "**/*Template.*",
    "**/*Queue.*",
    "**/*Topic.*",
    "**/*Worker.*",
    // Async / Scheduled
    "**/*AsyncService.*",
    "**/*AsyncHandler.*",
    "**/*AsyncTask.*",
    "**/*Scheduler.*",
    "**/*ScheduledTask.*",
    "**/*Job.*",
    "**/*Task.*",
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

  log(`[ExplainHandler] Found ${result.length} infrastructure files (clients/events/redis/async)`);
  return result;
}

async function findRepositories(): Promise<ServiceFile[]> {
  const patterns = [
    "**/*Repository.*",
    "**/*RepositoryImpl.*",
    "**/*Repo.*",
    "**/*RepoImpl.*",
    "**/*Gateway.*",
    "**/*GatewayImpl.*",
    "**/*Client.*",       // UserServiceClient, OrderClient, etc.
    "**/*Adapter.*",
    "**/*AdapterImpl.*",
    "**/*Dao.*",
    "**/*DaoImpl.*",
    "**/*Mapper.*",       // MyBatis / MapStruct mappers with DB operations
    "**/*Port.*",         // Hexagonal architecture output ports
    "**/*Persistence.*",  // PersistenceAdapter, UserPersistence
    "**/*Store.*",        // UserStore, TokenStore
    "**/*DataSource.*",   // Custom datasource wrappers
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

  log(`[ExplainHandler] Found ${result.length} repository/gateway/client files`);
  return result;
}

/**
 * Discovers ALL source files in the workspace by extension (not by name pattern).
 * Used as the pool for Capa 5 — any file not caught by layers 1-4 is a candidate.
 * Capped at MAX_FILES * 3 to avoid performance issues in large projects.
 */
async function findAllSourceFiles(): Promise<ServiceFile[]> {
  const patterns = SRC_EXTENSIONS.map((ext) => `**/*${ext}`);
  const uris = await findFilesByPatterns(patterns, BATCH.MAX_FILES * 3);
  const result: ServiceFile[] = [];

  for (const uri of uris) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, BATCH.MAX_CHARS_SERVICE);
      const name    = baseName(uri).replace(/\.[^.]+$/, "").toLowerCase();
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), name, content });
    } catch { /* skip */ }
  }

  log(`[ExplainHandler] Found ${result.length} total source files (Capa 5 pool)`);
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

async function findFilesByPatterns(patterns: string[], limitPerPattern = 200): Promise<vscode.Uri[]> {
  const all: vscode.Uri[] = [];
  for (const pattern of patterns) {
    try {
      const found = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, limitPerPattern);
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

/**
 * Strips common implementation/pattern suffixes so that "UserRepositoryImpl"
 * matches a service that injects "UserRepository", and "KafkaProducerAdapter"
 * matches a service that references "KafkaProducer".
 */
function stripImplSuffix(name: string): string {
  return name
    .replace(/(impl|default|base|abstract)$/, "")
    .replace(/(jpa|mongo|elastic|jdbc|hibernate|redis|memory|inmemory|inmemória)$/, "")
    .replace(/(adapter|dao|helper|wrapper|decorator|proxy|facade|delegate)$/, "");
}

/** Returns true if candidateName appears in combinedContent (full or stripped form). */
function isReferenced(candidateName: string, combinedContent: string): boolean {
  if (combinedContent.includes(candidateName)) { return true; }
  const stripped = stripImplSuffix(candidateName);
  return stripped.length >= 4 && stripped !== candidateName && combinedContent.includes(stripped);
}

// Infrastructure keywords that indicate direct (inline) usage in service/repo code
// without a dedicated wrapper class file.
const INLINE_INFRA_KEYWORDS: Array<{ keyword: string; label: string }> = [
  { keyword: "kafkatemplate",             label: "Kafka" },
  { keyword: "rabbittemplate",            label: "RabbitMQ" },
  { keyword: "@kafkalistener",            label: "Kafka" },
  { keyword: "redistemplate",             label: "Redis" },
  { keyword: "stringredistemplate",       label: "Redis" },
  { keyword: "reactiveredistemplate",     label: "Redis" },
  { keyword: "resttemplate",              label: "RestTemplate" },
  { keyword: "webclient.",                label: "WebClient" },
  { keyword: "sqsclient",                 label: "SQS" },
  { keyword: "snsclient",                 label: "SNS" },
  { keyword: "s3client",                  label: "S3" },
  { keyword: "applicationeventpublisher", label: "SpringEvents" },
  { keyword: "@eventlistener",            label: "SpringEvents" },
  { keyword: "@async",                    label: "Async" },
  { keyword: "completablefuture",         label: "Async" },
  { keyword: "executorservice",           label: "Async" },
  { keyword: "@scheduled",                label: "Scheduler" },
  { keyword: "messagingtemplate",         label: "Messaging" },
  { keyword: "streambridge",              label: "SpringCloud" },
];

/**
 * For services/repos that directly use infrastructure primitives (KafkaTemplate,
 * RedisTemplate, etc.) without a dedicated wrapper class, synthesizes a hint
 * ServiceFile containing only the relevant lines. This ensures layer 4 still
 * runs even when there are no dedicated infra files.
 */
function extractInlineInfraHints(files: ServiceFile[]): ServiceFile[] {
  const hints: ServiceFile[] = [];

  for (const file of files) {
    const lower = file.content.toLowerCase();
    const matched = INLINE_INFRA_KEYWORDS.filter(({ keyword }) => lower.includes(keyword));
    if (matched.length === 0) { continue; }

    const labels = [...new Set(matched.map(({ label }) => label))];
    const relevantLines = file.content
      .split("\n")
      .filter((line) => matched.some(({ keyword }) => line.toLowerCase().includes(keyword)))
      .slice(0, 50)
      .join("\n");

    if (!relevantLines.trim()) { continue; }

    hints.push({
      uri:     file.uri,
      relPath: file.relPath,
      name:    `${file.name}[inline:${labels.join("+")}]`,
      content: `// Uso inline de infraestructura en: ${file.relPath}\n// Tecnologías detectadas: ${labels.join(", ")}\n\n${relevantLines}`,
    });
  }

  return hints;
}

/**
 * Finds source files not covered by layers 1-4 that are still referenced by the
 * current batch. Searches through controller + already-matched layer content so
 * transitively-used helpers (validators, converters, exception handlers, etc.)
 * are also picked up. Capped at 15 files to avoid context explosion.
 */
function findUncoveredFiles(
  batch: ControllerFile[],
  coveredLayerFiles: ServiceFile[],
  allSourceFiles: ServiceFile[],
  coveredPaths: Set<string>,
  maxFiles = 15
): ServiceFile[] {
  const uncovered = allSourceFiles.filter((f) => !coveredPaths.has(f.uri.path));

  // Search in the content of all already-processed files for this batch
  const searchContent = [
    ...batch.map((c) => c.content),
    ...coveredLayerFiles.map((f) => f.content),
  ].join("\n").toLowerCase();

  return uncovered
    .filter((f) => isReferenced(f.name, searchContent))
    .slice(0, maxFiles);
}

function findRelevantServices(batch: ControllerFile[], services: ServiceFile[]): ServiceFile[] {
  const combined = batch.map((c) => c.content).join("\n").toLowerCase();
  return services.filter((s) => isReferenced(s.name, combined));
}

function findRelevantRepositories(services: ServiceFile[], repositories: ServiceFile[]): ServiceFile[] {
  const combined = services.map((s) => s.content).join("\n").toLowerCase();
  return repositories.filter((r) => isReferenced(r.name, combined));
}

function findRelevantInfrastructure(
  services: ServiceFile[],
  repositories: ServiceFile[],
  infrastructure: ServiceFile[]
): ServiceFile[] {
  const combined = [...services, ...repositories].map((f) => f.content).join("\n").toLowerCase();
  const fromFiles = infrastructure.filter((i) => isReferenced(i.name, combined));

  // Also collect inline usage hints from services/repos that use infra primitives directly
  const inlineHints = extractInlineInfraHints([...services, ...repositories]);

  // Merge: avoid duplicating hints for files already covered by a dedicated infra file
  const coveredPaths = new Set(fromFiles.map((f) => f.uri.path));
  const newHints = inlineHints.filter((h) => !coveredPaths.has(h.uri.path));

  return [...fromFiles, ...newHints];
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

