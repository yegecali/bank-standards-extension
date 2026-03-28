import * as vscode from "vscode";
import { renderPrompt } from "@vscode/prompt-tsx";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { parsePromptLibrary, blocksToMarkdown } from "../notion/parser";
import { handlePromptsCommand } from "../handlers/promptLibraryHandler";
import { handleNewFeatureCommand } from "../handlers/newFeatureHandler";
import { handleJiraCommand } from "../handlers/jiraHandler";
import { handleProjectCommand } from "../handlers/projectActionHandler";
import { handleOnboardingCommand } from "../handlers/onboardingHandler";
import { handleSetupCommand } from "../handlers/setupHandler";
import { handleKbSearchCommand } from "../handlers/kbSearchHandler";
import { handleExplainCommand } from "../handlers/explainHandler";
import { handleDocumentCommand } from "../handlers/documentHandler";
import { handleSecurityCommand } from "../handlers/securityHandler";
import { handleCheckstyleCommand } from "../handlers/checkstyleHandler";
import { isCreateIntent, createProjectFromNotion } from "./projectCreator";
import { getStagedDiff } from "./gitHelper";
import { BankPrompt } from "./BankPrompt";
import {
  PageType,
  resolvePageId,
  getActiveSpecialty,
  setActiveSpecialty,
  listSpecialties,
  detectSpecialtyFromPrompt,
} from "./specialtyResolver";

const PARTICIPANT_ID = "companyStandards.agent";

interface ChatResultMetadata {
  intent: string;
  specialty?: string;
}

export function registerBankAgent(context: vscode.ExtensionContext): void {
  log(`[BankAgent] Creating chat participant — id: "${PARTICIPANT_ID}"`);

  let participant: vscode.ChatParticipant;
  try {
    participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, makeHandler(context));
    log(`[BankAgent] Chat participant created OK — id: "${PARTICIPANT_ID}"`);
  } catch (err: unknown) {
    logError(`[BankAgent] FAILED to create chat participant — id: "${PARTICIPANT_ID}"`, err);
    throw err;
  }

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "images", "bank-agent.svg");

  // ─── Follow-up suggestions ──────────────────────────────────────────────────
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      const intent = (result.metadata as ChatResultMetadata | undefined)?.intent;

      // Context-aware: suggest the most relevant next actions based on what was just done
      const all: vscode.ChatFollowup[] = [
        {
          prompt: "/create",
          label: "$(file-directory) Crear nuevo proyecto",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/generate-test",
          label: "$(beaker) Agregar tests al archivo activo",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/docs",
          label: "$(book) Agregar documentación",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/jira subtasks",
          label: "$(list-tree) Ver mis subtareas",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/review",
          label: "$(search) Revisar archivo activo",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/standards",
          label: "$(symbol-ruler) Ver estándares de nomenclatura",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/project",
          label: "$(gear) Acciones de proyecto",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/jira",
          label: "$(issue-opened) Ver issues en progreso",
          participant: PARTICIPANT_ID,
        },
      ];

      // Remove the follow-up that matches what was just done
      const intentToCommand: Record<string, string> = {
        project:     "/create",
        testing:     "/generate-test",
        docs:        "/docs",
        jira:        "/jira",
        standards:   "/standards",
        review:      "/review",
        onboarding:  "/onboarding",
      };
      const doneCommand = intent ? intentToCommand[intent] : undefined;

      return all
        .filter((f) => !doneCommand || !f.prompt.startsWith(doneCommand))
        .slice(0, 4); // show max 4 to keep UI clean
    },
  };

  context.subscriptions.push(participant);
  log("[BankAgent] Chat participant registered");
}

// ─── Help text ───────────────────────────────────────────────────────────────

