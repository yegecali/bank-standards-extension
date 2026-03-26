import * as vscode from "vscode";
import { renderPrompt } from "@vscode/prompt-tsx";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { parsePromptLibrary, blocksToMarkdown } from "../notion/parser";
import { handlePromptsCommand } from "./promptLibraryHandler";
import { handleNewFeatureCommand } from "./newFeatureHandler";
import { handleJiraCommand } from "./jiraHandler";
import { handleProjectCommand } from "./projectActionHandler";
import { handleOnboardingCommand } from "./onboardingHandler";
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

    // 0 — Handle /specialty command
    if (request.command === "specialty") {
      return handleSpecialtyCommand(userPrompt, stream);
    }

    // 0a2 — Handle /onboarding command
    if (request.command === "onboarding") {
      await handleOnboardingCommand(stream, request.model, token);
      return { metadata: { intent: "onboarding" } };
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

