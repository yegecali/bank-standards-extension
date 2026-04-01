import * as vscode from "vscode";
import { log, logError } from "../logger";
import { BATCH, EXCLUDE_GLOB, SRC_EXTENSIONS } from "../config/defaults";
import { resolveModel } from "../utils/modelResolver";

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

  const [controllers, services, repositories, infrastructure, openapiText] = await Promise.all([
    findControllers(),
    findServices(),
    findRepositories(),
    findInfrastructure(),
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
    `| Repos/Gateways/Clientes | **${repositories.length}** |\n` +
    `| Infraestructura (Redis/Eventos/Async) | **${infrastructure.length}** |\n` +
    `| Lotes | **${batches.length}** (${BATCH.CONTROLLERS_PER_BATCH} controladores c/u) |\n` +
    `| OpenAPI | ${openapiText ? "✅ encontrado" : "⚠️ no encontrado"} |\n\n` +
    `Se procesará en **2 iteraciones** para maximizar la calidad del diagrama.\n\n`
  );

  log(`[ExplainHandler] ${controllers.length} controllers, ${services.length} services, ${repositories.length} repos/gateways, ${infrastructure.length} infra, ${batches.length} batches`);

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
    // Find repositories/gateways/clients referenced by those services
    const relevantRepositories = findRelevantRepositories(relevantServices, repositories);
    // Find infrastructure (Redis, events, async, REST clients) referenced anywhere in the chain
    const relevantInfrastructure = findRelevantInfrastructure(relevantServices, relevantRepositories, infrastructure);
    const refined = await refineDiagrams(batch, relevantServices, relevantRepositories, relevantInfrastructure, result.rawDiagrams, resolvedModel, token);
    result.refinedDiagrams = refined;

    stream.markdown(`- ✅ Lote ${i + 1} refinado (${relevantServices.length} svc, ${relevantRepositories.length} repo, ${relevantInfrastructure.length} infra)\n`);
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
    `Eres un arquitecto de software senior. Analiza los siguientes controladores` +
    (openapiText ? " y su contrato OpenAPI" : "") + `.\n\n` +

    `Para CADA endpoint que encuentres realiza DOS cosas:\n\n` +

    `**PARTE A — Documentación del endpoint:**\n` +
    `Describe con precisión qué hace el endpoint, sus parámetros, respuesta y flujo en prosa.\n\n` +

    `**PARTE B — Diagrama de secuencia boceto (capa por capa):**\n` +
    `Genera un diagrama Mermaid que muestre las capas en orden estricto:\n` +
    `  Client → Controller → Service → Repository/Gateway → DB\n` +
    `  Si el código usa Redis (@Cacheable, RedisTemplate): añade participant Redis\n` +
    `  Si el código publica eventos (KafkaTemplate, ApplicationEventPublisher): añade participant Kafka/EventBus\n` +
    `  Si el código llama a APIs externas (Feign, RestTemplate, WebClient): añade participant ExternalAPI\n` +
    `  Si hay métodos @Async o CompletableFuture: usa ->-) y nota "async"\n` +
    `Usa los nombres reales de clases y métodos que veas en el código.\n` +
    `En este boceto incluye el flujo principal (happy path) y un alt para el error más obvio.\n\n` +

    `FORMATO DE SALIDA OBLIGATORIO — usa exactamente estos marcadores:\n\n` +
    `## CONTROLLER: NombreExactoDelControlador\n\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: qué hace este endpoint en una línea\n` +
    `PARAMETROS: param1 (tipo) — descripción, param2 (tipo) — descripción\n` +
    `RESPUESTA: qué retorna en éxito y en error\n` +
    `FLUJO: descripción en prosa del flujo de ejecución en 2-3 líneas\n\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  participant Client\n` +
    `  participant Controller as NombreController\n` +
    `  participant Service as NombreService\n` +
    `  participant Repository as NombreRepo\n` +
    `  participant DB\n` +
    `  Client->>Controller: METHOD /ruta (params)\n` +
    `  Controller->>Service: metodoExacto(args)\n` +
    `  ...\n` +
    "```\n\n" +

    `REGLAS MERMAID OBLIGATORIAS:\n` +
    `- Usa \`->>\` para llamadas síncronas (NO ->>>)\n` +
    `- Usa \`-->>\` para respuestas (NO -->>>)\n` +
    `- Usa \`alt\`/\`else\`/\`end\` para condicionales\n` +
    `- Usa \`opt\` para flujos opcionales\n` +
    `- Los nombres de participant deben coincidir exactamente con los alias declarados\n` +
    `- No inventes clases ni métodos que no estén en el código\n\n` +

    `${controllerSection}\n\n${openapiSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Iteration 2: refine with service implementations ────────────────────────

async function refineDiagrams(
  batch: ControllerFile[],
  relevantServices: ServiceFile[],
  relevantRepositories: ServiceFile[],
  relevantInfrastructure: ServiceFile[],
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

  const repositorySection = relevantRepositories.length > 0
    ? relevantRepositories
        .map((r) => `### ${r.name}\n\`\`\`\n${r.content}\n\`\`\``)
        .join("\n\n")
    : "_No se encontraron implementaciones de repositorios/gateways._";

  const infrastructureSection = relevantInfrastructure.length > 0
    ? relevantInfrastructure
        .map((i) => `### ${i.name}\n\`\`\`\n${i.content}\n\`\`\``)
        .join("\n\n")
    : "_No se encontraron archivos de infraestructura dedicados. Detecta Redis/eventos/async por anotaciones en el código._";

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un arquitecto de software senior. Tienes el boceto de diagramas de secuencia de la iteración 1\n` +
    `y ahora también las implementaciones reales de servicios, repositorios, gateways y clientes.\n\n` +

    `Tu tarea es producir la versión DEFINITIVA y DETALLADA de cada diagrama. Para cada endpoint:\n\n` +

    `1. **Contrasta el boceto con el código real** — identifica qué falta, qué está mal nombrado o qué capas no aparecen.\n` +
    `2. **Expande capa por capa** en orden estricto:\n` +
    `   Client → Controller → (Filter/Interceptor si existe) → Service → (orquestación entre Services)\n` +
    `   → Repository/Gateway/DAO → DB\n` +
    `   → REST Client externo (Feign/@FeignClient, RestTemplate, WebClient, axios, fetch) → API Externa\n` +
    `   → Event Producer → Cola/Bus (Kafka, RabbitMQ, SQS, Spring Events)\n` +
    `   → Cache (RedisTemplate, @Cacheable, StringRedisTemplate, Jedis, Lettuce)\n` +
    `3. **Incluye interacciones con beans y configuración**:\n` +
    `   - Beans inyectados: nombre exacto de clase (Mapper, Validator, Converter, Builder)\n` +
    `   - Cache: alt { hit → retornar del cache } else { miss → consultar DB → guardar en cache }\n` +
    `   - Transacciones (@Transactional, @Transactional(readOnly)): Note over Service: @Transactional\n` +
    `   - Configuración relevante (@Value, @ConfigurationProperties) si afecta el flujo\n` +
    `4. **Llamadas asíncronas y eventos** — usa flechas especiales:\n` +
    `   - Llamada async (@Async, CompletableFuture, Mono/Flux): usa \`-->>\` con Note "async"\n` +
    `   - Fire-and-forget (publish evento, send Kafka sin esperar respuesta): usa \`->)\` \n` +
    `   - Consumidor de evento (@KafkaListener, @RabbitListener, @EventListener): nuevo participante\n` +
    `   - Si hay reactive (Mono/Flux): muestra el subscribe y el onNext/onError\n` +
    `5. **Flujos condicionales y excepciones**:\n` +
    `   - alt éxito / else error para validaciones y casos de negocio\n` +
    `   - Manejo de excepciones: qué lanza el servicio, cómo lo captura el controller\n` +
    `   - opt para flujos opcionales (auditoría, notificaciones, eventos secundarios)\n` +
    `6. **Usa los nombres exactos** de clases y métodos del código (no nombres genéricos).\n\n` +

    `MISMO FORMATO DE SALIDA OBLIGATORIO:\n\n` +
    `## CONTROLLER: NombreExactoDelControlador\n\n` +
    `### ENDPOINT: METHOD /ruta/exacta\n` +
    `DESCRIPCION: qué hace este endpoint en una línea\n` +
    `PARAMETROS: igual que iteración 1 (actualiza si encontraste más detalle)\n` +
    `RESPUESTA: igual que iteración 1\n` +
    `FLUJO: descripción en prosa actualizada con los detalles encontrados en el código\n\n` +
    "```mermaid\n" +
    `sequenceDiagram\n` +
    `  participant Client\n` +
    `  participant Controller as NombreController\n` +
    `  participant Service as NombreService\n` +
    `  participant Repository as NombreRepo\n` +
    `  participant DB\n` +
    `  ...\n` +
    "```\n\n" +

    `REGLAS MERMAID OBLIGATORIAS:\n` +
    `- \`->>\`  llamada síncrona (NO ->>>)\n` +
    `- \`-->>\` respuesta síncrona (NO -->>>)\n` +
    `- \`->)\`  mensaje async fire-and-forget (publicar evento, enviar a Kafka sin esperar)\n` +
    `- \`alt\`/\`else\`/\`end\`  condicionales\n` +
    `- \`opt\`  flujos opcionales\n` +
    `- \`Note over X,Y: texto\`  para @Transactional, async, retry, etc.\n` +
    `- Los alias de participant deben coincidir EXACTAMENTE con los usados en las flechas\n` +
    `- Agrega participantes para cada capa descubierta: Redis, Kafka, ExternalAPI, EventBus, etc.\n` +
    `- No inventes clases ni métodos que no estén en el código\n\n` +

    `--- BOCETOS ITERACIÓN 1 ---\n${previousDiagrams}\n\n` +
    `--- CONTROLADORES ---\n${controllerSection}\n\n` +
    `--- SERVICIOS ---\n${serviceSection}\n\n` +
    `--- REPOSITORIOS / GATEWAYS / CLIENTES REST ---\n${repositorySection}\n\n` +
    `--- INFRAESTRUCTURA (Redis, Eventos, Async, Producers, Consumers, Listeners) ---\n${infrastructureSection}`
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
    // Prefer refined (iteration 2); fall back to raw (iteration 1)
    const content = result.refinedDiagrams || result.rawDiagrams;
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

async function findInfrastructure(): Promise<ServiceFile[]> {
  const patterns = [
    // REST clients (Feign, RestTemplate wrappers, WebClient wrappers)
    "**/*RestClient.*",
    "**/*FeignClient.*",
    "**/*WebClient.*",
    "**/*HttpClient.*",
    "**/*ApiClient.*",
    // Event producers / consumers / listeners
    "**/*Producer.*",
    "**/*Consumer.*",
    "**/*Listener.*",
    "**/*Publisher.*",
    "**/*EventHandler.*",
    "**/*EventBus.*",
    "**/*MessageSender.*",
    "**/*MessageHandler.*",
    // Redis / Cache
    "**/*Redis*.*",
    "**/*CacheManager.*",
    "**/*CacheService.*",
    "**/*CacheHelper.*",
    // Async services
    "**/*AsyncService.*",
    "**/*AsyncHandler.*",
    "**/*AsyncTask.*",
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
    "**/*Gateway.*",
    "**/*GatewayImpl.*",
    "**/*Client.*",
    "**/*Adapter.*",
    "**/*Dao.*",
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

function findRelevantRepositories(services: ServiceFile[], repositories: ServiceFile[]): ServiceFile[] {
  const combined = services.map((s) => s.content).join("\n").toLowerCase();
  return repositories.filter((r) => combined.includes(r.name));
}

function findRelevantInfrastructure(
  services: ServiceFile[],
  repositories: ServiceFile[],
  infrastructure: ServiceFile[]
): ServiceFile[] {
  const combined = [...services, ...repositories].map((f) => f.content).join("\n").toLowerCase();
  return infrastructure.filter((i) => combined.includes(i.name));
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

