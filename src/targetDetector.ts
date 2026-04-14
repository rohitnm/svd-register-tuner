import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface DetectedTarget {
  device: string;
  svdPath: string;
  source: 'setting' | 'platformio' | 'cubemx' | 'makefile' | 'cmake' | 'svd-file';
}

/**
 * Auto-detects which MCU/device the workspace targets.
 * Checks multiple sources in priority order and returns the first match.
 */
export class TargetDetector {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * Detect target device from workspace context.
   * Priority: user setting > platformio.ini > .ioc > Makefile > CMake > SVD files
   */
  async detect(): Promise<DetectedTarget | null> {
    try {
    // 1. User setting (highest priority)
    const fromSetting = this.detectFromSettings();
    if (fromSetting) {
      this.log(`Target from settings: ${fromSetting.device}`);
      return fromSetting;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // 2. PlatformIO
    const fromPio = await this.detectFromPlatformIO(rootPath);
    if (fromPio) {
      this.log(`Target from platformio.ini: ${fromPio.device}`);
      return fromPio;
    }

    // 3. STM32CubeMX .ioc file
    const fromCubeMx = await this.detectFromCubeMX(rootPath);
    if (fromCubeMx) {
      this.log(`Target from .ioc: ${fromCubeMx.device}`);
      return fromCubeMx;
    }

    // 4. Makefile
    const fromMakefile = await this.detectFromMakefile(rootPath);
    if (fromMakefile) {
      this.log(`Target from Makefile: ${fromMakefile.device}`);
      return fromMakefile;
    }

    // 5. CMakeLists.txt
    const fromCmake = await this.detectFromCMake(rootPath);
    if (fromCmake) {
      this.log(`Target from CMake: ${fromCmake.device}`);
      return fromCmake;
    }

    // 6. Direct SVD file in workspace
    const fromSvd = await this.detectFromSvdFile(rootPath);
    if (fromSvd) {
      this.log(`Target from SVD file: ${fromSvd.device}`);
      return fromSvd;
    }

    return null;
    } catch (err) {
      this.log(`Detection error: ${err}`);
      return null;
    }
  }

  /** Check user/workspace settings for explicit device + svdPath */
  private detectFromSettings(): DetectedTarget | null {
    const config = vscode.workspace.getConfiguration('regHud');
    const device = config.get<string>('device');
    const svdPath = config.get<string>('svdPath');

    if (device && svdPath && fs.existsSync(svdPath)) {
      return { device, svdPath, source: 'setting' };
    }

    return null;
  }

  /** Parse platformio.ini for board → infer device */
  private async detectFromPlatformIO(
    rootPath: string,
  ): Promise<DetectedTarget | null> {
    const iniPath = path.join(rootPath, 'platformio.ini');
    if (!fs.existsSync(iniPath)) {
      return null;
    }

    const content = fs.readFileSync(iniPath, 'utf-8');

    // Extract board value
    const boardMatch = content.match(/^\s*board\s*=\s*(\S+)/m);
    if (!boardMatch) {
      return null;
    }

    const board = boardMatch[1];

    // Look for SVD file reference in platformio.ini
    const svdMatch = content.match(/^\s*debug_svd_path\s*=\s*(.+)/m);
    if (svdMatch) {
      const svdPath = svdMatch[1].trim();
      const resolved = path.isAbsolute(svdPath)
        ? svdPath
        : path.join(rootPath, svdPath);
      if (fs.existsSync(resolved)) {
        return { device: board, svdPath: resolved, source: 'platformio' };
      }
    }

    // Try to find SVD by board name in workspace
    const svdPath = await this.findSvdByName(rootPath, board);
    if (svdPath) {
      return { device: board, svdPath, source: 'platformio' };
    }

    return null;
  }

  /** Parse .ioc file for MCU identifier */
  private async detectFromCubeMX(
    rootPath: string,
  ): Promise<DetectedTarget | null> {
    const iocFiles = await this.findFiles(rootPath, '*.ioc');
    if (iocFiles.length === 0) {
      return null;
    }

    const content = fs.readFileSync(iocFiles[0], 'utf-8');

    // CubeMX .ioc files contain the MCU identifier
    const mcuMatch = content.match(
      /^Mcu\.UserName\s*=\s*(\S+)/m,
    );
    if (!mcuMatch) {
      return null;
    }

    const device = mcuMatch[1];
    const svdPath = await this.findSvdByName(rootPath, device);
    if (svdPath) {
      return { device, svdPath, source: 'cubemx' };
    }

    return null;
  }

  /** Scan Makefile for -DSTM32Fxxxx defines */
  private async detectFromMakefile(
    rootPath: string,
  ): Promise<DetectedTarget | null> {
    const makefile = path.join(rootPath, 'Makefile');
    if (!fs.existsSync(makefile)) {
      return null;
    }

    const content = fs.readFileSync(makefile, 'utf-8');

    // Match -DSTM32F407xx, -DSTM32L476xx, etc.
    const defineMatch = content.match(/-D(STM32[A-Z]\d{3}[A-Za-z]*)\b/);
    if (!defineMatch) {
      return null;
    }

    const device = defineMatch[1];
    const svdPath = await this.findSvdByName(rootPath, device);
    if (svdPath) {
      return { device, svdPath, source: 'makefile' };
    }

    return null;
  }

  /** Scan CMakeLists.txt for device identifiers */
  private async detectFromCMake(
    rootPath: string,
  ): Promise<DetectedTarget | null> {
    const cmakeFiles = await this.findFiles(rootPath, 'CMakeLists.txt');
    if (cmakeFiles.length === 0) {
      return null;
    }

    for (const cmakePath of cmakeFiles) {
      const content = fs.readFileSync(cmakePath, 'utf-8');

      // Match -DSTM32F407xx or add_definitions(-DSTM32...)
      const defineMatch = content.match(/-D(STM32[A-Z]\d{3}[A-Za-z]*)\b/);
      if (defineMatch) {
        const device = defineMatch[1];
        const svdPath = await this.findSvdByName(rootPath, device);
        if (svdPath) {
          return { device, svdPath, source: 'cmake' };
        }
      }

      // Match -mcpu=cortex-m4 etc. (less specific but useful context)
      const mcpuMatch = content.match(/-mcpu=(cortex-m\d\+?)/);
      if (mcpuMatch) {
        this.log(`Detected CPU: ${mcpuMatch[1]} (need SVD file to proceed)`);
      }
    }

    return null;
  }

  /** Look for .svd files directly in workspace */
  private async detectFromSvdFile(
    rootPath: string,
  ): Promise<DetectedTarget | null> {
    const svdFiles = await this.findFiles(rootPath, '*.svd');
    if (svdFiles.length === 0) {
      return null;
    }

    // If exactly one SVD file, use it
    if (svdFiles.length === 1) {
      const svdPath = svdFiles[0];
      const device = path.basename(svdPath, '.svd');
      return { device, svdPath, source: 'svd-file' };
    }

    // Multiple SVD files — log and return null (user should configure)
    this.log(
      `Found ${svdFiles.length} SVD files — set regHud.svdPath to choose one`,
    );
    return null;
  }

  /** Search workspace for an SVD file matching a device name pattern */
  private async findSvdByName(
    rootPath: string,
    deviceName: string,
  ): Promise<string | null> {
    const svdFiles = await this.findFiles(rootPath, '*.svd');
    const upper = deviceName.toUpperCase();

    // Exact match first
    for (const f of svdFiles) {
      if (path.basename(f, '.svd').toUpperCase() === upper) {
        return f;
      }
    }

    // Partial match — basename contains device name
    for (const f of svdFiles) {
      if (path.basename(f, '.svd').toUpperCase().includes(upper)) {
        return f;
      }
    }

    return null;
  }

  /** Find files matching a glob pattern in the workspace */
  private async findFiles(
    rootPath: string,
    pattern: string,
  ): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(
      `**/${pattern}`,
      '**/node_modules/**',
      10,
    );
    return uris.map((u) => u.fsPath);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[TargetDetector] ${message}`);
  }
}
