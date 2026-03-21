# Architecture

Technical reference for contributors and maintainers of the Bank Standards Extension.

---

## File structure

```
src/
├── extension.ts                      # Entry point + LM tool registration
├── agent/
│   ├── bankAgent.ts                  # @bank chat participant + slash commands + follow-ups
│   ├── BankPrompt.tsx                # Token-aware prompt via @vscode/prompt-tsx
│   ├── projectCreator.ts             # createProjectCore() + createProjectFromNotion()
│   ├── promptLibraryHandler.ts       # /prompts command — list and apply saved prompts
│   ├── specialtyResolver.ts          # getActiveSpecialty, resolvePageId, detectSpecialtyFromPrompt
│   └── tools/
│       ├── GetStandardsTool.ts       # LM Tool: fetches bank naming standards
│       ├── ReviewTestTool.ts         # LM Tool: reads active file + test standards
│       └── CreateProjectTool.ts      # LM Tool: scaffolds Maven/Quarkus project
├── knowledge/
│   ├── KnowledgeProvider.ts          # Provider-agnostic interface (KnowledgeBlock[])
│   ├── KnowledgeProviderFactory.ts   # Reads knowledgeSource setting, returns correct provider
│   └── providers/
│       ├── NotionKnowledgeProvider.ts     # Notion REST API v1 → KnowledgeBlock[]
│       └── ConfluenceKnowledgeProvider.ts # Confluence REST API v2 (ADF) → KnowledgeBlock[]
├── notion/
│   ├── client.ts                     # Low-level Notion HTTP client
│   ├── parser.ts                     # NamingRule / ProjectStep / PromptTemplate parsers + blocksToMarkdown
│   └── cache.ts                      # globalState cache with metadata invalidation
├── confluence/
│   └── client.ts                     # Low-level Confluence HTTP client (ADF format)
├── providers/
│   ├── diagnosticProvider.ts         # Inline warnings on save/open
│   ├── codeActionProvider.ts         # Quick Fix actions
│   └── statusBarProvider.ts          # Violation counter in status bar
└── standards/
    ├── rules.ts                       # Convention matching + name conversion
    └── validator.ts                   # Document scanning → Violation[]
```

---

## Knowledge provider flow

```
settings.json
  bankStandards.knowledgeSource = "notion" | "confluence"
         │
         ▼
KnowledgeProviderFactory.createKnowledgeProvider()
         │
         ├─ "notion"     → NotionKnowledgeProvider   → NotionClient (REST API v1)
         └─ "confluence" → ConfluenceKnowledgeProvider → ConfluenceClient (REST API v2, ADF)
                                    │
                                    ▼
                           KnowledgeBlock[]   (provider-agnostic)
                                    │
                    ┌───────────────┼──────────────────┬──────────────────┐
                    ▼               ▼                  ▼                  ▼
            parseNamingRules  parseProjectSteps  parsePromptLibrary  blocksToMarkdown
                                                                           │
                                                              ┌────────────┴────────────┐
                                                              ▼                         ▼
                                                        @bank agent              LM Tools
                                                      (chat participant)   (agent mode / #refs)
```

---

## Specialty resolution

Page IDs are resolved in this order for every request:

```
1. specialtiesMap[activeSpecialty][pageType]   ← per-specialty config (preferred)
2. pagesMap[pageType]                           ← legacy flat config (fallback)
```

`specialtyResolver.ts` exports:
- `getActiveSpecialty()` — reads `bankStandards.specialty` (default: `"backend"`)
- `setActiveSpecialty(name)` — persists to global settings
- `resolvePageId(pageType, specialty?)` — applies resolution order above
- `listSpecialties()` — returns keys of `specialtiesMap`
- `detectSpecialtyFromPrompt(prompt, known)` — matches specialty names mentioned in chat

---

## Cache behavior

All knowledge pages are cached in VS Code's `globalState`:

- On each load only **page metadata** (last modified date) is fetched — lightweight
- If unchanged → cached data returned instantly
- If updated → full content re-fetched and cache refreshed
- Works identically for Notion and Confluence
- Force reload: `Bank: Refresh Standards from Notion` command

---

## LM Tools vs @bank agent

|  | LM Tools | @bank Agent |
|---|---|---|
| Activation | Automatic in agent mode | Explicit `@bank` or auto-disambiguation |
| Interaction | Single tool call, structured result | Conversational, multi-turn |
| Confirmation | `bank_create_project` shows dialog | Inline in chat |
| Token management | Returns raw context for LLM | `@vscode/prompt-tsx` with priority pruning |
| Best for | Quick lookups in any Copilot chat | Deep Q&A, project guides, prompt library |

---

## Prompt-tsx priority levels

| Priority | Content |
|---|---|
| 100 | System prompt |
| 90 | User query |
| 80 | Active file context |
| 70 | Knowledge page content (Notion/Confluence) |
| 0 | Chat history |

Lower-priority content is pruned first when the model's token limit is approached.

---

## Publishing

```bash
npm install -g @vscode/vsce
vsce login <publisher-id>
npm run compile
vsce package                 # → bank-standards-extension-x.x.x.vsix
vsce publish                 # publish to Marketplace
vsce publish patch           # bump patch version and publish
```

### Checklist before publishing

- [ ] `publisher`, `repository`, `icon`, `license` in `package.json`
- [ ] `icon` points to a `.png` file (128×128 px minimum — SVG not accepted)
- [ ] `npm run compile` — no errors
- [ ] `npm test` — all tests pass
- [ ] Tested locally via `F5` (Extension Development Host)
- [ ] `.vscodeignore` excludes `src/`, `node_modules/`, test files, `.env`
