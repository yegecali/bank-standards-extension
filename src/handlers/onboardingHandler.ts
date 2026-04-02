import * as vscode from "vscode";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../knowledge/parser";
import { JiraClient, getConfiguredProjects } from "../jira/client";
import { resolveModel } from "../utils/modelResolver";

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleOnboardingCommand(
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  log("[Onboarding] Starting onboarding flow");

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Welcome ────────────────────────────────────────────────────────────────
  stream.markdown(
    `# 👋 Bienvenido al equipo\n\n` +
    `Esta guía te llevará paso a paso por todo lo que necesitas para tu primer día.\n\n` +
    `## Checklist\n\n` +
    `- [ ] **Paso 1** — Estándares de desarrollo\n` +
    `- [ ] **Paso 2** — Arquitectura del proyecto\n` +
    `- [ ] **Paso 3** — Setup del ambiente local\n` +
    `- [ ] **Paso 4** — Tu primera tarea en Jira\n\n` +
    `---\n\n`
  );

  // ── Step 1: Standards ──────────────────────────────────────────────────────
  stream.markdown(`## ✅ Paso 1 — Estándares de desarrollo\n\n`);
  stream.progress("Cargando estándares desde la base de conocimiento…");
  await loadStandardsStep(resolvedModel, stream, token);

  // ── Step 2: Architecture ───────────────────────────────────────────────────
  stream.markdown(`\n---\n\n## ✅ Paso 2 — Arquitectura del proyecto\n\n`);
  stream.progress("Analizando la arquitectura del proyecto…");
  await loadArchitectureStep(resolvedModel, stream, token);

  // ── Step 3: Local setup ────────────────────────────────────────────────────
  stream.markdown(`\n---\n\n## ✅ Paso 3 — Setup del ambiente local\n\n`);
  stream.progress("Leyendo configuración del proyecto…");
  await loadSetupStep(resolvedModel, stream, token);

  // ── Step 4: First Jira task ────────────────────────────────────────────────
  stream.markdown(`\n---\n\n## ✅ Paso 4 — Tu primera tarea en Jira\n\n`);
  stream.progress("Consultando Jira…");
  await loadFirstTaskStep(stream);

  // ── Done ───────────────────────────────────────────────────────────────────
  stream.markdown(
    `\n---\n\n` +
    `## 🎉 ¡Listo para empezar!\n\n` +
    `Tienes todo lo que necesitas. Comandos útiles para el día a día:\n\n` +
    `| Comando | Cuándo usarlo |\n|---|---|\n` +
    `| \`@company /review\` | Antes de hacer commit, para validar tu código |\n` +
    `| \`@company /generate-test\` | Para generar tests del archivo que estás editando |\n` +
    `| \`@company /docs\` | Para documentar métodos y clases |\n` +
    `| \`@company /jira\` | Para ver tus issues asignadas |\n` +
    `| \`@company /project <acción>\` | Para agregar componentes al proyecto |\n\n` +
    `> Si tienes dudas escribe cualquier pregunta a \`@company\` — estoy aquí para ayudarte.`
  );

  log("[Onboarding] Flow complete");
}

// ─── Step 1: Standards ────────────────────────────────────────────────────────

async function loadStandardsStep(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  let standardsContent = "";

  try {
    const config   = vscode.workspace.getConfiguration("companyStandards");
    const specialty = config.get<string>("specialty") ?? "backend";
    const specialtiesMap = config.get<Record<string, Record<string, string>>>("specialtiesMap") ?? {};
    const pagesMap       = config.get<Record<string, string>>("pagesMap") ?? {};

    const pageId =
      specialtiesMap[specialty]?.["standards"] ??
      pagesMap["standards"] ?? "";

    if (pageId) {
      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(pageId);
      standardsContent = blocksToMarkdown(page.blocks).slice(0, 6000);
      log(`[Onboarding] Standards page loaded: ${page.title}`);
    }
  } catch (err) {
    logError("[Onboarding] Could not load standards page", err);
  }

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un mentor de desarrollo de software explicando los estándares de la empresa a un developer que acaba de unirse al equipo. ` +
    `Tu objetivo es que entienda rápido las reglas más importantes. ` +
    `Sé amigable, claro y usa ejemplos de código cuando sea útil. Responde en español.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    standardsContent
      ? `Estos son los estándares de desarrollo de la empresa:\n\n${standardsContent}\n\n` +
        `Resume los puntos más importantes para un developer nuevo. ` +
        `Organízalos por categoría (naming, tests, documentación, etc.) con ejemplos concretos de ✅ correcto y ❌ incorrecto.`
      : `No hay página de estándares configurada. Explica brevemente las buenas prácticas generales de naming en Java/TypeScript ` +
        `(camelCase, PascalCase, UPPER_SNAKE) con ejemplos, y cómo configurar la extensión con su base de conocimiento.`
  );

  await streamLLM(model, [systemMsg, userMsg], stream, token, "[Onboarding/Standards]");
}

