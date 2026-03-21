// Minimal mock of the vscode module for unit tests.
// Only the types/classes used by validator.ts are implemented.

export class Position {
  constructor(public line: number, public character: number) {}
  translate(_deltaLine: number, deltaCharacter: number): Position {
    return new Position(this.line, this.character + deltaCharacter);
  }
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export const DiagnosticSeverity = { Warning: 1, Error: 0, Information: 2, Hint: 3 };

export class Diagnostic {
  constructor(
    public range: Range,
    public message: string,
    public severity: number
  ) {}
  source?: string;
  code?: string;
}

// Stub workspace / window so imports don't crash
export const workspace = { getConfiguration: () => ({}) };
export const window = {};
export const languages = {};
