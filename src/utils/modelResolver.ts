import * as vscode from "vscode";

/**
 * Resolves a usable LanguageModelChat from the given model or falls back
 * through GPT-4o → GPT-4 → Claude Sonnet → any available model.
 *
 * Returns null (and writes an error message to the stream) if no model is found.
 */
export async function resolveModel(
  model:  vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream
): Promise<vscode.LanguageModelChat | null> {
  if (model.id !== "auto") { return model; }

  stream.progress("Seleccionando modelo de lenguaje…");

  for (const selector of [
    { vendor: "copilot", family: "gpt-4o" },
    { vendor: "copilot", family: "gpt-4" },
    { vendor: "copilot", family: "claude-sonnet" },
    {},
  ]) {
    const models = await vscode.lm.selectChatModels(selector);
    if (models.length > 0) { return models[0]; }
  }

  stream.markdown("❌ No hay modelos de lenguaje disponibles. Activa GitHub Copilot.");
  return null;
}
