import * as vscode from "vscode";
import { log, logError } from "../logger";
import { JiraClient, JiraIssue, getConfiguredProjects } from "../jira/client";

const JIRA_CONFIG_HELP =
  `## ⚙️ Configura Jira primero\n\n` +
  `Para usar \`/jira\` necesitas configurar las credenciales en tus settings:\n\n` +
  `| Setting | Descripción |\n|---|---|\n` +
  `| \`companyStandards.jiraUrl\` | URL base de Jira (ej. \`https://tuempresa.atlassian.net\`) |\n` +
  `| \`companyStandards.jiraEmail\` | Email de tu cuenta Atlassian |\n` +
  `| \`companyStandards.jiraToken\` | API token ([id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)) |\n` +
  `| \`companyStandards.jiraProject\` | Proyecto(s) por defecto: \`"BANK"\` o \`["BANK","DEV"]\` |\n\n` +
  `Una vez configurado, vuelve a ejecutar \`@company /jira\`.`;

const USAGE_HELP =
  `ℹ️ **Uso de \`/jira\`:**\n\n` +
  `| Comando | Acción |\n|---|---|\n` +
  `| \`/jira\` | Listar issues en progreso de los proyectos configurados |\n` +
  `| \`/jira PROJ-123\` | Ver detalle de una issue |\n` +
  `| \`/jira subtasks PROJ-123\` | Listar mis subtareas asignadas en una issue |\n` +
  `| \`/jira create PROJ-123\` | Crear una subtarea en una issue |`;

/**
 * Main handler for the @company /jira command.
 * Routes to sub-actions based on the user argument.
 */
export async function handleJiraCommand(
  userArg: string,
  stream: vscode.ChatResponseStream,
  _context: vscode.ExtensionContext,
  _token: vscode.CancellationToken
): Promise<void> {
  const config = vscode.workspace.getConfiguration("companyStandards");
  const jiraUrl   = config.get<string>("jiraUrl") ?? "";
  const jiraEmail = config.get<string>("jiraEmail") ?? "";
  const jiraToken = config.get<string>("jiraToken") ?? "";

  if (!jiraUrl || !jiraEmail || !jiraToken) {
    stream.markdown(JIRA_CONFIG_HELP);
    return;
  }

  const arg = userArg.trim();

  // Route by argument pattern
  if (!arg || arg.toLowerCase() === "list") {
    await listAndPickIssue(stream);
    return;
  }

  const issueKeyPattern = /^[A-Z][A-Z0-9]+-\d+$/i;

  if (issueKeyPattern.test(arg)) {
    await showIssueDetail(arg.toUpperCase(), stream);
    return;
  }

  const subtasksMatch = arg.match(/^subtasks\s+([A-Z][A-Z0-9]+-\d+)$/i);
  if (subtasksMatch) {
    await listSubtasks(subtasksMatch[1].toUpperCase(), stream);
    return;
  }

  const createMatch = arg.match(/^create\s+([A-Z][A-Z0-9]+-\d+)$/i);
  if (createMatch) {
    await createSubtaskInteractive(createMatch[1].toUpperCase(), stream);
    return;
  }

  stream.markdown(USAGE_HELP);
}

// ─── Sub-actions ─────────────────────────────────────────────────────────────

/**
 * Lists issues using a custom JQL (if configured) or the default project/status filter.
 * Renders results as a markdown table.
 */
