import { XMLParser } from 'fast-xml-parser';
import type {
  AccessType,
  DeviceModel,
  EnumValue,
  Field,
  Peripheral,
  Register,
} from './types';
import { SVD_ACCESS_MAP } from './constants';

// ─── Raw SVD XML shapes (after fast-xml-parser) ────────

interface SvdDevice {
  name: string;
  description?: string;
  version?: string;
  addressUnitBits?: number;
  width?: number;
  peripherals: { peripheral: SvdPeripheral | SvdPeripheral[] };
}

interface SvdPeripheral {
  '@_derivedFrom'?: string;
  name: string;
  groupName?: string;
  description?: string;
  baseAddress: string;
  registers?: { register: SvdRegister | SvdRegister[] };
  dim?: number;
  dimIncrement?: string;
  dimIndex?: string;
}

interface SvdRegister {
  name: string;
  displayName?: string;
  description?: string;
  addressOffset: string;
  size?: number;
  access?: string;
  resetValue?: string;
  resetMask?: string;
  fields?: { field: SvdField | SvdField[] };
  dim?: number;
  dimIncrement?: string;
  dimIndex?: string;
  '@_derivedFrom'?: string;
}

interface SvdField {
  name: string;
  description?: string;
  bitOffset?: number;
  bitWidth?: number;
  lsb?: number;
  msb?: number;
  bitRange?: string;
  access?: string;
  enumeratedValues?: SvdEnumeratedValues | SvdEnumeratedValues[];
  dim?: number;
  dimIncrement?: string | number;
  dimIndex?: string;
}

interface SvdEnumeratedValues {
  enumeratedValue: SvdEnumValue | SvdEnumValue[];
}

interface SvdEnumValue {
  name: string;
  description?: string;
  value: string;
}

// ─── Parser ────────────────────────────────────────────

export function parseSvdXml(xmlContent: string): DeviceModel {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => {
      return ['peripheral', 'register', 'field', 'enumeratedValue'].includes(name);
    },
    trimValues: true,
    numberParseOptions: {
      hex: false,
      leadingZeros: false,
      skipLike: /[.]/,
    },
  });

  const parsed = parser.parse(xmlContent);
  const svdDevice: SvdDevice = parsed.device;

  if (!svdDevice) {
    throw new Error('Invalid SVD file: missing <device> root element');
  }

  const defaultWidth = svdDevice.width !== undefined ? parseHexOrDec(svdDevice.width) : 32;
  const defaultAccess: AccessType = 'read-write';

  // First pass: parse base peripherals (no derivedFrom)
  const rawPeripherals = toArray(svdDevice.peripherals?.peripheral);
  const peripheralMap = new Map<string, Peripheral>();
  const derivedQueue: Array<{ svd: SvdPeripheral; expanded: SvdPeripheral[] }> = [];

  // Collect raw register data for register-level derivedFrom resolution
  const rawRegisterMap = new Map<string, SvdRegister[]>();

  for (const svdPeriph of rawPeripherals) {
    const expanded = expandPeripheralDim(svdPeriph);
    if (svdPeriph['@_derivedFrom']) {
      derivedQueue.push({ svd: svdPeriph, expanded });
    } else {
      for (const ep of expanded) {
        const rawRegs = toArray(ep.registers?.register);
        rawRegisterMap.set(ep.name, rawRegs);
        const periph = parsePeripheral(ep, defaultWidth, defaultAccess);
        peripheralMap.set(periph.name, periph);
      }
    }
  }

  // Resolve register-level derivedFrom for all base peripherals
  for (const [pName] of peripheralMap) {
    resolveRegisterDerivedFrom(pName, rawRegisterMap, peripheralMap);
  }

  // Second pass: resolve peripheral-level derivedFrom
  for (const { svd, expanded } of derivedQueue) {
    const baseName = svd['@_derivedFrom']!;
    const base = peripheralMap.get(baseName);
    if (!base) {
      throw new Error(`Peripheral "${svd.name}" derivedFrom "${baseName}" which was not found`);
    }
    for (const ep of expanded) {
      const rawRegs = toArray(ep.registers?.register);
      rawRegisterMap.set(ep.name, rawRegs);
      const periph = parseDerivedPeripheral(ep, base, defaultWidth, defaultAccess);
      peripheralMap.set(periph.name, periph);
      // Resolve register-level derivedFrom for this derived peripheral
      resolveRegisterDerivedFrom(ep.name, rawRegisterMap, peripheralMap);
    }
  }

  // Propagate enum definitions across peripherals with matching register/field names.
  // Many SVDs (e.g. STM32) define enums only on one peripheral (GPIOA) but not
  // on siblings (GPIOB, GPIOC, ...) even though the fields are structurally identical.
  propagateEnums(peripheralMap);

  // Build indexes
  const addressIndex = new Map<number, { peripheral: string; register: string }>();
  const nameIndex = new Map<string, { peripheral: string; register: string }>();

  for (const [pName, periph] of peripheralMap) {
    for (const [rName, reg] of periph.registers) {
      addressIndex.set(reg.absoluteAddress, { peripheral: pName, register: rName });
      // Index multiple name forms
      nameIndex.set(`${pName}->${rName}`, { peripheral: pName, register: rName });
      nameIndex.set(`${pName}_${rName}`, { peripheral: pName, register: rName });
      nameIndex.set(`${pName}.${rName}`, { peripheral: pName, register: rName });
    }
  }

  return {
    name: svdDevice.name ?? 'Unknown',
    description: cleanText(svdDevice.description ?? ''),
    version: String(svdDevice.version ?? ''),
    addressUnitBits: svdDevice.addressUnitBits ?? 8,
    width: defaultWidth,
    peripherals: peripheralMap,
    addressIndex,
    nameIndex,
  };
}

