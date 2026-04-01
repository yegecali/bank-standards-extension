import axios, { AxiosInstance, AxiosError } from "axios";
import * as vscode from "vscode";
import { log, logError, notifyError } from "../logger";

export interface NotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionPage {
  id: string;
  title: string;
  blocks: NotionBlock[];
}

export interface NotionPageMeta {
  id: string;
  title: string;
  lastModified: string; // ISO 8601 from last_edited_time
}

export class NotionClient {
  private http: AxiosInstance;
  private tokenPreview: string;

  constructor() {
    const config = vscode.workspace.getConfiguration("companyStandards");
    const token = config.get<string>("notionToken") ?? "";

    if (!token) {
      throw new Error(
        "Notion not configured. Set companyStandards.notionToken in settings."
      );
    }

    this.tokenPreview = "[redacted]";

    log(`[NotionClient] Initialized — token: ${this.tokenPreview}`);
    log(`[NotionClient] Base URL: https://api.notion.com/v1`);
    log(`[NotionClient] Notion-Version: 2022-06-28`);

    this.http = axios.create({
      baseURL: "https://api.notion.com/v1",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    });
  }

  async getPageMetadata(pageId: string): Promise<NotionPageMeta> {
    const url = `/pages/${pageId}`;
    log(`[NotionClient] GET → ${url}`);

    try {
      const response = await this.http.get(url);
      const meta = {
        id: response.data.id,
        title: extractTitle(response.data),
        lastModified: response.data.last_edited_time as string,
      };
      log(`[NotionClient] ← ${response.status} OK | title: "${meta.title}", lastModified: ${meta.lastModified}`);
      return meta;
    } catch (err) {
      throw wrapNotionError(`GET ${url}`, err);
    }
  }

  async getPage(pageId: string): Promise<NotionPage> {
    log(`[NotionClient] Fetching full page — id: ${pageId}`);
    try {
      const [meta, blocks] = await Promise.all([
        this.getPageMetadata(pageId),
        this.fetchAllBlocks(pageId),
      ]);
      log(`[NotionClient] Page loaded — "${meta.title}" | ${blocks.length} blocks`);
      return { id: meta.id, title: meta.title, blocks };
    } catch (err) {
      // Already wrapped by getPageMetadata/fetchAllBlocks — re-throw as-is
      throw err instanceof Error ? err : wrapNotionError(`getPage(${pageId})`, err);
    }
  }

  private async fetchAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    let page = 1;

    do {
      const url = `/blocks/${blockId}/children`;
      log(`[NotionClient] GET → ${url} (page ${page}${cursor ? `, cursor: ${cursor}` : ""})`);
      try {
        const response = await this.http.get(url, {
          params: {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          },
        });
        const results = response.data.results as NotionBlock[];
        blocks.push(...results);
        log(`[NotionClient] ← ${response.status} OK | page ${page}: ${results.length} blocks (total: ${blocks.length})`);
        cursor = response.data.has_more ? (response.data.next_cursor as string) : undefined;
        page++;
      } catch (err) {
        throw wrapNotionError(`GET ${url}`, err);
      }
    } while (cursor);

    return blocks;
  }
}

function extractTitle(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, unknown>;
  for (const key of ["title", "Name", "Title"]) {
    const prop = props[key] as Record<string, unknown> | undefined;
    const titleArr = prop?.["title"] as Array<{ plain_text: string }> | undefined;
    if (titleArr?.[0]?.plain_text) return titleArr[0].plain_text;
  }
  return page.id as string;
}

function wrapNotionError(context: string, err: unknown): Error {
  if (!(err instanceof AxiosError)) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[NotionClient] UNKNOWN ERROR at ${context}`, msg);
    return new Error(`Notion: ${msg}`);
  }

  const status = err.response?.status;
  const data   = JSON.stringify(err.response?.data ?? {});
  const url    = err.config?.url;
  const auth   = err.config?.headers?.["Authorization"] ? "Bearer [redacted]" : "missing";

  logError(
    `[NotionClient] ← ${status ?? "network error"} at ${context}`,
    `URL: ${url} | Auth: ${auth} | body: ${data}`
  );

  if (status === 401) {
    const msg = "Notion: Token no autorizado o caducado. Actualiza companyStandards.notionToken en la configuración.";
    notifyError(msg, "companyStandards.notionToken");
    return new Error(msg);
  }
  if (status === 403) {
    const msg = "Notion: Sin acceso a esta página. Verifica que el token tenga permisos sobre la página configurada.";
    notifyError(msg, "companyStandards.notionToken");
    return new Error(msg);
  }
  if (status === 404) {
    const msg = `Notion: Página no encontrada. Verifica el ID en companyStandards.pagesMap o specialtiesMap. (${context})`;
    notifyError(msg, "companyStandards.specialtiesMap");
    return new Error(msg);
  }
  if (!status) {
    const msg = "Notion: Error de red — no se pudo conectar con la API. Verifica tu conexión a internet.";
    notifyError(msg);
    return new Error(msg);
  }
  return new Error(`Notion: Error inesperado (${status}) — ${err.message}`);
}
