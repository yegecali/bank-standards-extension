import * as vscode from "vscode";
import { KnowledgeProvider } from "../knowledge/KnowledgeProvider";
import { blocksToMarkdown } from "../knowledge/parser";
import { resolveModel } from "../utils/modelResolver";
import { log, logError } from "../logger";

/**
 * Shows a VS Code QuickPick listing the child pages of parentPageId.
 * On selection, fetches the full page content and returns title + markdown.
 * Returns null if the provider doesn't support getChildPages, the list is
 * empty, or the user cancels.
 */
export async function pickAndLoadChildPage(
  parentPageId: string,
  pickerTitle: string,
  stream: vscode.ChatResponseStream,
  provider: KnowledgeProvider
): Promise<{ id: string; title: string; markdown: string } | null> {
  if (!provider.getChildPages) {
    stream.markdown(
      `⚠️ El proveedor de conocimiento actual (**${provider.name}**) no soporta páginas hijas.\n\n` +
      `Configura **Confluence** como fuente en \`companyStandards.knowledgeSource\`.`
    );
    return null;
  }

  stream.progress(`Cargando páginas de "${pickerTitle}"…`);

  let children: Array<{ id: string; title: string }>;
  try {
    const metas  = await provider.getChildPages(parentPageId);
    children = metas.map((m) => ({ id: m.id, title: m.title }));
  } catch (err: unknown) {
    logError(`[ChildPageHandler] Failed to list children of ${parentPageId}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar las páginas de **${pickerTitle}**: ${msg}`);
    return null;
  }

  if (children.length === 0) {
    stream.markdown(`ℹ️ La página **"${pickerTitle}"** no tiene subpáginas configuradas.`);
    return null;
  }

  interface PagePickItem extends vscode.QuickPickItem { pageId: string; }

  const items: PagePickItem[] = children.map((c) => ({
    label:  c.title,
    pageId: c.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:       pickerTitle,
    placeHolder: "Selecciona una opción…",
  });

  if (!picked) {
    stream.markdown("_Operación cancelada._");
    return null;
  }

  stream.progress(`Cargando "${picked.label}"…`);

  let markdown: string;
  try {
    const page = await provider.getPage(picked.pageId);
    markdown   = blocksToMarkdown(page.blocks);
    log(`[ChildPageHandler] Loaded "${page.title}" — ${markdown.length} chars`);
  } catch (err: unknown) {
    logError(`[ChildPageHandler] Failed to load page ${picked.pageId}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la página **"${picked.label}"**: ${msg}`);
    return null;
  }

  return { id: picked.pageId, title: picked.label, markdown };
}

// ─── /prompts: full interactive flow ─────────────────────────────────────────

/**
 * Full interactive flow for /prompts:
 * 1. QuickPick — lists child pages of the prompts parent with descriptions
 * 2. Loads the selected page and shows a brief preview in the chat
 * 3. InputBox — asks the user what they want to request with this prompt
 * 4. Applies: prompt content + user context + active file → LLM
 */
export async function handlePromptsChildPageFlow(
  parentPageId: string,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  provider: KnowledgeProvider
): Promise<void> {
  if (!provider.getChildPages) {
    stream.markdown(
      `⚠️ El proveedor de conocimiento actual (**${provider.name}**) no soporta páginas hijas.\n\n` +
      `Configura **Confluence** como fuente en \`companyStandards.knowledgeSource\`.`
    );
    return;
  }

  // ── 1. Load child page list ────────────────────────────────────────────────
  stream.progress("Cargando biblioteca de prompts…");

  let children: Array<{ id: string; title: string }>;
  try {
    const metas = await provider.getChildPages(parentPageId);
    children    = metas.map((m) => ({ id: m.id, title: m.title }));
  } catch (err: unknown) {
    logError("[PromptsFlow] Failed to list prompt pages", err);
    stream.markdown(`❌ No pude cargar los prompts: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (children.length === 0) {
    stream.markdown("ℹ️ La página de prompts no tiene subpáginas configuradas.");
    return;
  }

  // ── 2. QuickPick: select prompt ────────────────────────────────────────────
  interface PromptPickItem extends vscode.QuickPickItem { pageId: string; }

  const items: PromptPickItem[] = children.map((c) => ({
    label:   c.title,
    pageId:  c.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:       "Biblioteca de Prompts — Selecciona un prompt",
    placeHolder: "Escribe para filtrar…",
  });

  if (!picked) {
    stream.markdown("_Operación cancelada._");
    return;
  }

  // ── 3. Load full page content ──────────────────────────────────────────────
  stream.progress(`Cargando prompt "${picked.label}"…`);

  let pageMarkdown: string;
  try {
    const page   = await provider.getPage(picked.pageId);
    pageMarkdown = blocksToMarkdown(page.blocks);
    log(`[PromptsFlow] Loaded "${page.title}" — ${pageMarkdown.length} chars`);
  } catch (err: unknown) {
    logError(`[PromptsFlow] Failed to load page ${picked.pageId}`, err);
    stream.markdown(`❌ No pude cargar el prompt **"${picked.label}"**: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── 4. Show prompt preview in chat ─────────────────────────────────────────
  const preview = extractPreview(pageMarkdown);
  stream.markdown(
    `## 📋 ${picked.label}\n\n` +
    `> ${preview}\n\n` +
    `---\n\n`
  );

  // ── 5. InputBox: ask what the user wants to request ────────────────────────
  const userContext = await vscode.window.showInputBox({
    title:          `Prompt: ${picked.label}`,
    prompt:         "¿Qué le quieres pedir a este prompt? (deja vacío para ejecutar el prompt base)",
    placeHolder:    "Ej: Analiza el método createUser() buscando problemas de seguridad",
    value:          userArg,    // pre-fill if user typed something after /prompts
    ignoreFocusOut: true,
  });

  if (userContext === undefined) {
    // User pressed Esc
    stream.markdown("_Operación cancelada._");
    return;
  }

  // ── 6. Apply prompt ────────────────────────────────────────────────────────
  await applyChildPageAsPrompt(picked.label, pageMarkdown, userContext.trim(), stream, model, token);
}

/** Extracts the first meaningful paragraph from markdown for the preview */
function extractPreview(markdown: string): string {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("```"));
  return (lines[0] ?? "Sin descripción").slice(0, 250);
}

// ─── Apply as prompt ──────────────────────────────────────────────────────────

/**
 * Applies the selected prompt page against the active editor file.
 * Used by /prompts with child-page flow.
 */
export async function applyChildPageAsPrompt(
  pageTitle: string,
  pageMarkdown: string,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const editor = vscode.window.activeTextEditor;
  let fileContext = "";
  let fileName    = "";

  if (editor) {
    fileName   = editor.document.fileName.split("/").pop() ?? "archivo";
    const lang = editor.document.languageId;
    const code = editor.document.getText();
    fileContext = `\n\n---\n## Archivo: \`${fileName}\`\n\`\`\`${lang}\n${code}\n\`\`\``;
    stream.progress(`Aplicando "${pageTitle}" sobre "${fileName}"…`);
  } else {
    stream.progress(`Aplicando prompt "${pageTitle}"…`);
  }

  stream.markdown(`> 🎯 Prompt: **${pageTitle}**${fileName ? ` · archivo: \`${fileName}\`` : ""}\n\n`);

  const msg = vscode.LanguageModelChatMessage.User(
    pageMarkdown +
    (userArg ? `\n\nContexto adicional: ${userArg}` : "") +
    fileContext
  );

  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const fragment of resp.text) { stream.markdown(fragment); }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[ChildPageHandler] LLM error: ${err.code}`, err);
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[ChildPageHandler] Unexpected LLM error", err);
    }
  }
}

