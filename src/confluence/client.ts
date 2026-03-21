import axios, { AxiosError } from "axios";
import * as vscode from "vscode";

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
    console.log(`[ConfluenceClient] GET metadata: ${url}`);

    try {
      const { data } = await axios.get(url, { headers: this.headers() });
      return {
        id:           String(data.id),
        title:        data.title ?? "(no title)",
        lastModified: data.version?.createdAt ?? data.createdAt ?? new Date().toISOString(),
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
    console.log(`[ConfluenceClient] GET page: ${url}`);

    try {
      const { data } = await axios.get(url, { headers: this.headers() });
      const adf: AdfDoc = data.body?.atlas_doc_format?.value
        ? JSON.parse(data.body.atlas_doc_format.value)
        : { version: 1, type: "doc", content: [] };

      return {
        id:    String(data.id),
        title: data.title ?? "(no title)",
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
    console.log(`[ConfluenceClient] GET spaces: ${url}`);
    try {
      const { data } = await axios.get(url, { headers: this.headers() });
      return (data.results ?? []).map((s: Record<string, unknown>) => ({
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
    console.log(`[ConfluenceClient] GET pages in space ${spaceId}: ${url}`);
    try {
      const { data } = await axios.get(url, { headers: this.headers() });
      return (data.results ?? []).map((p: Record<string, unknown>) => ({
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

    console.error(
      `[ConfluenceClient] Request failed — URL: ${url}, ` +
      `status: ${status ?? "network error"}, body: ${body}`
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
