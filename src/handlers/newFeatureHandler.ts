import * as vscode from "vscode";
import { log, logError } from "../logger";
import { JiraClient, JiraIssue, getConfiguredProjects } from "../jira/client";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../notion/parser";
import { resolvePageId, PageType } from "../agent/specialtyResolver";
import { BATCH, EXCLUDE_GLOB, SRC_EXTENSIONS } from "../config/defaults";

/**
 * Orchestrates the /new-feature guided workflow:
 * 1. Validate Jira config
 * 2. List Jira issues → QuickPick selection
 * 3. Fetch full issue detail → display in chat
 * 3b. Scan workspace context (pom.xml + key source files)
 * 4. LLM generates implementation plan with real project context (streamed)
 * 5. User confirmation via modal dialog
 * 5b. Offer Jira back-integration: transition + create subtasks from plan
 * 6. Load company standards from knowledge base
 * 7. LLM guides implementation with standards + workspace context (streamed)
 * 8. Suggest commit message in Conventional Commits format
 */
export async function handleNewFeatureCommand(
  userArg:   string,
  stream:    vscode.ChatResponseStream,
  model:     vscode.LanguageModelChat,
  _context:  vscode.ExtensionContext,
  specialty: string,
  token:     vscode.CancellationToken
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
      `| \`companyStandards.jiraToken\` | API token de Jira |\n` +
      `| \`companyStandards.jiraProject\` | Proyecto(s): \`"BANK"\` o \`["BANK","DEV"]\` |\n\n` +
      `Una vez configurado, vuelve a ejecutar \`@company /new-feature\`.`
    );
    return;
  }

  // Determine project key from arg or settings
  const argTrimmed = userArg.trim().toUpperCase();
  let projectKey   = "";

  const issueKeyMatch = argTrimmed.match(/^([A-Z][A-Z0-9]+)-\d+$/);
  if (issueKeyMatch) {
    projectKey = issueKeyMatch[1];
  } else if (argTrimmed.match(/^[A-Z][A-Z0-9]+$/)) {
    projectKey = argTrimmed;
  } else {
    projectKey = getConfiguredProjects()[0] ?? "";
  }

  if (!projectKey) {
    stream.markdown(
      `⚠️ No hay un proyecto Jira configurado.\n\n` +
      `Configura \`companyStandards.jiraProject\` en tus settings, o pasa la clave:\n` +
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
    issues = await client.listIssues([projectKey]);
  } catch (err: unknown) {
    logError("[NewFeature] Failed to list Jira issues", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude obtener las historias de Jira: **${msg}**`);
    return;
  }

  if (issues.length === 0) {
    stream.markdown(
      `ℹ️ No se encontraron historias abiertas en el proyecto **${projectKey}**.`
    );
    return;
  }

  interface IssuePickItem extends vscode.QuickPickItem { issueKey: string; }

  const picked = await vscode.window.showQuickPick(
    issues.map((i): IssuePickItem => ({
      label:       `$(issue-opened) ${i.key}`,
      description: i.priority,
      detail:      i.summary,
      issueKey:    i.key,
    })),
    { title: `Selecciona una historia de ${projectKey}`, placeHolder: "Escribe para filtrar…", matchOnDetail: true }
  );

  if (!picked) { stream.markdown("Operación cancelada."); return; }
  log(`[NewFeature] User selected: ${picked.issueKey}`);

  // ── PASO 3: Fetch full issue detail ──────────────────────────────────────
  stream.progress(`Cargando detalle de ${picked.issueKey}…`);
  let issue: JiraIssue;
  try {
    issue = await client.getIssue(picked.issueKey);
  } catch (err: unknown) {
    logError(`[NewFeature] Failed to fetch issue ${picked.issueKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la issue **${picked.issueKey}**: ${msg}`);
    return;
  }

  stream.markdown(
    `## 📋 ${issue.key}: ${issue.summary}\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| **Estado** | ${issue.status} |\n` +
    `| **Prioridad** | ${issue.priority} |\n` +
    `| **Story Points** | ${issue.storyPoints ?? "—"} |\n` +
    `| **Labels** | ${issue.labels.length ? issue.labels.join(", ") : "—"} |\n\n` +
    (issue.description ? `### Descripción\n\n${issue.description}\n\n` : "_Sin descripción._\n\n")
  );

  // ── PASO 3b: Scan workspace context ──────────────────────────────────────
  stream.progress("Escaneando estructura del proyecto…");
  const workspaceCtx = await scanWorkspaceContext();

  if (workspaceCtx) {
    stream.markdown(
      `> 🗂️ Contexto del proyecto cargado (${workspaceCtx.fileCount} archivos clave escaneados)\n\n`
    );
  }

  // ── PASO 4: LLM generates implementation plan ─────────────────────────────
  stream.progress("Generando plan de implementación…");
  stream.markdown(`---\n## 🗺️ Plan de implementación\n\n`);

  const workspaceSection = workspaceCtx
    ? `\n\n## Contexto real del proyecto\n\n${workspaceCtx.summary}`
    : "";

  const planMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(
      "Eres un experto en arquitectura de software. Genera planes técnicos detallados y accionables, " +
      "mencionando los archivos reales del proyecto cuando sea posible."
    ),
    vscode.LanguageModelChatMessage.User(
      `Historia de Jira:\n` +
      `Clave: ${issue.key}\n` +
      `Título: ${issue.summary}\n` +
      `Estado: ${issue.status}\n` +
      `Prioridad: ${issue.priority}\n` +
      (issue.description ? `Descripción:\n${issue.description}\n` : "") +
      workspaceSection +
      `\n\nGenera un plan de implementación técnica detallado con:\n` +
      `1. Archivos a crear o modificar (usa los nombres reales del proyecto si los conoces)\n` +
      `2. Endpoints o funciones a implementar\n` +
      `3. Subtareas concretas numeradas (cada una: una tarea de código específica)\n` +
      `4. Tests necesarios\n` +
      `5. Estimación de complejidad (baja/media/alta)\n\n` +
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
      logError(`[NewFeature] LLM error (plan): ${err.code}`, err);
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

  log("[NewFeature] User confirmed — proceeding");

  // ── PASO 5b: Jira back-integration ───────────────────────────────────────
  await offerJiraBackIntegration(issue.key, issue.summary, projectKey, planText, client, stream);

  // ── PASO 6: Load company standards ───────────────────────────────────────
  stream.progress("Cargando estándares de la compañía…");
  const standardsPageId = resolvePageId("standards" as PageType, specialty);
  let standardsMarkdown = "";

  if (standardsPageId) {
    try {
      const provider    = createKnowledgeProvider();
      const page        = await provider.getPage(standardsPageId);
      standardsMarkdown = blocksToMarkdown(page.blocks);
      log(`[NewFeature] Standards loaded: ${standardsMarkdown.length} chars`);
    } catch (err: unknown) {
      logError("[NewFeature] Failed to load standards", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`\n⚠️ No pude cargar los estándares: ${msg}. Continuando sin ellos.\n`);
    }
  } else {
    stream.markdown(
      `\n> ℹ️ No hay página de estándares configurada para **${specialty}**. ` +
      `Configura \`companyStandards.specialtiesMap.${specialty}.standards\` para incluirlos.\n\n`
    );
  }

  // ── PASO 7: LLM guides implementation ────────────────────────────────────
  stream.markdown(`\n---\n## 🚀 Guía de implementación\n\n`);
  stream.progress("Generando guía de implementación…");

  const systemPrompt =
    `Eres un asistente de implementación integrado en VSCode que sigue los estándares de la compañía.` +
    (standardsMarkdown ? `\n\nEstándares de la compañía:\n${standardsMarkdown.slice(0, 3_500)}` : "") +
    (workspaceCtx      ? `\n\nEstructura real del proyecto:\n${workspaceCtx.summary.slice(0, 2_000)}` : "");

  const implMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(systemPrompt),
    vscode.LanguageModelChatMessage.User(
      `Historia: ${issue.key} — ${issue.summary}\n\n` +
      `Plan de implementación aprobado:\n${planText}\n\n` +
      `Guía la implementación paso a paso aplicando los estándares. ` +
      `Indica qué archivos crear/modificar (usa los nombres reales del proyecto), ` +
      `qué convenciones usar, y proporciona ejemplos de código listos para usar. ` +
      `Responde en el mismo idioma que la historia.`
    ),
  ];

  try {
    log("[NewFeature] Requesting implementation guidance from LLM");
    const implResponse = await model.sendRequest(implMessages, {}, token);
    for await (const fragment of implResponse.text) { stream.markdown(fragment); }
    log("[NewFeature] Implementation guidance complete");
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[NewFeature] LLM error (impl): ${err.code}`, err);
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
    `\`\`\`\nfeat(${scope}): ${summarySlug} — ${issue.key}\n\`\`\`\n\n` +
    `_Usa \`@company /commit\` después de stagear tus cambios para un mensaje más preciso._`
  );

  log(`[NewFeature] Flow complete for ${issue.key}`);
}

// ─── Jira back-integration ────────────────────────────────────────────────────

async function offerJiraBackIntegration(
  issueKey:   string,
  issueSummary: string,
  projectKey: string,
  planText:   string,
  client:     JiraClient,
  stream:     vscode.ChatResponseStream
): Promise<void> {
  // Parse subtask candidates from plan (numbered/bulleted items)
  const subtaskCandidates = parsePlanSubtasks(planText);

  const options = [
    {
      label:       "$(sync) Mover a In Progress + Crear subtareas en Jira",
      description: `${subtaskCandidates.length} subtareas detectadas en el plan`,
      value:       "both",
    },
    {
      label:       "$(issue-opened) Solo mover a In Progress",
      description: "",
      value:       "transition",
    },
    {
      label:       "$(add) Solo crear subtareas",
      description: `${subtaskCandidates.length} subtareas detectadas`,
      value:       "subtasks",
    },
    {
      label:       "$(close) Continuar sin cambios en Jira",
      description: "",
      value:       "skip",
    },
  ];

  const picked = await vscode.window.showQuickPick(options, {
    title:       `¿Qué quieres hacer en Jira con ${issueKey}?`,
    placeHolder: "Selecciona una acción…",
  });

  if (!picked || picked.value === "skip") {
    stream.markdown("\n> _Sin cambios en Jira._\n\n");
    return;
  }

  stream.markdown(`\n---\n## 🔗 Actualizando Jira…\n\n`);

  // ── Transition to In Progress ─────────────────────────────────────────────
  if (picked.value === "both" || picked.value === "transition") {
    try {
      const transitions = await client.getTransitions(issueKey);
      const inProgress  = transitions.find((t) =>
        t.name.toLowerCase().includes("in progress") ||
        t.name.toLowerCase().includes("en progreso") ||
        t.name.toLowerCase().includes("en curso")
      );

      if (inProgress) {
        await client.transitionIssue(issueKey, inProgress.id);
        stream.markdown(`- ✅ **${issueKey}** movida a **${inProgress.name}**\n`);
        log(`[NewFeature] Transitioned ${issueKey} → ${inProgress.name}`);
      } else {
        // Let user pick
        interface TransPickItem extends vscode.QuickPickItem { id: string; transName: string; }
        const transPicked = await vscode.window.showQuickPick(
          transitions.map((t): TransPickItem => ({
            label:     `$(sync) ${t.name}`,
            id:        t.id,
            transName: t.name,
          })),
          { title: `Selecciona el estado destino para ${issueKey}`, placeHolder: "¿A qué estado mover?" }
        );
        if (transPicked) {
          await client.transitionIssue(issueKey, transPicked.id);
          stream.markdown(`- ✅ **${issueKey}** movida a **${transPicked.transName}**\n`);
        }
      }
    } catch (err: unknown) {
      logError(`[NewFeature] Failed to transition ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`- ⚠️ No pude mover la issue: ${msg}\n`);
    }
  }

  // ── Create subtasks ───────────────────────────────────────────────────────
  if ((picked.value === "both" || picked.value === "subtasks") && subtaskCandidates.length > 0) {
    // Multi-select: user picks which subtasks to create
    interface SubtaskPickItem extends vscode.QuickPickItem { summary: string; }

    const subtaskItems: SubtaskPickItem[] = subtaskCandidates.map((s) => ({
      label:   `$(add) ${s.slice(0, 80)}`,
      picked:  true,   // all pre-selected
      summary: s,
    }));

    const selectedItems = await vscode.window.showQuickPick(subtaskItems, {
      title:        `Subtareas a crear en ${issueKey}`,
      placeHolder:  "Desmarca las que NO quieres crear…",
      canPickMany:  true,
    });

    if (!selectedItems || selectedItems.length === 0) {
      stream.markdown(`- _Creación de subtareas cancelada._\n`);
    } else {
      let created = 0;
      for (const item of selectedItems) {
        try {
          const newKey = await client.createSubtask(issueKey, projectKey, item.summary);
          stream.markdown(`- ✅ Subtarea creada: **${newKey}** — ${item.summary.slice(0, 60)}\n`);
          created++;
          log(`[NewFeature] Subtask created: ${newKey}`);
        } catch (err: unknown) {
          logError(`[NewFeature] Failed to create subtask: ${item.summary}`, err);
          const msg = err instanceof Error ? err.message : String(err);
          stream.markdown(`- ⚠️ No pude crear: "${item.summary.slice(0, 40)}…" — ${msg}\n`);
        }
      }
      stream.markdown(`\n_${created} subtarea(s) creadas en **${issueKey}**._\n\n`);
    }
  } else if ((picked.value === "both" || picked.value === "subtasks") && subtaskCandidates.length === 0) {
    stream.markdown(`- ⚠️ No se detectaron subtareas en el plan. Crea las subtareas manualmente con \`@company /jira\`.\n`);
  }
}

// ─── Workspace context scanner ────────────────────────────────────────────────

interface WorkspaceContext {
  summary:   string;
  fileCount: number;
}

async function scanWorkspaceContext(): Promise<WorkspaceContext | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return null; }

  const root  = folders[0].uri;
  const parts: string[] = [];
  let   fileCount = 0;

  // Read pom.xml or package.json for project metadata
  for (const buildFile of ["pom.xml", "package.json", "build.gradle"]) {
    try {
      const uri     = vscode.Uri.joinPath(root, buildFile);
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, 2_500);
      parts.push(`### ${buildFile}\n\`\`\`\n${content}\n\`\`\``);
      fileCount++;
      break; // only first found
    } catch { /* not found */ }
  }

  // Find up to 5 key source files by layer priority
  try {
    const layerKeywords = ["controller", "resource", "router", "service", "repository", "gateway"];
    const uris = await vscode.workspace.findFiles(
      `**/*.{${SRC_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`,
      EXCLUDE_GLOB,
      BATCH.MAX_FILES
    );

    // Score and sort by layer priority
    const scored = uris.map((uri) => {
      const name  = uri.path.split("/").pop()?.toLowerCase() ?? "";
      const score = layerKeywords.reduce((s, kw, i) =>
        name.includes(kw) ? s + (layerKeywords.length - i) * 3 : s, 0
      );
      return { uri, score };
    }).sort((a, b) => b.score - a.score);

    // Read top 5 files, truncated to method signatures only
    for (const { uri } of scored.slice(0, 5)) {
      try {
        const bytes   = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf-8").slice(0, 1_800);
        const relPath = vscode.workspace.asRelativePath(uri);
        parts.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
        fileCount++;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (parts.length === 0) { return null; }

  return {
    summary:   parts.join("\n\n"),
    fileCount,
  };
}

// ─── Plan subtask parser ──────────────────────────────────────────────────────

/** Extracts numbered/bulleted task items from a plan text. */
function parsePlanSubtasks(planText: string): string[] {
  const results: string[] = [];
  const lines = planText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Match: "1. Something", "- Something", "* Something", "• Something"
    const match = trimmed.match(/^(?:\d+[.)]\s+|[-*•]\s+)(.+)$/);
    if (!match) { continue; }

    const text = match[1].trim();

    // Filter: skip short/meta lines and headings
    if (text.length < 10) { continue; }
    if (/^(componente|tests?|endpoint|archivo|estimaci|complej|baja|media|alta|ver|see|note|notas?)/i.test(text)) { continue; }
    if (text.startsWith("#")) { continue; }

    results.push(text);
  }

  // Deduplicate and limit to 12
  return [...new Set(results)].slice(0, 12);
}
