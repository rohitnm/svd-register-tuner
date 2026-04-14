/** Regex patterns for detecting register expressions in C/C++ code */
export const PATTERNS = {
  /** Matches `PERIPHx->REG` e.g. GPIOA->MODER, RCC->AHB1ENR */
  arrowAccess: /(\b[A-Z][A-Z0-9]+\b)\s*->\s*(\b[A-Z][A-Z0-9_]+\b)/,

  /** Matches flat macro names e.g. RCC_AHB1ENR, GPIO_MODER */
  flatMacro: /\b([A-Z][A-Z0-9]+)_([A-Z][A-Z0-9_]+)\b/,

  /** Matches 32-bit hex address literals e.g. 0x40020000 */
  addressLiteral: /\b0x([0-9A-Fa-f]{8})\b/,
} as const;

/** Default debounce delay for cursor tracking (ms) */
export const DEFAULT_DEBOUNCE_MS = 250;

/** Cache schema version — bump when serialization format changes */
export const CACHE_SCHEMA_VERSION = 4;

/** SVD access type string mapping */
export const SVD_ACCESS_MAP: Record<string, import('./types').AccessType> = {
  'read-only': 'read-only',
  'write-only': 'write-only',
  'read-write': 'read-write',
  'writeOnce': 'writeOnce',
  'read-writeOnce': 'read-writeOnce',
};
