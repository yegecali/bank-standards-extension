import axios, { AxiosError } from "axios";
import * as vscode from "vscode";
import { log, logError, notifyError } from "../logger";

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
    return vscode.workspace.getConfiguration("companyStandards");
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
      let adf: AdfDoc = { version: 1, type: "doc", content: [] };
      const rawAdf = res.data.body?.atlas_doc_format?.value;
      if (rawAdf) {
        try {
          adf = JSON.parse(rawAdf);
        } catch {
          log("[ConfluenceClient] ADF JSON parse failed — returning empty doc");
        }
      }

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
   * Lightweight CQL search — returns title, excerpt, and URL only (no body expansion).
   * Use getPage() separately when you need full content.
   */
  async searchPagesMeta(query: string, limit = 10): Promise<Array<{
    id: string;
    title: string;
    url: string;
    excerpt: string;
  }>> {
    this.validateConfig();
    const spaceKey = this.config.get<string>("confluenceSpaceKey") ?? "";
    const spacePart = spaceKey ? ` AND space="${spaceKey}"` : "";
    const cql = `type=page${spacePart} AND text~"${query.replace(/"/g, '\\"')}"`;
    const url = `${this.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;

    log(`[ConfluenceClient] CQL meta-search → ${url}`);
    try {
      const res = await axios.get(url, { headers: this.headers() });
      const results = res.data.results ?? [];
      log(`[ConfluenceClient] CQL meta-search ← ${results.length} results`);
      return results.map((r: Record<string, unknown>) => ({
        id:      String(r["id"]),
        title:   String(r["title"]),
        url:     `${this.baseUrl}/wiki${(r["_links"] as Record<string, unknown> | undefined)?.["webui"] ?? ""}`,
        excerpt: String((r["excerpt"] as string | undefined) ?? ""),
      }));
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Full-text search using Confluence CQL — includes ADF body.
   * Use searchPagesMeta() for listing; use this only when you need body content inline.
   */
  async searchPages(query: string, limit = 5): Promise<Array<{
    id: string;
    title: string;
    url: string;
    excerpt: string;
    adf: AdfDoc;
  }>> {
    this.validateConfig();
    const spaceKey = this.config.get<string>("confluenceSpaceKey") ?? "";
    const spacePart = spaceKey ? ` AND space="${spaceKey}"` : "";
    const cql = `type=page${spacePart} AND text~"${query.replace(/"/g, '\\"')}"`;
    const url = `${this.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=body.atlas_doc_format`;

    log(`[ConfluenceClient] CQL search → ${url}`);
    try {
      const res = await axios.get(url, { headers: this.headers() });
      const results = res.data.results ?? [];
      log(`[ConfluenceClient] CQL search ← ${results.length} results`);

      return results.map((r: Record<string, unknown>) => {
        const bodyRaw = (r["body"] as Record<string, unknown> | undefined)
          ?.["atlas_doc_format"] as Record<string, unknown> | undefined;
        let adf: AdfDoc = { version: 1, type: "doc", content: [] };
        if (bodyRaw?.["value"]) {
          try { adf = JSON.parse(String(bodyRaw["value"])); } catch { /* skip */ }
        }
        return {
          id:      String(r["id"]),
          title:   String(r["title"]),
          url:     `${this.baseUrl}/wiki${(r["_links"] as Record<string, unknown> | undefined)?.["webui"] ?? ""}`,
          excerpt: String((r["excerpt"] as string | undefined) ?? ""),
          adf,
        };
      });
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Lists the direct child pages of a given page (Confluence v2 API).
   * Returns id + title only (lightweight call).
   */
  async getChildPages(pageId: string): Promise<Array<{ id: string; title: string }>> {
    this.validateConfig();
    const url = `${this.baseUrl}/wiki/api/v2/pages/${pageId}/children?limit=50&sort=title`;
    log(`[ConfluenceClient] GET child pages → ${url}`);
    try {
      const res = await axios.get(url, { headers: this.headers() });
      const results = res.data.results ?? [];
      log(`[ConfluenceClient] ← ${res.status} | ${results.length} children`);
      return (results as Record<string, unknown>[]).map((p) => ({
        id:    String(p["id"]),
        title: String(p["title"]),
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
        "Set companyStandards.confluenceUrl, confluenceEmail, and confluenceToken in settings."
      );
    }
  }

  private wrapError(err: unknown, url: string): Error {
    if (!(err instanceof AxiosError)) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[ConfluenceClient] Non-HTTP error — ${url}`, msg);
      return new Error(`Confluence: ${msg}`);
    }

    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data ?? "");

    logError(
      `[ConfluenceClient] ← ${status ?? "network error"} — ${url}`,
      `body: ${body}`
    );

    if (status === 401) {
      const msg = "Confluence: Token no autorizado o caducado. Actualiza confluenceEmail y confluenceToken en la configuración.";
      notifyError(msg, "companyStandards.confluenceToken");
      return new Error(msg);
    }
    if (status === 403) {
      const msg = "Confluence: Sin acceso a esta página. Verifica que el token tenga permisos sobre el espacio configurado.";
      notifyError(msg, "companyStandards.confluenceToken");
      return new Error(msg);
    }
    if (status === 404) {
      return new Error(`Confluence: Página no encontrada (id: ${url.split("/").pop()?.split("?")[0]}). Verifica pagesMap o specialtiesMap.`);
    }
    if (!status) {
      const msg = "Confluence: Error de red — no se pudo conectar con el servidor. Verifica confluenceUrl y tu conexión.";
      notifyError(msg, "companyStandards.confluenceUrl");
      return new Error(msg);
    }
    return new Error(`Confluence: Error inesperado (${status}) — ${err.message}`);
  }
}
