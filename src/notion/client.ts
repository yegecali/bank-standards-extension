import axios, { AxiosInstance, AxiosError } from "axios";
import * as vscode from "vscode";

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
    const config = vscode.workspace.getConfiguration("bankStandards");
    const token = config.get<string>("notionToken") ?? "";

    if (!token) {
      throw new Error(
        "Notion not configured. Set bankStandards.notionToken in settings."
      );
    }

    this.tokenPreview = "[redacted]";

    console.log(`[NotionClient] Initialized — token: ${this.tokenPreview}`);
    console.log(`[NotionClient] Base URL: https://api.notion.com/v1`);
    console.log(`[NotionClient] Notion-Version: 2022-06-28`);

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
    console.log(`[NotionClient] GET ${url}`);

    try {
      const response = await this.http.get(url);
      const meta = {
        id: response.data.id,
        title: extractTitle(response.data),
        lastModified: response.data.last_edited_time as string,
      };
      console.log(`[NotionClient] Page metadata OK — title: "${meta.title}", lastModified: ${meta.lastModified}`);
      return meta;
    } catch (err) {
      logAxiosError(`GET ${url}`, err);
      throw err;
    }
  }

  async getPage(pageId: string): Promise<NotionPage> {
    console.log(`[NotionClient] Fetching full page — id: ${pageId}`);
    try {
      const [meta, blocks] = await Promise.all([
        this.getPageMetadata(pageId),
        this.fetchAllBlocks(pageId),
      ]);
      console.log(`[NotionClient] Page loaded — "${meta.title}" | ${blocks.length} blocks`);
      return { id: meta.id, title: meta.title, blocks };
    } catch (err) {
      logAxiosError(`getPage(${pageId})`, err);
      throw err;
    }
  }

  private async fetchAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    let page = 1;

    do {
      const url = `/blocks/${blockId}/children`;
      console.log(`[NotionClient] GET ${url} — page ${page}${cursor ? ` cursor: ${cursor}` : ""}`);
      try {
        const response = await this.http.get(url, {
          params: {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          },
        });
        const results = response.data.results as NotionBlock[];
        blocks.push(...results);
        console.log(`[NotionClient] Blocks page ${page} — got ${results.length} blocks (total so far: ${blocks.length})`);
        cursor = response.data.has_more ? (response.data.next_cursor as string) : undefined;
        page++;
      } catch (err) {
        logAxiosError(`GET ${url}`, err);
        throw err;
      }
    } while (cursor);

    return blocks;
  }
}

function extractTitle(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, unknown>;
  for (const key of ["title", "Name", "Title"]) {
    const prop = props[key] as any;
    if (prop?.title?.[0]?.plain_text) return prop.title[0].plain_text as string;
  }
  return page.id as string;
}

function logAxiosError(context: string, err: unknown): void {
  if (err instanceof AxiosError) {
    const status  = err.response?.status;
    const data    = JSON.stringify(err.response?.data ?? {});
    const url     = err.config?.url;
    const headers = JSON.stringify({
      "Notion-Version": err.config?.headers?.["Notion-Version"],
      "Authorization":  err.config?.headers?.["Authorization"] ? "Bearer [redacted]" : "missing",
    });
    console.error(`[NotionClient] ERROR at ${context}`);
    console.error(`  Status  : ${status}`);
    console.error(`  URL     : ${url}`);
    console.error(`  Headers : ${headers}`);
    console.error(`  Response: ${data}`);
  } else {
    console.error(`[NotionClient] UNKNOWN ERROR at ${context}:`, err);
  }
}
