# Architecture

Technical reference for contributors and maintainers of the Company Coding Standard extension.

---

## File structure

```
src/
├── extension.ts                  Entry point — registers all providers and commands
├── logger.ts                     Output Channel "Company Coding Standard" (log/logError/showChannel)
│
├── agent/
│   ├── bankAgent.ts              @bank chat participant — routes all slash commands
│   ├── specialtyResolver.ts      Specialty resolution: specialtiesMap → pagesMap fallback
│   ├── promptLibraryHandler.ts   /prompts — catalog listing and prompt execution
│   ├── jiraHandler.ts            /jira — issue listing, detail, subtasks, create
│   ├── newFeatureHandler.ts      /new-feature — 8-step guided implementation workflow
│   ├── gitHelper.ts              getStagedDiff() — reads git diff --cached
│   └── BankPrompt.tsx            Token-priority prompt builder for context pruning
│
├── commands/
│   └── setupConfluenceCommand.ts Guided wizard: pick Confluence space → map pages
│
├── knowledge/
│   ├── KnowledgeProvider.ts      Interfaces: KnowledgeBlock, KnowledgePage, KnowledgeProvider
│   ├── KnowledgeProviderFactory.ts Singleton factory with cache + resetKnowledgeProvider()
│   └── providers/
│       ├── NotionKnowledgeProvider.ts    Notion → KnowledgeBlock[]
│       └── ConfluenceKnowledgeProvider.ts ADF → KnowledgeBlock[] with full macro support
│
├── notion/
│   ├── client.ts                 Notion REST API v1 client (axios + Output Channel logs)
│   └── parser.ts                 parseNamingRules / parseProjectSteps / parsePromptLibrary / blocksToMarkdown
│
├── confluence/
│   └── client.ts                 Confluence REST API v2 client — getPage, getSpaces, getPagesInSpace
│
├── providers/
│   ├── diagnosticProvider.ts     Inline diagnostics with 300ms debounce
│   ├── codeActionProvider.ts     Lightbulb quick-fixes for naming violations
│   └── statusBarProvider.ts      Status bar item showing active knowledge source
│
└── standards/
    └── validator.ts              Regex-based naming convention checker (EXTRACTOR_PATTERNS)
```

---

## Knowledge provider flow

```
vscode settings
  knowledgeSource = "notion" | "confluence"
        │
        ▼
KnowledgeProviderFactory.createKnowledgeProvider()
  cached by source string — reset on credential change
        │
        ├─ notion      → NotionKnowledgeProvider  → NotionClient (REST v1)
        └─ confluence  → ConfluenceKnowledgeProvider → ConfluenceClient (REST v2)
                                │
                                ▼
                        KnowledgePage { id, title, blocks: KnowledgeBlock[] }
                                │
                                ▼
                        parser.ts
                          parseNamingRules()    → NamingRule[]
                          parseProjectSteps()   → ProjectStep[]
                          parsePromptLibrary()  → PromptTemplate[]
                          blocksToMarkdown()    → string
```

---

## Specialty resolution

```
resolvePageId(pageType, specialty?)
  │
  ├─ 1. specialtiesMap[activeSpecialty][pageType]   ← preferred
  ├─ 2. pagesMap[pageType]                          ← legacy fallback
  └─ 3. undefined → command shows "not configured" message
```

Active specialty is stored in `companyStandards.specialty` (global settings).
`detectSpecialtyFromPrompt()` auto-detects specialty keywords in the user's message.

---

## @bank agent — command routing

```
bankAgent.ts → handleRequest(request, context, stream, token)
  │
  ├─ /standards    → load "standards" page → blocksToMarkdown → stream
  ├─ /review       → load "standards" page + active file → LLM review
  ├─ /create       → load "project" page → blocksToMarkdown → stream
  ├─ /generate-test→ load "testing" page + active file → LLM unit test generation
  ├─ /docs         → load "standards" page + active file → LLM JSDoc/JavaDoc generation
  ├─ /commit       → getStagedDiff() + "standards" page → LLM Conventional Commit message
  ├─ /prompts      → load "prompts" page → parsePromptLibrary → handlePromptsCommand
  ├─ /specialty    → handleSpecialtyCommand (list or switch)
  ├─ /jira         → jiraHandler (list / detail / subtasks / create)
  ├─ /new-feature  → newFeatureHandler (8-step guided workflow)
  └─ (free text)   → load "standards" page → LLM general answer
```

