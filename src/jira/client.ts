import axios, { AxiosError } from "axios";
import * as vscode from "vscode";
import { log, logError } from "../logger";

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  priority: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string;
  storyPoints: number | null;
  labels: string[];
}

// ─── Atlassian Document Format (ADF) types ───────────────────────────────────

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

interface AdfDoc {
  version: number;
  type: "doc";
  content: AdfNode[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class JiraClient {
  private get config() {
    return vscode.workspace.getConfiguration("companyStandards");
  }

  private get baseUrl(): string {
    return (this.config.get<string>("jiraUrl") ?? "").replace(/\/$/, "");
  }

  private get authHeader(): string {
    const email = this.config.get<string>("jiraEmail") ?? "";
    const token = this.config.get<string>("jiraToken") ?? "";
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private headers() {
    return {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
  }

  /**
   * Lists open issues in a Jira project using JQL.
   * Returns issues in "To Do" or "In Progress" status, ordered by priority.
   */
  async listIssues(projectKey: string, maxResults = 20): Promise<JiraIssueSummary[]> {
    this.validateConfig();
    const jql = `project="${projectKey}" AND status in ("To Do","In Progress") ORDER BY priority DESC`;
    const url = `${this.baseUrl}/rest/api/3/search`;
    log(`[JiraClient] GET issues → ${url} | jql: ${jql}`);

    try {
      const res = await axios.get(url, {
        headers: this.headers(),
        params: { jql, maxResults, fields: "summary,status,priority" },
      });
      log(`[JiraClient] ← ${res.status} ${res.statusText} | ${res.data.issues?.length ?? 0} issues`);

      return (res.data.issues ?? []).map((issue: Record<string, unknown>) => {
        const fields = (issue["fields"] ?? {}) as Record<string, unknown>;
        const status  = fields["status"] as Record<string, unknown> | undefined;
        const priority = fields["priority"] as Record<string, unknown> | undefined;
        return {
          key:      String(issue["key"]),
          summary:  String(fields["summary"] ?? ""),
          status:   String(status?.["name"] ?? ""),
          priority: String(priority?.["name"] ?? ""),
        };
      });
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Fetches full details of a single Jira issue including description (ADF→text).
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    this.validateConfig();
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}`;
    log(`[JiraClient] GET issue → ${url}`);

    try {
      const res = await axios.get(url, {
        headers: this.headers(),
        params: { fields: "summary,description,status,priority,story_points,labels,customfield_10016" },
      });
      log(`[JiraClient] ← ${res.status} ${res.statusText} | key: "${issueKey}"`);

      const fields   = (res.data.fields ?? {}) as Record<string, unknown>;
      const status   = fields["status"] as Record<string, unknown> | undefined;
      const priority = fields["priority"] as Record<string, unknown> | undefined;
      const labels   = Array.isArray(fields["labels"]) ? (fields["labels"] as string[]) : [];

      // Story points: Jira Cloud uses customfield_10016
      const storyPoints =
        typeof fields["story_points"] === "number"
          ? (fields["story_points"] as number)
          : typeof fields["customfield_10016"] === "number"
          ? (fields["customfield_10016"] as number)
          : null;

      return {
        key:         issueKey,
        summary:     String(fields["summary"] ?? ""),
        description: this.adfToText(fields["description"]),
        status:      String(status?.["name"] ?? ""),
        priority:    String(priority?.["name"] ?? ""),
        storyPoints,
        labels,
      };
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Converts Atlassian Document Format (ADF) JSON to plain text.
   * Handles paragraph, text, heading, bulletList, listItem, and codeBlock nodes.
   */
  private adfToText(adf: unknown): string {
    if (!adf || typeof adf !== "object") return "";

    const doc = adf as AdfDoc;
    if (!Array.isArray(doc.content)) return "";

    return this.renderNodes(doc.content).trim();
  }

  private renderNodes(nodes: AdfNode[]): string {
    return nodes.map((node) => this.renderNode(node)).join("");
  }

  private renderNode(node: AdfNode): string {
    switch (node.type) {
      case "text":
        return node.text ?? "";
      case "hardBreak":
        return "\n";
      case "paragraph":
        return (node.content ? this.renderNodes(node.content) : "") + "\n";
      case "heading":
        return (node.content ? this.renderNodes(node.content) : "") + "\n";
      case "bulletList":
      case "orderedList":
        return node.content ? this.renderNodes(node.content) : "";
      case "listItem":
        return "• " + (node.content ? this.renderNodes(node.content).trim() : "") + "\n";
      case "codeBlock":
        return "```\n" + (node.content ? this.renderNodes(node.content) : "") + "\n```\n";
      case "blockquote":
        return node.content ? this.renderNodes(node.content) : "";
      default:
        return node.content ? this.renderNodes(node.content) : "";
    }
  }

  private validateConfig(): void {
    const url   = this.config.get<string>("jiraUrl");
    const email = this.config.get<string>("jiraEmail");
    const token = this.config.get<string>("jiraToken");

    if (!url || !email || !token) {
      throw new Error(
        "Jira not fully configured. " +
        "Set companyStandards.jiraUrl, jiraEmail, and jiraToken in settings."
      );
    }
  }

  private wrapError(err: unknown, url: string): Error {
    if (!(err instanceof AxiosError)) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[JiraClient] Non-HTTP error — ${url}`, msg);
      return new Error(`Jira: ${msg}`);
    }

    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data ?? "");

    logError(
      `[JiraClient] ← ${status ?? "network error"} — ${url}`,
      `body: ${body}`
    );

    if (status === 401) {
      return new Error("Jira: Unauthorized. Check jiraEmail and jiraToken.");
    }
    if (status === 403) {
      return new Error("Jira: Forbidden. Make sure the API token has access to this project.");
    }
    if (status === 404) {
      return new Error(`Jira: Issue or project not found. Check jiraProject and the issue key.`);
    }
    return new Error(`Jira: ${err.message}`);
  }
}
