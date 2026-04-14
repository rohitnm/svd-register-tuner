import type { RegisterToken } from './types';
import { PATTERNS } from './constants';

/**
 * Pure function: extract a RegisterToken from a line of text.
 * Tries patterns in priority order: arrow access, address literal, flat macro.
 *
 * Separated from CursorTracker class so it can be unit-tested without VS Code API.
 */
export function extractTokenFromLine(
  line: string,
  lineNumber: number,
  file: string,
): RegisterToken | null {
  // 1. Arrow access: GPIOA->MODER
  const arrowMatch = PATTERNS.arrowAccess.exec(line);
  if (arrowMatch) {
    return {
      raw: arrowMatch[0],
      peripheral: arrowMatch[1],
      register: arrowMatch[2],
      line: lineNumber,
      file,
    };
  }

  // 2. Address literal: 0x40020000 (check before flat macro to avoid false matches)
  const addrMatch = PATTERNS.addressLiteral.exec(line);
  if (addrMatch) {
    return {
      raw: addrMatch[0],
      address: parseInt(addrMatch[1], 16),
      line: lineNumber,
      file,
    };
  }

  // 3. Flat macro: RCC_AHB1ENR
  const flatMatch = PATTERNS.flatMacro.exec(line);
  if (flatMatch) {
    return {
      raw: flatMatch[0],
      peripheral: flatMatch[1],
      register: flatMatch[2],
      line: lineNumber,
      file,
    };
  }

  return null;
}
