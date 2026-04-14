import * as vscode from 'vscode';
import type { RegisterToken } from './types';
import { DEFAULT_DEBOUNCE_MS } from './constants';
import { extractTokenFromLine } from './tokenExtractor';

// Re-export for convenience
export { extractTokenFromLine } from './tokenExtractor';

/**
 * Watches active editor cursor changes and extracts register tokens
 * from the line under the cursor. Debounces rapid movements.
 */
export class CursorTracker implements vscode.Disposable {
  private readonly _onToken = new vscode.EventEmitter<RegisterToken | null>();
  readonly onToken: vscode.Event<RegisterToken | null> = this._onToken.event;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.handleSelectionChange(e);
      }),
      this._onToken,
    );
  }

  private handleSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      const token = this.extractToken(e.textEditor);
      this._onToken.fire(token);
    }, this.debounceMs);
  }

  /** Extract a register token from the current cursor position */
  extractToken(editor: vscode.TextEditor): RegisterToken | null {
    const position = editor.selection.active;
    const line = editor.document.lineAt(position.line).text;
    const file = editor.document.uri.fsPath;

    return extractTokenFromLine(line, position.line, file);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
