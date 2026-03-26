import * as vscode from "vscode";
import { log, logError } from "../logger";
import { JiraClient, JiraIssue, JiraComment, getConfiguredProjects } from "../jira/client";

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
  `| \`/jira update PROJ-123\` | Actualizar documentación (descripción, comentarios) |\n` +
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

  const updateMatch = arg.match(/^update\s+([A-Z][A-Z0-9]+-\d+)$/i);
  if (updateMatch) {
    await updateDocumentationInteractive(updateMatch[1].toUpperCase(), stream);
    return;
  }

  stream.markdown(USAGE_HELP);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Reads the subtask age threshold (in days) from settings. Default: 3. */
function getSubtaskAgeThreshold(): number {
  const config = vscode.workspace.getConfiguration("companyStandards");
  return config.get<number>("subtaskAgeThresholdDays") ?? 3;
}

/**
 * Returns true if the subtask was created more than `thresholdDays` days ago.
 * Returns false if `createdRaw` is null/invalid (cannot determine age).
 */
function isOverThreshold(createdRaw: string | null | undefined, thresholdDays: number): boolean {
  if (!createdRaw) return false;
  const ms = Date.now() - new Date(createdRaw).getTime();
  if (isNaN(ms) || ms < 0) return false;
  return ms / 86_400_000 > thresholdDays;
}

/** Returns the first word of a full name (e.g. "Jose Luis Cacsire" → "Jose") */
function firstNameOnly(fullName: string): string {
  if (!fullName || fullName === "—") return "—";
  return fullName.trim().split(/\s+/)[0];
}

/**
 * Truncates a string to the first `max` words.
 * If truncated, appends "...".
 */
