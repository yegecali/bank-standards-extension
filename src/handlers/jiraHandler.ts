import * as vscode from "vscode";
import { log, logError } from "../logger";
import { JiraClient, JiraIssueSummary, JiraSubtask, getConfiguredProjects } from "../jira/client";
import { JIRA } from "../config/defaults";

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
  `| \`/jira\` | Flujo guiado: ver issues → elegir → subtareas, crear o actualizar estado |`;

/**
 * Main handler for the @company /jira command.
 * All interactions are guided via QuickPick and InputBox — minimal chat output.
 */
export async function handleJiraCommand(
  userArg: string,
  stream: vscode.ChatResponseStream,
  _context: vscode.ExtensionContext,
  token: vscode.CancellationToken,
  _model?: vscode.LanguageModelChat
): Promise<void> {
  const config = vscode.workspace.getConfiguration("companyStandards");
  const jiraUrl   = config.get<string>("jiraUrl") ?? "";
  const jiraEmail = config.get<string>("jiraEmail") ?? "";
  const jiraToken = config.get<string>("jiraToken") ?? "";

  if (!jiraUrl || !jiraEmail || !jiraToken) {
    stream.markdown(JIRA_CONFIG_HELP);
    return;
  }

  const arg = userArg.trim().toLowerCase();

  if (!arg || arg === "list") {
    await guidedFlow(stream, token);
    return;
  }

  stream.markdown(USAGE_HELP);
}

// ─── Guided flow ─────────────────────────────────────────────────────────────

/**
 * Main guided interaction:
 * 1. Fetch and show compact issues table
 * 2. QuickPick: select an issue
 * 3. QuickPick: choose action (subtasks / create / update status)
 */
