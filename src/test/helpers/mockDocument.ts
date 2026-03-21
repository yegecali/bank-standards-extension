import { Position, Range } from "../__mocks__/vscode";
import * as vscode from "vscode";

/**
 * Creates a minimal TextDocument-like object from a plain string.
 * Enough for validator.ts to work without a real VSCode instance.
 */
export function mockDocument(
  content: string,
  languageId = "typescript"
): vscode.TextDocument {
  const lines = content.split("\n");

  return {
    getText: () => content,
    languageId,
    uri: { scheme: "file", toString: () => "file:///mock.ts" } as any,
    positionAt(offset: number): vscode.Position {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const lineLen = lines[line].length + 1; // +1 for \n
        if (remaining < lineLen) return new Position(line, remaining) as any;
        remaining -= lineLen;
      }
      return new Position(lines.length - 1, 0) as any;
    },
  } as unknown as vscode.TextDocument;
}
