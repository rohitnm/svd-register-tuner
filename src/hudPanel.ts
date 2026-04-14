import * as vscode from 'vscode';
import type {
  Register,
  Peripheral,
  Field,
  FieldViewModel,
  RegisterViewModel,
  GeneratedCode,
  ExtensionMessage,
  WebviewMessage,
  HudState,
  CandidateOption,
  CodeStyle,
  AccessType,
  PeripheralSummary,
  DeviceModel,
} from './types';
import { generateCode } from './codeGenerator';

/** Safe bitmask: avoids JS bug where 1<<32 === 1 */
function safeMask(bitWidth: number): number {
  return bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
}

/**
 * WebviewViewProvider for the RegHUD sidebar panel.
 * Manages HUD state machine and bidirectional messaging with the webview.
 */
export class HudPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'regHud.hudView';

  private view: vscode.WebviewView | undefined;
  private state: HudState = 'idle';
  private currentPeripheral: Peripheral | undefined;
  private currentRegister: Register | undefined;
  private fieldValues: Map<string, number> = new Map();
  private isPinned = false;
  private deviceModel: DeviceModel | null = null;
  private pendingMessages: ExtensionMessage[] = [];

  private readonly _onFieldChanged = new vscode.EventEmitter<{
    fieldName: string;
    value: number;
  }>();
  readonly onFieldChanged = this._onFieldChanged.event;

  private readonly _onMessage = new vscode.EventEmitter<WebviewMessage>();
  readonly onMessage = this._onMessage.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Flush any messages queued before the webview was ready
    for (const msg of this.pendingMessages) {
      webviewView.webview.postMessage(msg);
    }
    this.pendingMessages = [];

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this._onMessage.fire(msg);
      this.handleMessage(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.currentRegister) {
        this.sendRegisterUpdate();
      }
    });
  }

  /** Public API */

  /** Show a resolved register in the HUD */
  showRegister(peripheral: Peripheral, register: Register): void {
    if (this.isPinned) {
      return;
    }

    this.currentPeripheral = peripheral;
    this.currentRegister = register;

    // Initialize field values from reset value
    this.fieldValues.clear();
    const resetValue = register.resetValue;
    for (const field of register.fields) {
      const val = (resetValue >>> field.bitOffset) & safeMask(field.bitWidth);
      this.fieldValues.set(field.name, val);
    }

    this.setState('resolved');
    this.sendRegisterUpdate();
  }

  /** Show ambiguous candidates for user selection */
  showCandidates(candidates: CandidateOption[]): void {
    if (this.isPinned) {
      return;
    }
    this.setState('ambiguous');
    this.postMessage({ type: 'candidates', options: candidates });
  }

  /** Set the HUD state */
  setState(state: HudState): void {
    this.state = state;
    this.postMessage({ type: 'state', state });
    vscode.commands.executeCommand(
      'setContext',
      'regHud.hudVisible',
      state === 'resolved' || state === 'pinned',
    );
    vscode.commands.executeCommand(
      'setContext',
      'regHud.hasRegister',
      state === 'resolved' || state === 'pinned',
    );
  }

  /** Show error message in HUD */
  showError(message: string): void {
    this.postMessage({ type: 'error', message });
  }

  /** Get the current RegisterViewModel (for copy/insert commands) */
  getCurrentViewModel(): RegisterViewModel | null {
    if (!this.currentPeripheral || !this.currentRegister) {
      return null;
    }
    return this.buildViewModel(this.currentPeripheral, this.currentRegister);
  }

  /** Decode a hex value and update field values */
  decodeValue(hex: string): void {
    if (!this.currentRegister) {
      return;
    }
    const cleaned = hex.replace(/^0x/i, '');
    const decoded = parseInt(cleaned, 16);
    if (isNaN(decoded)) {
      this.postMessage({ type: 'error', message: 'Invalid hex value' });
      return;
    }
    for (const field of this.currentRegister.fields) {
      const val = (decoded >>> field.bitOffset) & safeMask(field.bitWidth);
      this.fieldValues.set(field.name, val);
    }
    this.sendRegisterUpdate();
  }

  /** Store the device model so the HUD can send the peripheral list */
  setDeviceModel(model: DeviceModel): void {
    this.deviceModel = model;
    this.sendPeripheralList();
  }

  /** Send the full peripheral/register tree to the webview for browsing */
  sendPeripheralList(): void {
    if (!this.deviceModel) {
      return;
    }
    const peripherals: PeripheralSummary[] = [];
    for (const [, periph] of this.deviceModel.peripherals) {
      const registers: PeripheralSummary['registers'] = [];
      for (const [, reg] of periph.registers) {
        registers.push({
          name: reg.name,
          description: reg.description,
          addressOffset: reg.addressOffset,
          absoluteAddress: reg.absoluteAddress,
        });
      }
      registers.sort((a, b) => a.addressOffset - b.addressOffset);
      peripherals.push({
        name: periph.name,
        description: periph.description,
        baseAddress: periph.baseAddress,
        registers,
      });
    }
    peripherals.sort((a, b) => a.name.localeCompare(b.name));
    this.postMessage({ type: 'peripheral-list', peripherals });
  }

  /** Get current pin state */
  get pinned(): boolean {
    return this.isPinned;
  }

  /** Message Handling */

  private handleMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'field-changed':
        this.fieldValues.set(msg.fieldName, msg.value);
        this._onFieldChanged.fire({
          fieldName: msg.fieldName,
          value: msg.value,
        });
        this.sendRegisterUpdate();
        break;

      case 'pin-toggle':
        this.isPinned = !this.isPinned;
        vscode.commands.executeCommand(
          'setContext',
          'regHud.isPinned',
          this.isPinned,
        );
        this.setState(this.isPinned ? 'pinned' : 'resolved');
        break;

      case 'decode-value': {
        if (!this.currentRegister) {
          break;
        }
        const hex = msg.hex.replace(/^0x/i, '');
        const decoded = parseInt(hex, 16);
        if (isNaN(decoded)) {
          this.postMessage({
            type: 'error',
            message: 'Invalid hex value',
          });
          break;
        }
        // Update all field values from decoded number
        for (const field of this.currentRegister.fields) {
          const val =
            (decoded >>> field.bitOffset) &
            safeMask(field.bitWidth);
          this.fieldValues.set(field.name, val);
        }
        this.sendRegisterUpdate();
        break;
      }

      case 'reset-fields':
        if (this.currentRegister) {
          const rv = this.currentRegister.resetValue;
          for (const field of this.currentRegister.fields) {
            const val =
              (rv >>> field.bitOffset) & safeMask(field.bitWidth);
            this.fieldValues.set(field.name, val);
          }
          this.sendRegisterUpdate();
        }
        break;

      case 'webview-ready':
        if (this.currentRegister) {
          this.sendRegisterUpdate();
        } else {
          this.setState('idle');
        }
        // Always send peripheral list if we have a model
        this.sendPeripheralList();
        break;

      case 'browse-registers':
        this.sendPeripheralList();
        break;

      // copy-code, insert-code, select-candidate handled by extension.ts via onMessage
    }
  }

  /** View Model Construction */

  private sendRegisterUpdate(): void {
    if (!this.currentPeripheral || !this.currentRegister) {
      return;
    }
    const viewModel = this.buildViewModel(
      this.currentPeripheral,
      this.currentRegister,
    );
    this.postMessage({ type: 'update', register: viewModel });
  }

  buildViewModel(
    peripheral: Peripheral,
    register: Register,
  ): RegisterViewModel {
    const fields: FieldViewModel[] = register.fields
      .slice()
      .sort((a, b) => b.bitOffset - a.bitOffset) // MSB first for display
      .map((f) => this.buildFieldViewModel(f, register.access));

    // Compose current value from field values
    let composedValue = 0;
    for (const field of register.fields) {
      const val = this.fieldValues.get(field.name) ?? 0;
      composedValue |= (val & safeMask(field.bitWidth)) << field.bitOffset;
    }

    return {
      peripheralName: peripheral.name,
      registerName: register.name,
      fullName: `${peripheral.name}->${register.name}`,
      description: register.description,
      absoluteAddress: '0x' + register.absoluteAddress.toString(16).padStart(8, '0'),
      size: register.size,
      access: register.access,
      resetValue: '0x' + register.resetValue.toString(16).padStart(register.size / 4, '0'),
      fields,
      currentValue: '0x' + (composedValue >>> 0).toString(16).padStart(register.size / 4, '0'),
      generatedCode: generateCode(peripheral, register, this.fieldValues, {
        showComments: vscode.workspace.getConfiguration('regHud').get<boolean>('showComments', true),
      }),
    };
  }

  private buildFieldViewModel(
    field: Field,
    registerAccess: AccessType,
  ): FieldViewModel {
    const access = field.access ?? registerAccess;
    return {
      name: field.name,
      description: field.description,
      bitOffset: field.bitOffset,
      bitWidth: field.bitWidth,
      access,
      isReserved: field.isReserved,
      value: this.fieldValues.get(field.name) ?? 0,
      maxValue: field.maxValue,
      enumeratedValues: field.enumeratedValues,
      hasEnum: field.enumeratedValues.length > 0,
    };
  }

  /** Webview Communication */

  private postMessage(message: ExtensionMessage): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  /** Webview HTML */

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>SVD Register Tuner</title>
  <style nonce="${nonce}">
    ${getWebviewStyles()}
  </style>