// ─── Step 2: Architecture ─────────────────────────────────────────────────────

async function loadArchitectureStep(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown(`_No hay workspace abierto. Abre el proyecto y ejecuta \`@company /onboarding\` de nuevo._\n`);
    return;
  }

  const root    = workspaceFolders[0].uri;
  const tree    = await buildFileTree(root, 3);
  const readmes = await readFiles(root, ["README.md", "readme.md", "ARCHITECTURE.md", "docs/architecture.md"]);

  // Also try to load architecture knowledge page
  let archKnowledge = "";
  try {
    const config         = vscode.workspace.getConfiguration("companyStandards");
    const specialty      = config.get<string>("specialty") ?? "backend";
    const specialtiesMap = config.get<Record<string, Record<string, string>>>("specialtiesMap") ?? {};
    const pagesMap       = config.get<Record<string, string>>("pagesMap") ?? {};
    const pageId         = specialtiesMap[specialty]?.["project"] ?? pagesMap["project"] ?? "";
    if (pageId) {
      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(pageId);
      archKnowledge  = blocksToMarkdown(page.blocks).slice(0, 3000);
    }
  } catch { /* optional */ }

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un senior developer explicando la arquitectura del proyecto a un nuevo compañero de equipo. ` +
    `Explica de forma clara y práctica: qué hace cada carpeta/módulo, cómo fluye una request, ` +
    `dónde está la lógica de negocio y cómo están separadas las capas. Responde en español.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    `Estructura del proyecto:\n\`\`\`\n${tree.join("\n")}\n\`\`\`` +
    (readmes ? `\n\nDocumentación del proyecto:\n${readmes}` : "") +
    (archKnowledge ? `\n\nEstandar de arquitectura de la empresa:\n${archKnowledge}` : "") +
    `\n\nExplica la arquitectura para un developer que llega hoy. ` +
    `Usa secciones: "¿Qué hace este proyecto?", "Estructura de carpetas", "Flujo de una petición", "Dónde empieza un developer".`
  );

  await streamLLM(model, [systemMsg, userMsg], stream, token, "[Onboarding/Architecture]");
}

// ─── Step 3: Local Setup ──────────────────────────────────────────────────────

async function loadSetupStep(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown(`_No hay workspace abierto._\n`);
    return;
  }

  const root    = workspaceFolders[0].uri;
  const content = await readFiles(root, [
    "pom.xml",
    "package.json",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".env.example",
    ".env.template",
    "Makefile",
    "README.md",
    "CONTRIBUTING.md",
  ]);

  if (!content) {
    stream.markdown(`_No encontré archivos de configuración (pom.xml, docker-compose, etc.)._\n`);
    return;
  }

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un DevOps engineer ayudando a un nuevo developer a levantar el ambiente local. ` +
    `Sé muy específico: comandos exactos, orden correcto, qué variables de entorno son obligatorias. ` +
    `Si falta información, indica qué le debe preguntar al equipo. Responde en español.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    `Archivos de configuración del proyecto:\n\n${content}\n\n` +
    `Genera una guía de setup local paso a paso con:\n` +
    `1. **Prerequisitos** (versiones de Java/Node/Docker necesarias)\n` +
    `2. **Variables de entorno** (cuáles configurar y ejemplos de valores)\n` +
    `3. **Cómo levantar el proyecto** (comandos exactos)\n` +
    `4. **Cómo correr los tests**\n` +
    `5. **Cómo verificar que todo funciona** (URLs, endpoints de healthcheck, logs esperados)`
  );

  await streamLLM(model, [systemMsg, userMsg], stream, token, "[Onboarding/Setup]");
}

// ─── Step 4: First Jira task ──────────────────────────────────────────────────