---

## /jira command

```
jiraHandler.ts
  │
  ├─ /jira               → JiraClient.getIssues(projects) → QuickPick → showIssueDetail()
  ├─ /jira PROJ-123      → JiraClient.getIssue(key) → showIssueDetail()
  ├─ /jira subtasks KEY  → JiraClient.getSubtasks(key) → markdown table
  └─ /jira create KEY    → InputBox(summary) → JiraClient.createSubtask() → confirm

JiraClient
  baseUrl  : companyStandards.jiraUrl
  auth     : Basic (jiraEmail + jiraToken)
  projects : companyStandards.jiraProject (string | string[])

Time metrics: "45m" | "3h 20m" | "3d 4h" | "2w 1d" | "3 months"
```

---

## /new-feature workflow

```
newFeatureHandler.ts — 8 steps
  1. Validate Jira config
  2. JiraClient.getIssues(project) → QuickPick story
  3. Display selected issue detail
  4. LLM → stream implementation plan (components, endpoints, tests, complexity)
  5. Modal confirm "Proceed with implementation?"
  6. Load standards page (active specialty)
  7. LLM → stream step-by-step guidance with company conventions applied
  8. Suggest commit: feat(projectKey): summary-slug — ISSUE-KEY
```

---

## /generate-test, /docs, /commit

```
/generate-test
  active editor file (content + language)
  + testing standards page (specialty-resolved)
  → LLM: "generate unit tests with AAA pattern, one per public method"

/docs
  active editor file (content + language)
  + standards page (specialty-resolved)
  → LLM: "add JSDoc/JavaDoc to public methods only, don't modify logic"

/commit
  getStagedDiff() → git diff --cached from workspace root
  + standards page
  → LLM: "generate Conventional Commits message (type(scope): description)"
```

---

## Prompt library parsing

```
parsePromptLibrary(blocks: KnowledgeBlock[]): PromptTemplate[]

Each prompt section:
  heading2  → slug = text.toLowerCase().replace("Prompts: ","").replace(/\s+/g,"-")
  paragraph → description (first one) | template (subsequent ones, accumulated)
  code      → template (takes priority over paragraph accumulation)
  bullet    → appended to template as "- item"

Slug cleaning: strips "Prompts: " / "Prompt - " prefix, removes special chars
```

---

## Model resolution

```
resolveModel(model)
  │
  ├─ model.id !== "auto"  → use as-is
  └─ model.id === "auto"  → vscode.lm.selectChatModels() fallback chain:
       1. { vendor: "copilot", family: "gpt-4o" }
       2. { vendor: "copilot", family: "gpt-4" }
       3. { vendor: "copilot", family: "claude-sonnet" }
       4. {} — any model
```

The "auto" model is Copilot's routing placeholder and does NOT support `sendRequest()` from extensions directly.

---

## Confluence ADF → KnowledgeBlock conversion

The `adfToBlocks()` function handles all Confluence node types:

| ADF node | KnowledgeBlock |
|---|---|
| `heading` level 1/2/3 | `heading1` / `heading2` / `heading3` |
| `paragraph` | `paragraph` |
| `bulletList` items | `bullet` |
| `orderedList` items | `numbered` |
| `codeBlock` | `code` (with language) |
| `rule` | `divider` |
| `table` + `tableRow` | `table` + `table_row` |
| `expand` / `nestedExpand` | emits title as `heading2`, recurses content |
| `panel` (Info/Note/Warning/Tip) | recurses content |
| `bodiedExtension` key="code" | `code` (legacy Code macro) |
| `bodiedExtension` other | recurses content |
| `layoutSection` / `layoutColumn` / `blockquote` | recurses content |

---

## LM Tools vs @bank

| | LM Tools | @bank |
|---|---|---|
| Invocation | Automatic by Copilot in agent mode | Explicit `@bank /command` |
| Context | Copilot reads `#companyStandards` etc. | Active editor + settings |
| Tools | `bank_get_standards`, `bank_review_test`, `bank_create_project` | All slash commands |
| Best for | Inline suggestions while coding | Explicit queries and generation |

---

## Cache behavior

`KnowledgeProviderFactory` caches the provider instance by source string.
Cache is invalidated when:
- `companyStandards.knowledgeSource` changes
- `companyStandards.notionToken` changes
- `companyStandards.confluenceToken` changes

Run `Bank: Refresh Standards from Notion` to force cache invalidation manually.
