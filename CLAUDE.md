# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile      # TypeScript type-check (no emit for quick validation)
npm run watch        # TypeScript watch mode for development
npm run bundle       # Production build via esbuild (minified CJS → out/extension.js)
npm run lint         # ESLint on src/
npm test             # Jest (all tests)
npx jest --testPathPattern=parser  # Run a single test file by pattern
```

Tests run with `testEnvironment: node`; VSCode is mocked at `src/test/__mocks__/vscode.ts`.

## Architecture

### Entry Point

`src/extension.ts` registers the chat participant on `onStartupFinished`:
- `registerBankAgent()` — registers the `@company` chat participant
- LM Tools: `GetStandardsTool`, `ReviewTestTool`, `CreateProjectTool`

### Chat Participant & Command Routing

`src/agent/bankAgent.ts` is the core. All 9 slash commands (`/help`, `/standards`, `/prompts`, `/docs`, `/jira`, `/project`, `/search`, `/explain`, `/security`) route through `makeHandler()`, which dispatches to individual handlers in `src/handlers/`.

**Command Details:**
- `/help` — Shows all available commands and usage
- `/standards <page-id>` — Lists coding standards; accepts Confluence page ID as argument or uses `standardsPageId` setting. Uses `looksLikePageId()` to detect if user provided an ID vs natural language
- `/prompts [name]` — Lists available prompts or applies one by name
- `/docs` — Generates JSDoc/JavaDoc for active file following bank documentation standards
- `/jira [query]` — Manages Jira issues: list stories, view/create subtasks, update documentation
- `/project <page-id>` — Lists dev tool guides; accepts Confluence page ID as argument or uses `devToolsPageId` setting. Same `looksLikePageId()` detection as `/standards`
- `/search <question>` — Searches knowledge base (Confluence) with natural language; Copilot responds based on results
- `/explain` — Analyzes project architecture and generates sequence diagrams (Mermaid) for endpoints; traces controller → services → repositories/gateways. Writes to `docs/sequence-diagrams.md`
- `/security` — Scans project for vulnerabilities (OWASP Top 10 + configurable risks); generates detailed report to `docs/security-report.md`

Handler signature convention:
```typescript
export async function handleXxxCommand(
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  specialty?: string,
  token?: vscode.CancellationToken
): Promise<void>
```
All output goes to `stream.markdown()` / `stream.progress()` — no return values.

### Knowledge Base Abstraction

`src/knowledge/KnowledgeProvider.ts` defines the provider interface returning `KnowledgePage { id, title, blocks: KnowledgeBlock[] }`.

`src/knowledge/KnowledgeProviderFactory.ts` is a singleton factory that returns:
- `ConfluenceKnowledgeProvider` → Confluence REST API v2 (`src/confluence/client.ts`)

Cache invalidates when `confluenceUrl`, `confluenceEmail`, or `confluenceToken` settings change.

Parsed output from `src/knowledge/parser.ts`:
- `parseProjectSteps()` → `ProjectStep[]`
- `parsePromptLibrary()` → `PromptTemplate[]`
- `blocksToMarkdown()` → `string`

### Specialty System

`src/agent/specialtyResolver.ts` maps `specialty → pageType → pageId`:
1. `specialtiesMap[activeSpecialty][pageType]` (preferred)
2. `pagesMap[pageType]` (legacy fallback)
3. `undefined` → command shows "not configured"

`pageType` is one of: `"standards" | "testing" | "project" | "prompts"`.
Active specialty stored in `companyStandards.specialty`; auto-detected from prompt keywords via `detectSpecialtyFromPrompt()`.

### Token-Aware Prompting

`src/agent/BankPrompt.tsx` uses `@vscode/prompt-tsx` with priority-based pruning so prompts fit within `model.maxInputTokens`. Priority order (highest = never pruned):
1. System prompt (100)
2. User query (90)
3. Active file content (80)
4. KB doc section (70)
5. Chat history (0, pruned first)

### Model Resolution

`src/utils/modelResolver.ts`: if `model.id === "auto"` (Copilot routing placeholder that can't call `sendRequest()` directly), falls back through: GPT-4o → GPT-4 → Claude Sonnet → any available.

### Workspace Context (Batch Processing)

Large handlers (`/security`, `/explain`) scan workspace files in batches. Key constants from `src/config/defaults.ts`:
- `SRC_EXTENSIONS`: `.java .ts .kt .py .cs .go .js`
- `BATCH.FILES_PER_BATCH = 4`, `BATCH.MAX_FILES = 100`, `BATCH.MAX_CHARS_FILE = 4500`

Complex handlers use a two-iteration pattern: iteration 1 generates raw content, iteration 2 refines with cross-references or synthesis.

### External Integrations

- **Jira** (`src/jira/client.ts`) — Basic Auth; methods: `listIssues`, `getIssue`, `getSubtasks`, `createSubtask`, `searchByJql`
- **Copilot LM Tools** (`src/agent/tools/`) — available in Copilot agent mode without explicit `@company`

### Settings Prefix

All settings use `companyStandards.*`. Key ones:
- **Confluence**: `confluenceUrl`, `confluenceEmail`, `confluenceToken`, `confluenceSpaceKey`
- **Jira**: `jiraUrl`, `jiraEmail`, `jiraToken`, `jiraProject`, `jiraJql`, `subtaskAgeThresholdHours`
- **Knowledge Base**: `standardsPageId`, `devToolsPageId`, `promptsPageId`, `specialty`, `specialtiesMap`, `interactivePromptMarker`
- **Security**: `securityRisks`, `iriusriskReportPath` (threat model report from IriusRisk tool)
