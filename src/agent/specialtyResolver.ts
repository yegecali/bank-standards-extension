import * as vscode from "vscode";

export type PageType = "standards" | "testing" | "project" | "prompts";

/** Nested map: specialty → pageType → pageId */
export interface SpecialtiesMap {
  [specialty: string]: Partial<Record<PageType, string>>;
}

/**
 * Returns the currently active specialty from settings.
 * Defaults to "backend" if not configured.
 */
export function getActiveSpecialty(): string {
  const config = vscode.workspace.getConfiguration("companyStandards");
  return config.get<string>("specialty") ?? "backend";
}

/**
 * Sets the active specialty in workspace settings.
 */
export async function setActiveSpecialty(specialty: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("companyStandards");
  await config.update("specialty", specialty, vscode.ConfigurationTarget.Global);
}

/**
 * Returns the full specialtiesMap from settings.
 */
export function getSpecialtiesMap(): SpecialtiesMap {
  const config = vscode.workspace.getConfiguration("companyStandards");
  return config.get<SpecialtiesMap>("specialtiesMap") ?? {};
}

/**
 * Returns all configured specialty names.
 */
export function listSpecialties(): string[] {
  return Object.keys(getSpecialtiesMap());
}

/**
 * Resolves the page ID for a given page type and optional specialty.
 *
 * Resolution order:
 *  1. specialtiesMap[specialty][pageType]  — new per-specialty config
 *  2. pagesMap[pageType]                   — legacy flat config (backward compat)
 */
export function resolvePageId(pageType: PageType, specialty?: string): string | undefined {
  const activeSpecialty = specialty ?? getActiveSpecialty();
  const specialtiesMap  = getSpecialtiesMap();

  const specialtyPages = specialtiesMap[activeSpecialty];
  if (specialtyPages?.[pageType]) {
    return specialtyPages[pageType];
  }

  // Fallback: legacy pagesMap
  const config   = vscode.workspace.getConfiguration("companyStandards");
  const pagesMap = config.get<Record<string, string>>("pagesMap") ?? {};
  return pagesMap[pageType] || undefined;
}

/**
 * Detects whether the prompt mentions a known specialty by name.
 * Returns the matched specialty or undefined.
 */
export function detectSpecialtyFromPrompt(
  prompt: string,
  knownSpecialties: string[]
): string | undefined {
  const lower = prompt.toLowerCase();
  return knownSpecialties.find((s) => lower.includes(s.toLowerCase()));
}