async function guidedFlow(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const config    = vscode.workspace.getConfiguration("companyStandards");
  const customJql = (config.get<string>("jiraJql") ?? "").trim();
  const jiraBase  = (config.get<string>("jiraUrl") ?? "").replace(/\/$/, "");
  const client    = new JiraClient();

  // ── 1. Fetch issues ──────────────────────────────────────────────────────
  stream.progress("Buscando issues en progreso…");

  let issues: JiraIssueSummary[];
  try {
    if (customJql) {
      log(`[JiraHandler] Using custom JQL: ${customJql}`);
      issues = await client.searchByJql(customJql);
    } else {
      const projects = getConfiguredProjects();
      if (projects.length === 0) {
        stream.markdown(
          `⚠️ No hay proyectos de Jira configurados.\n\n` +
          `Configura \`companyStandards.jiraProject\` o \`companyStandards.jiraJql\` en tus settings.`
        );
        return;
      }
      issues = await client.listIssues(projects);
    }
  } catch (err: unknown) {
    logError("[JiraHandler] Failed to list issues", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude obtener las issues de Jira: **${msg}**`);
    return;
  }

  if (issues.length === 0) {
    stream.markdown(`ℹ️ No hay issues en progreso en los proyectos configurados.`);
    return;
  }

  // ── 2. Show first page in chat ──────────────────────────────────────────
  const totalPages = Math.ceil(issues.length / JIRA.PAGE_SIZE);
  stream.markdown(issueTable(issues.slice(0, JIRA.PAGE_SIZE), jiraBase, 1, totalPages, issues.length));

  // ── 3. Paginated QuickPick ───────────────────────────────────────────────
  const issueKey = await pickIssuePaged(issues, stream);
  if (!issueKey) {
    stream.markdown("_Operación cancelada._");
    return;
  }

  // ── 4. QuickPick: choose action ──────────────────────────────────────────
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(list-unordered) Ver mis subtareas",           value: "subtasks" },
      { label: "$(add) Crear subtarea",                         value: "create"   },
      { label: "$(sync) Actualizar estado de subtarea",         value: "status"   },
    ],
    {
      title:       `¿Qué quieres hacer con ${issueKey}?`,
      placeHolder: "Selecciona una acción…",
    }
  );

  if (!action) {
    stream.markdown("_Operación cancelada._");
    return;
  }

  if (action.value === "subtasks") {
    await showMySubtasks(issueKey, stream);
  } else if (action.value === "create") {
    await createSubtaskInteractive(issueKey, stream, jiraBase);
  } else if (action.value === "status") {
    await updateStatusInteractive(issueKey, stream, jiraBase, token);
  }
}

// ─── Action: Ver subtareas ────────────────────────────────────────────────────

async function showMySubtasks(
  issueKey: string,
  stream: vscode.ChatResponseStream
): Promise<void> {
  stream.progress(`Cargando tus subtareas en ${issueKey}…`);

  const client = new JiraClient();
  let subtasks: JiraSubtask[];
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

  const threshold    = getSubtaskAgeThresholdHours();
  const displayed    = subtasks.slice(0, 10);
  const extra        = subtasks.length - displayed.length;

  stream.markdown(
    `## Mis subtareas en ${issueKey} (${subtasks.length})\n\n` +
    `| Clave | Resumen | Estado | Abierta hace |\n` +
    `|---|---|---|---|\n` +
    displayed.map((st) => {
      const over     = isOverThreshold(st.createdRaw, threshold);
      const timeCell = over ? `🚨 **${st.timeOpen}**` : st.timeOpen;
      return `| ${st.key} | ${truncateWords(st.summary, 8)} | ${st.status} | ${timeCell} |`;
    }).join("\n") +
    "\n"
  );

  if (extra > 0) {
    stream.markdown(`_…y ${extra} subtarea(s) más._\n`);
  }

  log(`[JiraHandler] My subtasks listed for ${issueKey}: ${subtasks.length}`);
}

// ─── Action: Crear subtarea ───────────────────────────────────────────────────

async function createSubtaskInteractive(
  parentKey: string,
  stream: vscode.ChatResponseStream,
  jiraBase: string
): Promise<void> {
  const summary = await vscode.window.showInputBox({
    title:       `Nueva subtarea en ${parentKey}`,
    prompt:      "Resumen de la subtarea",
    placeHolder: "Ej: Agregar validación de entrada al endpoint POST /users",
    validateInput: (value) => {
      if (!value || !value.trim()) { return "El resumen no puede estar vacío"; }
      if (value.trim().length < 5) { return "El resumen debe tener al menos 5 caracteres"; }
      return undefined;
    },
  });

  if (!summary || !summary.trim()) {
    stream.markdown("_Creación de subtarea cancelada._");
    return;
  }

  const projectKey = parentKey.split("-")[0];

  stream.progress(`Creando subtarea en ${parentKey}…`);
  log(`[JiraHandler] Creating subtask — parent: ${parentKey}, project: ${projectKey}, summary: "${summary.trim()}"`);

  const client = new JiraClient();
  let newKey: string;
  try {
    newKey = await client.createSubtask(parentKey, projectKey, summary.trim());
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to create subtask in ${parentKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude crear la subtarea: **${msg}**`);
    return;
  }

  const issueUrl = `${jiraBase}/browse/${newKey}`;
  stream.markdown(
    `✅ Subtarea creada: **[${newKey}](${issueUrl})** — ${summary.trim()}\n\n` +
    `_Issue padre: ${parentKey}_`
  );

  log(`[JiraHandler] Subtask created: ${newKey} under ${parentKey}`);
}

// ─── Action: Actualizar estado ────────────────────────────────────────────────

async function updateStatusInteractive(
  issueKey: string,
  stream: vscode.ChatResponseStream,
  jiraBase: string,
  _token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Cargando tus subtareas en ${issueKey}…`);

  const client = new JiraClient();
  let subtasks: JiraSubtask[];
  try {
    subtasks = await client.getMySubtasks(issueKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to get subtasks for ${issueKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude cargar las subtareas de **${issueKey}**: ${msg}`);
    return;
  }

  if (subtasks.length === 0) {
    stream.markdown(`ℹ️ No tienes subtareas asignadas en **${issueKey}** para actualizar.`);
    return;
  }

  // ── Select subtask ─────────────────────────────────────────────────────
  interface SubtaskPickItem extends vscode.QuickPickItem {
    subtaskKey: string;
  }

  const subtaskItems: SubtaskPickItem[] = subtasks.map((st) => ({
    label:       `$(issue-opened) ${st.key}`,
    description: st.status,
    detail:      truncateWords(st.summary, 12),
    subtaskKey:  st.key,
  }));

  const pickedSubtask = await vscode.window.showQuickPick(subtaskItems, {
    title:         `Selecciona la subtarea a actualizar (${issueKey})`,
    placeHolder:   "Escribe para filtrar…",
    matchOnDetail: true,
  });

  if (!pickedSubtask) {
    stream.markdown("_Operación cancelada._");
    return;
  }

  const subtaskKey = pickedSubtask.subtaskKey;

  // ── Fetch transitions ──────────────────────────────────────────────────
  stream.progress(`Cargando transiciones disponibles para ${subtaskKey}…`);

  let transitions: Array<{ id: string; name: string }>;
  try {
    transitions = await client.getTransitions(subtaskKey);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to get transitions for ${subtaskKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude obtener las transiciones de **${subtaskKey}**: ${msg}`);
    return;
  }

  if (transitions.length === 0) {
    stream.markdown(`ℹ️ No hay transiciones disponibles para **${subtaskKey}**.`);
    return;
  }

  // ── Select transition ──────────────────────────────────────────────────
  interface TransitionPickItem extends vscode.QuickPickItem {
    transitionId: string;
    transitionName: string;
  }

  const transitionItems: TransitionPickItem[] = transitions.map((t) => ({
    label:          `$(sync) ${t.name}`,
    transitionId:   t.id,
    transitionName: t.name,
  }));

  const pickedTransition = await vscode.window.showQuickPick(transitionItems, {
    title:       `Nuevo estado para ${subtaskKey}`,
    placeHolder: "Selecciona el estado…",
  });

  if (!pickedTransition) {
    stream.markdown("_Operación cancelada._");
    return;
  }

  // ── Apply transition ───────────────────────────────────────────────────
  stream.progress(`Actualizando estado de ${subtaskKey} a "${pickedTransition.transitionName}"…`);
  try {
    await client.transitionIssue(subtaskKey, pickedTransition.transitionId);
  } catch (err: unknown) {
    logError(`[JiraHandler] Failed to transition ${subtaskKey}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude actualizar el estado de **${subtaskKey}**: ${msg}`);
    return;
  }

  const subtaskUrl = `${jiraBase}/browse/${subtaskKey}`;
  stream.markdown(
    `✅ Estado actualizado: **[${subtaskKey}](${subtaskUrl})** → **${pickedTransition.transitionName}**`
  );

  log(`[JiraHandler] Transitioned ${subtaskKey} → "${pickedTransition.transitionName}" (id: ${pickedTransition.transitionId})`);
}

// ─── Paginated issue picker ───────────────────────────────────────────────────

interface IssuePickItem extends vscode.QuickPickItem {
  issueKey?: string;
  navDir?:   "prev" | "next";
}

/**
 * Shows a paginated QuickPick (JIRA.PAGE_SIZE items per page).
 * Navigation items "⬅ Página anterior" / "Página siguiente ➡" let the user
 * browse interactively. Returns the selected issue key, or null if cancelled.
 */
async function pickIssuePaged(
  issues: JiraIssueSummary[],
  stream: vscode.ChatResponseStream
): Promise<string | null> {
  const total      = issues.length;
  const totalPages = Math.ceil(total / JIRA.PAGE_SIZE);
  let page = 0;

  while (true) {
    const start = page * JIRA.PAGE_SIZE;
    const end   = Math.min(start + JIRA.PAGE_SIZE, total);
    const slice = issues.slice(start, end);

    const items: IssuePickItem[] = [
      {
        label: `Página ${page + 1} de ${totalPages}  ·  issues ${start + 1}–${end} de ${total}`,
        kind:  vscode.QuickPickItemKind.Separator,
      },
      ...slice.map((i): IssuePickItem => ({
        label:       i.key,
        description: i.status,
        detail:      truncateWords(i.summary, 12),
        issueKey:    i.key,
      })),
      ...(page > 0 ? [{
        label:   `⬅  Página anterior  (${page} de ${totalPages})`,
        detail:  `Volver a issues ${(page - 1) * JIRA.PAGE_SIZE + 1}–${page * JIRA.PAGE_SIZE}`,
        navDir:  "prev" as const,
      }] : []),
      ...(page + 1 < totalPages ? [{
        label:   `Página siguiente  (${page + 2} de ${totalPages})  ➡`,
        detail:  `Ver issues ${end + 1}–${Math.min(end + JIRA.PAGE_SIZE, total)}`,
        navDir:  "next" as const,
      }] : []),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title:              `Issues en progreso — ${total} total`,
      placeHolder:        "Selecciona una issue o navega entre páginas…",
      matchOnDetail:      true,
      matchOnDescription: true,
    });

    if (!picked) { return null; }

    if (picked.navDir === "prev") {
      page--;
      // Update chat table to reflect the new page
      stream.markdown(issueTable(
        issues.slice((page) * JIRA.PAGE_SIZE, (page + 1) * JIRA.PAGE_SIZE),
        (vscode.workspace.getConfiguration("companyStandards").get<string>("jiraUrl") ?? "").replace(/\/$/, ""),
        page + 1, totalPages, total
      ));
      continue;
    }
    if (picked.navDir === "next") {
      page++;
      stream.markdown(issueTable(
        issues.slice((page) * JIRA.PAGE_SIZE, (page + 1) * JIRA.PAGE_SIZE),
        (vscode.workspace.getConfiguration("companyStandards").get<string>("jiraUrl") ?? "").replace(/\/$/, ""),
        page + 1, totalPages, total
      ));
      continue;
    }
    if (picked.issueKey) {
      stream.markdown(`\n📌 Issue seleccionada: **${picked.issueKey}** — ${picked.detail ?? ""}\n\n`);
      return picked.issueKey;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compact issue table for the chat — shows one page with pagination header */
function issueTable(
  issues: JiraIssueSummary[],
  jiraBase: string,
  page: number,
  totalPages: number,
  total: number
): string {
  const rows = issues.map((i) => {
    const keyCell = jiraBase ? `[${i.key}](${jiraBase}/browse/${i.key})` : i.key;
    return `| ${keyCell} | ${truncateWords(i.summary, 10)} | ${i.status} |`;
  });
  return (
    `## Issues en progreso — Página ${page} de ${totalPages} (${total} total)\n\n` +
    `| Clave | Resumen | Estado |\n` +
    `|---|---|---|\n` +
    rows.join("\n") + "\n\n"
  );
}

function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) { return text; }
  return words.slice(0, max).join(" ") + "…";
}

function getSubtaskAgeThresholdHours(): number {
  const config = vscode.workspace.getConfiguration("companyStandards");
  const hours  = config.get<number>("subtaskAgeThresholdHours");
  if (hours !== undefined && hours !== null) { return hours; }
  const days = config.get<number>("subtaskAgeThresholdDays");
  if (days !== undefined && days !== null) { return days * 24; }
  return 72;
}

function isOverThreshold(createdRaw: string | null | undefined, thresholdHours: number): boolean {
  if (!createdRaw) { return false; }
  const ms = Date.now() - new Date(createdRaw).getTime();
  if (isNaN(ms) || ms < 0) { return false; }
  return ms / 3_600_000 > thresholdHours;
}
