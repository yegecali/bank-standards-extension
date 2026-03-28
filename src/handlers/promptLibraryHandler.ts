import * as vscode from "vscode";
import { PromptTemplate } from "../notion/parser";
import { log, logError } from "../logger";

/**
 * Handles the /prompts slash command.
 *
 * - No argument  → lists all available prompts
 * - With argument → finds the best matching prompt and applies it with the
 *                   active editor file as context
 */
export async function handlePromptsCommand(
  userArg: string,
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  pageTitle: string
): Promise<void> {
  log(`[PromptsHandler] handlePromptsCommand — arg: "${userArg}", model: ${model.id}, templates: ${templates.length}`);

  if (templates.length === 0) {
    stream.markdown(
      "⚠️ No encontré prompts en la página de Confluence/Notion.\n\n" +
      "Asegúrate de que la página tenga el formato correcto:\n\n" +
      "```\n## nombre-del-prompt\nDescripción breve.\nTexto del prompt aquí.\n```"
    );
    return;
  }

  // No argument — show the catalog
  if (!userArg) {
    showPromptCatalog(templates, stream, pageTitle);
    return;
  }

  // With argument — find matching prompt and apply it
  const match = findBestMatch(userArg, templates);
  log(`[PromptsHandler] findBestMatch("${userArg}") → ${match ? `"${match.name}"` : "NOT FOUND"}`);

  if (!match) {
    stream.markdown(
      `No encontré un prompt que coincida con **"${userArg}"**.\n\n` +
      `Prompts disponibles: ${templates.map((t) => `\`${t.name}\``).join(", ")}\n\n` +
      `Usa \`@bank /prompts\` para ver el catálogo completo.`
    );
    return;
  }

  // Resolve a concrete model — "auto" does not support sendRequest() directly
  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) return;

  await applyPrompt(match, userArg, stream, resolvedModel, token);
}

// ─── Catalog listing ─────────────────────────────────────────────────────────

function showPromptCatalog(
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  pageTitle: string
): void {
  stream.markdown(`## 📋 Prompt Library — *${pageTitle}*\n\n`);
  stream.markdown("Estos son los prompts disponibles. Usa `/prompts <nombre>` para aplicar uno con el archivo activo:\n\n");

  for (const t of templates) {
    stream.markdown(`### \`${t.name}\`\n${t.description}\n\n`);
  }

  stream.markdown(
    "---\n**Ejemplos de uso:**\n" +
    templates.slice(0, 3).map((t) => `- \`@bank /prompts ${t.name}\``).join("\n")
  );
}

// ─── Model resolver ───────────────────────────────────────────────────────────

/**
 * The "auto" model is Copilot's routing placeholder and does NOT support
 * sendRequest() from extensions. When it's detected, we fall back to the
 * first available GPT-4o / GPT-4 / any model via selectChatModels().
 */
async function resolveModel(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream
): Promise<vscode.LanguageModelChat | null> {
  log(`[PromptsHandler] resolveModel — incoming model: id="${model.id}" family="${model.family}" vendor="${model.vendor}"`);

  if (model.id !== "auto") {
    log(`[PromptsHandler] Using model as-is: "${model.id}"`);
    return model;
  }

  log(`[PromptsHandler] Model is "auto" — selecting concrete model via vscode.lm.selectChatModels()`);
  stream.progress("Seleccionando modelo de lenguaje…");

  // Try preferred models in order
  const candidates = [
    { vendor: "copilot", family: "gpt-4o" },
    { vendor: "copilot", family: "gpt-4" },
    { vendor: "copilot", family: "claude-sonnet" },
    {},  // any model
  ];

  for (const selector of candidates) {
    const models = await vscode.lm.selectChatModels(selector);
    log(`[PromptsHandler] selectChatModels(${JSON.stringify(selector)}) → ${models.length} models: [${models.map((m) => m.id).join(", ")}]`);
    if (models.length > 0) {
      log(`[PromptsHandler] Resolved model: "${models[0].id}" (${models[0].family})`);
      return models[0];
    }
  }

  logError("[PromptsHandler] No models available — cannot execute prompt");
  stream.markdown(
    "❌ No hay modelos de lenguaje disponibles.\n\n" +
    "Asegúrate de tener GitHub Copilot activo y haber iniciado sesión."
  );
  return null;
}

