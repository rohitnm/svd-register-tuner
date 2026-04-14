import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CachedDevice,
  DeviceModel,
  Peripheral,
  Register,
  SerializedDeviceModel,
  SerializedPeripheral,
} from './types';
import { CACHE_SCHEMA_VERSION } from './constants';

export class CacheManager {
  private readonly cacheDir: string;
  private readonly maxBytes: number;

  constructor(globalStoragePath: string, maxMb: number = 100) {
    this.cacheDir = path.join(globalStoragePath, 'cache');
    this.maxBytes = maxMb * 1024 * 1024;
  }

  /** Ensure cache directory exists */
  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch {
    }
  }

  /** Compute SHA-256 hash of a file's contents */
  computeFileHash(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  /** Get cache file path for a device name */
  private getCachePath(deviceName: string): string {
    // Sanitize device name for filesystem safety
    const safe = deviceName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safe}.json`);
  }

  /** Try to load a cached device model. Returns null if cache miss or stale. */
  load(deviceName: string, svdHash: string): DeviceModel | null {
    const cachePath = this.getCachePath(deviceName);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const cached: CachedDevice = JSON.parse(raw);

      // Validate schema version and hash
      if (cached.version !== CACHE_SCHEMA_VERSION) {
        return null;
      }
      if (cached.svdHash !== svdHash) {
        return null;
      }

      return deserializeModel(cached.model);
    } catch {
      // Corrupt cache, ignore
      return null;
    }
  }

  /** Save a parsed device model to cache */
  save(deviceName: string, svdHash: string, model: DeviceModel): void {
    try {
      this.ensureDir();
      this.enforceMaxSize();

      const cached: CachedDevice = {
        version: CACHE_SCHEMA_VERSION,
        svdHash,
        parsedAt: new Date().toISOString(),
        model: serializeModel(model),
      };

      const cachePath = this.getCachePath(deviceName);
      fs.writeFileSync(cachePath, JSON.stringify(cached), 'utf-8');
    } catch {
      // Cache save is best-effort — don't crash
    }
  }

  /** Invalidate cache for a device */
  invalidate(deviceName: string): void {
    try {
      const cachePath = this.getCachePath(deviceName);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
    } catch {
    }
  }

  /** Evict oldest cache files if total size exceeds max */
  private enforceMaxSize(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return;
      }

      const files = fs.readdirSync(this.cacheDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const fullPath = path.join(this.cacheDir, f);
          const stat = fs.statSync(fullPath);
          return { path: fullPath, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime); // oldest first

      let totalSize = files.reduce((sum, f) => sum + f.size, 0);

      // Remove oldest files until under limit
      for (const file of files) {
        if (totalSize <= this.maxBytes) {
          break;
        }
        try { fs.unlinkSync(file.path); } catch { /* skip locked files */ }
        totalSize -= file.size;
      }
    } catch {
      // Best-effort
    }
  }
}

/** Serialization */

function serializeModel(model: DeviceModel): SerializedDeviceModel {
  const peripherals: Record<string, SerializedPeripheral> = {};
  for (const [name, periph] of model.peripherals) {
    const registers: Record<string, Register> = {};
    for (const [rName, reg] of periph.registers) {
      registers[rName] = reg;
    }
    peripherals[name] = {
      name: periph.name,
      groupName: periph.groupName,
      description: periph.description,
      baseAddress: periph.baseAddress,
      registers,
      derivedFrom: periph.derivedFrom,
    };
  }

  return {
    name: model.name,
    description: model.description,
    version: model.version,
    addressUnitBits: model.addressUnitBits,
    width: model.width,
    peripherals,
  };
}

function deserializeModel(serialized: SerializedDeviceModel): DeviceModel {
  const peripherals = new Map<string, Peripheral>();
  const addressIndex = new Map<number, { peripheral: string; register: string }>();
  const nameIndex = new Map<string, { peripheral: string; register: string }>();

  for (const [pName, sp] of Object.entries(serialized.peripherals)) {
    const registers = new Map<string, Register>();
    for (const [rName, reg] of Object.entries(sp.registers)) {
      registers.set(rName, reg);
      addressIndex.set(reg.absoluteAddress, { peripheral: pName, register: rName });
      nameIndex.set(`${pName}->${rName}`, { peripheral: pName, register: rName });
      nameIndex.set(`${pName}_${rName}`, { peripheral: pName, register: rName });
      nameIndex.set(`${pName}.${rName}`, { peripheral: pName, register: rName });
    }
    peripherals.set(pName, {
      name: sp.name,
      groupName: sp.groupName,
      description: sp.description,
      baseAddress: sp.baseAddress,
      registers,
      derivedFrom: sp.derivedFrom,
    });
  }

  return {
    name: serialized.name,
    description: serialized.description,
    version: serialized.version,
    addressUnitBits: serialized.addressUnitBits,
    width: serialized.width,
    peripherals,
    addressIndex,
    nameIndex,
  };
}
