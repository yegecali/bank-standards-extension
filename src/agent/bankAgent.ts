import * as vscode from "vscode";
import { renderPrompt } from "@vscode/prompt-tsx";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../knowledge/parser";
import { handleJiraCommand } from "../handlers/jiraHandler";
import { handleProjectCommand } from "../handlers/projectActionHandler";
import { handleKbSearchCommand } from "../handlers/kbSearchHandler";
import { handleExplainCommand } from "../handlers/explainHandler";
import { handleSecurityCommand } from "../handlers/securityHandler";
import {
  pickAndLoadChildPage,
  applyChildPageAsGuide,
  applyChildPageAsStandard,
  handlePromptsChildPageFlow,
} from "../handlers/confluenceChildPageHandler";
import { BankPrompt } from "./BankPrompt";
import {
  PageType,
  resolvePageId,
  getActiveSpecialty,
  listSpecialties,
  detectSpecialtyFromPrompt,
} from "./specialtyResolver";
import { parsePromptLibrary } from "../knowledge/parser";

const PARTICIPANT_ID = "companyStandards.agent";

interface ChatResultMetadata {
  intent: string;
  specialty?: string;
}

export function registerBankAgent(context: vscode.ExtensionContext): void {
  log(`[BankAgent] Creating chat participant — id: "${PARTICIPANT_ID}"`);

  let participant: vscode.ChatParticipant;
  try {
    participant = vscode.chat.createChatParticipant(
      PARTICIPANT_ID,
      makeHandler(context),
    );
    log(`[BankAgent] Chat participant created OK — id: "${PARTICIPANT_ID}"`);
  } catch (err: unknown) {
    logError(
      `[BankAgent] FAILED to create chat participant — id: "${PARTICIPANT_ID}"`,
      err,
    );
    throw err;
  }

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "images",
    "icon.svg",
  );

  // ─── Follow-up suggestions ──────────────────────────────────────────────────
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): vscode.ChatFollowup[] {
      const intent = (result.metadata as ChatResultMetadata | undefined)
        ?.intent;

      // Context-aware: suggest the most relevant next actions based on what was just done
      const all: vscode.ChatFollowup[] = [
        {
          prompt: "/explain",
          label: "Documentar flujos y diagramas de secuencia",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/search",
          label: "Buscar información en la base de conocimiento",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/jira subtasks",
          label: "Ver mis subtareas en Jira",
          participant: PARTICIPANT_ID,
        },
        {
          prompt: "/security",
          label: "Análisis de seguridad del proyecto",
          participant: PARTICIPANT_ID,
        },
      ];

      // Remove the follow-up that matches what was just done
      const intentToCommand: Record<string, string> = {
        jira: "/jira",
        standards: "/standards",
        docs: "/docs",
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

Soy tu agente de estándares de desarrollo. Te ayudo a entender el proyecto, gestionar tus tareas y mantener la calidad del código.

---

## 🔍 Análisis de proyecto

| Comando | Qué hace |
|---|---|
| \`@company /explain\` | Genera diagramas de secuencia Mermaid de toda la arquitectura (5 capas + validación global). Escribe en \`docs/sequence-diagrams.md\` |
| \`@company /security\` | Escaneo de seguridad del workspace (OWASP Top 10 + riesgos configurables). Escribe en \`docs/security-report.md\` |

---

## 📚 Conocimiento y estándares

| Comando | Qué hace |
|---|---|
| \`@company /standards\` | Consulta estándares de desarrollo desde Confluence (selector interactivo) |
| \`@company /prompts\` | Biblioteca de prompts — lista subpáginas de Confluence, muestra preview y aplica al archivo activo |
| \`@company /project\` | Guías de herramientas de desarrollo (dev tools) desde Confluence |
| \`@company /search <pregunta>\` | Búsqueda semántica en la base de conocimiento |
| \`@company /docs\` | Genera JSDoc/JavaDoc para el archivo activo siguiendo los estándares de documentación |

---

## 📋 Jira

| Comando | Qué hace |
|---|---|
| \`@company /jira\` | Flujo guiado: muestra issues en progreso → elige una → ver subtareas / crear subtarea / actualizar estado |

---

## ⚙️ Configuración mínima requerida

\`\`\`json
{
  "companyStandards.knowledgeSource": "confluence",
  "companyStandards.confluenceUrl":   "https://tuempresa.atlassian.net",
  "companyStandards.confluenceEmail": "tu@empresa.com",
  "companyStandards.confluenceToken": "tu-api-token",
  "companyStandards.specialtiesMap": {
    "backend": {
      "standards": "<id-de-pagina>",
      "project":   "<id-de-pagina>",
      "prompts":   "<id-de-pagina>"
    }
  },
  "companyStandards.jiraUrl":         "https://tuempresa.atlassian.net",
  "companyStandards.jiraEmail":       "tu@empresa.com",
  "companyStandards.jiraToken":       "tu-api-token",
  "companyStandards.jiraProject":     ["BANK"]
}
\`\`\`
`.trim();

// ─── Request handler ────────────────────────────────────────────────────────

function makeHandler(
  context: vscode.ExtensionContext,
): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const userPrompt = request.prompt.trim();
    log(`[BankAgent] ── request received ────────────────────────────────`);
    log(`[BankAgent] command : "${request.command ?? "(none)"}"`);
    log(
      `[BankAgent] prompt  : "${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? "…" : ""}"`,
    );
    log(`[BankAgent] model   : ${request.model?.id ?? "(unknown)"}`);

    // 0 — Handle /help command
    if (request.command === "help") {
      stream.markdown(HELP_TEXT);
      return { metadata: { intent: "help" } };
    }

    // 0a0 — Handle /explain command
    if (request.command === "explain") {
      await handleExplainCommand(stream, request.model, token);
      return { metadata: { intent: "explain" } };
    }

    // 0a0c — Handle /security command
    if (request.command === "security") {
      await handleSecurityCommand(stream, request.model, token);
      return { metadata: { intent: "security" } };
    }

    // 0a1 — Handle /search command
    if (request.command === "search") {
      await handleKbSearchCommand(userPrompt, stream, request.model, token);
      return { metadata: { intent: "search" } };
    }

    // 0b — Handle /jira command (early-exit — Jira issues manager)
    if (request.command === "jira") {
      await handleJiraCommand(
        userPrompt,
        stream,
        context,
        token,
        request.model,
      );
      return { metadata: { intent: "jira" } };
    }

    // 0d — Handle /project command (early-exit)
    // New flow: devToolsPageId → list child pages → QuickPick → apply guide
    // Legacy flow: projectActionsPage → single page with H2 sections
    if (request.command === "project") {
      const cfg = vscode.workspace.getConfiguration("companyStandards");
      const devToolsPage = (cfg.get<string>("devToolsPageId") ?? "").trim();
      const actionsPage = (cfg.get<string>("projectActionsPage") ?? "").trim();

      if (devToolsPage) {
        const provider = createKnowledgeProvider();
        const picked = await pickAndLoadChildPage(
          devToolsPage,
          "Dev Tools — ¿Qué deseas hacer?",
          stream,
          provider,
        );
        if (picked) {
          await applyChildPageAsGuide(
            picked.title,
            picked.markdown,
            userPrompt,
            stream,
            request.model,
            token,
          );
        }
        return { metadata: { intent: "project" } };
      }

      if (!actionsPage) {
        stream.markdown(
          `⚠️ Configura \`companyStandards.devToolsPageId\` con el ID de la página padre "Dev Tools" en Confluence, ` +
            `o \`companyStandards.projectActionsPage\` para el modo legado.\n\n` +
            `Cada subpágina (o encabezado H2) define una acción de proyecto.`,
        );
        return { metadata: { intent: "project" } };
      }

      stream.progress("Cargando acciones de proyecto…");
      try {
        const provider = createKnowledgeProvider();
        const page = await provider.getPage(actionsPage);
        const templates = parsePromptLibrary(page.blocks);
        log(
          `[BankAgent] /project legacy — loaded ${templates.length} actions from "${actionsPage}"`,
        );
        await handleProjectCommand(
          userPrompt,
          templates,
          stream,
          request.model,
          token,
          page.title,
        );
      } catch (err: unknown) {
        logError("[BankAgent] /project — failed to load actions page", err);
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`❌ No pude cargar la página de acciones: **${msg}**`);
      }
      return { metadata: { intent: "project" } };
    }

    // 0e — Handle /prompts command (early-exit)
    // Uses promptsPageId (or specialtiesMap.prompts) as parent page; child pages = prompts
    if (request.command === "prompts") {
      const cfg           = vscode.workspace.getConfiguration("companyStandards");
      const promptsParent = (cfg.get<string>("promptsPageId") ?? "").trim()
                         || (resolvePageId("prompts") ?? "");

      if (!promptsParent) {
        stream.markdown(
          `⚠️ Configura \`companyStandards.promptsPageId\` con el ID de la página padre **"Prompts"** en Confluence.\n\n` +
          `Cada subpágina de esa página es un prompt seleccionable.`
        );
        return { metadata: { intent: "prompts" } };
      }

      const provider = createKnowledgeProvider();
      await handlePromptsChildPageFlow(promptsParent, userPrompt, stream, request.model, token, provider);
      return { metadata: { intent: "prompts" } };
    }

    // 0f — Handle /standards command (early-exit)
    // Uses standardsPageId as parent page; child pages = individual standards
    if (request.command === "standards") {
      const cfg           = vscode.workspace.getConfiguration("companyStandards");
      const standardsPage = (cfg.get<string>("standardsPageId") ?? "").trim();

      if (standardsPage) {
        const provider = createKnowledgeProvider();
        const picked   = await pickAndLoadChildPage(standardsPage, "Estándares de Desarrollo", stream, provider);
        if (picked) {
          await applyChildPageAsStandard(picked.title, picked.markdown, userPrompt, stream, request.model, token);
        }
        return { metadata: { intent: "standards" } };
      }
      // No standardsPageId set — fall through to legacy knowledge-page flow
    }

    // 1 — Detect specialty: prompt mention > active setting
    const knownSpecialties = listSpecialties();
    const promptSpecialty = detectSpecialtyFromPrompt(
      userPrompt,
      knownSpecialties,
    );
    const specialty = promptSpecialty ?? getActiveSpecialty();
    log(
      `[BankAgent] specialty: "${specialty}" (${promptSpecialty ? "detected from prompt" : "from settings"})`,
    );

    if (promptSpecialty) {
      stream.progress(`Usando especialidad: ${promptSpecialty}`);
    }

    // 2 — Pick the right page: explicit slash command takes precedence over keyword detection
    const pageKey = resolvePageKey(request.command, userPrompt);
    const pageId = resolvePageId(pageKey as PageType, specialty);
    log(
      `[BankAgent] pageKey  : "${pageKey}" → pageId: "${pageId ?? "NOT FOUND"}"`,
    );
    log(
      `[BankAgent] via      : ${request.command ? "slash command" : "keyword detection"}`,
    );

    if (!pageId) {
      const specialtiesMap = knownSpecialties.length
        ? `Specialties configured: ${knownSpecialties.join(", ")}.`
        : "";
      stream.markdown(
        `No tengo una página configurada para **"${pageKey}"** (especialidad: **${specialty}**).\n\n` +
          `Configúrala en \`companyStandards.specialtiesMap.${specialty}.${pageKey}\` en tus settings.\n\n` +
          (specialtiesMap ? `> ${specialtiesMap}` : ""),
      );
      return { metadata: { intent: pageKey, specialty } };
    }

    // 3 — Load knowledge content (with cache)
    stream.progress(
      `Consultando base de conocimiento [${specialty}] (${pageKey})…`,
    );
    log(`[BankAgent] Loading page id: ${pageId}`);

    let pageMarkdown: string;
    let pageTitle: string;

    try {
      const provider = createKnowledgeProvider();
      log(`[BankAgent] Using knowledge provider: ${provider.name}`);

      const rawPage = await provider.getPage(pageId);
      pageTitle = rawPage.title;
      pageMarkdown = blocksToMarkdown(rawPage.blocks);
      log(
        `[BankAgent] Page "${pageTitle}" loaded, ~${pageMarkdown.length} chars`,
      );
    } catch (err: unknown) {
      logError("[BankAgent] Failed to load knowledge page", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(
        `❌ No pude cargar la página de conocimiento: **${msg}**`,
      );
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4 — /docs: read active file to generate documentation
    let activeFileContext = "";
    if (request.command === "docs") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        stream.markdown(
          "⚠️ No hay ningún archivo abierto en el editor.\n\n" +
            "Abre el archivo al que quieres agregar documentación y vuelve a ejecutar el comando.",
        );
        return { metadata: { intent: pageKey, specialty } };
      }
      const fileName = editor.document.fileName.split("/").pop() ?? "archivo";
      const fileContent = editor.document.getText();
      const langId = editor.document.languageId;
      log(
        `[BankAgent] /docs — Reading active file: ${fileName} (${langId}), ${fileContent.length} chars`,
      );
      stream.progress(`Generando documentación para "${fileName}"…`);
      activeFileContext =
        `\n\n---\n## Archivo a documentar: \`${fileName}\`\n` +
        `\`\`\`${langId}\n${fileContent}\n\`\`\``;
    }

    // 5 — Build token-aware prompt via prompt-tsx
    const model = request.model;
    log(
      `[BankAgent] Using model: ${model.name} (${model.id}), max tokens: ${model.maxInputTokens}`,
    );

    const systemPrompt =
      `Eres un agente de estándares de la compañía integrado en VSCode. Tienes acceso a la documentación oficial ` +
      `del banco almacenada en Confluence. Responde SOLO basándote en el contenido de la documentación proporcionada. ` +
      `Usa formato Markdown en tus respuestas. Responde en el mismo idioma que el usuario.`;

    let reviewInstruction = "";
    if (activeFileContext && request.command === "docs") {
      reviewInstruction =
        `\nAgrega comentarios JSDoc/JavaDoc al archivo adjunto siguiendo los estándares de la documentación. ` +
        `Documenta únicamente métodos y clases públicos. No modifiques la lógica del código. ` +
        `Devuelve el archivo completo con los comentarios añadidos.`;
    }

    const { messages } = await renderPrompt(
      BankPrompt,
      {
        systemPrompt,
        reviewInstruction,
        kbContent: pageMarkdown,
        pageTitle,
        activeFileContext,
        userPrompt,
        history: chatContext.history,
      },
      { modelMaxPromptTokens: model.maxInputTokens },
      model,
    );

    log(`[BankAgent] Rendered ${messages.length} messages for LLM`);

    // 6 — Stream response
    stream.markdown(
      `> 📖 Basado en **${pageTitle}** · especialidad: **${specialty}**\n\n`,
    );

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

    // 7 — Action buttons after response
    stream.button({
      title: "Actualizar estándares",
      command: "companyStandards.refreshStandards",
    });

    return { metadata: { intent: pageKey, specialty } };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePageKey(command: string | undefined, prompt: string): string {
  if (command === "standards") return "standards";
  if (command === "docs") return "standards";
  if (command === "prompts") return "prompts";
  if (command === "jira") return "standards";
  return detectIntent(prompt);
}

/**
 * Keyword-based fallback intent detection (used when no slash command is given).
 */
function detectIntent(prompt: string): string {
  const lower = prompt.toLowerCase();
  const testingKeywords = [
    "revisa",
    "review",
    "analiza",
    "analyse",
    "analyze",
    "test",
    "aaa",
    "arrange",
    "assert",
    "valida",
    "validate",
    "verifica",
    "verify",
    "cumple",
    "junit",
    "spec",
  ];
  const standardsKeywords = [
    "standard",
    "naming",
    "camelcase",
    "convención",
    "convencion",
    "regla",
    "snake",
    "pascal",
  ];
  const projectKeywords = [
    "proyecto",
    "project",
    "maven",
    "quarkus",
    "crear",
    "create",
    "controller",
    "contrato",
    "contract",
    "openapi",
    "scaffold",
  ];

  if (testingKeywords.some((k) => lower.includes(k))) return "testing";
  if (standardsKeywords.some((k) => lower.includes(k))) return "standards";
  if (projectKeywords.some((k) => lower.includes(k))) return "project";
  return "project";
}