</head>
<body>
  <div id="app">
    <!-- Idle state -->
    <div id="idle-state" class="state-view active">
      <div class="empty-state">
        <span class="codicon codicon-circuit-board"></span>
        <p>Move cursor to a register expression</p>
        <p class="hint">e.g. <code>GPIOA-&gt;MODER</code></p>
      </div>
      <div id="register-browser" class="section register-browser">
        <div class="section-title">Register Browser</div>
        <input type="text" id="browser-search" class="browser-search"
               placeholder="Search peripherals or registers…" spellcheck="false">
        <div id="peripheral-tree" class="peripheral-tree"></div>
      </div>
    </div>

    <!-- Loading state -->
    <div id="loading-state" class="state-view">
      <div class="empty-state">
        <div class="spinner"></div>
        <p>Resolving register…</p>
      </div>
    </div>

    <!-- Error state -->
    <div id="error-state" class="state-view">
      <div class="empty-state error">
        <span class="icon">⚠</span>
        <p id="error-message"></p>
      </div>
    </div>

    <!-- Ambiguous state -->
    <div id="ambiguous-state" class="state-view">
      <div class="section">
        <div class="section-title">Multiple matches</div>
        <div id="candidate-list" class="candidate-list"></div>
      </div>
    </div>

    <!-- Resolved state -->
    <div id="resolved-state" class="state-view">
      <!-- Register Header -->
      <div id="register-header" class="section register-header">
        <div class="header-row">
          <span class="peripheral-name" id="peripheral-name"></span>
          <span class="arrow">→</span>
          <span class="register-name" id="register-name"></span>
          <button class="icon-btn pin-btn" id="pin-btn" title="Pin register" aria-label="Pin register">📌</button>
        </div>
        <div class="header-meta">
          <span class="address badge" id="reg-address" title="Click to copy"></span>
          <span class="size badge" id="reg-size"></span>
          <span class="access badge" id="reg-access"></span>
        </div>
        <div class="header-meta">
          <span class="reset-label">Reset:</span>
          <span class="reset-value" id="reg-reset"></span>
        </div>
        <div class="description" id="reg-description"></div>
      </div>

      <!-- Bit-field Grid -->
      <div class="section">
        <div class="section-title">Bit Field Grid</div>
        <div id="bitfield-grid" class="bitfield-grid"></div>
        <div class="composed-value">
          Value: <span id="composed-value" class="mono" aria-live="polite"></span>
        </div>
      </div>

      <!-- Field Editor -->
      <div class="section">
        <div class="section-title">Fields</div>
        <div id="field-list" class="field-list"></div>
      </div>

      <!-- Decode Input -->
      <div class="section">
        <div class="section-title">Decode Hex Value</div>
        <div class="decode-row">
          <input type="text" id="decode-input" class="decode-input"
                 placeholder="0x00000000" spellcheck="false"
                 aria-label="Hex value to decode">
          <button class="btn" id="decode-btn">Decode</button>
        </div>
      </div>

      <!-- Code Preview -->
      <div class="section">
        <div class="section-title">
          Generated Code
          <select id="style-select" class="style-select" aria-label="Code generation style">
            <option value="rmw" selected>Read-Modify-Write</option>
            <option value="raw">Raw Write</option>
            <option value="cmsis">CMSIS Macros</option>
            <option value="commented">Commented</option>
          </select>
        </div>
        <pre id="code-preview" class="code-preview"><code></code></pre>
        <div class="action-buttons">
          <button class="btn" id="copy-btn" aria-label="Copy generated code">📋 Copy</button>
          <button class="btn" id="insert-btn" aria-label="Insert code at cursor">⬇ Insert</button>
          <button class="btn btn-secondary" id="reset-btn" aria-label="Reset fields to default">↺ Reset</button>
          <button class="btn btn-secondary" id="browse-btn" title="Browse all registers" aria-label="Browse all registers">📖 Browse</button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    ${getWebviewScript()}
  </script>
