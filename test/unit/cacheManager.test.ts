import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CacheManager } from '../../src/cacheManager';
import { parseSvdXml } from '../../src/svdParser';
import type { DeviceModel } from '../../src/types';

const SVD_PATH = path.join(__dirname, '..', 'fixtures', 'test-device.svd');

describe('CacheManager', () => {
  let tmpDir: string;
  let cache: CacheManager;
  let model: DeviceModel;
  let svdHash: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reghud-test-'));
    cache = new CacheManager(tmpDir, 10);

    const xml = fs.readFileSync(SVD_PATH, 'utf-8');
    model = parseSvdXml(xml);
    svdHash = cache.computeFileHash(SVD_PATH);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for cache miss', () => {
    const result = cache.load('NonExistent', 'abc');
    expect(result).toBeNull();
  });

  it('saves and loads a device model', () => {
    cache.save('TestMCU', svdHash, model);
    const loaded = cache.load('TestMCU', svdHash);

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('TestMCU');
    expect(loaded!.peripherals.size).toBe(model.peripherals.size);
  });

  it('round-trips register data correctly', () => {
    cache.save('TestMCU', svdHash, model);
    const loaded = cache.load('TestMCU', svdHash)!;

    const moder = loaded.peripherals.get('GPIOA')!.registers.get('MODER')!;
    expect(moder.absoluteAddress).toBe(0x40020000);
    expect(moder.resetValue).toBe(0xa8000000);
    expect(moder.fields.length).toBeGreaterThan(0);
  });

  it('round-trips enum values', () => {
    cache.save('TestMCU', svdHash, model);
    const loaded = cache.load('TestMCU', svdHash)!;

    const moder = loaded.peripherals.get('GPIOA')!.registers.get('MODER')!;
    const moder0 = moder.fields.find((f) => f.name === 'MODER0')!;
    expect(moder0.enumeratedValues).toHaveLength(4);
    expect(moder0.enumeratedValues[0].name).toBe('Input');
  });

  it('rebuilds indexes on load', () => {
    cache.save('TestMCU', svdHash, model);
    const loaded = cache.load('TestMCU', svdHash)!;

    expect(loaded.addressIndex.get(0x40020000)).toEqual({
      peripheral: 'GPIOA',
      register: 'MODER',
    });
    expect(loaded.nameIndex.get('GPIOA->MODER')).toEqual({
      peripheral: 'GPIOA',
      register: 'MODER',
    });
  });

  it('returns null if hash does not match', () => {
    cache.save('TestMCU', svdHash, model);
    const loaded = cache.load('TestMCU', 'wrong-hash');
    expect(loaded).toBeNull();
  });

  it('invalidates cache', () => {
    cache.save('TestMCU', svdHash, model);
    cache.invalidate('TestMCU');
    const loaded = cache.load('TestMCU', svdHash);
    expect(loaded).toBeNull();
  });

  it('computes consistent file hash', () => {
    const hash1 = cache.computeFileHash(SVD_PATH);
    const hash2 = cache.computeFileHash(SVD_PATH);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sanitizes device name for filesystem', () => {
    // Should not throw even with special characters
    cache.save('STM32F4/VG<test>', svdHash, model);
    const loaded = cache.load('STM32F4/VG<test>', svdHash);
    expect(loaded).not.toBeNull();
  });
});