// ─── Enum Propagation ──────────────────────────────────

/**
 * Propagate enumerated values from fields that have them to structurally
 * identical fields (same register name + field name + bit width) that don't.
 * This handles the common SVD pattern where enums are defined only once
 * (e.g. on GPIOA) but omitted from sibling peripherals (GPIOB, GPIOC, ...).
 */
function propagateEnums(peripheralMap: Map<string, Peripheral>): void {
  // Build a pool: key = "registerName.normalizedFieldName.bitWidth" → enums
  const enumPool = new Map<string, EnumValue[]>();

  // First pass: collect all enum definitions
  for (const [, periph] of peripheralMap) {
    for (const [rName, reg] of periph.registers) {
      for (const f of reg.fields) {
        if (f.enumeratedValues.length > 0) {
          // Normalize field name: strip trailing digits from dim-expanded names
          const normName = f.name.replace(/\d+$/, '#');
          const key = `${rName}.${normName}.${f.bitWidth}`;
          if (!enumPool.has(key)) {
            enumPool.set(key, f.enumeratedValues);
          }
        }
      }
    }
  }

  // Second pass: fill in missing enums
  for (const [, periph] of peripheralMap) {
    for (const [rName, reg] of periph.registers) {
      for (const f of reg.fields) {
        if (f.enumeratedValues.length === 0) {
          const normName = f.name.replace(/\d+$/, '#');
          const key = `${rName}.${normName}.${f.bitWidth}`;
          const pooled: EnumValue[] | undefined = enumPool.get(key);
          if (pooled) {
            f.enumeratedValues = pooled;
          }
        }
      }
    }
  }
}

// ─── Peripheral Parsing ────────────────────────────────

function parsePeripheral(
  svd: SvdPeripheral,
  defaultWidth: number,
  defaultAccess: AccessType,
): Peripheral {
  const baseAddress = parseHexOrDec(svd.baseAddress);
  const registers = new Map<string, Register>();

  const rawRegs = toArray(svd.registers?.register);
  for (const svdReg of rawRegs) {
    const expanded = expandRegisterDim(svdReg);
    for (const er of expanded) {
      const reg = parseRegister(er, baseAddress, defaultWidth, defaultAccess);
      registers.set(reg.name, reg);
    }
  }

  return {
    name: svd.name,
    groupName: svd.groupName,
    description: cleanText(svd.description ?? ''),
    baseAddress,
    registers,
  };
}

function parseDerivedPeripheral(
  svd: SvdPeripheral,
  base: Peripheral,
  defaultWidth: number,
  defaultAccess: AccessType,
): Peripheral {
  const baseAddress = parseHexOrDec(svd.baseAddress);

  // Clone base registers with updated addresses
  const registers = new Map<string, Register>();

  // If the derived peripheral has its own registers, use those
  const ownRegs = toArray(svd.registers?.register);
  if (ownRegs.length > 0) {
    for (const svdReg of ownRegs) {
      const expanded = expandRegisterDim(svdReg);
      for (const er of expanded) {
        const reg = parseRegister(er, baseAddress, defaultWidth, defaultAccess);
        registers.set(reg.name, reg);
      }
    }
  } else {
    // Inherit from base, recalculating absolute addresses
    for (const [name, baseReg] of base.registers) {
      registers.set(name, {
        ...baseReg,
        absoluteAddress: baseAddress + baseReg.addressOffset,
        fields: baseReg.fields.map((f) => ({ ...f })),
      });
    }
  }

  return {
    name: svd.name,
    groupName: svd.groupName ?? base.groupName,
    description: cleanText(svd.description ?? base.description),
    baseAddress,
    registers,
    derivedFrom: base.name,
  };
}

