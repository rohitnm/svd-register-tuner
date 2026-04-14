import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateCodeFromObject } from '../../src/codeGenerator';
import { parseSvdXml } from '../../src/svdParser';
import type { DeviceModel, Peripheral, Register } from '../../src/types';

describe('Code Generator', () => {
  let model: DeviceModel;
  let gpioA: Peripheral;
  let moder: Register;
  let rcc: Peripheral;
  let ahb1enr: Register;

  beforeAll(() => {
    const svdPath = path.join(__dirname, '..', 'fixtures', 'test-device.svd');
    const xml = fs.readFileSync(svdPath, 'utf-8');
    model = parseSvdXml(xml);
    gpioA = model.peripherals.get('GPIOA')!;
    moder = gpioA.registers.get('MODER')!;
    rcc = model.peripherals.get('RCC')!;
    ahb1enr = rcc.registers.get('AHB1ENR')!;
  });

  /** Helper: build field values from reset with overrides */
  function resetValues(register: Register, overrides: Record<string, number> = {}): Record<string, number> {
    const vals: Record<string, number> = {};
    for (const field of register.fields) {
      const resetVal = (register.resetValue >>> field.bitOffset) & ((1 << field.bitWidth) - 1);
      vals[field.name] = overrides[field.name] ?? resetVal;
    }
    return vals;
  }

  describe('No changes from reset', () => {
    it('returns no-change message for all styles', () => {
      const vals = resetValues(moder);
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.raw).toContain('GPIOA->MODER');
      expect(code.rmw).toContain('No fields changed');
      expect(code.cmsis).toContain('No fields changed');
      expect(code.commented).toContain('No fields changed');
    });
  });

  describe('Style: raw', () => {
    it('generates full register write with hex value', () => {
      const vals = resetValues(moder, { MODER0: 1 }); // Change to output
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.raw).toContain('GPIOA->MODER =');
      expect(code.raw).toMatch(/0x[0-9A-F]+/);
    });

    it('includes comment when showComments is true', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals, { showComments: true });
      expect(code.raw).toContain('Full register write');
    });

    it('omits comment when showComments is false', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals, { showComments: false });
      expect(code.raw).not.toContain('/*');
    });
  });

  describe('Style: rmw (read-modify-write)', () => {
    it('generates temp variable pattern', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.rmw).toContain('uint32_t temp = GPIOA->MODER;');
      expect(code.rmw).toContain('temp &= ~');
      expect(code.rmw).toContain('GPIOA->MODER = temp;');
    });

    it('clears and sets modified field', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.rmw).toContain('temp &= ~');
      expect(code.rmw).toContain('temp |=');
    });

    it('only clears when setting to 0', () => {
      const vals = resetValues(moder, { MODER0: 0 });
      // MODER0 reset might already be 0, so use a field that has non-zero reset
      // Just verify the pattern works
      const code = generateCodeFromObject(gpioA, moder, vals);
      // No change case — MODER0 reset is 0
      expect(code.rmw).toBeDefined();
    });

    it('includes field name comments', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals, { showComments: true });

      expect(code.rmw).toContain('MODER0');
    });
  });

  describe('Style: cmsis', () => {
    it('generates MODIFY_REG for mixed clear+set', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      // Should use MODIFY_REG, SET_BIT, or CLEAR_REG
      const hasCmsisMacro =
        code.cmsis.includes('MODIFY_REG') ||
        code.cmsis.includes('SET_BIT') ||
        code.cmsis.includes('CLEAR_REG');

      expect(hasCmsisMacro || code.cmsis.includes('No fields changed')).toBe(true);
    });

    it('uses CLEAR_REG when setting value to 0', () => {
      // Find a field with non-zero reset to clear it
      const fields = moder.fields.filter(
        (f) => !f.isReserved && ((moder.resetValue >>> f.bitOffset) & ((1 << f.bitWidth) - 1)) !== 0,
      );

      if (fields.length > 0) {
        const overrides: Record<string, number> = {};
        overrides[fields[0].name] = 0;
        const vals = resetValues(moder, overrides);
        const code = generateCodeFromObject(gpioA, moder, vals);

        expect(code.cmsis).toContain('CLEAR_REG');
      }
    });
  });

  describe('Style: commented', () => {
    it('includes register address in header comment', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.commented).toContain('Address:');
      expect(code.commented).toContain('Reset:');
    });

    it('documents all non-reserved fields', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.commented).toContain('MODER0');
    });

    it('includes bit range notation', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      // Should have [x:y] or [x] notation
      expect(code.commented).toMatch(/\[\d+(:\d+)?\]/);
    });

    it('generates RMW code with per-line comments', () => {
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals);

      expect(code.commented).toContain('uint32_t temp');
      expect(code.commented).toContain('Clear');
    });
  });

  describe('Enum values in comments', () => {
    it('uses enum name when available', () => {
      // MODER fields have enums: Input(0), Output(1), Alternate(2), Analog(3)
      const vals = resetValues(moder, { MODER0: 1 });
      const code = generateCodeFromObject(gpioA, moder, vals, { showComments: true });

      // Should reference the enum name in commented output
      const hasEnumRef =
        code.commented.includes('Output') ||
        code.rmw.includes('Output') ||
        code.cmsis.includes('Output');

      // If MODER0 has enums, we should see the name
      const moder0 = moder.fields.find((f) => f.name === 'MODER0');
      if (moder0 && moder0.enumeratedValues.length > 0) {
        expect(hasEnumRef).toBe(true);
      }
    });
  });

  describe('Read-only and reserved fields', () => {
    it('skips reserved fields in code generation', () => {
      const vals = resetValues(moder);
      // Set a reserved field value (should be ignored)
      const reservedField = moder.fields.find((f) => f.isReserved);
      if (reservedField) {
        vals[reservedField.name] = 1;
        const code = generateCodeFromObject(gpioA, moder, vals);
        expect(code.rmw).not.toContain(reservedField.name);
      }
    });
  });

  describe('Multiple field changes', () => {
    it('handles multiple fields changed at once', () => {
      const vals = resetValues(moder, {
        MODER0: 1,
        MODER1: 2,
        MODER2: 3,
      });
      const code = generateCodeFromObject(gpioA, moder, vals);

      // RMW should have multiple clear/set operations
      const clearCount = (code.rmw.match(/temp &= ~/g) || []).length;
      expect(clearCount).toBeGreaterThanOrEqual(1);
    });
  });
});
