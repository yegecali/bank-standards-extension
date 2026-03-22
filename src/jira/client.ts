import axios, { AxiosError } from "axios";
import * as vscode from "vscode";
import { log, logError } from "../logger";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  priority: string;
  project: string;
  assignee: string | null;
  timeInProgress: string | null;
  created: string;
  statusChangedDate: string | null;
}

export interface JiraSubtask {
  key: string;
  summary: string;
  status: string;
  priority: string;
  timeOpen: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string;
  storyPoints: number | null;
  labels: string[];
  subtasks: JiraSubtask[];
  timeOpen: string;
  timeInProgress: string | null;
  created: string;
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

// ─── Config helper ───────────────────────────────────────────────────────────

/**
 * Returns the configured Jira project keys as an array.
 * Supports both a single string ("BANK") and an array (["BANK","DEV"]).
 * Used by /jira and /new-feature commands.
 */
export function getConfiguredProjects(): string[] {
  const config = vscode.workspace.getConfiguration("companyStandards");
  const raw = config.get<unknown>("jiraProject");
  if (Array.isArray(raw)) return (raw as unknown[]).filter((v) => typeof v === "string" && v.trim()) as string[];
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
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
   * Lists open issues across one or more Jira projects.
   * Includes time-open and time-in-progress metrics.
   */
  async listIssues(projectKeys: string[], maxResults = 30): Promise<JiraIssueSummary[]> {
    this.validateConfig();

    const projectList = projectKeys.map((k) => `"${k}"`).join(",");
    const jql = `project in (${projectList}) AND status = "In Progress" ORDER BY priority DESC, updated DESC`;
    const url = `${this.baseUrl}/rest/api/3/search/jql`;
    log(`[JiraClient] POST issues → ${url} | jql: ${jql}`);

    try {
      const res = await axios.post(url, {
        jql,
        maxResults,
        fields: ["summary", "status", "priority", "created", "statuscategorychangedate", "assignee", "project"],
      }, { headers: { ...this.headers(), "Content-Type": "application/json" } });
      log(`[JiraClient] ← ${res.status} ${res.statusText} | ${res.data.issues?.length ?? 0} issues`);

      return (res.data.issues ?? []).map((issue: Record<string, unknown>) => {
        const fields            = (issue["fields"] ?? {}) as Record<string, unknown>;
        const status            = fields["status"] as Record<string, unknown> | undefined;
        const priority          = fields["priority"] as Record<string, unknown> | undefined;
        const project           = fields["project"] as Record<string, unknown> | undefined;
        const assignee          = fields["assignee"] as Record<string, unknown> | null | undefined;
        const created           = String(fields["created"] ?? "");
        const statusChangedDate = typeof fields["statuscategorychangedate"] === "string"
          ? fields["statuscategorychangedate"]
          : null;
        const statusName = String(status?.["name"] ?? "");

        return {
          key:              String(issue["key"]),
          summary:          String(fields["summary"] ?? ""),
          status:           statusName,
          priority:         String(priority?.["name"] ?? ""),
          project:          String(project?.["key"] ?? ""),
          assignee:         assignee ? String(assignee["displayName"] ?? assignee["emailAddress"] ?? "") : null,
          timeInProgress:   this.formatAge(statusChangedDate),
          created,
          statusChangedDate,
        };
      });
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Fetches full details of a single Jira issue including description, subtasks, and time metrics.
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    this.validateConfig();
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}`;
    log(`[JiraClient] GET issue → ${url}`);

    try {
      const res = await axios.get(url, {
        headers: this.headers(),
        params: {
          fields: "summary,description,status,priority,customfield_10016,labels,subtasks,created,statuscategorychangedate,project",
        },
      });
      log(`[JiraClient] ← ${res.status} ${res.statusText} | key: "${issueKey}"`);

      const fields            = (res.data.fields ?? {}) as Record<string, unknown>;
      const status            = fields["status"] as Record<string, unknown> | undefined;
      const priority          = fields["priority"] as Record<string, unknown> | undefined;
      const labels            = Array.isArray(fields["labels"]) ? (fields["labels"] as string[]) : [];
      const created           = String(fields["created"] ?? "");
      const statusChangedDate = typeof fields["statuscategorychangedate"] === "string"
        ? fields["statuscategorychangedate"]
        : null;
      const statusName = String(status?.["name"] ?? "");

      // Story points: Jira Cloud uses customfield_10016
      const storyPoints =
        typeof fields["story_points"] === "number"
          ? (fields["story_points"] as number)
          : typeof fields["customfield_10016"] === "number"
          ? (fields["customfield_10016"] as number)
          : null;

      // Parse subtasks
      const rawSubtasks = Array.isArray(fields["subtasks"]) ? fields["subtasks"] as Record<string, unknown>[] : [];
      const subtasks: JiraSubtask[] = rawSubtasks.map((st) => {
        const stFields   = (st["fields"] ?? {}) as Record<string, unknown>;
        const stStatus   = stFields["status"] as Record<string, unknown> | undefined;
        const stPriority = stFields["priority"] as Record<string, unknown> | undefined;
        const stCreated  = typeof stFields["created"] === "string" ? stFields["created"] : null;
        return {
          key:      String(st["key"]),
          summary:  String(stFields["summary"] ?? ""),
          status:   String(stStatus?.["name"] ?? ""),
          priority: String(stPriority?.["name"] ?? ""),
          timeOpen: this.formatAge(stCreated) ?? "—",
        };
      });

      return {
        key:             issueKey,
        summary:         String(fields["summary"] ?? ""),
        description:     this.adfToText(fields["description"]),
        status:          statusName,
        priority:        String(priority?.["name"] ?? ""),
        storyPoints,
        labels,
        subtasks,
        timeOpen:        this.formatAge(created) ?? "—",
        timeInProgress:  statusName === "In Progress" ? this.formatAge(statusChangedDate) : null,
        created,
      };
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  /**
   * Returns the subtasks of a given issue.
   * Uses getIssue() internally — subtasks are already included.
   */
  async getSubtasks(issueKey: string): Promise<JiraSubtask[]> {
    const issue = await this.getIssue(issueKey);
    return issue.subtasks;
  }

  /**
   * Creates a new subtask under the given parent issue.
   * Returns the key of the newly created issue.
   */
  async createSubtask(parentKey: string, projectKey: string, summary: string): Promise<string> {
    this.validateConfig();
    const url = `${this.baseUrl}/rest/api/3/issue`;
    log(`[JiraClient] POST createSubtask → ${url} | parent: ${parentKey}, project: ${projectKey}`);

    try {
      const res = await axios.post(
        url,
        {
          fields: {
            project:   { key: projectKey },
            parent:    { key: parentKey },
            summary,
            issuetype: { name: "Sub-task" },
          },
        },
        { headers: { ...this.headers(), "Content-Type": "application/json" } }
      );
      log(`[JiraClient] ← ${res.status} | created: ${res.data.key}`);
      return String(res.data.key);
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  // ─── Time helpers ──────────────────────────────────────────────────────────

  /**
   * Formats the age of a date (from isoDate to now) as a human-readable string.
   * Returns null if the date is null/empty.
   * Examples: "45m", "3h 20m", "3d 4h", "2w 1d", "3 months"
   */
  private formatAge(isoDate: string | null | undefined): string | null {
    if (!isoDate) return null;
    const ms = Date.now() - new Date(isoDate).getTime();
    if (isNaN(ms) || ms < 0) return null;

    const minutes = Math.floor(ms / 60_000);
    const hours   = Math.floor(ms / 3_600_000);
    const days    = Math.floor(ms / 86_400_000);
    const weeks   = Math.floor(days / 7);
    const months  = Math.floor(days / 30);

    if (minutes < 60)  return `${minutes}m`;
    if (hours < 24)    return `${hours}h ${minutes % 60}m`;
    if (days < 7)      return `${days}d ${hours % 24}h`;
    if (weeks < 5)     return `${weeks}w ${days % 7}d`;
    if (months === 1)  return "1 month";
    return `${months} months`;
  }

  // ─── ADF helpers ───────────────────────────────────────────────────────────

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
      case "text":         return node.text ?? "";
      case "hardBreak":    return "\n";
      case "paragraph":    return (node.content ? this.renderNodes(node.content) : "") + "\n";
      case "heading":      return (node.content ? this.renderNodes(node.content) : "") + "\n";
      case "bulletList":
      case "orderedList":  return node.content ? this.renderNodes(node.content) : "";
      case "listItem":     return "• " + (node.content ? this.renderNodes(node.content).trim() : "") + "\n";
      case "codeBlock":    return "```\n" + (node.content ? this.renderNodes(node.content) : "") + "\n```\n";
      default:             return node.content ? this.renderNodes(node.content) : "";
    }
  }

  // ─── Config / error helpers ────────────────────────────────────────────────

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

    if (status === 401) return new Error("Jira: Unauthorized. Check jiraEmail and jiraToken.");
    if (status === 403) return new Error("Jira: Forbidden. Make sure the API token has access to this project.");
    if (status === 404) return new Error("Jira: Issue or project not found. Check jiraProject and the issue key.");
    return new Error(`Jira: ${err.message}`);
  }
}
