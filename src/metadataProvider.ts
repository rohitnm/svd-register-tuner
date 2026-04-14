import * as fs from 'fs';
import { parseSvdXml } from './svdParser';
import { CacheManager } from './cacheManager';
import type { DeviceModel, Peripheral, Register } from './types';

export class MetadataProvider {
  private model: DeviceModel | null = null;
  private cache: CacheManager;

  constructor(globalStoragePath: string, cacheMaxMb: number = 100) {
    this.cache = new CacheManager(globalStoragePath, cacheMaxMb);
  }

  /** Load device metadata from SVD file (using cache when possible) */
  async loadFromSvd(svdPath: string): Promise<DeviceModel> {
    const svdHash = this.cache.computeFileHash(svdPath);
    if (!svdHash) {
      throw new Error(`Cannot read SVD file: ${svdPath}`);
    }

    // Try reading the SVD to get the device name for cache key
    // First attempt cache with a preliminary name from filename
    const fileName = svdPath.replace(/\\/g, '/').split('/').pop()?.replace('.svd', '') ?? 'unknown';

    const cached = this.cache.load(fileName, svdHash);
    if (cached) {
      this.model = cached;
      return cached;
    }

    // Parse SVD
    let xmlContent: string;
    try {
      xmlContent = fs.readFileSync(svdPath, 'utf-8');
    } catch (err) {
      throw new Error(`Cannot read SVD file: ${svdPath} — ${err}`);
    }
    const model = parseSvdXml(xmlContent);
    this.model = model;

    // Cache using actual device name
    this.cache.save(model.name || fileName, svdHash, model);

    return model;
  }

  /** Get the currently loaded model */
  getModel(): DeviceModel | null {
    return this.model;
  }

  /** Query a peripheral by name */
  getPeripheral(name: string): Peripheral | undefined {
    return this.model?.peripherals.get(name);
  }

  /** Query a register by peripheral and register name */
  getRegister(peripheral: string, register: string): Register | undefined {
    return this.model?.peripherals.get(peripheral)?.registers.get(register);
  }

  /** Reverse-lookup a register by absolute address */
  resolveAddress(addr: number): { peripheral: string; register: string } | undefined {
    return this.model?.addressIndex.get(addr);
  }

  /** Resolve by combined name (e.g. "GPIOA->MODER" or "GPIOA_MODER") */
  resolveByName(combinedName: string): { peripheral: string; register: string } | undefined {
    return this.model?.nameIndex.get(combinedName);
  }

  /** Search registers by partial name match */
  searchRegisters(query: string): Array<{ peripheral: string; register: Register }> {
    if (!this.model) {
      return [];
    }

    const upper = query.toUpperCase();
    const results: Array<{ peripheral: string; register: Register }> = [];

    for (const [pName, periph] of this.model.peripherals) {
      for (const [, reg] of periph.registers) {
        if (
          reg.name.toUpperCase().includes(upper) ||
          pName.toUpperCase().includes(upper) ||
          `${pName}_${reg.name}`.toUpperCase().includes(upper)
        ) {
          results.push({ peripheral: pName, register: reg });
        }
      }
    }

    return results;
  }

  /** Invalidate cache for current device and reload */
  async reload(svdPath: string): Promise<DeviceModel> {
    if (this.model) {
      this.cache.invalidate(this.model.name);
    }
    return this.loadFromSvd(svdPath);
  }
}
