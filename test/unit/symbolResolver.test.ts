import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolResolver } from '../../src/symbolResolver';
import { MetadataProvider } from '../../src/metadataProvider';
import type { RegisterToken } from '../../src/types';

describe('SymbolResolver', () => {
  let resolver: SymbolResolver;
  let metadata: MetadataProvider;

  const svdPath = path.join(__dirname, '..', 'fixtures', 'test-device.svd');
  const tmpDir = path.join(__dirname, '..', '.tmp-resolver-cache');

  beforeAll(async () => {
    // Ensure tmp dir
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    metadata = new MetadataProvider(tmpDir);
    await metadata.loadFromSvd(svdPath);
    resolver = new SymbolResolver(metadata);
  });

  function makeToken(overrides: Partial<RegisterToken>): RegisterToken {
    return {
      raw: '',
      line: 0,
      file: '/test/main.c',
      ...overrides,
    };
  }

  describe('Arrow access resolution', () => {
    it('resolves GPIOA->MODER', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'GPIOA->MODER', peripheral: 'GPIOA', register: 'MODER' }),
      );
      expect(result).not.toBeNull();
      expect('resolved' in result!).toBe(true);
      if ('resolved' in result!) {
        expect(result.resolved.peripheral.name).toBe('GPIOA');
        expect(result.resolved.register.name).toBe('MODER');
      }
    });

    it('resolves RCC->AHB1ENR', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'RCC->AHB1ENR', peripheral: 'RCC', register: 'AHB1ENR' }),
      );
      expect(result).not.toBeNull();
      if (result && 'resolved' in result) {
        expect(result.resolved.peripheral.name).toBe('RCC');
        expect(result.resolved.register.name).toBe('AHB1ENR');
      }
    });

    it('resolves derived peripheral GPIOB->MODER', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'GPIOB->MODER', peripheral: 'GPIOB', register: 'MODER' }),
      );
      expect(result).not.toBeNull();
      if (result && 'resolved' in result) {
        expect(result.resolved.peripheral.name).toBe('GPIOB');
        expect(result.resolved.register.name).toBe('MODER');
      }
    });
  });

  describe('Address resolution', () => {
    it('resolves register by absolute address', () => {
      // GPIOA base is 0x40020000, MODER offset is 0x00
      const result = resolver.resolve(
        makeToken({ raw: '0x40020000', address: 0x40020000 }),
      );
      expect(result).not.toBeNull();
      if (result && 'resolved' in result) {
        expect(result.resolved.peripheral.name).toBe('GPIOA');
        expect(result.resolved.register.name).toBe('MODER');
      }
    });

    it('returns null for unknown address', () => {
      const result = resolver.resolve(
        makeToken({ raw: '0xDEADBEEF', address: 0xDEADBEEF }),
      );
      expect(result).toBeNull();
    });
  });

  describe('Flat macro resolution', () => {
    it('resolves RCC_AHB1ENR as flat macro', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'RCC_AHB1ENR', peripheral: 'RCC', register: 'AHB1ENR' }),
      );
      expect(result).not.toBeNull();
      if (result && 'resolved' in result) {
        expect(result.resolved.peripheral.name).toBe('RCC');
        expect(result.resolved.register.name).toBe('AHB1ENR');
      }
    });
  });

  describe('No match', () => {
    it('returns null for unknown peripheral', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'XYZZY->FOO', peripheral: 'XYZZY', register: 'FOO' }),
      );
      expect(result).toBeNull();
    });

    it('returns null for unknown register', () => {
      const result = resolver.resolve(
        makeToken({
          raw: 'GPIOA->NONEXISTENT',
          peripheral: 'GPIOA',
          register: 'NONEXISTENT',
        }),
      );
      expect(result).toBeNull();
    });

    it('returns null when no model loaded', () => {
      const emptyMeta = new MetadataProvider(tmpDir);
      const emptyResolver = new SymbolResolver(emptyMeta);
      const result = emptyResolver.resolve(
        makeToken({ raw: 'GPIOA->MODER', peripheral: 'GPIOA', register: 'MODER' }),
      );
      expect(result).toBeNull();
    });
  });

  describe('Disambiguation cache', () => {
    it('caches and retrieves a user choice', () => {
      const token = makeToken({
        raw: 'MODER',
        peripheral: 'GPIO',
        register: 'MODER',
        file: '/test/main.c',
      });

      resolver.cacheChoice(token, 'GPIOA', 'MODER');
      const cached = resolver.getCachedChoice(token);
      expect(cached).not.toBeNull();
      expect(cached!.peripheral.name).toBe('GPIOA');
      expect(cached!.register.name).toBe('MODER');
    });

    it('returns null for uncached token', () => {
      const token = makeToken({
        raw: 'UNKNOWN',
        file: '/other/file.c',
      });
      const cached = resolver.getCachedChoice(token);
      expect(cached).toBeNull();
    });
  });

  describe('Dim-expanded peripherals', () => {
    it('resolves TIM2->CR1 (dim-expanded)', () => {
      const result = resolver.resolve(
        makeToken({ raw: 'TIM2->CR1', peripheral: 'TIM2', register: 'CR1' }),
      );
      expect(result).not.toBeNull();
      if (result && 'resolved' in result) {
        expect(result.resolved.peripheral.name).toBe('TIM2');
        expect(result.resolved.register.name).toBe('CR1');
      }
    });
  });
});
