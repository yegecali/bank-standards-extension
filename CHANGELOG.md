# Changelog

All notable changes to the "Company Coding Standard" extension are documented here.

## [0.0.61] - 2026-04-02

### Removed
- **Slash commands removed**: `/review`, `/coverage`, `/checkstyle`, `/generate-test`, `/commit`, `/document`, `/new-feature`, `/create`, `/pr-review`, `/onboarding`, `/setup`, `/specialty` — all removed from the chat participant and routing logic.
- **Imports cleaned up** in `bankAgent.ts`: removed unused imports for `handlePromptsCommand`, `handleNewFeatureCommand`, `handleOnboardingCommand`, `handleSetupCommand`, `handleDocumentCommand`, `handleCheckstyleCommand`, `handleReviewCommand`, `handleGenerateTestCommand`, `handleCommitCommand`, `handlePrReviewCommand`, `handleCoverageCommand`, `applyChildPageAsPrompt`, `isCreateIntent`, `createProjectFromKb`, `getStagedDiff`, and `setActiveSpecialty`.
- **Settings removed** (only used by removed commands): `companyStandards.checkstyleConfigPath`, `companyStandards.mavenExecutable`, `companyStandards.coverageThreshold`, `companyStandards.setupPage`.
- **`isReviewIntent` function** removed from `bankAgent.ts` (no longer used).

### Changed
- **`HELP_TEXT`** updated to show only the kept commands: `/explain`, `/security`, `/standards`, `/prompts`, `/project`, `/search`, `/docs`, `/jira`.
- **`sampleRequests`** in `package.json` updated to reflect the active command set.
- **`intentToCommand`** in the followup provider simplified to only map `jira`, `standards`, and `docs`.
- **`resolvePageKey`** simplified to handle only the kept commands.
- **`systemPrompt`** simplified — removed "IMPORTANTE: Este agente SÍ puede crear proyectos…" paragraph.
- **`reviewInstruction` logic** simplified to only handle the `/docs` case.
- Section numbering in `makeHandler` updated (sections 4 and 5–7 renumbered).

### Added
- **New settings** added to `package.json` (referenced in code but previously undeclared): `companyStandards.promptsPageId`, `companyStandards.devToolsPageId`, `companyStandards.standardsPageId`.

## [0.0.59] - 2026-04-01

### Removed
- **Notion integration completely removed** — Confluence is now the only knowledge source.
  - Deleted `src/notion/client.ts`, `src/notion/cache.ts`, `src/knowledge/providers/NotionKnowledgeProvider.ts`, and the `src/notion/` directory.
  - Removed `companyStandards.notionToken` setting from `package.json`.
  - Removed `"notion"` from the `knowledgeSource` enum; default changed from `"notion"` to `"confluence"`.
  - Removed `"notion"` keyword from extension manifest.

### Changed
- `src/notion/parser.ts` moved to `src/knowledge/parser.ts` (provider-agnostic; no logic changes).
- `src/notion/cache.ts` moved to `src/knowledge/cache.ts` (provider-agnostic; no logic changes).
- `KnowledgeProviderFactory`: simplified to always return `ConfluenceKnowledgeProvider`; `KnowledgeSourceType` is now `"confluence"` only.
- `bankAgent.ts`: renamed `notionMarkdown` → `pageMarkdown`; updated HELP_TEXT to show Confluence config; system prompt now says "almacenada en Confluence"; `/setup` warning updated; "Actualizar estándares desde Notion" button renamed to "Actualizar estándares".
- `BankPrompt.tsx`: renamed prop `notionContent` → `kbContent`; updated JSDoc comment from "Notion documentation" to "Knowledge base documentation".
- `projectCreator.ts`: renamed export `createProjectFromNotion` → `createProjectFromKb`.
- `extension.ts`: log line changed from `notionToken` → `confluenceToken`; change-listener no longer watches `notionToken`; "Notion (page updated)" message → "Confluence (page updated)".
- All remaining `../notion/parser` imports across handlers and tools updated to `../knowledge/parser`.
- All remaining `../notion/cache` imports updated to `../knowledge/cache`.

## [0.0.58] - 2026-04-01

### Added
- `/project` command now supports a new **child-page flow**: configure `companyStandards.devToolsPageId` with a Confluence parent page ID and the command lists its subpages via QuickPick, then loads and applies the selected guide with the LLM.
- `confluenceChildPageHandler.ts`: new shared handler with three reusable functions — `pickAndLoadChildPage`, `applyChildPageAsGuide`, `applyChildPageAsStandard`, and `applyChildPageAsPrompt`.
- `ConfluenceClient.getChildPages()`: lightweight Confluence v2 API call that fetches direct child pages (id + title) sorted by title.
- `KnowledgeProvider.getChildPages()`: optional method added to the interface; implemented by `ConfluenceKnowledgeProvider`.

### Improved
- Extension icon updated: `icon.svg` replaces the old `bank-agent.svg` / `company-agent.svg` references in both the participant icon path and `package.json`.
- Code formatting pass on `bankAgent.ts`: trailing commas, consistent indentation, and multi-line call signatures aligned to project ESLint style.

### Fixed
- `NotionKnowledgeProvider.toKnowledgeBlock()`: `content.rich_text` is now correctly cast to `RichTextArray | undefined` before being passed to `rt()`, resolving eight `TS2345` type errors introduced when `tsconfig.json` strict mode propagated `unknown`.

## [0.0.47] - 2026-03-31

### Added
- `/pr-review` command: reviews the full diff of the current branch vs. a base branch selected via QuickPick, analysing logic changes, test coverage, naming, potential bugs, and standards violations.
- `/coverage` command: analyses Maven JaCoCo coverage reports (`target/site/jacoco/jacoco.csv`) or Surefire reports, shows a per-class coverage table, and suggests which classes to test when they fall below the configured threshold.
- `/new-feature` guided flow: select a Jira story, plan the implementation following company standards, and write it back to Jira on completion.

### Improved
- `/jira` redesigned as a guided 3-operation flow: list issues with time metrics, view/create subtasks, and update documentation.
- `/search` now returns a directly synthesised answer built from Confluence results rather than a raw list of links.
- `/checkstyle` iterates until Maven `checkstyle:check` reports zero errors, applying JavaDoc and formatting fixes in a loop.
- `/review`, `/generate-test`, and `/commit` handlers refactored with shared workspace-context utilities to reduce duplication.

### Internal
- Technical debt pass (P1): shared helpers extracted, activation events tightened to `onStartupFinished`.
- Test suite: 69 unit tests across 5 suites, all passing.

## [0.0.46] - prior release

Initial marketplace release covering: `/standards`, `/review`, `/create`, `/prompts`, `/specialty`, `/generate-test`, `/docs`, `/commit`, `/new-feature`, `/jira`, `/project`, `/onboarding`, `/setup`, `/search`, `/explain`, `/document`, `/security`, `/checkstyle`.
