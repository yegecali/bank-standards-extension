/* eslint-disable @typescript-eslint/no-unused-vars */
/** @jsx vscpp */
/** @jsxFrag vscppf */
import "@vscode/prompt-tsx/dist/base/tsx"; // registers vscpp / vscppf globals
import {
  PromptElement,
  UserMessage,
  AssistantMessage,
  PrioritizedList,
  BasePromptElementProps,
  PromptPiece,
} from "@vscode/prompt-tsx";
import * as vscode from "vscode";

export interface BankPromptProps extends BasePromptElementProps {
  systemPrompt: string;
  reviewInstruction: string;
  notionContent: string;
  pageTitle: string;
  activeFileContext: string;
  userPrompt: string;
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[];
}

/**
 * Token-aware prompt for the @bank agent.
 *
 * Priority order (higher = kept last when tokens run out):
 *   100 — system instructions (never pruned)
 *    90 — current user query  (never pruned)
 *    80 — active file content (pruned before query)
 *    70 — Notion documentation (pruned before file)
 *     0 — chat history        (first to be pruned)
 */
export class BankPrompt extends PromptElement<BankPromptProps> {
  render(): PromptPiece {
    const {
      systemPrompt,
      reviewInstruction,
      notionContent,
      pageTitle,
      activeFileContext,
      userPrompt,
      history,
    } = this.props;

    const docSection =
      `## Documentación: "${pageTitle}"\n\n` +
      notionContent;

    return (
      <>
        {/* System instructions — highest priority, never pruned */}
        <UserMessage priority={100}>
          {systemPrompt}
          {reviewInstruction}
        </UserMessage>

        {/* Notion documentation — pruned before file context */}
        <UserMessage priority={70}>{docSection}</UserMessage>

        {/* Active file content — pruned before user query */}
        {activeFileContext
          ? <UserMessage priority={80}>{activeFileContext}</UserMessage>
          : <></>
        }

        {/* Chat history — first to be pruned when budget is tight */}
        <PrioritizedList priority={0} descending={false}>
          {buildHistoryElements(history)}
        </PrioritizedList>

        {/* Current user query — second-highest priority */}
        <UserMessage priority={90}>{userPrompt}</UserMessage>
      </>
    );
  }
}

function buildHistoryElements(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]
): PromptPiece[] {
  return history.flatMap((turn) => {
    if (turn instanceof vscode.ChatRequestTurn) {
      return [<UserMessage>{turn.prompt}</UserMessage>];
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter(
          (r): r is vscode.ChatResponseMarkdownPart =>
            r instanceof vscode.ChatResponseMarkdownPart
        )
        .map((r) => r.value.value)
        .join("");
      return text ? [<AssistantMessage>{text}</AssistantMessage>] : [];
    }
    return [];
  });
}