function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(" ") + "...";
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
    `| Clave | Resumen | Asignado a | Tiempo en progreso |\n` +
    `|---|---|---|---|\n`
  );
  for (const issue of issues) {
    const timeLabel     = issue.timeInProgress ? `⏳ ${issue.timeInProgress}` : "—";
    const assigneeLabel = issue.assignee ? firstNameOnly(issue.assignee) : "Sin asignar";
    const summaryLabel  = truncateWords(issue.summary, 10);
    stream.markdown(
      `| ${issue.key} | ${summaryLabel} | ${assigneeLabel} | ${timeLabel} |\n`
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
    const threshold    = getSubtaskAgeThreshold();
    const criticalKeys = issue.subtasks.filter((st) => isOverThreshold(st.createdRaw, threshold)).map((st) => st.key);

    if (criticalKeys.length > 0) {
      stream.markdown(
        `> 🚨 **${criticalKeys.length} subtarea(s) crítica(s)** con más de **${threshold} día(s)** abiertas: ` +
        criticalKeys.join(", ") + `\n\n`
      );
    }

    stream.markdown(
      `### Subtareas (${issue.subtasks.length})\n\n` +
      `| Clave | Resumen | Estado | Tiempo abierto |\n` +
      `|---|---|---|---|\n` +
      issue.subtasks.map((st) => {
        const critical = isOverThreshold(st.createdRaw, threshold);
        const timeCell = critical ? `🚨 **${st.timeOpen}** ← CRÍTICA` : `📅 ${st.timeOpen}`;
        return `| ${st.key} | ${truncateWords(st.summary, 10)} | ${st.status} | ${timeCell} |`;
      }).join("\n") +
      "\n\n"
    );
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

  const threshold    = getSubtaskAgeThreshold();
  const criticalKeys = subtasks.filter((st) => isOverThreshold(st.createdRaw, threshold)).map((st) => st.key);

  if (criticalKeys.length > 0) {
    stream.markdown(
      `> 🚨 **${criticalKeys.length} subtarea(s) crítica(s)** llevan más de **${threshold} día(s)** abiertas: ` +
      criticalKeys.join(", ") + `\n\n`
    );
  }

  stream.markdown(
    `## 🔗 Mis subtareas en ${issueKey} (${subtasks.length})\n\n` +
    `| Clave | Resumen | Estado | Tiempo abierto |\n` +
    `|---|---|---|---|\n` +
    subtasks.map((st) => {
      const critical = isOverThreshold(st.createdRaw, threshold);
      const timeCell = critical ? `🚨 **${st.timeOpen}** ← CRÍTICA` : `📅 ${st.timeOpen}`;
      return `| ${st.key} | ${truncateWords(st.summary, 10)} | ${st.status} | ${timeCell} |`;
    }).join("\n") +
    "\n"
  );

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

/**
 * Interactive flow to update the documentation of a Jira issue.
 * Options: description, summary, add comment, or edit existing comment.
 */
async function updateDocumentationInteractive(
  issueKey: string,
  stream: vscode.ChatResponseStream
): Promise<void> {
  stream.progress(`Cargando issue ${issueKey}…`);

  const client = new JiraClient();
  let issue: JiraIssue;
  try {
    issue = await client.getIssue(issueKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to fetch issue ${issueKey} for update`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar la issue **${issueKey}**: ${msg}`);
    return;
  }

  stream.markdown(
    `## ✏️ Actualizar documentación: **${issueKey}**\n\n` +
    `> ${issue.summary}\n\n` +
    `_Selecciona qué deseas actualizar en el cuadro de opciones._\n\n`
  );

  interface UpdateOption extends vscode.QuickPickItem {
    action: string;
  }

  const options: UpdateOption[] = [
    {
      label:       "$(edit) Descripción",
      description: "Actualizar el cuerpo de descripción de la issue",
      action:      "description",
    },
    {
      label:       "$(pencil) Resumen (título)",
      description: "Cambiar el título principal de la issue",
      action:      "summary",
    },
    {
      label:       "$(comment) Agregar comentario",
      description: "Añadir un nuevo comentario a la issue",
      action:      "add-comment",
    },
    {
      label:       "$(sync) Editar comentario existente",
      description: "Seleccionar y modificar un comentario anterior",
      action:      "edit-comment",
    },
  ];

  const picked = await vscode.window.showQuickPick(options, {
    title:       `¿Qué deseas actualizar en ${issueKey}?`,
    placeHolder: "Selecciona una opción…",
  });

  if (!picked) {
    stream.markdown("Actualización cancelada.");
    return;
  }

  const config  = vscode.workspace.getConfiguration("companyStandards");
  const jiraUrl = (config.get<string>("jiraUrl") ?? "").replace(/\/$/, "");

  // ── Descripción ────────────────────────────────────────────────────────────
  if (picked.action === "description") {
    stream.markdown(
      `### Descripción actual\n\n` +
      (issue.description ? issue.description : "_Sin descripción._") +
      `\n\n_Se abrirá un cuadro para editar la descripción._\n\n`
    );

    const newDesc = await vscode.window.showInputBox({
      title:       `Actualizar descripción de ${issueKey}`,
      prompt:      "Nueva descripción (texto plano; usa doble Enter para separar párrafos)",
      value:       issue.description,
      validateInput: (v) => (!v?.trim() ? "La descripción no puede estar vacía" : undefined),
    });

    if (!newDesc || !newDesc.trim()) {
      stream.markdown("Actualización cancelada.");
      return;
    }

    stream.progress(`Actualizando descripción de ${issueKey}…`);
    try {
      await client.updateIssue(issueKey, { description: newDesc.trim() });
    } catch (err: unknown) {
      logError(`[JiraHandler] Failed to update description of ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ Error al actualizar la descripción: **${msg}**`);
      return;
    }

    stream.markdown(
      `## ✅ Descripción actualizada\n\n` +
      `**Issue:** ${issueKey}\n\n` +
      `🔗 [Ver ${issueKey} en Jira](${jiraUrl}/browse/${issueKey})`
    );
    log(`[JiraHandler] Description updated for ${issueKey}`);
  }

  // ── Resumen (título) ───────────────────────────────────────────────────────
  else if (picked.action === "summary") {
    const newSummary = await vscode.window.showInputBox({
      title:       `Actualizar resumen de ${issueKey}`,
      prompt:      "Nuevo resumen (título de la issue)",
      value:       issue.summary,
      validateInput: (v) => (!v?.trim() ? "El resumen no puede estar vacío" : undefined),
    });

    if (!newSummary || !newSummary.trim()) {
      stream.markdown("Actualización cancelada.");
      return;
    }

    stream.progress(`Actualizando resumen de ${issueKey}…`);
    try {
      await client.updateIssue(issueKey, { summary: newSummary.trim() });
    } catch (err: unknown) {
      logError(`[JiraHandler] Failed to update summary of ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ Error al actualizar el resumen: **${msg}**`);
      return;
    }

    stream.markdown(
      `## ✅ Resumen actualizado\n\n` +
      `| Campo | Valor |\n|---|---|\n` +
      `| **Issue** | ${issueKey} |\n` +
      `| **Nuevo resumen** | ${newSummary.trim()} |\n\n` +
      `🔗 [Ver ${issueKey} en Jira](${jiraUrl}/browse/${issueKey})`
    );
    log(`[JiraHandler] Summary updated for ${issueKey}`);
  }

  // ── Agregar comentario ─────────────────────────────────────────────────────
  else if (picked.action === "add-comment") {
    const comment = await vscode.window.showInputBox({
      title:       `Agregar comentario en ${issueKey}`,
      prompt:      "Escribe tu comentario",
      placeHolder: "Ej: Se implementó la validación usando el patrón AAA...",
      validateInput: (v) => (!v?.trim() ? "El comentario no puede estar vacío" : undefined),
    });

    if (!comment || !comment.trim()) {
      stream.markdown("Operación cancelada.");
      return;
    }

    stream.progress(`Agregando comentario en ${issueKey}…`);
    let commentId: string;
    try {
      commentId = await client.addComment(issueKey, comment.trim());
    } catch (err: unknown) {
      logError(`[JiraHandler] Failed to add comment to ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ Error al agregar el comentario: **${msg}**`);
      return;
    }

    stream.markdown(
      `## ✅ Comentario agregado\n\n` +
      `| Campo | Valor |\n|---|---|\n` +
      `| **Issue** | ${issueKey} |\n` +
      `| **ID del comentario** | ${commentId} |\n\n` +
      `🔗 [Ver ${issueKey} en Jira](${jiraUrl}/browse/${issueKey})`
    );
    log(`[JiraHandler] Comment added to ${issueKey}: id ${commentId}`);
  }

  // ── Editar comentario existente ────────────────────────────────────────────
  else if (picked.action === "edit-comment") {
    stream.progress(`Cargando comentarios de ${issueKey}…`);

    let comments: JiraComment[];
    try {
      comments = await client.listComments(issueKey);
    } catch (err: unknown) {
      logError(`[JiraHandler] Failed to list comments for ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ No pude cargar los comentarios de **${issueKey}**: ${msg}`);
      return;
    }

    if (comments.length === 0) {
      stream.markdown(`ℹ️ La issue **${issueKey}** no tiene comentarios todavía.`);
      return;
    }

    interface CommentPickItem extends vscode.QuickPickItem {
      commentId: string;
      currentBody: string;
    }

    const commentItems: CommentPickItem[] = comments.map((c) => ({
      label:       `$(comment) ${c.author}`,
      description: `hace ${c.timeAgo}`,
      detail:      c.body.length > 120 ? c.body.slice(0, 120) + "…" : c.body,
      commentId:   c.id,
      currentBody: c.body,
    }));

    const pickedComment = await vscode.window.showQuickPick(commentItems, {
      title:         `Selecciona el comentario a editar (${issueKey})`,
      placeHolder:   "Escribe para filtrar…",
      matchOnDetail: true,
    });

    if (!pickedComment) {
      stream.markdown("Edición cancelada.");
      return;
    }

    const updatedBody = await vscode.window.showInputBox({
      title:       `Editar comentario en ${issueKey}`,
      prompt:      "Nuevo contenido del comentario",
      value:       pickedComment.currentBody,
      validateInput: (v) => (!v?.trim() ? "El comentario no puede estar vacío" : undefined),
    });

    if (!updatedBody || !updatedBody.trim()) {
      stream.markdown("Edición cancelada.");
      return;
    }

    stream.progress(`Actualizando comentario en ${issueKey}…`);
    try {
      await client.updateComment(issueKey, pickedComment.commentId, updatedBody.trim());
    } catch (err: unknown) {
      logError(`[JiraHandler] Failed to update comment ${pickedComment.commentId} in ${issueKey}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ Error al actualizar el comentario: **${msg}**`);
      return;
    }

    stream.markdown(
      `## ✅ Comentario actualizado\n\n` +
      `| Campo | Valor |\n|---|---|\n` +
      `| **Issue** | ${issueKey} |\n` +
      `| **Autor original** | ${pickedComment.label.replace("$(comment) ", "")} |\n\n` +
      `🔗 [Ver ${issueKey} en Jira](${jiraUrl}/browse/${issueKey})`
    );
    log(`[JiraHandler] Comment ${pickedComment.commentId} updated in ${issueKey}`);
  }
}
