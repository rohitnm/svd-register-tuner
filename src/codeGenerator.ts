import type {
  Register,
  Peripheral,
  Field,
  GeneratedCode,
  CodeStyle,
} from './types';

interface FieldChange {
  field: Field;
  value: number;
}

/**
 * Generates C code from the current field values in 4 styles:
 * - raw: Direct full register write
 * - rmw: Read-modify-write (safe, preserves other bits)
 * - cmsis: CMSIS MODIFY_REG / SET_BIT macros
 * - commented: Read-modify-write with field comments
 */
export function generateCode(
  peripheral: Peripheral,
  register: Register,
  fieldValues: Map<string, number>,
  options: { showComments: boolean } = { showComments: true },
): GeneratedCode {
  const regExpr = `${peripheral.name}->${register.name}`;

  // Compute the full composed value
  let composedValue = 0;
  for (const field of register.fields) {
    const val = fieldValues.get(field.name) ?? 0;
    composedValue |= (val & ((1 << field.bitWidth) - 1)) << field.bitOffset;
  }
  composedValue = composedValue >>> 0; // Ensure unsigned

  // Find fields that differ from reset value
  const changes = getChangedFields(register, fieldValues);

  return {
    raw: generateRaw(regExpr, composedValue, register, options),
    rmw: generateRmw(regExpr, register, changes, options),
    cmsis: generateCmsis(regExpr, peripheral, register, changes, options),
    commented: generateCommented(regExpr, peripheral, register, changes, fieldValues, options),
  };
}

/**
 * Pure function version for testing — accepts plain object instead of Map.
 */
export function generateCodeFromObject(
  peripheral: Peripheral,
  register: Register,
  fieldValues: Record<string, number>,
  options: { showComments: boolean } = { showComments: true },
): GeneratedCode {
  const map = new Map(Object.entries(fieldValues));
  return generateCode(peripheral, register, map, options);
}

/** Style 1: Raw */

function generateRaw(
  regExpr: string,
  composedValue: number,
  register: Register,
  options: { showComments: boolean },
): string {
  const hex = formatHex(composedValue, register.size);
  const lines: string[] = [];
  if (options.showComments) {
    lines.push(`/* Full register write — overwrites all fields */`);
  }
  lines.push(`${regExpr} = ${hex};`);
  return lines.join('\n');
}

/** Style 2: Read-Modify-Write */

function generateRmw(
  regExpr: string,
  register: Register,
  changes: FieldChange[],
  options: { showComments: boolean },
): string {
  if (changes.length === 0) {
    return `/* No fields changed from reset value */`;
  }

  const lines: string[] = [];

  if (options.showComments) {
    lines.push(`/* Read-modify-write: preserves unmodified bits */`);
  }

  lines.push(`uint32_t temp = ${regExpr};`);

  // Group: clear all changed fields, then set
  const clearParts: string[] = [];
  const setParts: string[] = [];

  for (const { field, value } of changes) {
    const mask = formatHex(field.bitMask, register.size);
    clearParts.push(
      options.showComments
        ? `temp &= ~${mask};${pad(40)}/* Clear ${field.name} */`
        : `temp &= ~${mask};`,
    );

    if (value !== 0) {
      const shifted = formatHex((value << field.bitOffset) >>> 0, register.size);
      setParts.push(
        options.showComments
          ? `temp |=  ${shifted};${pad(40)}/* Set ${field.name} = ${formatFieldValue(field, value)} */`
          : `temp |=  ${shifted};`,
      );
    }
  }

  lines.push(...clearParts);
  lines.push(...setParts);
  lines.push(`${regExpr} = temp;`);

  return lines.join('\n');
}

/** Style 3: CMSIS */

