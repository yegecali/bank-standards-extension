import axios, { AxiosError } from "axios";
import * as vscode from "vscode";
import { log, logError } from "../logger";

export interface ConfluencePageMeta {
  id: string;
  title: string;
  /** ISO 8601 — last modification date, used for cache invalidation */
  lastModified: string;
}

export interface ConfluencePageContent {
  id: string;
  title: string;
  /** Atlassian Document Format (ADF) as parsed JSON */
  adf: AdfDoc;
}

// ─── Atlassian Document Format (ADF) types ───────────────────────────────────

export interface AdfDoc {
  version: number;
  type: "doc";
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ConfluenceClient {
  private get config() {
    return vscode.workspace.getConfiguration("bankStandards");
  }

  private get baseUrl(): string {
    return (this.config.get<string>("confluenceUrl") ?? "").replace(/\/$/, "");
  }

  private get authHeader(): string {
    const email = this.config.get<string>("confluenceEmail") ?? "";
    const token = this.config.get<string>("confluenceToken") ?? "";
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private headers() {
    return {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
  }

  /**
   * Lightweight call — fetches only page metadata for cache comparison.
   * Uses Confluence Cloud REST API v2.
   */
  async getPageMetadata(pageId: string): Promise<ConfluencePageMeta> {
    this.validateConfig();
    const url = `${this.baseUrl}/wiki/api/v2/pages/${pageId}`;
    log(`[ConfluenceClient] GET metadata → ${url}`);

    try {
      const res = await axios.get(url, { headers: this.headers() });
      log(`[ConfluenceClient] ← ${res.status} ${res.statusText} | title: "${res.data.title}"`);
      return {
        id:           String(res.data.id),
        title:        res.data.title ?? "(no title)",
        lastModified: res.data.version?.createdAt ?? res.data.createdAt ?? new Date().toISOString(),
      };
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Full call — fetches page content in ADF (JSON), no HTML parsing needed.
   */
  async getPage(pageId: string): Promise<ConfluencePageContent> {
    this.validateConfig();
    const url = `${this.baseUrl}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`;
    log(`[ConfluenceClient] GET page → ${url}`);

    try {
      const res = await axios.get(url, { headers: this.headers() });
      log(`[ConfluenceClient] ← ${res.status} ${res.statusText} | title: "${res.data.title}"`);
      const adf: AdfDoc = res.data.body?.atlas_doc_format?.value
        ? JSON.parse(res.data.body.atlas_doc_format.value)
        : { version: 1, type: "doc", content: [] };

      return {
        id:    String(res.data.id),
        title: res.data.title ?? "(no title)",
        adf,
      };
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Lists all available Confluence spaces the user has access to.
   */
  async getSpaces(): Promise<Array<{ id: string; key: string; name: string }>> {
    this.validateConfig();
    const url = `${this.baseUrl}/wiki/api/v2/spaces?limit=50&sort=name`;
    log(`[ConfluenceClient] GET spaces → ${url}`);
    try {
      const res = await axios.get(url, { headers: this.headers() });
      log(`[ConfluenceClient] ← ${res.status} ${res.statusText} | ${(res.data.results ?? []).length} spaces`);
      return (res.data.results ?? []).map((s: Record<string, unknown>) => ({
        id:   String(s["id"]),
        key:  String(s["key"]),
        name: String(s["name"]),
      }));
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Lists pages inside a Confluence space by space ID.
   */
  async getPagesInSpace(spaceId: string): Promise<Array<{ id: string; title: string }>> {
    this.validateConfig();
    const url = `${this.baseUrl}/wiki/api/v2/spaces/${spaceId}/pages?limit=250&sort=title`;
    log(`[ConfluenceClient] GET pages in space ${spaceId} → ${url}`);
    try {
      const res = await axios.get(url, { headers: this.headers() });
      log(`[ConfluenceClient] ← ${res.status} ${res.statusText} | ${(res.data.results ?? []).length} pages`);
      return (res.data.results ?? []).map((p: Record<string, unknown>) => ({
        id:    String(p["id"]),
        title: String(p["title"]),
      }));
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private validateConfig(): void {
    const url   = this.config.get<string>("confluenceUrl");
    const email = this.config.get<string>("confluenceEmail");
    const token = this.config.get<string>("confluenceToken");

    if (!url || !email || !token) {
      throw new Error(
        "Confluence not fully configured. " +
        "Set bankStandards.confluenceUrl, confluenceEmail, and confluenceToken in settings."
      );
    }
  }

  private wrapError(err: unknown, url: string): Error {
    const axiosErr = err as AxiosError;
    const status   = axiosErr.response?.status;
    const body     = JSON.stringify(axiosErr.response?.data ?? "");

    logError(
      `[ConfluenceClient] ← ${status ?? "network error"} — ${url}`,
      `body: ${body}`
    );

    if (status === 401) {
      return new Error("Confluence: Unauthorized. Check confluenceEmail and confluenceToken.");
    }
    if (status === 403) {
      return new Error("Confluence: Forbidden. Make sure the API token has access to this page.");
    }
    if (status === 404) {
      return new Error(`Confluence: Page not found (id: ${url.split("/").pop()?.split("?")[0]}). Check pagesMap.`);
    }
    return new Error(`Confluence: ${axiosErr.message}`);
  }
}