</body>
</html>`;
  }
}

/** Helpers */

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Inline Styles */

function getWebviewStyles(): string {
  return /*css*/ `
    :root {
      --field-0: 199, 80%, 64%;
      --field-1: 88, 50%, 67%;
      --field-2: 33, 100%, 65%;
      --field-3: 291, 47%, 71%;
      --field-4: 187, 71%, 68%;
      --field-5: 45, 100%, 65%;
      --field-6: 0, 82%, 77%;
      --field-7: 16, 18%, 58%;
      --reserved: var(--vscode-disabledForeground, #666);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
      overflow-y: auto;
    }

    #app { padding: 8px; }

    .state-view { display: none; }
    .state-view.active { display: block; }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state .icon, .empty-state .codicon { font-size: 32px; margin-bottom: 12px; }
    .empty-state p { margin: 4px 0; }
    .empty-state .hint { font-size: 0.85em; opacity: 0.7; }
    .empty-state code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
    }
    .empty-state.error .icon { color: var(--vscode-errorForeground); }

    .spinner {
      width: 24px; height: 24px;
      border: 3px solid var(--vscode-progressBar-background, #0078d4);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Sections */
    .section {
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      font-weight: 600;
    }

    /* Register Header */
    .register-header { padding-bottom: 10px; }
    .header-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }
    .peripheral-name {
      font-weight: 700;
      font-size: 1.1em;
      color: var(--vscode-symbolIcon-classForeground, #ee9d28);
    }
    .arrow { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .register-name {
      font-weight: 700;
      font-size: 1.1em;
      color: var(--vscode-symbolIcon-methodForeground, #4fc1ff);
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 3px 0;
      font-size: 0.9em;
    }
    .badge {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: default;
    }
    .address { cursor: pointer; }
    .address:hover { opacity: 0.8; }
    .reset-label { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .reset-value { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
    .description {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.4;
    }
    .pin-btn {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      opacity: 0.6;
      padding: 2px 4px;
    }
    .pin-btn:hover, .pin-btn:focus-visible { opacity: 1; }
    .pin-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .pin-btn.pinned { opacity: 1; }

    .icon-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .icon-btn:hover, .icon-btn:focus-visible { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

    /* Bit-field Grid */
    .bitfield-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 1px;
      margin-bottom: 6px;
    }
    .bit-cell {
      width: 22px;
      height: 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.75em;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 2px;
      cursor: default;
      position: relative;
      transition: background 0.15s;
    }
    .bit-cell .bit-num {
      font-size: 0.6em;
      color: var(--vscode-descriptionForeground);
      line-height: 1;
    }
    .bit-cell .bit-val {
      font-weight: 600;
      line-height: 1;
    }
    .bit-cell:hover, .bit-cell:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      z-index: 1;
    }
    .bit-cell.reserved {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1));
      color: var(--reserved);
    }
    .bit-cell.readonly { opacity: 0.7; }
    .bit-cell.clickable { cursor: pointer; }

    .composed-value {
      font-size: 0.9em;
      font-family: var(--vscode-editor-font-family, monospace);
      margin-top: 4px;
    }
    .mono { font-family: var(--vscode-editor-font-family, monospace); }

    /* Field List */
    .field-list { display: flex; flex-direction: column; gap: 2px; }
    .field-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border-radius: 3px;
      font-size: 0.9em;
      transition: background 0.15s;
    }
    .field-row:hover { background: var(--vscode-list-hoverBackground); }
    .field-row.reserved { opacity: 0.5; }
    .field-name {
      font-weight: 600;
      min-width: 80px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .field-bits {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      min-width: 48px;
    }
    .field-control { margin-left: auto; display: flex; align-items: center; gap: 4px; }
    .field-control select,
    .field-control input[type="number"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 2px 4px;
      font-family: inherit;
      font-size: 0.9em;
      min-width: 80px;
    }
    .field-control input[type="checkbox"] {
      accent-color: var(--vscode-checkbox-background);
    }
    .field-hex {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      min-width: 28px;
      text-align: right;
    }
    .field-color-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* Decode Input */
    .decode-row { display: flex; gap: 6px; }
    .decode-input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .decode-input:focus { outline: 1px solid var(--vscode-focusBorder); }

    /* Buttons */
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 0.85em;
      white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .action-buttons { display: flex; gap: 6px; margin-top: 8px; }

    /* Style Select */
    .style-select {
      float: right;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 0.9em;
      font-family: inherit;
    }

    /* Code Preview */
    .code-preview {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      border-radius: 4px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      line-height: 1.5;
      overflow-x: auto;
      white-space: pre;
      max-height: 200px;
      overflow-y: auto;
    }

    /* Candidate List */
    .candidate-list { display: flex; flex-direction: column; gap: 2px; }
    .candidate-item {
      padding: 6px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.1));
    }
    .candidate-item:hover, .candidate-item:focus-visible {
      background: var(--vscode-list-hoverBackground);
    }
    .candidate-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

    /* Register Browser */
    .register-browser { margin-top: 12px; }
    .browser-search {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 5px 8px;
      font-size: 0.9em;
      margin-bottom: 6px;
    }
    .browser-search:focus { outline: 1px solid var(--vscode-focusBorder); }
    .peripheral-tree {
      max-height: 400px;
      overflow-y: auto;
    }
    .periph-group { margin-bottom: 2px; }
    .periph-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 0.9em;
      font-weight: 600;
      user-select: none;
    }
    .periph-header:hover, .periph-header:focus-visible { background: var(--vscode-list-hoverBackground); }
    .periph-header:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .periph-header .chevron {
      display: inline-block;
      width: 12px;
      text-align: center;
      font-size: 0.75em;
      transition: transform 0.15s;
    }
    .periph-header.expanded .chevron { transform: rotate(90deg); }
    .periph-addr {
      margin-left: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
    }
    .periph-registers {
      display: none;
      padding-left: 18px;
    }
    .periph-registers.visible { display: block; }
    .reg-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .reg-item:hover, .reg-item:focus-visible { background: var(--vscode-list-hoverBackground); }
    .reg-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .reg-item .reg-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 500;
    }
    .reg-item .reg-offset {
      margin-left: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }
    .browser-empty {
      padding: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      font-style: italic;
    }
  `;
}

// ── Inline Script ───────────────────────────────────────

function getWebviewScript(): string {
  return /*js*/ `
    const vscode = acquireVsCodeApi();

    // ── State Management ──────────────────────────────────

    const stateViews = {
      idle: document.getElementById('idle-state'),
      loading: document.getElementById('loading-state'),
      resolved: document.getElementById('resolved-state'),
      pinned: document.getElementById('resolved-state'),
      ambiguous: document.getElementById('ambiguous-state'),
      unsupported: document.getElementById('error-state'),
      error: document.getElementById('error-state'),
    };

    let currentRegister = null;
    let isPinned = false;
    let allPeripherals = [];

    function showState(state) {
      Object.values(stateViews).forEach(v => v?.classList.remove('active'));
      const target = stateViews[state];
      if (target) target.classList.add('active');
    }

    // ── Field Color Palette ───────────────────────────────

    const FIELD_COLORS = [
      '--field-0', '--field-1', '--field-2', '--field-3',
      '--field-4', '--field-5', '--field-6', '--field-7',
    ];

    function getFieldColor(index) {
      const varName = FIELD_COLORS[index % FIELD_COLORS.length];
      const hsl = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return 'hsl(' + hsl + ')';
    }

    function getFieldColorAlpha(index, alpha) {
      const varName = FIELD_COLORS[index % FIELD_COLORS.length];
      const hsl = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return 'hsla(' + hsl + ', ' + alpha + ')';
    }

    // ── Message Handler ───────────────────────────────────

    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'state':
          showState(msg.state);
          if (msg.state === 'pinned') isPinned = true;
          else if (msg.state === 'resolved') isPinned = false;
          updatePinButton();
          break;

        case 'update':
          currentRegister = msg.register;
          renderRegister(msg.register);
          showState(isPinned ? 'pinned' : 'resolved');
          break;

        case 'candidates':
          renderCandidates(msg.options);
          showState('ambiguous');
          break;

        case 'error':
          document.getElementById('error-message').textContent = msg.message;
          showState('error');
          break;

        case 'decode-result':
          if (currentRegister) {
            currentRegister.fields = msg.fields;
            currentRegister.currentValue = msg.hex;
            renderRegister(currentRegister);
          }
          break;

        case 'peripheral-list':
          allPeripherals = msg.peripherals;
          console.log('[RegHUD] Received peripheral-list with', msg.peripherals.length, 'peripherals');
          renderPeripheralTree(msg.peripherals);
          break;
      }
    });

    // ── Render Functions ──────────────────────────────────

    function renderRegister(reg) {
      // Header
      document.getElementById('peripheral-name').textContent = reg.peripheralName;
      document.getElementById('register-name').textContent = reg.registerName;
      document.getElementById('reg-address').textContent = reg.absoluteAddress;
      document.getElementById('reg-size').textContent = reg.size + '-bit';
      document.getElementById('reg-access').textContent = formatAccess(reg.access);
      document.getElementById('reg-reset').textContent = reg.resetValue;
      document.getElementById('reg-description').textContent = reg.description || '';
      document.getElementById('composed-value').textContent = reg.currentValue;

      // Access badge color
      const accessEl = document.getElementById('reg-access');
      accessEl.style.background = getAccessColor(reg.access);

      // Build field color map (non-reserved fields get colors)
      const fieldColorMap = {};
      let colorIdx = 0;
      for (const f of reg.fields) {
        if (!f.isReserved) {
          fieldColorMap[f.name] = colorIdx++;
        }
      }

      renderBitGrid(reg, fieldColorMap);
      renderFieldList(reg, fieldColorMap);
      renderCodePreview(reg);
    }

    function renderCodePreview(reg) {
      const styleSelect = document.getElementById('style-select');
      const style = styleSelect?.value || 'rmw';
      const code = reg.generatedCode?.[style] || '// No code generated';
      const preview = document.getElementById('code-preview');
      if (preview) {
        preview.textContent = code;
      }
    }

    function renderBitGrid(reg, fieldColorMap) {
      const grid = document.getElementById('bitfield-grid');
      grid.innerHTML = '';

      // Build bit → field lookup
      const bitToField = {};
      for (const f of reg.fields) {
        for (let b = f.bitOffset; b < f.bitOffset + f.bitWidth; b++) {
          bitToField[b] = f;
        }
      }

      // Render MSB to LSB
      for (let bit = reg.size - 1; bit >= 0; bit--) {
        const cell = document.createElement('div');
        cell.className = 'bit-cell';

        const field = bitToField[bit];
        const bitValue = field
          ? (field.value >>> (bit - field.bitOffset)) & 1
          : 0;

        // Bit number label
        const numSpan = document.createElement('span');
        numSpan.className = 'bit-num';
        numSpan.textContent = bit;
        cell.appendChild(numSpan);

        // Bit value
        const valSpan = document.createElement('span');
        valSpan.className = 'bit-val';
        valSpan.textContent = bitValue;
        cell.appendChild(valSpan);

        if (field) {
          if (field.isReserved) {
            cell.classList.add('reserved');
          } else {
            const ci = fieldColorMap[field.name];
            if (ci !== undefined) {
              cell.style.borderColor = getFieldColor(ci);
              if (bitValue) {
                cell.style.background = getFieldColorAlpha(ci, 0.2);
              }
            }

            // All non-readonly fields are clickable (toggle the individual bit)
            if (!isReadOnly(field.access)) {
              cell.classList.add('clickable');
              cell.setAttribute('tabindex', '0');
              cell.setAttribute('role', 'button');
              cell.setAttribute('aria-label',
                field.name + ' bit ' + bit + ', value ' + bitValue);
              cell.addEventListener('click', () => {
                const bitPos = bit - field.bitOffset;
                const newVal = field.value ^ (1 << bitPos);
                vscode.postMessage({ type: 'field-changed', fieldName: field.name, value: newVal });
              });
              cell.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  cell.click();
                }
              });
            }
          }

          if (isReadOnly(field.access)) {
            cell.classList.add('readonly');
          }

          cell.title = field.name + ' [' + (field.bitOffset + field.bitWidth - 1) +
            (field.bitWidth > 1 ? ':' + field.bitOffset : '') + '] = ' + field.value;
        } else {
          cell.classList.add('reserved');
          cell.title = 'Reserved (bit ' + bit + ')';
        }

        grid.appendChild(cell);
      }
    }

    function renderFieldList(reg, fieldColorMap) {
      const list = document.getElementById('field-list');
      list.innerHTML = '';

      for (const field of reg.fields) {
        const row = document.createElement('div');
        row.className = 'field-row' + (field.isReserved ? ' reserved' : '');

        // Color dot
        const dot = document.createElement('span');
        dot.className = 'field-color-dot';
        if (!field.isReserved && fieldColorMap[field.name] !== undefined) {
          dot.style.background = getFieldColor(fieldColorMap[field.name]);
        } else {
          dot.style.background = 'var(--reserved)';
        }
        row.appendChild(dot);

        // Name
        const name = document.createElement('span');
        name.className = 'field-name';
        name.textContent = field.name;
        name.title = field.description;
        row.appendChild(name);

        // Bits
        const bits = document.createElement('span');
        bits.className = 'field-bits';
        const msb = field.bitOffset + field.bitWidth - 1;
        bits.textContent = field.bitWidth > 1
          ? '[' + msb + ':' + field.bitOffset + ']'
          : '[' + field.bitOffset + ']';
        row.appendChild(bits);

        // Control
        const control = document.createElement('div');
        control.className = 'field-control';

        if (field.isReserved || isReadOnly(field.access)) {
          // Read-only display
          const span = document.createElement('span');
          span.className = 'field-hex';
          span.textContent = '0x' + field.value.toString(16);
          control.appendChild(span);
        } else if (field.bitWidth === 1 && !field.hasEnum) {
          // Checkbox
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = field.value === 1;
          cb.addEventListener('change', () => {
            vscode.postMessage({ type: 'field-changed', fieldName: field.name, value: cb.checked ? 1 : 0 });
          });
          control.appendChild(cb);
        } else if (field.hasEnum) {
          // Dropdown
          const sel = document.createElement('select');
          for (const ev of field.enumeratedValues) {
            const opt = document.createElement('option');
            opt.value = ev.value;
            opt.textContent = ev.name;
            opt.title = ev.description;
            if (ev.value === field.value) opt.selected = true;
            sel.appendChild(opt);
          }
          // Add raw number option if current value not in enum
          if (!field.enumeratedValues.some(e => e.value === field.value)) {
            const opt = document.createElement('option');
            opt.value = field.value;
            opt.textContent = '0x' + field.value.toString(16);
            opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => {
            vscode.postMessage({ type: 'field-changed', fieldName: field.name, value: parseInt(sel.value) });
          });
          control.appendChild(sel);
        } else {
          // Number input
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = 0;
          inp.max = field.maxValue;
          inp.value = field.value;
          inp.addEventListener('change', () => {
            let val = parseInt(inp.value);
            if (isNaN(val)) val = 0;
            if (val < 0) val = 0;
            if (val > field.maxValue) val = field.maxValue;
            inp.value = val;
            vscode.postMessage({ type: 'field-changed', fieldName: field.name, value: val });
          });
          control.appendChild(inp);
        }

        // Hex value display
        if (!field.isReserved && !isReadOnly(field.access)) {
          const hex = document.createElement('span');
          hex.className = 'field-hex';
          hex.textContent = '0x' + field.value.toString(16);
          control.appendChild(hex);
        }

        row.appendChild(control);
        list.appendChild(row);
      }
    }

    function renderCandidates(options) {
      const list = document.getElementById('candidate-list');
      list.innerHTML = '';
      for (const opt of options) {
        const item = document.createElement('div');
        item.className = 'candidate-item';
        item.textContent = opt.label;
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
        const selectCandidate = () => {
          vscode.postMessage({
            type: 'select-candidate',
            peripheral: opt.peripheral,
            register: opt.register,
          });
        };
        item.addEventListener('click', selectCandidate);
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCandidate(); }
        });
        list.appendChild(item);
      }
    }

    // ── Register Browser ──────────────────────────────────

    function renderPeripheralTree(peripherals, filter) {
      const tree = document.getElementById('peripheral-tree');
      if (!tree) return;
      tree.innerHTML = '';

      const query = (filter || '').toUpperCase().trim();

      let matchCount = 0;
      for (const periph of peripherals) {
        // Filter: match peripheral name or any register name
        let matchingRegs = periph.registers;
        if (query) {
          const periphMatch = periph.name.toUpperCase().includes(query);
          matchingRegs = periph.registers.filter(r =>
            periphMatch ||
            r.name.toUpperCase().includes(query) ||
            (periph.name + '_' + r.name).toUpperCase().includes(query)
          );
          if (matchingRegs.length === 0) continue;
        }

        matchCount += matchingRegs.length;
        const group = document.createElement('div');
        group.className = 'periph-group';

        const isExpanded = !!query;
        const header = document.createElement('div');
        header.className = 'periph-header' + (isExpanded ? ' expanded' : '');
        header.setAttribute('tabindex', '0');
        header.setAttribute('role', 'treeitem');
        header.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '▶';
        header.appendChild(chevron);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = periph.name;
        header.appendChild(nameSpan);

        const addrSpan = document.createElement('span');
        addrSpan.className = 'periph-addr';
        addrSpan.textContent = '0x' + periph.baseAddress.toString(16).padStart(8, '0');
        header.appendChild(addrSpan);

        const regList = document.createElement('div');
        regList.className = 'periph-registers' + (isExpanded ? ' visible' : '');
        regList.setAttribute('role', 'group');

        for (const reg of matchingRegs) {
          const item = document.createElement('div');
          item.className = 'reg-item';
          item.setAttribute('tabindex', '0');
          item.setAttribute('role', 'treeitem');

          const regNameSpan = document.createElement('span');
          regNameSpan.className = 'reg-name';
          regNameSpan.textContent = reg.name;
          item.appendChild(regNameSpan);

          const regOffset = document.createElement('span');
          regOffset.className = 'reg-offset';
          regOffset.textContent = '+0x' + reg.addressOffset.toString(16).padStart(2, '0');
          item.appendChild(regOffset);

          item.title = reg.description || (periph.name + '->' + reg.name);
          const selectReg = () => {
            vscode.postMessage({
              type: 'select-candidate',
              peripheral: periph.name,
              register: reg.name,
            });
          };
          item.addEventListener('click', selectReg);
          item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectReg(); }
          });
          regList.appendChild(item);
        }

        const toggleExpand = () => {
          const expanded = header.classList.toggle('expanded');
          regList.classList.toggle('visible');
          header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        };
        header.addEventListener('click', toggleExpand);
        header.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); }
        });

        group.appendChild(header);
        group.appendChild(regList);
        tree.appendChild(group);
      }

      if (matchCount === 0 && query) {
        const empty = document.createElement('div');
        empty.className = 'browser-empty';
        empty.textContent = 'No registers matching "' + query + '"';
        tree.appendChild(empty);
      }
    }

    // ── UI Event Handlers ─────────────────────────────────

    document.getElementById('pin-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'pin-toggle' });
    });

    document.getElementById('reg-address')?.addEventListener('click', () => {
      const addr = document.getElementById('reg-address')?.textContent;
      if (addr) navigator.clipboard.writeText(addr);
    });

    document.getElementById('decode-btn')?.addEventListener('click', () => {
      const input = document.getElementById('decode-input');
      if (input?.value) {
        vscode.postMessage({ type: 'decode-value', hex: input.value });
      }
    });

    document.getElementById('decode-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('decode-btn')?.click();
      }
    });

    document.getElementById('reset-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'reset-fields' });
    });

    document.getElementById('copy-btn')?.addEventListener('click', () => {
      const style = document.getElementById('style-select')?.value || 'rmw';
      vscode.postMessage({ type: 'copy-code', style });
    });

    document.getElementById('insert-btn')?.addEventListener('click', () => {
      const style = document.getElementById('style-select')?.value || 'rmw';
      vscode.postMessage({ type: 'insert-code', style });
    });

    document.getElementById('style-select')?.addEventListener('change', () => {
      if (currentRegister) renderCodePreview(currentRegister);
    });

    let searchTimer = null;
    document.getElementById('browser-search')?.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        renderPeripheralTree(allPeripherals, e.target.value);
      }, 150);
    });

    document.getElementById('browse-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'browse-registers' });
      showState('idle');
    });

    // ── Helpers ─────────────────────────────────────────────

    function formatAccess(access) {
      const map = {
        'read-only': 'RO',
        'write-only': 'WO',
        'read-write': 'RW',
        'writeOnce': 'W1',
        'read-writeOnce': 'RW1',
      };
      return map[access] || access;
    }

    function getAccessColor(access) {
      if (access === 'read-only') return 'var(--vscode-charts-blue, rgba(79, 195, 247, 0.3))';
      if (access === 'write-only') return 'var(--vscode-charts-orange, rgba(255, 183, 77, 0.3))';
      return 'var(--vscode-charts-green, rgba(174, 213, 129, 0.3))';
    }

    function isReadOnly(access) {
      return access === 'read-only';
    }

    function updatePinButton() {
      const btn = document.getElementById('pin-btn');
      if (btn) {
        btn.classList.toggle('pinned', isPinned);
        btn.title = isPinned ? 'Unpin register' : 'Pin register';
      }
    }

    // ── Init ──────────────────────────────────────────────

    vscode.postMessage({ type: 'webview-ready' });
  `;
}