async function listAndPickIssue(stream: vscode.ChatResponseStream): Promise<void> {
  const config     = vscode.workspace.getConfiguration("companyStandards");
  const customJql  = (config.get<string>("jiraJql") ?? "").trim();
  const client     = new JiraClient();
  let issues;
  let heading: string;

  if (customJql) {
    stream.progress(`Ejecutando JQL configurado…`);
    log(`[JiraHandler] Using custom JQL: ${customJql}`);
    try {
      issues = await client.searchByJql(customJql);
    } catch (err: unknown) {
      logError("[JiraHandler] Failed to execute custom JQL", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ Error ejecutando el JQL configurado: **${msg}**\n\n_Revisa \`companyStandards.jiraJql\` en tus settings._`);
      return;
    }
    heading = `📋 Resultados de JQL (${issues.length})`;
  } else {
    const projects = getConfiguredProjects();
    if (projects.length === 0) {
      stream.markdown(
        `⚠️ No hay proyectos de Jira configurados.\n\n` +
        `Configura \`companyStandards.jiraProject\` o \`companyStandards.jiraJql\` en tus settings.`
      );
      return;
    }
    stream.progress(`Cargando issues de ${projects.join(", ")}…`);
    try {
      issues = await client.listIssues(projects);
    } catch (err: unknown) {
      logError("[JiraHandler] Failed to list issues", err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ No pude obtener las issues de Jira: **${msg}**`);
      return;
    }
    heading = `📋 Issues en progreso — ${projects.join(", ")} (${issues.length})`;
  }

  if (issues.length === 0) {
    stream.markdown(`ℹ️ La consulta no devolvió resultados.`);
    return;
  }

  stream.markdown(`## ${heading}\n\n`);
  stream.markdown(
    `| Clave | Resumen | Estado | Prioridad | Asignado a | Tiempo en progreso |\n` +
    `|---|---|---|---|---|---|\n`
  );
  for (const issue of issues) {
    const timeLabel     = issue.timeInProgress ? `⏳ ${issue.timeInProgress}` : "—";
    const assigneeLabel = issue.assignee ?? "Sin asignar";
    stream.markdown(
      `| ${issue.key} | ${issue.summary} | ${issue.status} | ${issue.priority} | ${assigneeLabel} | ${timeLabel} |\n`
    );
  }
  stream.markdown(`\n_Para crear una subtarea usa \`/jira create PROJ-123\`._\n`);

  log(`[JiraHandler] Issues listed: ${issues.length}`);
}

/**
 * Fetches and renders full issue detail including subtasks and time metrics.
 */
async function showIssueDetail(issueKey: string, stream: vscode.ChatResponseStream): Promise<void> {
  stream.progress(`Cargando detalle de ${issueKey}…`);

  const client = new JiraClient();
  let issue: JiraIssue;
  try {
    issue = await client.getIssue(issueKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to fetch issue ${issueKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la issue **${issueKey}**: ${msg}`);
    return;
  }

  const labelsStr    = issue.labels.length ? issue.labels.join(", ") : "—";
  const spStr        = issue.storyPoints != null ? String(issue.storyPoints) : "—";
  const inProgressStr = issue.timeInProgress ? `⏳ ${issue.timeInProgress}` : "—";

  stream.markdown(
    `## 📋 ${issue.key}: ${issue.summary}\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| **Estado** | ${issue.status} |\n` +
    `| **Prioridad** | ${issue.priority} |\n` +
    `| **Story Points** | ${spStr} |\n` +
    `| **Labels** | ${labelsStr} |\n` +
    `| **Tiempo abierto** | 📅 ${issue.timeOpen} |\n` +
    `| **Tiempo en progreso** | ${inProgressStr} |\n\n` +
    (issue.description
      ? `### Descripción\n\n${issue.description}\n\n`
      : "_Sin descripción._\n\n")
  );

  // Subtasks table
  if (issue.subtasks.length > 0) {
    stream.markdown(`### Subtareas (${issue.subtasks.length})\n\n`);
    stream.markdown(
      `| Clave | Resumen | Estado | Prioridad | Tiempo abierto |\n` +
      `|---|---|---|---|---|\n`
    );
    for (const st of issue.subtasks) {
      stream.markdown(
        `| ${st.key} | ${st.summary} | ${st.status} | ${st.priority} | 📅 ${st.timeOpen} |\n`
      );
    }
    stream.markdown("\n");
  } else {
    stream.markdown(`_Esta issue no tiene subtareas._\n\n`);
  }

  stream.button({ title: `Crear subtarea en ${issue.key}`, command: "companyStandards.refreshStandards" });
  log(`[JiraHandler] Issue detail rendered: ${issueKey}`);
}

/**
 * Lists subtasks of a specific issue assigned to the current user.
 */
async function listSubtasks(issueKey: string, stream: vscode.ChatResponseStream): Promise<void> {
  stream.progress(`Cargando tus subtareas en ${issueKey}…`);

  const client = new JiraClient();
  let subtasks;
  try {
    subtasks = await client.getMySubtasks(issueKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to get my subtasks for ${issueKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar las subtareas de **${issueKey}**: ${msg}`);
    return;
  }

  if (subtasks.length === 0) {
    stream.markdown(`ℹ️ No tienes subtareas asignadas en **${issueKey}**.`);
    return;
  }

  stream.markdown(`## 🔗 Mis subtareas en ${issueKey} (${subtasks.length})\n\n`);
  stream.markdown(
    `| Clave | Resumen | Estado | Prioridad | Tiempo abierto |\n` +
    `|---|---|---|---|---|\n`
  );
  for (const st of subtasks) {
    stream.markdown(
      `| ${st.key} | ${st.summary} | ${st.status} | ${st.priority} | 📅 ${st.timeOpen} |\n`
    );
  }

  log(`[JiraHandler] My subtasks listed for ${issueKey}: ${subtasks.length}`);
}

/**
 * Interactive flow to create a new subtask under a parent issue.
 * Steps: InputBox for summary → POST to Jira → show result.
 */
async function createSubtaskInteractive(parentKey: string, stream: vscode.ChatResponseStream): Promise<void> {
  stream.progress(`Preparando creación de subtarea en ${parentKey}…`);

  const client = new JiraClient();

  // Fetch parent to get project key
  let parentIssue: JiraIssue;
  try {
    parentIssue = await client.getIssue(parentKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to fetch parent issue ${parentKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la issue padre **${parentKey}**: ${msg}`);
    return;
  }

  // Derive project key from parent key (e.g. "BANK-42" → "BANK")
  const projectKey = parentKey.split("-")[0];

  stream.markdown(
    `### ✏️ Crear subtarea en **${parentKey}**: ${parentIssue.summary}\n\n` +
    `_Se abrirá un cuadro de texto para ingresar el resumen de la subtarea._\n\n`
  );

  const summary = await vscode.window.showInputBox({
    title:       `Nueva subtarea en ${parentKey}`,
    prompt:      "Resumen de la subtarea",
    placeHolder: "Ej: Agregar validación de entrada al endpoint POST /users",
    validateInput: (value) => {
      if (!value || !value.trim()) return "El resumen no puede estar vacío";
      if (value.trim().length < 5) return "El resumen debe tener al menos 5 caracteres";
      return undefined;
    },
  });

  if (!summary || !summary.trim()) {
    stream.markdown("Creación de subtarea cancelada.");
    return;
  }

  stream.progress(`Creando subtarea en ${parentKey}…`);
  log(`[JiraHandler] Creating subtask — parent: ${parentKey}, project: ${projectKey}, summary: "${summary.trim()}"`);

  let newKey: string;
  try {
    newKey = await client.createSubtask(parentKey, projectKey, summary.trim());
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to create subtask in ${parentKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude crear la subtarea: **${msg}**`);
    return;
  }

  const config   = vscode.workspace.getConfiguration("companyStandards");
  const jiraUrl  = (config.get<string>("jiraUrl") ?? "").replace(/\/$/, "");
  const issueUrl = `${jiraUrl}/browse/${newKey}`;

  stream.markdown(
    `## ✅ Subtarea creada exitosamente\n\n` +
    `| Campo | Valor |\n|---|---|\n` +
    `| **Clave** | ${newKey} |\n` +
    `| **Resumen** | ${summary.trim()} |\n` +
    `| **Issue padre** | ${parentKey} |\n` +
    `| **Proyecto** | ${projectKey} |\n\n` +
    `🔗 [Ver ${newKey} en Jira](${issueUrl})`
  );

  log(`[JiraHandler] Subtask created: ${newKey} under ${parentKey}`);
}
