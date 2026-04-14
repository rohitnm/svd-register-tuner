// ─── Access Type ────────────────────────────────────────

export type AccessType =
  | 'read-only'
  | 'write-only'
  | 'read-write'
  | 'writeOnce'
  | 'read-writeOnce';

// ─── Enumerated Value ──────────────────────────────────

export interface EnumValue {
  name: string;
  description: string;
  value: number;
}

// ─── Field ─────────────────────────────────────────────

export interface Field {
  name: string;
  description: string;
  bitOffset: number;
  bitWidth: number;
  access?: AccessType;
  enumeratedValues: EnumValue[];

  // Derived (computed after parsing)
  bitMask: number;
  maxValue: number;
  isReserved: boolean;
}

// ─── Register ──────────────────────────────────────────

export interface Register {
  name: string;
  displayName?: string;
  description: string;
  addressOffset: number;
  absoluteAddress: number;
  size: number;
  access: AccessType;
  resetValue: number;
  resetMask?: number;
  fields: Field[];
}

// ─── Peripheral ────────────────────────────────────────

export interface Peripheral {
  name: string;
  groupName?: string;
  description: string;
  baseAddress: number;
  registers: Map<string, Register>;
  derivedFrom?: string;
}

// ─── Device Model ──────────────────────────────────────

export interface DeviceModel {
  name: string;
  description: string;
  version: string;
  addressUnitBits: number;
  width: number;
  peripherals: Map<string, Peripheral>;

  // Derived indexes
  addressIndex: Map<number, { peripheral: string; register: string }>;
  nameIndex: Map<string, { peripheral: string; register: string }>;
}

// ─── Code Generation ───────────────────────────────────

export type CodeStyle = 'raw' | 'rmw' | 'cmsis' | 'commented';

export interface GeneratedCode {
  raw: string;
  rmw: string;
  cmsis: string;
  commented: string;
}

// ─── View Models (Extension → Webview) ─────────────────

export interface FieldViewModel {
  name: string;
  description: string;
  bitOffset: number;
  bitWidth: number;
  access: AccessType;
  isReserved: boolean;
  value: number;
  maxValue: number;
  enumeratedValues: EnumValue[];
  hasEnum: boolean;
}

export interface RegisterViewModel {
  peripheralName: string;
  registerName: string;
  fullName: string;
  description: string;
  absoluteAddress: string;
  size: number;
  access: AccessType;
  resetValue: string;
  fields: FieldViewModel[];
  currentValue: string;
  generatedCode: GeneratedCode;
}

// ─── HUD State ─────────────────────────────────────────

export type HudState =
  | 'idle'
  | 'loading'
  | 'resolved'
  | 'ambiguous'
  | 'unsupported'
  | 'pinned';

// ─── Webview Message Protocol ──────────────────────────

export interface CandidateOption {
  peripheral: string;
  register: string;
  label: string;
}

export interface PeripheralSummary {
  name: string;
  description: string;
  baseAddress: number;
  registers: RegisterSummary[];
}

export interface RegisterSummary {
  name: string;
  description: string;
  addressOffset: number;
  absoluteAddress: number;
}

export type ExtensionMessage =
  | { type: 'update'; register: RegisterViewModel }
  | { type: 'state'; state: HudState }
  | { type: 'candidates'; options: CandidateOption[] }
  | { type: 'decode-result'; fields: FieldViewModel[]; hex: string }
  | { type: 'error'; message: string }
  | { type: 'peripheral-list'; peripherals: PeripheralSummary[] };

export type WebviewMessage =
  | { type: 'field-changed'; fieldName: string; value: number }
  | { type: 'copy-code'; style: CodeStyle }
  | { type: 'insert-code'; style: CodeStyle }
  | { type: 'pin-toggle' }
  | { type: 'decode-value'; hex: string }
  | { type: 'select-candidate'; peripheral: string; register: string }
  | { type: 'browse-registers' }
  | { type: 'reset-fields' }
  | { type: 'webview-ready' };

// ─── Cursor Tracker ────────────────────────────────────

export interface RegisterToken {
  raw: string;
  peripheral?: string;
  register?: string;
  address?: number;
  line: number;
  file: string;
}

// ─── Target Detection ──────────────────────────────────

export interface DeviceIdentifier {
  family: string;
  device: string;
  svdPath: string;
}

// ─── Cache ─────────────────────────────────────────────

export interface CachedDevice {
  version: number;
  svdHash: string;
  parsedAt: string;
  model: SerializedDeviceModel;
}

/** JSON-safe version of DeviceModel (Maps → plain objects) */
export interface SerializedDeviceModel {
  name: string;
  description: string;
  version: string;
  addressUnitBits: number;
  width: number;
  peripherals: Record<string, SerializedPeripheral>;
}

export interface SerializedPeripheral {
  name: string;
  groupName?: string;
  description: string;
  baseAddress: number;
  registers: Record<string, Register>;
  derivedFrom?: string;
}
