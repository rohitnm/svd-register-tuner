import type { MetadataProvider } from './metadataProvider';
import type {
  RegisterToken,
  Register,
  Peripheral,
  CandidateOption,
} from './types';

export interface ResolvedRegister {
  peripheral: Peripheral;
  register: Register;
}

/**
 * Maps a RegisterToken (from cursor tracker) to a unique peripheral + register
 * identity using the MetadataProvider's indexes.
 */
export class SymbolResolver {
  /** Per-file cache of last user disambiguation choice */
  private disambiguationCache = new Map<string, string>();

  constructor(private readonly metadata: MetadataProvider) {}

  /**
   * Resolve a token to a peripheral + register.
   * Returns null if no match. Returns candidates array if ambiguous.
   */
  resolve(
    token: RegisterToken,
  ): { resolved: ResolvedRegister } | { candidates: CandidateOption[] } | null {
    const model = this.metadata.getModel();
    if (!model) {
      return null;
    }

    // 1. Address literal → reverse lookup
    if (token.address !== undefined) {
      return this.resolveByAddress(token.address);
    }

    // 2. Arrow access (GPIOA->MODER) → direct lookup
    if (token.peripheral && token.register) {
      const direct = this.directLookup(token.peripheral, token.register);
      if (direct) {
        return { resolved: direct };
      }

      // Try name index with combined forms
      const byName = this.resolveByNameIndex(token.peripheral, token.register);
      if (byName) {
        return byName;
      }
    }

    // 3. Flat macro (RCC_AHB1ENR) → try name index, then prefix split
    if (token.peripheral && token.register) {
      const flat = this.resolveFlatMacro(token.peripheral, token.register);
      if (flat) {
        return flat;
      }
    }

    return null;
  }

  /** Check disambiguation cache for a file+raw key */
  getCachedChoice(token: RegisterToken): ResolvedRegister | null {
    const key = `${token.file}::${token.raw}`;
    const cached = this.disambiguationCache.get(key);
    if (!cached) {
      return null;
    }

    const [peripheral, register] = cached.split('->');
    return this.directLookup(peripheral, register);
  }

  /** Store a user's disambiguation choice */
  cacheChoice(token: RegisterToken, peripheral: string, register: string): void {
    const key = `${token.file}::${token.raw}`;
    this.disambiguationCache.set(key, `${peripheral}->${register}`);
  }

  private directLookup(
    peripheralName: string,
    registerName: string,
  ): ResolvedRegister | null {
    const peripheral = this.metadata.getPeripheral(peripheralName);
    if (!peripheral) {
      return null;
    }
    const register = peripheral.registers.get(registerName);
    if (!register) {
      return null;
    }
    return { peripheral, register };
  }

  private resolveByAddress(
    address: number,
  ): { resolved: ResolvedRegister } | null {
    const model = this.metadata.getModel();
    if (!model) {
      return null;
    }

    const entry = model.addressIndex.get(address);
    if (!entry) {
      return null;
    }

    const result = this.directLookup(entry.peripheral, entry.register);
    if (!result) {
      return null;
    }
    return { resolved: result };
  }

  private resolveByNameIndex(
    peripheral: string,
    register: string,
  ): { resolved: ResolvedRegister } | null {
    const model = this.metadata.getModel();
    if (!model) {
      return null;
    }

    // Try all known combined-name formats
    const forms = [
      `${peripheral}->${register}`,
      `${peripheral}_${register}`,
      `${peripheral}.${register}`,
    ];

    for (const form of forms) {
      const entry = model.nameIndex.get(form);
      if (entry) {
        const result = this.directLookup(entry.peripheral, entry.register);
        if (result) {
          return { resolved: result };
        }
      }
    }

    return null;
  }

  private resolveFlatMacro(
    prefix: string,
    suffix: string,
  ): { resolved: ResolvedRegister } | { candidates: CandidateOption[] } | null {
    const model = this.metadata.getModel();
    if (!model) {
      return null;
    }

    // Try the prefix as a peripheral name directly
    const direct = this.directLookup(prefix, suffix);
    if (direct) {
      return { resolved: direct };
    }

    // Search all peripherals for a register matching the suffix
    const candidates: CandidateOption[] = [];
    for (const [pName, peripheral] of model.peripherals) {
      const reg = peripheral.registers.get(suffix);
      if (reg) {
        candidates.push({
          peripheral: pName,
          register: reg.name,
          label: `${pName}->${reg.name}`,
        });
      }
    }

    if (candidates.length === 1) {
      const c = candidates[0];
      const result = this.directLookup(c.peripheral, c.register);
      if (result) {
        return { resolved: result };
      }
    }

    if (candidates.length > 1) {
      return { candidates };
    }

    // Try progressive prefix splitting: RCC_AHB1ENR → try "RCC" + "AHB1ENR"
    // Already tried above. Now try longer prefixes for names like GPIO_MODER_MODER0
    const combined = `${prefix}_${suffix}`;
    for (const [pName, peripheral] of model.peripherals) {
      if (combined.startsWith(pName + '_')) {
        const regName = combined.slice(pName.length + 1);
        const reg = peripheral.registers.get(regName);
        if (reg) {
          return { resolved: { peripheral, register: reg } };
        }
      }
    }

    return null;
  }
}
