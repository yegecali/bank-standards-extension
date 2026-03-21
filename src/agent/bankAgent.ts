import * as vscode from "vscode";
import { renderPrompt } from "@vscode/prompt-tsx";
import { KnowledgeBlock } from "../knowledge/KnowledgeProvider";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { parseNamingRules, parseProjectSteps, parsePromptLibrary, blocksToMarkdown } from "../notion/parser";
import { handlePromptsCommand } from "./promptLibraryHandler";
import { resolveWithCache } from "../notion/cache";
import { isCreateIntent, createProjectFromNotion } from "./projectCreator";
import { BankPrompt } from "./BankPrompt";
import {
  PageType,
  resolvePageId,
  getActiveSpecialty,
  setActiveSpecialty,
  listSpecialties,
  detectSpecialtyFromPrompt,
} from "./specialtyResolver";

const PARTICIPANT_ID = "bankStandards.agent";

interface ChatResultMetadata {
  intent: string;
  specialty?: string;
}

export function registerBankAgent(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, makeHandler(context));
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "images", "bank-agent.svg");

  // ─── Follow-up suggestions ──────────────────────────────────────────────────
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      const intent = (result.metadata as ChatResultMetadata | undefined)?.intent;
      const followups: vscode.ChatFollowup[] = [];

      if (intent !== "testing") {
        followups.push({
          prompt: "revisa este archivo contra los estándares",
          label: "Revisar archivo abierto",
          participant: PARTICIPANT_ID,
        });
      }
      if (intent !== "project") {
        followups.push({
          prompt: "crea un proyecto base con quarkus",
          label: "Crear proyecto Quarkus",
          participant: PARTICIPANT_ID,
        });
      }
      if (intent !== "standards") {
        followups.push({
          prompt: "¿qué convenciones de nombres debo usar?",
          label: "Ver estándares de nomenclatura",
          participant: PARTICIPANT_ID,
        });
      }
      return followups;
    },
  };

  context.subscriptions.push(participant);
  console.log("[BankAgent] Chat participant registered");
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
    console.log(`[BankAgent] User prompt: "${userPrompt}", command: "${request.command ?? "none"}"`);

    // 0 — Handle /specialty command
    if (request.command === "specialty") {
      return handleSpecialtyCommand(userPrompt, stream);
    }

    // 1 — Detect specialty: prompt mention > active setting
    const knownSpecialties = listSpecialties();
    const promptSpecialty  = detectSpecialtyFromPrompt(userPrompt, knownSpecialties);
    const specialty        = promptSpecialty ?? getActiveSpecialty();
    console.log(`[BankAgent] Specialty: "${specialty}" (${promptSpecialty ? "detected from prompt" : "from settings"})`);

    if (promptSpecialty) {
      stream.progress(`Usando especialidad: ${promptSpecialty}`);
    }

    // 2 — Pick the right page: explicit slash command takes precedence over keyword detection
    const pageKey = resolvePageKey(request.command, userPrompt);
    console.log(`[BankAgent] Resolved page key: "${pageKey}" (via ${request.command ? "slash command" : "keyword detection"})`);

    const pageId = resolvePageId(pageKey as PageType, specialty);

    if (!pageId) {
      const specialtiesMap = knownSpecialties.length
        ? `Specialties configured: ${knownSpecialties.join(", ")}.`
        : "";
      stream.markdown(
        `No tengo una página configurada para **"${pageKey}"** (especialidad: **${specialty}**).\n\n` +
        `Configúrala en \`bankStandards.specialtiesMap.${specialty}.${pageKey}\` en tus settings.\n\n` +
        (specialtiesMap ? `> ${specialtiesMap}` : "")
      );
      return { metadata: { intent: pageKey, specialty } };
    }

    // 3 — Load knowledge content (with cache)
    stream.progress(`Consultando base de conocimiento [${specialty}] (${pageKey})…`);
    console.log(`[BankAgent] Loading page id: ${pageId}`);

    let notionMarkdown: string;
    let pageTitle: string;
    let fromCache: boolean;

    try {
      const provider = createKnowledgeProvider();
      console.log(`[BankAgent] Using knowledge provider: ${provider.name}`);

      const parse = (pageKey === "standards" || pageKey === "testing")
        ? (blocks: KnowledgeBlock[]) => parseNamingRules(blocks) as unknown[]
        : pageKey === "prompts"
          ? (blocks: KnowledgeBlock[]) => parsePromptLibrary(blocks) as unknown[]
          : (blocks: KnowledgeBlock[]) => parseProjectSteps(blocks) as unknown[];

      const result = await resolveWithCache(context, pageId, provider, parse, "BankAgent");
      pageTitle  = result.pageTitle;
      fromCache  = result.fromCache;

      const rawPage = await provider.getPage(pageId);
      notionMarkdown = blocksToMarkdown(rawPage.blocks);
      console.log(`[BankAgent] Page "${pageTitle}" loaded (fromCache: ${fromCache}), ~${notionMarkdown.length} chars`);
    } catch (err: any) {
      console.error(`[BankAgent] Failed to load knowledge page: ${err.message}`);
      stream.markdown(`❌ No pude cargar la página de conocimiento: **${err.message}**`);
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4a — If testing intent, read the active editor file
    // Trigger on explicit /review command OR keyword-based review intent
    let activeFileContext = "";
    if (pageKey === "testing" && (request.command === "review" || isReviewIntent(userPrompt))) {
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
      console.log(`[BankAgent] Reading active file: ${fileName} (${langId}), ${fileContent.length} chars`);
      stream.progress(`Leyendo archivo "${fileName}"…`);

      activeFileContext =
        `\n\n---\n## Archivo a revisar: \`${fileName}\`\n` +
        `\`\`\`${langId}\n${fileContent}\n\`\`\``;
    }

    // 4b — Create project intent → generate files directly (no LLM needed)
    // Trigger on explicit /create command OR keyword-based create intent
    if (pageKey === "project" && (request.command === "create" || isCreateIntent(userPrompt))) {
      console.log("[BankAgent] Create intent detected — generating project files");
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
      console.log(`[BankAgent] Prompt library loaded: ${templates.length} prompts`);

      await handlePromptsCommand(userPrompt, templates, stream, request.model, token, pageTitle);
      stream.button({ title: "Actualizar biblioteca de prompts", command: "bankStandards.refreshStandards" });
      return { metadata: { intent: pageKey, specialty } };
    }

    // 4 — Build token-aware prompt via prompt-tsx
    const model = request.model;
    console.log(`[BankAgent] Using model: ${model.name} (${model.id}), max tokens: ${model.maxInputTokens}`);

    const systemPrompt =
      `Eres un agente de estándares del banco integrado en VSCode. Tienes acceso a la documentación oficial ` +
      `del banco almacenada en Notion. Responde SOLO basándote en el contenido de la documentación proporcionada. ` +
      `IMPORTANTE: Este agente SÍ puede crear proyectos y generar archivos en disco automáticamente. ` +
      `Cuando el usuario pida crear, generar o inicializar un proyecto, dile que el agente lo generará ` +
      `y que debe seleccionar la carpeta destino en el diálogo que aparecerá. ` +
      `Nunca digas que no puedes crear proyectos. ` +
      `Usa formato Markdown en tus respuestas. Responde en el mismo idioma que el usuario.`;

    const reviewInstruction = activeFileContext
      ? `\nAnaliza el archivo adjunto línea por línea contra los estándares del banco. ` +
        `Lista cada violación encontrada con: número de línea, problema y corrección sugerida. ` +
        `Al final muestra un resumen con ✅ si cumple o ❌ si no cumple cada regla del checklist.`
      : "";

    const { messages } = await renderPrompt(
      BankPrompt,
      {
        systemPrompt,
        reviewInstruction,
        notionContent: notionMarkdown,
        pageTitle,
        fromCache,
        activeFileContext,
        userPrompt,
        history: chatContext.history,
      },
      { modelMaxPromptTokens: model.maxInputTokens },
      model
    );

    console.log(`[BankAgent] Rendered ${messages.length} messages for LLM`);

    // 5 — Stream response
    stream.markdown(`> 📖 Basado en **${pageTitle}** · especialidad: **${specialty}** *(${fromCache ? "caché" : "live"})*\n\n`);

    try {
      console.log("[BankAgent] Sending request to LLM…");
      const response = await model.sendRequest(messages, {}, token);

      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }
      console.log("[BankAgent] LLM response complete");
    } catch (err: any) {
      if (err instanceof vscode.LanguageModelError) {
        console.error(`[BankAgent] LLM error — code: ${err.code}, message: ${err.message}`);
        stream.markdown(`❌ Error del modelo: ${err.message}`);
      } else {
        throw err;
      }
    }

    // 6 — Action buttons after response
    stream.button({ title: "Actualizar estándares desde Notion", command: "bankStandards.refreshStandards" });

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
        `Añade entradas en \`bankStandards.specialtiesMap\` en tus settings.\n\n` +
        `**Ejemplo:**\n` +
        `\`\`\`json\n` +
        `"bankStandards.specialtiesMap": {\n` +
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
  if (command === "standards") return "standards";
  if (command === "review")    return "testing";
  if (command === "create")    return "project";
  if (command === "prompts")   return "prompts";
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