function generateCmsis(
  regExpr: string,
  peripheral: Peripheral,
  register: Register,
  changes: FieldChange[],
  options: { showComments: boolean },
): string {
  if (changes.length === 0) {
    return `/* No fields changed from reset value */`;
  }

  const lines: string[] = [];
  if (options.showComments) {
    lines.push(`/* CMSIS-style register modification */`);
  }

  // Build combined mask and value
  let combinedMask = 0;
  let combinedValue = 0;
  const fieldComments: string[] = [];

  for (const { field, value } of changes) {
    combinedMask |= field.bitMask;
    combinedValue |= (value << field.bitOffset) >>> 0;
    fieldComments.push(`${field.name} = ${formatFieldValue(field, value)}`);
  }

  combinedMask = combinedMask >>> 0;
  combinedValue = combinedValue >>> 0;

  const maskStr = formatHex(combinedMask, register.size);
  const valStr = formatHex(combinedValue, register.size);

  if (options.showComments && fieldComments.length > 0) {
    lines.push(`/* ${fieldComments.join(', ')} */`);
  }

  if (combinedValue === 0) {
    // Only clearing bits
    lines.push(`CLEAR_REG(${regExpr}, ${maskStr});`);
  } else if (combinedMask === combinedValue) {
    // Only setting bits (no clear needed)
    lines.push(`SET_BIT(${regExpr}, ${valStr});`);
  } else {
    lines.push(`MODIFY_REG(${regExpr}, ${maskStr}, ${valStr});`);
  }

  return lines.join('\n');
}

/** Style 4: Commented */

function generateCommented(
  regExpr: string,
  peripheral: Peripheral,
  register: Register,
  changes: FieldChange[],
  fieldValues: Map<string, number>,
  options: { showComments: boolean },
): string {
  if (changes.length === 0) {
    return `/* No fields changed from reset value */`;
  }

  const lines: string[] = [];

  // Header comment
  lines.push(`/*`);
  lines.push(` * ${peripheral.name} ${register.name} configuration`);
  lines.push(` * Address: 0x${register.absoluteAddress.toString(16).padStart(8, '0')}`);
  lines.push(` * Reset:   ${formatHex(register.resetValue, register.size)}`);
  lines.push(` *`);

  // Document all non-reserved fields and their values
  const sortedFields = register.fields
    .filter((f) => !f.isReserved)
    .sort((a, b) => b.bitOffset - a.bitOffset);

  for (const field of sortedFields) {
    const val = fieldValues.get(field.name) ?? 0;
    const msb = field.bitOffset + field.bitWidth - 1;
    const bitRange =
      field.bitWidth > 1
        ? `[${msb}:${field.bitOffset}]`
        : `[${field.bitOffset}]`;
    const valStr = formatFieldValue(field, val);
    lines.push(` * ${field.name.padEnd(16)} ${bitRange.padEnd(8)} = ${valStr}`);
  }
  lines.push(` */`);

  // Generate the RMW code
  lines.push(`uint32_t temp = ${regExpr};`);

  for (const { field, value } of changes) {
    const mask = formatHex(field.bitMask, register.size);
    const msb = field.bitOffset + field.bitWidth - 1;
    const bitRange =
      field.bitWidth > 1
        ? `[${msb}:${field.bitOffset}]`
        : `[${field.bitOffset}]`;

    lines.push(`temp &= ~${mask};  /* Clear ${field.name} ${bitRange} */`);
    if (value !== 0) {
      const shifted = formatHex((value << field.bitOffset) >>> 0, register.size);
      lines.push(
        `temp |=  ${shifted};  /* ${field.name} = ${formatFieldValue(field, value)} */`,
      );
    }
  }

  lines.push(`${regExpr} = temp;`);
  return lines.join('\n');
}

/** Helpers */

function getChangedFields(
  register: Register,
  fieldValues: Map<string, number>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of register.fields) {
    if (field.isReserved) {
      continue;
    }
    if (field.access === 'read-only') {
      continue;
    }
    const currentValue = fieldValues.get(field.name) ?? 0;
    const resetFieldValue =
      (register.resetValue >>> field.bitOffset) &
      ((1 << field.bitWidth) - 1);
    if (currentValue !== resetFieldValue) {
      changes.push({ field, value: currentValue });
    }
  }
  // Sort by bit offset descending (MSB first) for readability
  changes.sort((a, b) => b.field.bitOffset - a.field.bitOffset);
  return changes;
}

function formatHex(value: number, registerSize: number): string {
  const digits = registerSize / 4;
  return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function formatFieldValue(field: Field, value: number): string {
  // Check enum
  const enumVal = field.enumeratedValues.find((e) => e.value === value);
  if (enumVal) {
    return `${enumVal.name} (${value})`;
  }
  if (field.bitWidth === 1) {
    return value ? '1' : '0';
  }
  return `0x${value.toString(16).toUpperCase()}`;
}

function pad(targetCol: number): string {
  // Returns spaces to help align comments (approximate)
  return ' '.repeat(Math.max(1, targetCol - 30));
}
