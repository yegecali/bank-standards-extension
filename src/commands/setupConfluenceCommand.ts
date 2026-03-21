import * as vscode from "vscode";
import { ConfluenceClient } from "../confluence/client";
import { log, logError } from "../logger";

const PAGE_TYPES: Array<{ key: string; label: string; description: string }> = [
  { key: "standards", label: "Estándares de nomenclatura",  description: "Naming conventions, camelCase, PascalCase, etc." },
  { key: "testing",   label: "Estándares de testing",       description: "Triple AAA, test patterns" },
  { key: "project",   label: "Plantilla de proyecto",       description: "Maven / Quarkus project template" },
  { key: "prompts",   label: "Biblioteca de prompts",       description: "Saved prompt library" },
];

/**
 * Multi-step wizard to select a Confluence space and map pages to
 * each specialty's page types. Saves result to bankStandards.specialtiesMap.
 */
export async function setupConfluenceCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration("bankStandards");
  const source = config.get<string>("knowledgeSource");

  if (source !== "confluence") {
    vscode.window.showWarningMessage(
      "Bank Standards: Set bankStandards.knowledgeSource to \"confluence\" first."
    );
    return;
  }

  const client = new ConfluenceClient();

  // ── Step 1: select space ──────────────────────────────────────────────────
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Bank Standards: Loading Confluence spaces…" },
    async () => { /* just shows the spinner while we await below */ }
  );

  let spaces: Array<{ id: string; key: string; name: string }>;
  try {
    log("[SetupConfluence] Fetching spaces…");
    spaces = await client.getSpaces();
    log(`[SetupConfluence] Got ${spaces.length} spaces`);
  } catch (err: unknown) {
    logError("[SetupConfluence] Failed to fetch spaces", err);
    vscode.window.showErrorMessage(
      `Bank Standards: Could not load Confluence spaces — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (spaces.length === 0) {
    vscode.window.showWarningMessage("Bank Standards: No Confluence spaces found for this account.");
    return;
  }

  const spaceItems = spaces.map((s) => ({
    label:       `$(symbol-namespace) ${s.name}`,
    description: s.key,
    detail:      `Space ID: ${s.id}`,
    space:       s,
  }));

  const pickedSpace = await vscode.window.showQuickPick(spaceItems, {
    title: "Confluence — Selecciona el espacio de documentación",
    placeHolder: "Escribe para filtrar espacios…",
    matchOnDescription: true,
  });

  if (!pickedSpace) return;
  log(`[SetupConfluence] Space selected: ${pickedSpace.space.name} (${pickedSpace.space.key})`);

  // ── Step 2: load pages in that space ─────────────────────────────────────
  let pages: Array<{ id: string; title: string }>;
  try {
    log(`[SetupConfluence] Fetching pages in space ${pickedSpace.space.id}…`);
    pages = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading pages from "${pickedSpace.space.name}"…` },
      () => client.getPagesInSpace(pickedSpace.space.id)
    );
    log(`[SetupConfluence] Got ${pages.length} pages`);
  } catch (err: unknown) {
    logError("[SetupConfluence] Failed to fetch pages", err);
    vscode.window.showErrorMessage(
      `Bank Standards: Could not load pages — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (pages.length === 0) {
    vscode.window.showWarningMessage(`Bank Standards: No pages found in space "${pickedSpace.space.name}".`);
    return;
  }

  const pageItems = pages.map((p) => ({
    label:       `$(file) ${p.title}`,
    description: p.id,
    page:        p,
  }));

  // ── Step 3: for each page type, let user pick a page (or skip) ───────────
  const specialty = config.get<string>("specialty") ?? "backend";
  const specialtiesMap = config.get<Record<string, Record<string, string>>>("specialtiesMap") ?? {};
  const current = specialtiesMap[specialty] ?? {};

  const skipItem = { label: "$(dash) Omitir (no configurar ahora)", description: "", page: null };

  const newMapping: Record<string, string> = { ...current };
  let anyPicked = false;

  for (const pageType of PAGE_TYPES) {
    const currentId    = current[pageType.key];
    const currentPage  = currentId ? pages.find((p) => p.id === currentId) : undefined;
    const currentLabel = currentPage ? ` (actual: "${currentPage.title}")` : "";

    const picked = await vscode.window.showQuickPick(
      [skipItem, ...pageItems],
      {
        title: `Confluence — Mapear "${pageType.label}"${currentLabel}`,
        placeHolder: `Selecciona la página para "${pageType.label}" — ${pageType.description}`,
        matchOnDescription: true,
      }
    );

    if (!picked) return; // user pressed Escape — abort whole wizard
    if (picked.page) {
      newMapping[pageType.key] = picked.page.id;
      anyPicked = true;
      log(`[SetupConfluence] Mapped ${pageType.key} → "${picked.page.title}" (${picked.page.id})`);
    }
  }

  if (!anyPicked) {
    vscode.window.showInformationMessage("Bank Standards: No se mapeó ninguna página.");
    return;
  }

  // ── Step 4: save to settings ──────────────────────────────────────────────
  const updatedMap = { ...specialtiesMap, [specialty]: newMapping };
  await config.update("specialtiesMap", updatedMap, vscode.ConfigurationTarget.Global);
  log(`[SetupConfluence] specialtiesMap updated for specialty "${specialty}"`);

  vscode.window.showInformationMessage(
    `Bank Standards: Confluence configurado para especialidad "${specialty}" en espacio "${pickedSpace.space.name}".`
  );
}