// ─── Apply as dev-tool guide ──────────────────────────────────────────────────

/**
 * Shows the selected dev-tool guide and applies it with the LLM.
 * Used by /project with child-page flow.
 */
export async function applyChildPageAsGuide(
  pageTitle: string,
  pageMarkdown: string,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  stream.markdown(`## 📋 ${pageTitle}\n\n${pageMarkdown}\n\n---\n\n`);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const editor = vscode.window.activeTextEditor;
  const fileContext = editor
    ? `\n\n---\n## Archivo activo: \`${editor.document.fileName.split("/").pop()}\`\n` +
      `\`\`\`${editor.document.languageId}\n${editor.document.getText()}\n\`\`\``
    : "";

  const instruction =
    userArg
      ? `El usuario pregunta: ${userArg}\n\nResponde usando la guía anterior como referencia.`
      : `Explica brevemente cómo aplicar esta guía al proyecto activo y cuáles son los pasos clave.`;

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un agente de desarrollo. Tienes la siguiente guía de "${pageTitle}":\n\n` +
    pageMarkdown +
    fileContext +
    `\n\n${instruction}`
  );

  stream.progress(`Generando respuesta para "${pageTitle}"…`);
  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const fragment of resp.text) { stream.markdown(fragment); }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[ChildPageHandler] LLM error: ${err.code}`, err);
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[ChildPageHandler] Unexpected LLM error", err);
    }
  }
}

// ─── Apply as standard ────────────────────────────────────────────────────────

/**
 * Evaluates the active file against the selected standard.
 * Used by /standards with child-page flow.
 */
export async function applyChildPageAsStandard(
  pageTitle: string,
  pageMarkdown: string,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const editor = vscode.window.activeTextEditor;
  let fileContext = "";
  let fileName    = "";

  if (editor) {
    fileName   = editor.document.fileName.split("/").pop() ?? "archivo";
    const lang = editor.document.languageId;
    const code = editor.document.getText();
    fileContext = `\n\n---\n## Archivo a evaluar: \`${fileName}\`\n\`\`\`${lang}\n${code}\n\`\`\``;
    stream.progress(`Evaluando "${fileName}" contra estándar "${pageTitle}"…`);
  } else {
    stream.progress(`Mostrando estándar "${pageTitle}"…`);
    stream.markdown(`## 📐 ${pageTitle}\n\n${pageMarkdown}`);
    return;
  }

  stream.markdown(`> 📐 Estándar: **${pageTitle}** · archivo: \`${fileName}\`\n\n`);

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un revisor de estándares de desarrollo. Evalúa el archivo adjunto contra el siguiente estándar.\n\n` +
    `ESTÁNDAR — ${pageTitle}:\n${pageMarkdown}\n\n` +
    `INSTRUCCIONES:\n` +
    `1. Lista qué cumple el archivo ✅\n` +
    `2. Lista qué NO cumple o puede mejorar ❌ / ⚠️\n` +
    `3. Para cada incumplimiento, muestra el fragmento problemático y cómo corregirlo\n` +
    `4. Da una puntuación de cumplimiento: X/10\n` +
    (userArg ? `\nContexto adicional: ${userArg}\n` : "") +
    fileContext
  );

  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const fragment of resp.text) { stream.markdown(fragment); }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[ChildPageHandler] LLM error: ${err.code}`, err);
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[ChildPageHandler] Unexpected LLM error", err);
    }
  }
}