// ─── Register Parsing ──────────────────────────────────

function parseRegister(
  svd: SvdRegister,
  peripheralBaseAddress: number,
  defaultWidth: number,
  defaultAccess: AccessType,
): Register {
  const addressOffset = parseHexOrDec(svd.addressOffset);
  const size = svd.size !== undefined ? parseHexOrDec(svd.size) : defaultWidth;
  const access = parseAccess(svd.access) ?? defaultAccess;
  const resetValue = svd.resetValue !== undefined ? parseHexOrDec(svd.resetValue) : 0;
  const resetMask = svd.resetMask !== undefined ? parseHexOrDec(svd.resetMask) : undefined;

  const rawFields = toArray(svd.fields?.field);
  const expandedFields = rawFields.flatMap((f) => expandFieldDim(f));
  const fields: Field[] = expandedFields.map((f) => parseField(f, access));

  // Sort fields by bit offset ascending
  fields.sort((a, b) => a.bitOffset - b.bitOffset);

  return {
    name: svd.name,
    displayName: svd.displayName,
    description: cleanText(svd.description ?? ''),
    addressOffset,
    absoluteAddress: peripheralBaseAddress + addressOffset,
    size,
    access,
    resetValue,
    resetMask,
    fields,
  };
}

// ─── Field Parsing ─────────────────────────────────────

function parseField(svd: SvdField, registerAccess: AccessType): Field {
  let bitOffset: number;
  let bitWidth: number;

  if (svd.bitRange) {
    // Format: [MSB:LSB]
    const match = svd.bitRange.match(/\[(\d+):(\d+)\]/);
    if (!match) {
      throw new Error(`Invalid bitRange format: ${svd.bitRange}`);
    }
    const msb = parseInt(match[1], 10);
    const lsb = parseInt(match[2], 10);
    bitOffset = lsb;
    bitWidth = msb - lsb + 1;
  } else if (svd.lsb !== undefined && svd.msb !== undefined) {
    bitOffset = svd.lsb;
    bitWidth = svd.msb - svd.lsb + 1;
  } else {
    bitOffset = svd.bitOffset ?? 0;
    bitWidth = svd.bitWidth ?? 1;
  }

  const access = parseAccess(svd.access) ?? registerAccess;
  const enumeratedValues = parseEnumeratedValues(svd.enumeratedValues);
  const bitMask = (bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1)) << bitOffset;
  const maxValue = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;

  return {
    name: svd.name,
    description: cleanText(svd.description ?? ''),
    bitOffset,
    bitWidth,
    access,
    enumeratedValues,
    bitMask: bitMask >>> 0, // ensure unsigned
    maxValue,
    isReserved: /reserved/i.test(svd.name),
  };
}

function parseEnumeratedValues(
  svdEnums: SvdEnumeratedValues | SvdEnumeratedValues[] | undefined,
): EnumValue[] {
  if (!svdEnums) {
    return [];
  }

  // Can be single or array of enum groups; merge all values
  const groups = toArray(svdEnums);
  const result: EnumValue[] = [];

  for (const group of groups) {
    const values = toArray(group.enumeratedValue);
    for (const v of values) {
      // Skip default/catch-all entries without a numeric value
      const numericValue = parseEnumValueSafe(v.value);
      if (numericValue !== null) {
        result.push({
          name: v.name,
          description: cleanText(v.description ?? ''),
          value: numericValue,
        });
      }
    }
  }

  return result;
}

// ─── Dim Expansion ─────────────────────────────────────

function expandPeripheralDim(svd: SvdPeripheral): SvdPeripheral[] {
  if (!svd.dim || !svd.dimIndex) {
    return [svd];
  }

  const indices = parseDimIndex(svd.dimIndex);
  const increment = parseHexOrDec(svd.dimIncrement ?? '0');
  const baseAddr = parseHexOrDec(svd.baseAddress);

  return indices.map((idx, i) => ({
    ...svd,
    name: svd.name.replace('%s', idx),
    baseAddress: '0x' + (baseAddr + i * increment).toString(16),
    dim: undefined,
    dimIncrement: undefined,
    dimIndex: undefined,
  }));
}

