import * as vscode from "vscode";
import { PromptTemplate } from "../notion/parser";

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
  if (templates.length === 0) {
    stream.markdown(
      "⚠️ No encontré prompts en la página de Notion.\n\n" +
      "Asegúrate de que la página tenga el formato correcto:\n\n" +
      "```\n## nombre-del-prompt\nDescripción breve.\n```\nPlantilla del prompt\n```\n```"
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
  if (!match) {
    stream.markdown(
      `No encontré un prompt que coincida con **"${userArg}"**.\n\n` +
      `Prompts disponibles: ${templates.map((t) => `\`${t.name}\``).join(", ")}\n\n` +
      `Usa \`@bank /prompts\` para ver el catálogo completo.`
    );
    return;
  }

  await applyPrompt(match, userArg, stream, model, token);
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

// ─── Apply a prompt ───────────────────────────────────────────────────────────

async function applyPrompt(
  template: PromptTemplate,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
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
    stream.progress(`Aplicando prompt "${template.name}" sobre "${fileName}"…`);
  } else {
    stream.progress(`Aplicando prompt "${template.name}"…`);
  }

  // Extra instructions typed after the prompt name become additional context
  const extraContext = userArg.replace(template.name, "").trim();

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un agente de estándares del banco integrado en VSCode. ` +
    `Usa formato Markdown. Responde en el mismo idioma que el usuario.`
  );

  const promptMsg = vscode.LanguageModelChatMessage.User(
    template.template +
    (extraContext ? `\n\nContexto adicional: ${extraContext}` : "") +
    fileContext
  );

  stream.markdown(`> 🎯 Prompt: **${template.name}**${fileName ? ` · archivo: \`${fileName}\`` : ""}\n\n`);

  try {
    const response = await model.sendRequest([systemMsg, promptMsg], {}, token);
    for await (const fragment of response.text) {
      stream.markdown(fragment);
    }
  } catch (err: any) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`❌ Error del modelo: ${err.message}`);
    } else {
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