const HELP_TEXT = `
# 📖 Company Coding Standard — Ayuda

Soy tu agente de estándares de desarrollo. Te ayudo a escribir código correcto, entender el proyecto y gestionar tus tareas.

---

## 🚀 Primeros pasos

| Comando | Cuándo usarlo |
|---|---|
| \`@company /onboarding\` | Eres nuevo en el equipo — guía completa del primer día |
| \`@company /setup <guía>\` | Configurar tu ambiente de desarrollo (Maven, Docker, etc.) |
| \`@company /standards\` | Ver las convenciones de nombrado y estándares de la empresa |

---

## 💻 Desarrollo diario

| Comando | Qué hace |
|---|---|
| \`@company /review\` | Revisa el archivo activo contra los estándares de la empresa |
| \`@company /generate-test\` | Genera tests unitarios para el archivo activo (patrón Triple AAA) |
| \`@company /docs\` | Genera JSDoc/JavaDoc para el archivo activo |
| \`@company /commit\` | Sugiere un mensaje de commit basado en tus cambios staged |
| \`@company /prompts\` | Lista los prompts disponibles en tu base de conocimiento |
| \`@company /prompts <nombre>\` | Aplica un prompt al archivo activo (ej: \`sonar-vulnerabilidades\`) |

---

## 🏗️ Proyecto

| Comando | Qué hace |
|---|---|
| \`@company /create\` | Genera un proyecto nuevo desde tu plantilla (Maven + Quarkus) |
| \`@company /project\` | Lista las acciones de proyecto disponibles |
| \`@company /project <acción>\` | Ejecuta una acción sobre el proyecto (ej: \`agrega-redis\`, \`agrega-client-rest\`) |
| \`@company /new-feature\` | Flujo guiado: selecciona historia de Jira → planifica → implementa |

---

## 📋 Jira

| Comando | Qué hace |
|---|---|
| \`@company /jira\` | Ver issues en progreso (usa JQL configurado o filtro por defecto) |
| \`@company /jira <texto>\` | Buscar issues por descripción usando IA (ej: \`/jira pagos con Redis\`) |
| \`@company /jira PROJ-123\` | Ver detalle completo de una issue |
| \`@company /jira subtasks PROJ-123\` | Ver tus subtareas asignadas (con alarma de edad) |
| \`@company /jira create PROJ-123\` | Crear una subtarea en una issue |
| \`@company /jira update PROJ-123\` | Actualizar descripción o agregar comentario |

---

## ⚙️ Configuración mínima requerida

\`\`\`json
{
  "companyStandards.knowledgeSource": "notion",
  "companyStandards.notionToken":     "secret_xxxx",
  "companyStandards.specialtiesMap": {
    "backend": {
      "standards": "<id-de-pagina>",
      "testing":   "<id-de-pagina>",
      "project":   "<id-de-pagina>",
      "prompts":   "<id-de-pagina>"
    }
  },
  "companyStandards.jiraUrl":         "https://tuempresa.atlassian.net",
  "companyStandards.jiraEmail":       "tu@empresa.com",
  "companyStandards.jiraToken":       "tu-api-token",
  "companyStandards.jiraProject":     ["BANK"],
  "companyStandards.setupPage":       "<id-pagina-setup>",
  "companyStandards.projectActionsPage": "<id-pagina-acciones>"
}
\`\`\`

---

## 💡 Tips

- Escribe \`@company\` + espacio para ver sugerencias de comandos
- Los comandos \`/review\`, \`/generate-test\` y \`/docs\` usan el archivo que tienes **abierto y activo** en el editor
- \`/jira <texto libre>\` hace búsqueda semántica con IA sobre todas tus issues
- Si eres nuevo, empieza con \`@company /onboarding\`
`.trim();

// ─── Request handler ────────────────────────────────────────────────────────