async function loadFirstTaskStep(stream: vscode.ChatResponseStream): Promise<void> {
  const config    = vscode.workspace.getConfiguration("companyStandards");
  const jiraUrl   = config.get<string>("jiraUrl") ?? "";
  const jiraEmail = config.get<string>("jiraEmail") ?? "";
  const jiraToken = config.get<string>("jiraToken") ?? "";

  if (!jiraUrl || !jiraEmail || !jiraToken) {
    stream.markdown(
      `_Jira no está configurado. Pídele al tech lead que te agregue al proyecto y configura:\n\n` +
      "```json\n" +
      `"companyStandards.jiraUrl":   "https://tuempresa.atlassian.net",\n` +
      `"companyStandards.jiraEmail": "tu@email.com",\n` +
      `"companyStandards.jiraToken": "tu-api-token"\n` +
      "```\n_"
    );
    return;
  }

  try {
    const client   = new JiraClient();
    const projects = getConfiguredProjects();

    // Search for issues assigned to current user
    const jql      = projects.length > 0
      ? `assignee = currentUser() AND project in (${projects.map((p) => `"${p}"`).join(",")}) AND status != Done ORDER BY priority DESC`
      : `assignee = currentUser() AND status != Done ORDER BY priority DESC`;

    const issues = await client.searchByJql(jql, 5);

    if (issues.length === 0) {
      stream.markdown(
        `No tienes issues asignadas todavía — es normal el primer día.\n\n` +
        `**Próximos pasos:**\n` +
        `1. Habla con tu tech lead para que te asigne tu primera tarea\n` +
        `2. Úsarás \`@company /jira\` para ver tus issues cuando las tengas\n` +
        `3. Cuando tengas una issue, usa \`@company /jira create PROJ-123\` para crear subtareas\n`
      );
      return;
    }

    stream.markdown(
      `Tienes **${issues.length} issue(s)** asignada(s). Por aquí puedes empezar:\n\n` +
      `| Clave | Resumen | Estado | Tiempo |\n|---|---|---|---|\n`
    );

    for (const issue of issues) {
      const time = issue.timeInProgress ? `⏳ ${issue.timeInProgress}` : "—";
      const words = issue.summary.split(" ").slice(0, 10).join(" ");
      const summary = issue.summary.split(" ").length > 10 ? `${words}…` : words;
      stream.markdown(`| **${issue.key}** | ${summary} | ${issue.status} | ${time} |\n`);
    }

    stream.markdown(
      `\n**¿Cómo empezar con una issue?**\n\n` +
      `1. Escribe \`@company /jira ${issues[0].key}\` para ver el detalle completo\n` +
      `2. Usa \`@company /jira create ${issues[0].key}\` para crear una subtarea\n` +
      `3. Cuando termines, usa \`@company /commit\` para generar el mensaje de commit\n`
    );
  } catch (err) {
    logError("[Onboarding] Jira error", err);
    stream.markdown(`_No pude conectar con Jira: ${err instanceof Error ? err.message : String(err)}_\n`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function streamLLM(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  logPrefix: string
): Promise<void> {
  try {
    const response = await model.sendRequest(messages, {}, token);
    let count = 0;
    for await (const chunk of response.text) {
      stream.markdown(chunk);
      count++;
    }
    log(`${logPrefix} LLM complete — ${count} chunks`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`${logPrefix} LanguageModelError: ${err.code}`, err);
      stream.markdown(`\n_⚠️ Error del modelo: ${err.message}_\n`);
    } else {
      logError(`${logPrefix} Unexpected error`, err);
    }
  }
}

async function readFiles(root: vscode.Uri, paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of paths) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
      const content = Buffer.from(bytes).toString("utf-8").slice(0, 4000);
      parts.push(`### \`${rel}\`\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* file not found */ }
  }
  return parts.join("\n\n");
}

async function buildFileTree(dir: vscode.Uri, depth: number, prefix = ""): Promise<string[]> {
  const IGNORE = new Set(["node_modules", ".git", "target", "build", "dist", "out", ".idea", ".vscode", "__pycache__"]);
  if (depth < 0) { return []; }
  const entries = await vscode.workspace.fs.readDirectory(dir);
  const lines: string[] = [];
  for (const [name, type] of entries) {
    if (IGNORE.has(name)) { continue; }
    lines.push(`${prefix}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}`);
    if (type === vscode.FileType.Directory && depth > 0) {
      const sub = await buildFileTree(vscode.Uri.joinPath(dir, name), depth - 1, prefix + "  ");
      lines.push(...sub);
    }
  }
  return lines;
}

