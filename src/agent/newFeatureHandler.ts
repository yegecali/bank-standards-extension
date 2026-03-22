import * as vscode from "vscode";
import { log, logError } from "../logger";
import { JiraClient, getConfiguredProjects } from "../jira/client";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../notion/parser";
import { resolvePageId, getActiveSpecialty, PageType } from "./specialtyResolver";

/**
 * Orchestrates the /new-feature guided workflow:
 * 1. Validate Jira config
 * 2. List Jira issues → QuickPick selection
 * 3. Fetch full issue detail → display in chat
 * 4. LLM generates implementation plan (streamed)
 * 5. User confirmation via modal dialog
 * 6. Load company standards from knowledge base
 * 7. LLM guides implementation with standards context (streamed)
 * 8. Suggest commit message in Conventional Commits format
 */
export async function handleNewFeatureCommand(
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  context: vscode.ExtensionContext,
  specialty: string,
  token: vscode.CancellationToken
): Promise<void> {
  const config = vscode.workspace.getConfiguration("companyStandards");

  // ── PASO 1: Validate Jira configuration ──────────────────────────────────
  const jiraUrl   = config.get<string>("jiraUrl") ?? "";
  const jiraEmail = config.get<string>("jiraEmail") ?? "";
  const jiraToken = config.get<string>("jiraToken") ?? "";

  if (!jiraUrl || !jiraEmail || !jiraToken) {
    stream.markdown(
      `## ⚙️ Configura Jira primero\n\n` +
      `Para usar \`/new-feature\` necesitas configurar las credenciales de Jira en tus settings:\n\n` +
      `| Setting | Descripción |\n|---|---|\n` +
      `| \`companyStandards.jiraUrl\` | URL base de Jira (ej. \`https://tuempresa.atlassian.net\`) |\n` +
      `| \`companyStandards.jiraEmail\` | Email de tu cuenta Atlassian |\n` +
      `| \`companyStandards.jiraToken\` | API token de Jira (desde [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)) |\n` +
      `| \`companyStandards.jiraProject\` | Proyecto(s): \`"BANK"\` o \`["BANK","DEV"]\` |\n\n` +
      `Una vez configurado, vuelve a ejecutar \`@company /new-feature\`.`
    );
    return;
  }

  // Determine project key: from arg (e.g. "PROJ-123" or "PROJ"), or from settings
  const argTrimmed = userArg.trim().toUpperCase();
  let projectKey = "";

  // If user passed an issue key like "PROJ-123", extract project part
  const issueKeyMatch = argTrimmed.match(/^([A-Z][A-Z0-9]+)-\d+$/);
  if (issueKeyMatch) {
    projectKey = issueKeyMatch[1];
  } else if (argTrimmed.match(/^[A-Z][A-Z0-9]+$/)) {
    // User passed just a project key
    projectKey = argTrimmed;
  } else {
    // Fall back to configured projects (use first one for /new-feature)
    const configuredProjects = getConfiguredProjects();
    projectKey = configuredProjects[0] ?? "";
  }

  if (!projectKey) {
    stream.markdown(
      `⚠️ No hay un proyecto Jira configurado.\n\n` +
      `Configura \`companyStandards.jiraProject\` en tus settings, o pasa la clave del proyecto como argumento:\n` +
      `\`@company /new-feature MYPROJECT\``
    );
    return;
  }

  // ── PASO 2: List issues and let user pick ─────────────────────────────────
  stream.progress(`Obteniendo historias de Jira [${projectKey}]…`);
  log(`[NewFeature] Listing issues for project: ${projectKey}`);

  const client = new JiraClient();
  let issues;
  try {
    issues = await client.listIssues(projectKey);
  } catch (err: unknown) {
    logError("[NewFeature] Failed to list Jira issues", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude obtener las historias de Jira: **${msg}**`);
    return;
  }

  if (issues.length === 0) {
    stream.markdown(
      `ℹ️ No se encontraron historias abiertas en el proyecto **${projectKey}**.\n\n` +
      `Solo se muestran issues en estado "To Do" o "In Progress".`
    );
    return;
  }

  log(`[NewFeature] ${issues.length} issues found, showing QuickPick`);

  interface IssueQuickPickItem extends vscode.QuickPickItem {
    issueKey: string;
    issueSummary: string;
  }

  const items: IssueQuickPickItem[] = issues.map((issue) => ({
    label:        `$(issue-opened) ${issue.key}`,
    description:  issue.priority,
    detail:       issue.summary,
    issueKey:     issue.key,
    issueSummary: issue.summary,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:              `Selecciona una historia de ${projectKey}`,
    placeHolder:        "Escribe para filtrar…",
    matchOnDetail:      true,
    matchOnDescription: true,
  });

  if (!picked) {
    stream.markdown("Operación cancelada.");
    return;
  }

  log(`[NewFeature] User selected: ${picked.issueKey}`);

  // ── PASO 3: Fetch full issue detail ──────────────────────────────────────
  stream.progress(`Cargando detalle de ${picked.issueKey}…`);

  let issue;
  try {
    issue = await client.getIssue(picked.issueKey);
  } catch (err: unknown) {
    logError(`[NewFeature] Failed to fetch issue ${picked.issueKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la issue **${picked.issueKey}**: ${msg}`);
    return;
  }

  // Display issue detail in chat
  const labelsStr     = issue.labels.length ? issue.labels.join(", ") : "—";
  const storyPointStr = issue.storyPoints != null ? String(issue.storyPoints) : "—";

  stream.markdown(
    `## 📋 ${issue.key}: ${issue.summary}\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| **Estado** | ${issue.status} |\n` +
    `| **Prioridad** | ${issue.priority} |\n` +
    `| **Story Points** | ${storyPointStr} |\n` +
    `| **Labels** | ${labelsStr} |\n\n` +
    (issue.description
      ? `### Descripción\n\n${issue.description}\n\n`
      : "_Sin descripción._\n\n")
  );

  // ── PASO 4: LLM generates implementation plan ─────────────────────────────
  stream.progress("Generando plan de implementación…");
  stream.markdown(`---\n## 🗺️ Plan de implementación\n\n`);

  const planMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(
      "Eres un experto en arquitectura de software. Genera planes técnicos detallados y accionables."
    ),
    vscode.LanguageModelChatMessage.User(
      `Historia de Jira:\n` +
      `Clave: ${issue.key}\n` +
      `Título: ${issue.summary}\n` +
      `Estado: ${issue.status}\n` +
      `Prioridad: ${issue.priority}\n` +
      (issue.description ? `Descripción:\n${issue.description}\n` : "") +
      `\nGenera un plan de implementación técnica con:\n` +
      `1. Componentes a crear o modificar\n` +
      `2. Endpoints o funciones necesarias\n` +
      `3. Tests necesarios\n` +
      `4. Estimación de complejidad (baja/media/alta)\n\n` +
      `Responde en el mismo idioma que el título de la historia.`
    ),
  ];

  let planText = "";
  try {
    log("[NewFeature] Requesting implementation plan from LLM");
    const planResponse = await model.sendRequest(planMessages, {}, token);
    for await (const fragment of planResponse.text) {
      stream.markdown(fragment);
      planText += fragment;
    }
    log(`[NewFeature] Plan generated: ${planText.length} chars`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[NewFeature] LLM error (plan) — code: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo al generar el plan: ${err.message}`);
      return;
    }
    throw err;
  }

  // ── PASO 5: User confirmation ─────────────────────────────────────────────
  log("[NewFeature] Waiting for user confirmation");
  const answer = await vscode.window.showInformationMessage(
    `¿Proceder con la implementación de ${issue.key}: "${issue.summary}"?`,
    { modal: true },
    "Sí, continuar",
    "Cancelar"
  );

  if (answer !== "Sí, continuar") {
    stream.markdown("\n\n---\nImplementación cancelada por el usuario.");
    return;
  }

  log("[NewFeature] User confirmed — proceeding with implementation");

  // ── PASO 6: Load company standards ───────────────────────────────────────
  stream.progress("Cargando estándares de la compañía…");

  const standardsPageId = resolvePageId("standards" as PageType, specialty);
  let standardsMarkdown = "";

  if (standardsPageId) {
    try {
      const provider = createKnowledgeProvider();
      log(`[NewFeature] Loading standards page: ${standardsPageId}`);
      const page      = await provider.getPage(standardsPageId);
      standardsMarkdown = blocksToMarkdown(page.blocks);
      log(`[NewFeature] Standards loaded: ${standardsMarkdown.length} chars`);
    } catch (err: unknown) {
      logError("[NewFeature] Failed to load standards", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`\n⚠️ No pude cargar los estándares: ${msg}. Continuando sin ellos.\n`);
    }
  } else {
    log(`[NewFeature] No standards page configured for specialty: ${specialty}`);
    stream.markdown(
      `\n> ℹ️ No hay página de estándares configurada para la especialidad **${specialty}**. ` +
      `Configura \`companyStandards.specialtiesMap.${specialty}.standards\` para incluirlos.\n\n`
    );
  }

  // ── PASO 7: LLM guides implementation with standards context ──────────────
  stream.markdown(`\n---\n## 🚀 Guía de implementación\n\n`);
  stream.progress("Generando guía de implementación con estándares…");

  const implSystemPrompt =
    `Eres un asistente de implementación integrado en VSCode que sigue los estándares de la compañía.` +
    (standardsMarkdown
      ? `\n\nEstándares de la compañía:\n${standardsMarkdown}`
      : "");

  const implMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(implSystemPrompt),
    vscode.LanguageModelChatMessage.User(
      `Historia: ${issue.key} — ${issue.summary}\n\n` +
      `Plan de implementación aprobado:\n${planText}\n\n` +
      `Guía la implementación paso a paso, aplicando los estándares de la compañía. ` +
      `Indica qué archivos crear, qué convenciones usar, y proporciona ejemplos de código. ` +
      `Responde en el mismo idioma que la historia.`
    ),
  ];

  try {
    log("[NewFeature] Requesting implementation guidance from LLM");
    const implResponse = await model.sendRequest(implMessages, {}, token);
    for await (const fragment of implResponse.text) {
      stream.markdown(fragment);
    }
    log("[NewFeature] Implementation guidance complete");
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[NewFeature] LLM error (impl) — code: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo al generar la guía: ${err.message}`);
      return;
    }
    throw err;
  }

  // ── PASO 8: Suggest commit message ────────────────────────────────────────
  const scope       = projectKey.toLowerCase();
  const summarySlug = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);

  stream.markdown(
    `\n---\n## 💬 Mensaje de commit sugerido\n\n` +
    `\`\`\`\n` +
    `feat(${scope}): ${summarySlug} — ${issue.key}\n` +
    `\`\`\`\n\n` +
    `> Formato: [Conventional Commits](https://www.conventionalcommits.org/) · ` +
    `\`feat(scope): description — ISSUE-KEY\``
  );

  stream.button({ title: "Actualizar estándares", command: "companyStandards.refreshStandards" });

  log(`[NewFeature] Flow complete for ${issue.key}`);
}