function expandRegisterDim(svd: SvdRegister): SvdRegister[] {
  if (!svd.dim || !svd.dimIndex) {
    return [svd];
  }

  const indices = parseDimIndex(svd.dimIndex);
  const increment = parseHexOrDec(svd.dimIncrement ?? '0');
  const baseOffset = parseHexOrDec(svd.addressOffset);

  return indices.map((idx, i) => ({
    ...svd,
    name: svd.name.replace('%s', idx),
    addressOffset: '0x' + (baseOffset + i * increment).toString(16),
    dim: undefined,
    dimIncrement: undefined,
    dimIndex: undefined,
  }));
}

function expandFieldDim(svd: SvdField): SvdField[] {
  if (!svd.dim || !svd.dimIndex) {
    return [svd];
  }

  const indices = parseDimIndex(String(svd.dimIndex));
  const increment = parseHexOrDec(svd.dimIncrement ?? '0');
  const baseBitOffset = svd.bitOffset ?? 0;

  return indices.map((idx, i) => ({
    ...svd,
    name: svd.name.replace('%s', idx),
    bitOffset: baseBitOffset + i * increment,
    dim: undefined,
    dimIncrement: undefined,
    dimIndex: undefined,
  }));
}

function parseDimIndex(dimIndex: string): string[] {
  // Comma-separated: "A,B,C,D"
  if (dimIndex.includes(',')) {
    return dimIndex.split(',').map((s) => s.trim());
  }
  // Range: "0-3"
  const rangeMatch = dimIndex.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const result: string[] = [];
    for (let i = start; i <= end; i++) {
      result.push(i.toString());
    }
    return result;
  }
  return [dimIndex];
}

// ─── Register-level derivedFrom Resolution ─────────────

function resolveRegisterDerivedFrom(
  pName: string,
  rawRegisterMap: Map<string, SvdRegister[]>,
  peripheralMap: Map<string, Peripheral>,
): void {
  const rawRegs = rawRegisterMap.get(pName);
  const periph = peripheralMap.get(pName);
  if (!rawRegs || !periph) return;

  for (const svdReg of rawRegs) {
    const derivedFrom = svdReg['@_derivedFrom'];
    if (!derivedFrom) continue;

    // derivedFrom format: "PeripheralName.RegisterName" or just "RegisterName"
    const parts = derivedFrom.split('.');
    const basePeriphName = parts.length >= 2 ? parts[0] : pName;
    const baseRegName = parts.length >= 2 ? parts[1] : parts[0];
    const basePeriph = peripheralMap.get(basePeriphName);
    if (!basePeriph) continue;

    // Expand both the current register and look up matching base registers
    const expanded = expandRegisterDim(svdReg);
    for (const er of expanded) {
      const existing = periph.registers.get(er.name);
      if (!existing || existing.fields.length > 0) continue;

      // Try exact match first (base register name may also contain %s)
      // Replace %s in base name with same index used in expanded name
      const expandedSuffix = er.name.replace(svdReg.name.replace('%s', ''), '');
      const resolvedBaseName = baseRegName.replace('%s', expandedSuffix);

      const baseReg = basePeriph.registers.get(resolvedBaseName)
        ?? basePeriph.registers.get(baseRegName);

      if (baseReg && baseReg.fields.length > 0) {
        existing.fields = baseReg.fields.map(f => ({ ...f }));
      }
    }
  }
}

// ─── Utilities ─────────────────────────────────────────

function parseHexOrDec(value: string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  const trimmed = value.trim();
  let result: number;
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    result = parseInt(trimmed, 16);
  } else if (trimmed.startsWith('#')) {
    result = parseInt(trimmed.slice(1), 16);
  } else {
    result = parseInt(trimmed, 10);
  }
  if (Number.isNaN(result)) {
    return 0;
  }
  return result;
}

function parseAccess(access: string | undefined): AccessType | undefined {
  if (!access) {
    return undefined;
  }
  return SVD_ACCESS_MAP[access.trim()] ?? undefined;
}

function parseEnumValueSafe(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }
  const trimmed = value.trim();
  // Skip pattern values like "#*" or "default"
  if (!/^[0-9xX#]/.test(trimmed)) {
    return null;
  }
  const num = parseHexOrDec(trimmed);
  return isNaN(num) ? null : num;
}

function cleanText(text: string | number | undefined | null): string {
  if (text === undefined || text === null) {
    return '';
  }
  return String(text).replace(/\s+/g, ' ').trim();
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
