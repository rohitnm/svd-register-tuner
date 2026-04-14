import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSvdXml } from '../../src/svdParser';
import type { DeviceModel } from '../../src/types';

const SVD_PATH = path.join(__dirname, '..', 'fixtures', 'test-device.svd');

describe('SVD Parser', () => {
  let model: DeviceModel;

  beforeAll(() => {
    const xml = fs.readFileSync(SVD_PATH, 'utf-8');
    model = parseSvdXml(xml);
  });

  // ─── Device-level ──────────────────────────────────

  describe('Device metadata', () => {
    it('parses device name', () => {
      expect(model.name).toBe('TestMCU');
    });

    it('parses description', () => {
      expect(model.description).toBe('Test MCU for unit tests');
    });

    it('parses version', () => {
      expect(model.version).toBe('1.0');
    });

    it('parses addressUnitBits', () => {
      expect(model.addressUnitBits).toBe(8);
    });

    it('parses default width', () => {
      expect(model.width).toBe(32);
    });
  });

  // ─── Peripheral parsing ────────────────────────────

  describe('Peripheral parsing', () => {
    it('parses base peripheral (GPIOA)', () => {
      const gpioa = model.peripherals.get('GPIOA');
      expect(gpioa).toBeDefined();
      expect(gpioa!.name).toBe('GPIOA');
      expect(gpioa!.groupName).toBe('GPIO');
      expect(gpioa!.baseAddress).toBe(0x40020000);
    });

    it('parses standalone peripheral (RCC)', () => {
      const rcc = model.peripherals.get('RCC');
      expect(rcc).toBeDefined();
      expect(rcc!.baseAddress).toBe(0x40023800);
    });

    it('counts all peripherals including derived and expanded', () => {
      // GPIOA, GPIOB (derived), RCC, TIM1, TIM2 (dim-expanded)
      expect(model.peripherals.size).toBe(5);
    });
  });

  // ─── DerivedFrom ───────────────────────────────────

  describe('derivedFrom', () => {
    it('creates GPIOB with inherited registers', () => {
      const gpiob = model.peripherals.get('GPIOB');
      expect(gpiob).toBeDefined();
      expect(gpiob!.baseAddress).toBe(0x40020400);
      expect(gpiob!.derivedFrom).toBe('GPIOA');
    });

    it('GPIOB has same register names as GPIOA', () => {
      const gpioa = model.peripherals.get('GPIOA')!;
      const gpiob = model.peripherals.get('GPIOB')!;

      const aNames = [...gpioa.registers.keys()].sort();
      const bNames = [...gpiob.registers.keys()].sort();
      expect(bNames).toEqual(aNames);
    });

    it('GPIOB registers have different absolute addresses', () => {
      const gpiobModer = model.peripherals.get('GPIOB')!.registers.get('MODER')!;
      expect(gpiobModer.absoluteAddress).toBe(0x40020400); // base + 0x00
    });

    it('GPIOB fields are independent copies', () => {
      const gpioa = model.peripherals.get('GPIOA')!;
      const gpiob = model.peripherals.get('GPIOB')!;
      const aFields = gpioa.registers.get('MODER')!.fields;
      const bFields = gpiob.registers.get('MODER')!.fields;
      // Same values but different objects
      expect(bFields).not.toBe(aFields);
      expect(bFields[0].name).toBe(aFields[0].name);
    });
  });

  // ─── Dim expansion ─────────────────────────────────

  describe('Dim expansion', () => {
    it('expands peripheral dim into TIM1 and TIM2', () => {
      expect(model.peripherals.has('TIM1')).toBe(true);
      expect(model.peripherals.has('TIM2')).toBe(true);
    });

    it('TIM1 has correct base address', () => {
      expect(model.peripherals.get('TIM1')!.baseAddress).toBe(0x40000000);
    });

    it('TIM2 has incremented base address', () => {
      expect(model.peripherals.get('TIM2')!.baseAddress).toBe(0x40000400);
    });

    it('expands register dim into CCR1 and CCR2', () => {
      const tim1 = model.peripherals.get('TIM1')!;
      expect(tim1.registers.has('CCR1')).toBe(true);
      expect(tim1.registers.has('CCR2')).toBe(true);
    });

    it('CCR registers have correct offset increments', () => {
      const tim1 = model.peripherals.get('TIM1')!;
      expect(tim1.registers.get('CCR1')!.addressOffset).toBe(0x34);
      expect(tim1.registers.get('CCR2')!.addressOffset).toBe(0x38);
    });
  });

  // ─── Register parsing ──────────────────────────────

  describe('Register parsing', () => {
    it('parses MODER register properties', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      expect(moder.name).toBe('MODER');
      expect(moder.displayName).toBe('GPIOA_MODER');
      expect(moder.addressOffset).toBe(0x00);
      expect(moder.absoluteAddress).toBe(0x40020000);
      expect(moder.size).toBe(32);
      expect(moder.access).toBe('read-write');
      expect(moder.resetValue).toBe(0xa8000000);
    });

    it('parses read-only register access', () => {
      const idr = model.peripherals.get('GPIOA')!.registers.get('IDR')!;
      expect(idr.access).toBe('read-only');
    });

    it('computes absolute address correctly', () => {
      const ahb1enr = model.peripherals.get('RCC')!.registers.get('AHB1ENR')!;
      expect(ahb1enr.absoluteAddress).toBe(0x40023800 + 0x30);
    });
  });

  // ─── Field parsing ─────────────────────────────────

  describe('Field parsing', () => {
    it('parses bitOffset and bitWidth', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      expect(moder0.bitOffset).toBe(0);
      expect(moder0.bitWidth).toBe(2);
    });

    it('computes bitMask correctly', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      expect(moder0.bitMask).toBe(0x3); // bits [1:0]

      const moder1 = moder.fields.find((f) => f.name === 'MODER1')!;
      expect(moder1.bitMask).toBe(0xc); // bits [3:2]
    });

    it('computes maxValue correctly', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      expect(moder0.maxValue).toBe(3); // 2-bit field
    });

    it('detects reserved fields', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const reserved = moder.fields.find((f) => f.name === 'RESERVED')!;
      expect(reserved.isReserved).toBe(true);
    });

    it('non-reserved fields are not marked reserved', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      expect(moder0.isReserved).toBe(false);
    });

    it('parses bitRange format [MSB:LSB]', () => {
      const idr = model.peripherals.get('GPIOA')!.registers.get('IDR')!;
      const idr0 = idr.fields.find((f) => f.name === 'IDR0')!;
      expect(idr0.bitOffset).toBe(0);
      expect(idr0.bitWidth).toBe(1);
    });

    it('parses lsb/msb format', () => {
      const idr = model.peripherals.get('GPIOA')!.registers.get('IDR')!;
      const idr1 = idr.fields.find((f) => f.name === 'IDR1')!;
      expect(idr1.bitOffset).toBe(1);
      expect(idr1.bitWidth).toBe(1);
    });

    it('sorts fields by bitOffset ascending', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      for (let i = 1; i < moder.fields.length; i++) {
        expect(moder.fields[i].bitOffset).toBeGreaterThanOrEqual(moder.fields[i - 1].bitOffset);
      }
    });

    it('parses 1-bit field correctly', () => {
      const odr = model.peripherals.get('GPIOA')!.registers.get('ODR')!;
      const odr0 = odr.fields.find((f) => f.name === 'ODR0')!;
      expect(odr0.bitWidth).toBe(1);
      expect(odr0.maxValue).toBe(1);
      expect(odr0.bitMask).toBe(1);
    });

    it('parses wide field (16-bit CCR)', () => {
      const tim1 = model.peripherals.get('TIM1')!;
      const ccr1 = tim1.registers.get('CCR1')!;
      const ccrField = ccr1.fields.find((f) => f.name === 'CCR')!;
      expect(ccrField.bitWidth).toBe(16);
      expect(ccrField.maxValue).toBe(65535);
    });
  });

  // ─── Enumerated values ─────────────────────────────

  describe('Enumerated values', () => {
    it('parses enum values for MODER0', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      expect(moder0.enumeratedValues).toHaveLength(4);
    });

    it('enum values have correct names and numeric values', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;

      const input = moder0.enumeratedValues.find((e) => e.name === 'Input')!;
      expect(input.value).toBe(0);

      const output = moder0.enumeratedValues.find((e) => e.name === 'Output')!;
      expect(output.value).toBe(1);

      const alternate = moder0.enumeratedValues.find((e) => e.name === 'Alternate')!;
      expect(alternate.value).toBe(2);

      const analog = moder0.enumeratedValues.find((e) => e.name === 'Analog')!;
      expect(analog.value).toBe(3);
    });

    it('enum descriptions are parsed', () => {
      const moder = model.peripherals.get('GPIOA')!.registers.get('MODER')!;
      const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
      const output = moder0.enumeratedValues.find((e) => e.name === 'Output')!;
      expect(output.description).toBe('General purpose output mode');
    });

    it('fields without enums have empty array', () => {
      const odr = model.peripherals.get('GPIOA')!.registers.get('ODR')!;
      const odr0 = odr.fields.find((f) => f.name === 'ODR0')!;
      expect(odr0.enumeratedValues).toEqual([]);
    });

    it('parses RCC enum values (decimal format)', () => {
      const ahb1enr = model.peripherals.get('RCC')!.registers.get('AHB1ENR')!;
      const gpioaen = ahb1enr.fields.find((f) => f.name === 'GPIOAEN')!;
      expect(gpioaen.enumeratedValues).toHaveLength(2);

      const disabled = gpioaen.enumeratedValues.find((e) => e.name === 'Disabled')!;
      expect(disabled.value).toBe(0);

      const enabled = gpioaen.enumeratedValues.find((e) => e.name === 'Enabled')!;
      expect(enabled.value).toBe(1);
    });
  });

  // ─── Indexes ───────────────────────────────────────

  describe('Indexes', () => {
    it('address index maps to correct register', () => {
      const result = model.addressIndex.get(0x40020000);
      expect(result).toEqual({ peripheral: 'GPIOA', register: 'MODER' });
    });

    it('address index works for derived peripheral', () => {
      const result = model.addressIndex.get(0x40020400);
      expect(result).toEqual({ peripheral: 'GPIOB', register: 'MODER' });
    });

    it('address index works for RCC register', () => {
      const result = model.addressIndex.get(0x40023830);
      expect(result).toEqual({ peripheral: 'RCC', register: 'AHB1ENR' });
    });

    it('name index resolves arrow notation', () => {
      const result = model.nameIndex.get('GPIOA->MODER');
      expect(result).toEqual({ peripheral: 'GPIOA', register: 'MODER' });
    });

    it('name index resolves underscore notation', () => {
      const result = model.nameIndex.get('GPIOA_MODER');
      expect(result).toEqual({ peripheral: 'GPIOA', register: 'MODER' });
    });

    it('name index resolves dot notation', () => {
      const result = model.nameIndex.get('RCC.AHB1ENR');
      expect(result).toEqual({ peripheral: 'RCC', register: 'AHB1ENR' });
    });

    it('name index includes dim-expanded registers', () => {
      const result = model.nameIndex.get('TIM1->CR1');
      expect(result).toEqual({ peripheral: 'TIM1', register: 'CR1' });
    });
  });

  // ─── Error handling ────────────────────────────────

  describe('Error handling', () => {
    it('throws on empty input', () => {
      expect(() => parseSvdXml('')).toThrow();
    });

    it('throws on missing device element', () => {
      expect(() => parseSvdXml('<root><notDevice/></root>')).toThrow(
        'Invalid SVD file: missing <device> root element',
      );
    });

    it('throws on unresolvable derivedFrom', () => {
      const xml = `
        <device>
          <name>Bad</name>
          <peripherals>
            <peripheral derivedFrom="NonExistent">
              <name>BROKEN</name>
              <baseAddress>0x0</baseAddress>
            </peripheral>
          </peripherals>
        </device>
      `;
      expect(() => parseSvdXml(xml)).toThrow('derivedFrom "NonExistent" which was not found');
    });
  });
});