// ─── Apply a prompt ───────────────────────────────────────────────────────────

async function applyPrompt(
  template: PromptTemplate,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  log(`[PromptsHandler] applyPrompt — name: "${template.name}", model: "${model.id}", templateLength: ${template.template.length}`);

  // Read active editor file for context
  const editor = vscode.window.activeTextEditor;
  let fileContext = "";
  let fileName = "";

  if (editor) {
    fileName   = editor.document.fileName.split("/").pop() ?? "archivo";
    const lang = editor.document.languageId;
    const code = editor.document.getText();
    fileContext =
      `\n\n---\n## Archivo: \`${fileName}\`\n` +
      `\`\`\`${lang}\n${code}\n\`\`\``;
    log(`[PromptsHandler] Active file: "${fileName}" (${lang}), ${code.length} chars`);
    stream.progress(`Aplicando prompt "${template.name}" sobre "${fileName}"…`);
  } else {
    log(`[PromptsHandler] No active editor file`);
    stream.progress(`Aplicando prompt "${template.name}"…`);
  }

  const extraContext = userArg.replace(template.name, "").trim();
  if (extraContext) {
    log(`[PromptsHandler] Extra context: "${extraContext}"`);
  }

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un agente de estándares del banco integrado en VSCode. ` +
    `Usa formato Markdown. Responde en el mismo idioma que el usuario.`
  );

  const promptMsg = vscode.LanguageModelChatMessage.User(
    template.template +
    (extraContext ? `\n\nContexto adicional: ${extraContext}` : "") +
    fileContext
  );

  const totalChars = template.template.length + fileContext.length;
  log(`[PromptsHandler] Sending request — total prompt chars: ${totalChars}, model maxTokens: ${model.maxInputTokens}`);
  stream.markdown(`> 🎯 Prompt: **${template.name}**${fileName ? ` · archivo: \`${fileName}\`` : ""}\n\n`);

  try {
    const response = await model.sendRequest([systemMsg, promptMsg], {}, token);
    log(`[PromptsHandler] Stream started — reading response fragments…`);
    let fragmentCount = 0;
    for await (const fragment of response.text) {
      stream.markdown(fragment);
      fragmentCount++;
    }
    log(`[PromptsHandler] Stream complete — ${fragmentCount} fragments received`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[PromptsHandler] LanguageModelError — code: "${err.code}", message: "${err.message}"`, err);
      stream.markdown(
        `❌ Error del modelo (\`${err.code}\`): ${err.message}\n\n` +
        (err.code === "NotFound" || err.code === "noEndpointFound"
          ? "El modelo seleccionado no tiene endpoint disponible. Intenta abrir el chat de Copilot y seleccionar un modelo concreto (GPT-4o, Claude, etc.) antes de invocar el prompt."
          : "")
      );
    } else {
      logError("[PromptsHandler] Unexpected error in applyPrompt", err);
      throw err;
    }
  }
}

// ─── Fuzzy match ─────────────────────────────────────────────────────────────

/**
 * Finds the best matching template for the given query.
 * Tries exact match first, then prefix, then substring.
 */
function findBestMatch(query: string, templates: PromptTemplate[]): PromptTemplate | null {
  const q = query.toLowerCase().trim();

  // Exact match
  const exact = templates.find((t) => t.name === q);
  if (exact) return exact;

  // Prefix match (e.g. "rev" matches "review")
  const prefix = templates.find((t) => t.name.startsWith(q));
  if (prefix) return prefix;

  // Substring match on name or description
  const sub = templates.find(
    (t) => t.name.includes(q) || t.description.toLowerCase().includes(q)
  );
  return sub ?? null;
}
