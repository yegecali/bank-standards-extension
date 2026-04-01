# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile      # TypeScript type-check (no emit for quick validation)
npm run watch        # TypeScript watch mode for development
npm run bundle       # Production build via esbuild (minified CJS → out/extension.js)
npm run lint         # ESLint on src/
npm test             # Jest (all tests)
npx jest --testPathPattern=validator  # Run a single test file by pattern
```

Tests run with `testEnvironment: node`; VSCode is mocked at `src/test/__mocks__/vscode.ts`.

## Architecture

### Entry Point

`src/extension.ts` registers all providers and the chat participant on `onStartupFinished`:
- `DiagnosticProvider` — inline naming-convention warnings (300ms debounce)
- `BankStandardsCodeActionProvider` — quick-fix lightbulbs
- `StatusBarProvider` — shows active knowledge source
- `registerBankAgent()` — registers the `@company` chat participant
- LM Tools: `GetStandardsTool`, `ReviewTestTool`, `CreateProjectTool`

### Chat Participant & Command Routing

`src/agent/bankAgent.ts` is the core. All 22 slash commands (`/review`, `/jira`, `/generate-test`, `/commit`, `/new-feature`, `/pr-review`, `/coverage`, `/checkstyle`, `/security`, `/document`, `/explain`, `/search`, `/prompts`, `/specialty`, `/standards`, `/create`, `/project`, `/docs`, `/onboarding`, `/setup`, `/help`) route through `makeHandler()`, which dispatches to individual handlers in `src/handlers/`.

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

`src/knowledge/KnowledgeProviderFactory.ts` is a singleton factory that returns either:
- `NotionKnowledgeProvider` → Notion REST API v1 (`src/notion/client.ts`)
- `ConfluenceKnowledgeProvider` → Confluence REST API v2 (`src/confluence/client.ts`)

Cache invalidates when `knowledgeSource`, `notionToken`, or `confluenceToken` settings change.

Parsed output from `src/notion/parser.ts`:
- `parseNamingRules()` → `NamingRule[]`
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

Large handlers (`/document`, `/security`, `/explain`, `/coverage`, `/pr-review`) scan workspace files. Key constants from `src/config/defaults.ts`:
- `SRC_EXTENSIONS`: `.java .ts .kt .py .cs .go .js`
- `BATCH.FILES_PER_BATCH = 4`, `BATCH.MAX_FILES = 100`, `BATCH.MAX_CHARS_FILE = 4500`

Complex handlers use a two-iteration pattern: iteration 1 generates raw content, iteration 2 refines with cross-references or synthesis.

### External Integrations

- **Jira** (`src/jira/client.ts`) — Basic Auth; methods: `listIssues`, `getIssue`, `getSubtasks`, `createSubtask`, `searchByJql`
- **Git** (`src/agent/gitHelper.ts`) — `getStagedDiff()` runs `git diff --cached` for `/commit`
- **Copilot LM Tools** (`src/agent/tools/`) — available in Copilot agent mode without explicit `@company`

### Settings Prefix

All settings use `companyStandards.*`. Key ones: `knowledgeSource`, `notionToken`, `confluenceUrl/Email/Token/SpaceKey`, `jiraUrl/Email/Token/Project`, `specialty`, `specialtiesMap`, `namingRules`, `coverageThreshold`.
