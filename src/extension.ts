import * as vscode from 'vscode';
import { CursorTracker } from './cursorTracker';
import { SymbolResolver } from './symbolResolver';
import { MetadataProvider } from './metadataProvider';
import { TargetDetector } from './targetDetector';
import { HudPanel } from './hudPanel';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('SVD Register Tuner');
  outputChannel.appendLine('SVD Register Tuner extension activated');

  /** Core services **/
  const config = vscode.workspace.getConfiguration('regHud');
  const debounceMs = config.get<number>('debounceMs', 250);
  const cacheMaxMb = config.get<number>('cacheMaxMb', 100);

  const metadata = new MetadataProvider(context.globalStorageUri.fsPath, cacheMaxMb);
  const resolver = new SymbolResolver(metadata);
  const cursorTracker = new CursorTracker(debounceMs);
  const targetDetector = new TargetDetector(outputChannel);

  /** HUD Panel **/
  const hudPanel = new HudPanel(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HudPanel.viewType, hudPanel),
  );

  /** Cursor → resolve → HUD **/
  cursorTracker.onToken(async (token) => {
    try {
    if (!token) {
      return;
    }

    const autoFollow = vscode.workspace
      .getConfiguration('regHud')
      .get<boolean>('autoFollow', true);
    if (!autoFollow) {
      return;
    }

    if (!metadata.getModel()) {
      return; // No device loaded yet
    }

    // Check disambiguation cache first
    const cached = resolver.getCachedChoice(token);
    if (cached) {
      hudPanel.showRegister(cached.peripheral, cached.register);
      return;
    }

    const result = resolver.resolve(token);
    if (!result) {
      return; // Silent — no match for this line
    }

    if ('resolved' in result) {
      const { peripheral, register } = result.resolved;
      outputChannel.appendLine(
        `[Resolved] ${peripheral.name}->${register.name} @ 0x${register.absoluteAddress.toString(16)}`,
      );
      hudPanel.showRegister(peripheral, register);
    } else if ('candidates' in result) {
      outputChannel.appendLine(
        `[Ambiguous] ${token.raw} → ${result.candidates.map((c) => c.label).join(', ')}`,
      );
      hudPanel.showCandidates(result.candidates);
    }
    } catch (err) {
      outputChannel.appendLine(`[Error] cursor resolve: ${err}`);
    }
  });

  /** Handle webview messages **/
  hudPanel.onMessage(async (msg) => {
    switch (msg.type) {
      case 'select-candidate': {
        const peripheral = metadata.getPeripheral(msg.peripheral);
        const register = metadata.getRegister(msg.peripheral, msg.register);
        if (peripheral && register) {
          hudPanel.showRegister(peripheral, register);
        }
        break;
      }

      case 'copy-code': {
        const vm = hudPanel.getCurrentViewModel();
        if (vm) {
          const style = msg.style as import('./types').CodeStyle;
          const code = vm.generatedCode[style] || vm.generatedCode.rmw;
          await vscode.env.clipboard.writeText(code);
          vscode.window.showInformationMessage('SVD Register Tuner: Code copied to clipboard');
        }
        break;
      }

      case 'insert-code': {
        const viewModel = hudPanel.getCurrentViewModel();
        const editor = vscode.window.activeTextEditor;
        if (viewModel && editor) {
          const style = msg.style as import('./types').CodeStyle;
          const code = viewModel.generatedCode[style] || viewModel.generatedCode.rmw;
          await editor.edit((editBuilder) => {
            const pos = editor.selection.active;
            // Insert on the next line with proper indentation
            const currentLine = editor.document.lineAt(pos.line).text;
            const indent = currentLine.match(/^(\s*)/)?.[1] ?? '';
            const indentedCode = code
              .split('\n')
              .map((line) => indent + line)
              .join('\n');
            editBuilder.insert(
              new vscode.Position(pos.line + 1, 0),
              indentedCode + '\n',
            );
          });
        }
        break;
      }
    }
  });

  /** Auto-detect target on activation **/
  targetDetector.detect().then(async (target) => {
    if (target) {
      outputChannel.appendLine(
        `Auto-detected device: ${target.device} (source: ${target.source})`,
      );
      outputChannel.appendLine(`SVD path: ${target.svdPath}`);
      try {
        await metadata.loadFromSvd(target.svdPath);
        const model = metadata.getModel();
        outputChannel.appendLine(
          `Loaded SVD: ${model?.name ?? target.device} — ${model?.peripherals.size ?? 0} peripherals`,
        );
        if (model) {
          hudPanel.setDeviceModel(model);
          outputChannel.appendLine('Device model sent to HUD panel');
        }
      } catch (err) {
        outputChannel.appendLine(`Failed to load SVD: ${err}`);
      }
    } else {
      outputChannel.appendLine(
        'No device detected — use "SVD Register Tuner: Select Device" or set regHud.svdPath',
      );
    }
  }).catch((err) => {
    outputChannel.appendLine(`[Error] target detection failed: ${err}`);
  });

  /** Commands **/
  context.subscriptions.push(
    vscode.commands.registerCommand('regHud.togglePanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.reghud');
    }),

    vscode.commands.registerCommand('regHud.selectDevice', async () => {
      const svdPath = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'SVD Files': ['svd'] },
        title: 'Select SVD File',
      });
      if (svdPath && svdPath[0]) {
        try {
          const model = await metadata.loadFromSvd(svdPath[0].fsPath);
          await vscode.workspace
            .getConfiguration('regHud')
            .update('svdPath', svdPath[0].fsPath);
          outputChannel.appendLine(`Device loaded: ${model.name}`);
          hudPanel.setDeviceModel(model);
          vscode.window.showInformationMessage(`SVD Register Tuner: Loaded ${model.name}`);
        } catch (err) {
          vscode.window.showErrorMessage(`SVD Register Tuner: Failed to load SVD — ${err}`);
        }
      }
    }),

    vscode.commands.registerCommand('regHud.refreshMetadata', async () => {
      try {
        const target = await targetDetector.detect();
        if (target) {
          if (metadata.getModel()) {
            await metadata.reload(target.svdPath);
          } else {
            await metadata.loadFromSvd(target.svdPath);
          }
          const model = metadata.getModel();
          if (model) {
            hudPanel.setDeviceModel(model);
          }
          outputChannel.appendLine('Metadata refreshed');
        }
      } catch (err) {
        outputChannel.appendLine(`[Error] refresh metadata: ${err}`);
        vscode.window.showErrorMessage(`SVD Register Tuner: Failed to refresh — ${err}`);
      }
    }),

    vscode.commands.registerCommand('regHud.pinRegister', () => {
      vscode.commands.executeCommand('setContext', 'regHud.isPinned', true);
    }),

    vscode.commands.registerCommand('regHud.unpinRegister', () => {
      vscode.commands.executeCommand('setContext', 'regHud.isPinned', false);
    }),

    vscode.commands.registerCommand('regHud.copyCode', async () => {
      const vm = hudPanel.getCurrentViewModel();
      if (vm) {
        const style = vscode.workspace.getConfiguration('regHud').get<string>('codeStyle', 'rmw') as import('./types').CodeStyle;
        const code = vm.generatedCode[style] || vm.generatedCode.rmw;
        await vscode.env.clipboard.writeText(code);
        vscode.window.showInformationMessage('SVD Register Tuner: Code copied to clipboard');
      }
    }),
    vscode.commands.registerCommand('regHud.insertCode', async () => {
      const vm = hudPanel.getCurrentViewModel();
      const editor = vscode.window.activeTextEditor;
      if (vm && editor) {
        const style = vscode.workspace.getConfiguration('regHud').get<string>('codeStyle', 'rmw') as import('./types').CodeStyle;
        const code = vm.generatedCode[style] || vm.generatedCode.rmw;
        await editor.edit((editBuilder) => {
          const pos = editor.selection.active;
          const currentLine = editor.document.lineAt(pos.line).text;
          const indent = currentLine.match(/^(\s*)/)?.[1] ?? '';
          const indentedCode = code.split('\n').map((line) => indent + line).join('\n');
          editBuilder.insert(new vscode.Position(pos.line + 1, 0), indentedCode + '\n');
        });
      }
    }),
    vscode.commands.registerCommand('regHud.decodeValue', async () => {
      const hex = await vscode.window.showInputBox({
        prompt: 'Enter hex value to decode',
        placeHolder: '0x00000000',
        validateInput: (v) => /^(0x)?[0-9a-fA-F]+$/.test(v) ? null : 'Invalid hex value',
      });
      if (hex) {
        hudPanel.decodeValue(hex);
      }
    }),
    vscode.commands.registerCommand('regHud.switchCodeStyle', async () => {
      const styles = [
        { label: 'Read-Modify-Write', description: 'Safe, preserves other bits', detail: 'rmw' },
        { label: 'Raw Write', description: 'Direct full register write', detail: 'raw' },
        { label: 'CMSIS Macros', description: 'MODIFY_REG / SET_BIT / CLEAR_REG', detail: 'cmsis' },
        { label: 'Commented', description: 'RMW with full field documentation', detail: 'commented' },
      ];
      const picked = await vscode.window.showQuickPick(styles, { placeHolder: 'Select code generation style' });
      if (picked) {
        await vscode.workspace.getConfiguration('regHud').update('codeStyle', picked.detail);
      }
    }),

    cursorTracker,
    outputChannel,
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