function makeHandler(context: vscode.ExtensionContext): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    const userPrompt = request.prompt.trim();
    log(`[BankAgent] ── request received ────────────────────────────────`);
    log(`[BankAgent] command : "${request.command ?? "(none)"}"`);
    log(`[BankAgent] prompt  : "${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? "…" : ""}"`);
    log(`[BankAgent] model   : ${request.model?.id ?? "(unknown)"}`);

    // 0 — Handle /help command
    if (request.command === "help") {
      stream.markdown(HELP_TEXT);
      return { metadata: { intent: "help" } };
    }

    // 0 — Handle /specialty command
    if (request.command === "specialty") {
      return handleSpecialtyCommand(userPrompt, stream);
    }

    // 0a0 — Handle /explain command
    if (request.command === "explain") {
      await handleExplainCommand(stream, request.model, token);
      return { metadata: { intent: "explain" } };
    }

    // 0a0b — Handle /document command
    if (request.command === "document") {
      await handleDocumentCommand(stream, request.model, token);
      return { metadata: { intent: "document" } };
    }

    // 0a0c — Handle /security command
    if (request.command === "security") {
      await handleSecurityCommand(stream, request.model, token);
      return { metadata: { intent: "security" } };
    }

    // 0a0d — Handle /checkstyle command
    if (request.command === "checkstyle") {
      await handleCheckstyleCommand(stream, request.model, token);
      return { metadata: { intent: "checkstyle" } };
    }

    // 0a1 — Handle /search command
    if (request.command === "search") {
      await handleKbSearchCommand(userPrompt, stream, request.model, token);
      return { metadata: { intent: "search" } };
    }

    // 0a2 — Handle /onboarding command
    if (request.command === "onboarding") {
      await handleOnboardingCommand(stream, request.model, token);
      return { metadata: { intent: "onboarding" } };
    }

    // 0a3 — Handle /setup command
    if (request.command === "setup") {
      const config    = vscode.workspace.getConfiguration("companyStandards");
      const setupPage = (config.get<string>("setupPage") ?? "").trim();

      if (!setupPage) {
        stream.markdown(
          `⚠️ Configura \`companyStandards.setupPage\` con el ID o URL de la página de Notion/Confluence ` +
          `que contiene tus guías de setup.\n\n` +
          `Cada encabezado H2 define una guía. Ejemplo:\n\n` +
          "```markdown\n" +
          `## maven\n` +
          `Antes de compilar el proyecto Maven necesitas:\n` +
          `1. Descargar los certificados corporativos.\n` +
          `2. Importarlos al cacert de Java con keytool.\n` +
          `3. Configurar el settings.xml de Maven.\n` +
          `4. Ejecutar mvn clean install.\n\n` +
          `## docker\n` +
          `Para levantar con Docker Compose...\n` +
          "```"
        );
        return { metadata: { intent: "setup" } };
      }

      stream.progress("Cargando guías de setup…");
      try {
        const provider  = createKnowledgeProvider();
        const page      = await provider.getPage(setupPage);
        const templates = parsePromptLibrary(page.blocks);
        log(`[BankAgent] /setup — ${templates.length} guides from "${setupPage}"`);
        await handleSetupCommand(userPrompt, templates, stream, request.model, token, page.title);
      } catch (err: unknown) {
        logError("[BankAgent] /setup — failed to load setup page", err);
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`❌ No pude cargar la página de setup: **${msg}**`);
      }
      return { metadata: { intent: "setup" } };
    }

    // 0b — Handle /jira command (early-exit — Jira issues manager)
    if (request.command === "jira") {
      await handleJiraCommand(userPrompt, stream, context, token, request.model);
      return { metadata: { intent: "jira" } };
    }

    // 0c — Handle /new-feature command (early-exit — uses Jira, not knowledge base)
    if (request.command === "new-feature") {
      const activeSpecialty = getActiveSpecialty();
      await handleNewFeatureCommand(userPrompt, stream, request.model, context, activeSpecialty, token);
      return { metadata: { intent: "new-feature", specialty: activeSpecialty } };
    }

    // 0d — Handle /project command (early-exit — uses projectActionsPage from settings)
    if (request.command === "project") {
      const config      = vscode.workspace.getConfiguration("companyStandards");
      const actionsPage = (config.get<string>("projectActionsPage") ?? "").trim();

      if (!actionsPage) {
        stream.markdown(
          `⚠️ Configura \`companyStandards.projectActionsPage\` con el ID o URL de la página ` +
          `de Notion/Confluence que contiene las acciones de proyecto.\n\n` +
          `Cada encabezado H2 de esa página define una acción:\n` +
          "```\n## agrega-redis\nCrea una interfaz RedisClient...\n\n## agrega-client-rest\n...\n```"
        );
        return { metadata: { intent: "project" } };
      }

      stream.progress("Cargando acciones de proyecto…");
      try {
        const provider = createKnowledgeProvider();
        const page     = await provider.getPage(actionsPage);
        const templates = parsePromptLibrary(page.blocks);
        log(`[BankAgent] /project — loaded ${templates.length} actions from "${actionsPage}"`);
        await handleProjectCommand(userPrompt, templates, stream, request.model, token, page.title);
      } catch (err: unknown) {
        logError("[BankAgent] /project — failed to load actions page", err);
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`❌ No pude cargar la página de acciones: **${msg}**`);
      }
      return { metadata: { intent: "project" } };
    }

    // 1 — Detect specialty: prompt mention > active setting
    const knownSpecialties = listSpecialties();
    const promptSpecialty  = detectSpecialtyFromPrompt(userPrompt, knownSpecialties);
    const specialty        = promptSpecialty ?? getActiveSpecialty();
    log(`[BankAgent] specialty: "${specialty}" (${promptSpecialty ? "detected from prompt" : "from settings"})`);

    if (promptSpecialty) {
      stream.progress(`Usando especialidad: ${promptSpecialty}`);
    }

    // 2 — Pick the right page: explicit slash command takes precedence over keyword detection
    const pageKey = resolvePageKey(request.command, userPrompt);
    const pageId  = resolvePageId(pageKey as PageType, specialty);
    log(`[BankAgent] pageKey  : "${pageKey}" → pageId: "${pageId ?? "NOT FOUND"}"`);
    log(`[BankAgent] via      : ${request.command ? "slash command" : "keyword detection"}`);

    if (!pageId) {
      const specialtiesMap = knownSpecialties.length
        ? `Specialties configured: ${knownSpecialties.join(", ")}.`
        : "";
      stream.markdown(
        `No tengo una página configurada para **"${pageKey}"** (especialidad: **${specialty}**).\n\n` +
        `Configúrala en \`companyStandards.specialtiesMap.${specialty}.${pageKey}\` en tus settings.\n\n` +
        (specialtiesMap ? `> ${specialtiesMap}` : "")
      );
      return { metadata: { intent: pageKey, specialty } };
    }

    // 3 — Load knowledge content (with cache)
    stream.progress(`Consultando base de conocimiento [${specialty}] (${pageKey})…`);
    log(`[BankAgent] Loading page id: ${pageId}`);

    let notionMarkdown: string;
    let pageTitle: string;

    try {
      const provider = createKnowledgeProvider();
      log(`[BankAgent] Using knowledge provider: ${provider.name}`);

      const rawPage = await provider.getPage(pageId);
      pageTitle      = rawPage.title;
      notionMarkdown = blocksToMarkdown(rawPage.blocks);
      log(`[BankAgent] Page "${pageTitle}" loaded, ~${notionMarkdown.length} chars`);
    } catch (err: unknown) {
      logError("[BankAgent] Failed to load knowledge page", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ No pude cargar la página de conocimiento: **${msg}**`);
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4a — If testing/generate-test intent, read the active editor file
    // Trigger on explicit /review or /generate-test command OR keyword-based review intent
    let activeFileContext = "";
    if (pageKey === "testing" && (request.command === "review" || request.command === "generate-test" || isReviewIntent(userPrompt))) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        stream.markdown(
          "⚠️ No hay ningún archivo abierto en el editor.\n\n" +
          "Abre el archivo de test que quieres revisar y vuelve a ejecutar el comando."
        );
        return { metadata: { intent: pageKey, specialty } };
      }
      const fileName   = editor.document.fileName.split("/").pop() ?? "archivo";
      const fileContent = editor.document.getText();
      const langId     = editor.document.languageId;
      log(`[BankAgent] Reading active file: ${fileName} (${langId}), ${fileContent.length} chars`);
      stream.progress(`Leyendo archivo "${fileName}"…`);

      activeFileContext =
        `\n\n---\n## Archivo a revisar: \`${fileName}\`\n` +
        `\`\`\`${langId}\n${fileContent}\n\`\`\``;
    }

    // 4a2 — /docs: read active file to generate documentation
    if (request.command === "docs") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        stream.markdown(
          "⚠️ No hay ningún archivo abierto en el editor.\n\n" +
          "Abre el archivo al que quieres agregar documentación y vuelve a ejecutar el comando."
        );
        return { metadata: { intent: pageKey, specialty } };
      }
      const fileName    = editor.document.fileName.split("/").pop() ?? "archivo";
      const fileContent = editor.document.getText();
      const langId      = editor.document.languageId;
      log(`[BankAgent] /docs — Reading active file: ${fileName} (${langId}), ${fileContent.length} chars`);
      stream.progress(`Generando documentación para "${fileName}"…`);
      activeFileContext =
        `\n\n---\n## Archivo a documentar: \`${fileName}\`\n` +
        `\`\`\`${langId}\n${fileContent}\n\`\`\``;
    }

    // 4a3 — /commit: get staged git diff
    if (request.command === "commit") {
      const diff = getStagedDiff();
      if (!diff) {
        stream.markdown(
          "⚠️ No hay cambios staged.\n\n" +
          "Añade archivos con `git add` antes de ejecutar este comando."
        );
        return { metadata: { intent: pageKey, specialty } };
      }
      log(`[BankAgent] /commit — Staged diff: ${diff.length} chars`);
      stream.progress("Analizando cambios staged para sugerir mensaje de commit…");
      activeFileContext =
        `\n\n---\n## Cambios staged (git diff --cached)\n` +
        `\`\`\`diff\n${diff}\n\`\`\``;
    }

    // 4b — Create project intent → generate files directly (no LLM needed)
    // Trigger on explicit /create command OR keyword-based create intent
    if (pageKey === "project" && (request.command === "create" || isCreateIntent(userPrompt))) {
      log("[BankAgent] Create intent detected — generating project files");
      stream.progress("Preparando generación del proyecto…");

      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(pageId);
      const result   = await createProjectFromNotion(page.blocks, stream);

      if (result) {
        stream.markdown(
          `## ✅ Proyecto creado\n\n` +
          `**Carpeta:** \`${result.folder}\`\n\n` +
          `**Archivos generados (${result.files.length}):**\n` +
          result.files.map((f) => `- \`${f}\``).join("\n") +
          `\n\n> Ejecuta \`mvn quarkus:dev\` para levantar el servidor.`
        );
        stream.button({ title: "Abrir carpeta del proyecto", command: "vscode.openFolder" });
      }
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4c — Prompt library: list or apply a saved prompt from knowledge source
    if (pageKey === "prompts") {
      const provider  = createKnowledgeProvider();
      const page      = await provider.getPage(pageId);
      const templates = parsePromptLibrary(page.blocks);
      log(`[BankAgent] Prompt library loaded: ${templates.length} prompts`);

      await handlePromptsCommand(userPrompt, templates, stream, request.model, token, pageTitle);
      stream.button({ title: "Actualizar biblioteca de prompts", command: "companyStandards.refreshStandards" });
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4 — Build token-aware prompt via prompt-tsx
    const model = request.model;
    log(`[BankAgent] Using model: ${model.name} (${model.id}), max tokens: ${model.maxInputTokens}`);

    const systemPrompt =
      `Eres un agente de estándares de la compañía integrado en VSCode. Tienes acceso a la documentación oficial ` +
      `del banco almacenada en Notion. Responde SOLO basándote en el contenido de la documentación proporcionada. ` +
      `IMPORTANTE: Este agente SÍ puede crear proyectos y generar archivos en disco automáticamente. ` +
      `Cuando el usuario pida crear, generar o inicializar un proyecto, dile que el agente lo generará ` +
      `y que debe seleccionar la carpeta destino en el diálogo que aparecerá. ` +
      `Nunca digas que no puedes crear proyectos. ` +
      `Usa formato Markdown en tus respuestas. Responde en el mismo idioma que el usuario.`;

    let reviewInstruction = "";
    if (activeFileContext) {
      if (request.command === "generate-test") {
        reviewInstruction =
          `\nGenera tests unitarios completos para el archivo adjunto siguiendo los estándares de testing de la documentación. ` +
          `Incluye: imports necesarios, clase de test, métodos de test con patrón AAA (Arrange/Act/Assert), ` +
          `y al menos un caso por método público. Usa el mismo lenguaje que el archivo fuente.`;
      } else if (request.command === "docs") {
        reviewInstruction =
          `\nAgrega comentarios JSDoc/JavaDoc al archivo adjunto siguiendo los estándares de la documentación. ` +
          `Documenta únicamente métodos y clases públicos. No modifiques la lógica del código. ` +
          `Devuelve el archivo completo con los comentarios añadidos.`;
      } else if (request.command === "commit") {
        reviewInstruction =
          `\nA partir de los cambios staged adjuntos y los estándares de la documentación, ` +
          `genera un mensaje de commit en formato Conventional Commits (type(scope): description). ` +
          `Incluye: tipo (feat/fix/refactor/docs/test/chore), scope opcional, descripción corta en el idioma del usuario, ` +
          `y un cuerpo explicando el "por qué" si los cambios son complejos.`;
      } else {
        reviewInstruction =
          `\nAnaliza el archivo adjunto línea por línea contra los estándares de la compañía. ` +
          `Lista cada violación encontrada con: número de línea, problema y corrección sugerida. ` +
          `Al final muestra un resumen con ✅ si cumple o ❌ si no cumple cada regla del checklist.`;
      }
    }

    const { messages } = await renderPrompt(
      BankPrompt,
      {
        systemPrompt,
        reviewInstruction,
        notionContent: notionMarkdown,
        pageTitle,
        activeFileContext,
        userPrompt,
        history: chatContext.history,
      },
      { modelMaxPromptTokens: model.maxInputTokens },
      model
    );

    log(`[BankAgent] Rendered ${messages.length} messages for LLM`);

    // 5 — Stream response
    stream.markdown(`> 📖 Basado en **${pageTitle}** · especialidad: **${specialty}**\n\n`);

    try {
      log("[BankAgent] Sending request to LLM…");
      const response = await model.sendRequest(messages, {}, token);

      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }
      log("[BankAgent] LLM response complete");
    } catch (err: unknown) {
      if (err instanceof vscode.LanguageModelError) {
        logError(`[BankAgent] LLM error — code: ${err.code}`, err);
        stream.markdown(`❌ Error del modelo: ${err.message}`);
      } else {
        throw err;
      }
    }

    log(`[BankAgent] ── request complete ─────────────────────────────`);

    // 6 — Action buttons after response
    stream.button({ title: "Actualizar estándares desde Notion", command: "companyStandards.refreshStandards" });

    return { metadata: { intent: pageKey, specialty } };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Handles the /specialty command:
 * - No arg → list available specialties + show active one
 * - Arg matches known specialty → switch to it
 * - Arg not found → show error with available options
 */
async function handleSpecialtyCommand(
  userArg: string,
  stream: vscode.ChatResponseStream
): Promise<vscode.ChatResult> {
  const knownSpecialties = listSpecialties();
  const active           = getActiveSpecialty();
  const arg              = userArg.trim().toLowerCase();

  if (!arg) {
    // List mode
    if (knownSpecialties.length === 0) {
      stream.markdown(
        `No hay especialidades configuradas aún.\n\n` +
        `Añade entradas en \`companyStandards.specialtiesMap\` en tus settings.\n\n` +
        `**Ejemplo:**\n` +
        `\`\`\`json\n` +
        `"companyStandards.specialtiesMap": {\n` +
        `  "backend":  { "standards": "<id>", "testing": "<id>", "project": "<id>", "prompts": "<id>" },\n` +
        `  "frontend": { "standards": "<id>", "testing": "<id>" },\n` +
        `  "qa":       { "testing": "<id>", "prompts": "<id>" }\n` +
        `}\n\`\`\``
      );
    } else {
      const rows = knownSpecialties
        .map((s) => `| ${s} | ${s === active ? "✅ activa" : ""} |`)
        .join("\n");
      stream.markdown(
        `## Especialidades disponibles\n\n` +
        `| Especialidad | Estado |\n|---|---|\n${rows}\n\n` +
        `**Activa:** \`${active}\`\n\n` +
        `Para cambiar: \`@bank /specialty <nombre>\``
      );
    }
    return { metadata: { intent: "specialty" } };
  }

  // Switch mode
  const match = knownSpecialties.find((s) => s.toLowerCase() === arg);
  if (!match) {
    const options = knownSpecialties.length
      ? knownSpecialties.map((s) => `\`${s}\``).join(", ")
      : "ninguna configurada aún";
    stream.markdown(
      `❌ Especialidad **"${arg}"** no encontrada.\n\n` +
      `Disponibles: ${options}`
    );
    return { metadata: { intent: "specialty" } };
  }

  await setActiveSpecialty(match);
  stream.markdown(
    `✅ Especialidad cambiada a **${match}**.\n\n` +
    `A partir de ahora usaré la documentación de **${match}** para todas las consultas.`
  );
  return { metadata: { intent: "specialty" } };
}

function resolvePageKey(command: string | undefined, prompt: string): string {
  if (command === "standards")      return "standards";
  if (command === "review")         return "testing";
  if (command === "generate-test")  return "testing";
  if (command === "create")         return "project";
  if (command === "prompts")        return "prompts";
  if (command === "docs")           return "standards";
  if (command === "commit")         return "standards";
  if (command === "new-feature")    return "standards";
  if (command === "jira")           return "standards";
  return detectIntent(prompt);
}

/**
 * Keyword-based fallback intent detection (used when no slash command is given).
 */
function detectIntent(prompt: string): string {
  const lower = prompt.toLowerCase();
  const testingKeywords   = ["revisa", "review", "analiza", "analyse", "analyze", "test", "aaa", "arrange", "assert", "valida", "validate", "verifica", "verify", "cumple", "junit", "spec"];
  const standardsKeywords = ["standard", "naming", "camelcase", "convención", "convencion", "regla", "snake", "pascal"];
  const projectKeywords   = ["proyecto", "project", "maven", "quarkus", "crear", "create", "controller", "contrato", "contract", "openapi", "scaffold"];

  if (testingKeywords.some((k) => lower.includes(k)))   return "testing";
  if (standardsKeywords.some((k) => lower.includes(k))) return "standards";
  if (projectKeywords.some((k) => lower.includes(k)))   return "project";
  return "project";
}

function isReviewIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(revisa|review|analiza|analiz[ae]|valida|verifica|cumple|este test|este archivo|el archivo|the file)\b/.test(lower);
}

