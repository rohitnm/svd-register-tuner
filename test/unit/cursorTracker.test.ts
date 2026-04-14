import { describe, it, expect } from 'vitest';
import { extractTokenFromLine } from '../../src/tokenExtractor';

describe('CursorTracker — extractTokenFromLine', () => {
  const file = '/test/main.c';

  describe('Arrow access (PERIPH->REG)', () => {
    it('extracts GPIOA->MODER', () => {
      const token = extractTokenFromLine('  GPIOA->MODER = 0x00;', 10, file);
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('GPIOA');
      expect(token!.register).toBe('MODER');
      expect(token!.raw).toBe('GPIOA->MODER');
      expect(token!.line).toBe(10);
      expect(token!.file).toBe(file);
    });

    it('extracts RCC->AHB1ENR', () => {
      const token = extractTokenFromLine('  RCC->AHB1ENR |= (1 << 0);', 5, file);
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('RCC');
      expect(token!.register).toBe('AHB1ENR');
    });

    it('handles spaces around arrow', () => {
      const token = extractTokenFromLine('  TIM1 -> CCR1 = 100;', 0, file);
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('TIM1');
      expect(token!.register).toBe('CCR1');
    });

    it('extracts from complex expressions', () => {
      const token = extractTokenFromLine(
        '  if (USART1->SR & USART_SR_RXNE) {',
        22,
        file,
      );
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('USART1');
      expect(token!.register).toBe('SR');
    });

    it('extracts from assignment with OR', () => {
      const token = extractTokenFromLine(
        '  GPIOB->ODR |= GPIO_ODR_OD5;',
        15,
        file,
      );
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('GPIOB');
      expect(token!.register).toBe('ODR');
    });
  });

  describe('Address literals', () => {
    it('extracts 32-bit hex address', () => {
      const token = extractTokenFromLine(
        '  *(volatile uint32_t*)0x40020000 = val;',
        3,
        file,
      );
      expect(token).not.toBeNull();
      expect(token!.address).toBe(0x40020000);
      expect(token!.raw).toBe('0x40020000');
      expect(token!.peripheral).toBeUndefined();
    });

    it('extracts address in define', () => {
      const token = extractTokenFromLine(
        '#define GPIOA_BASE 0x40020000',
        1,
        file,
      );
      expect(token).not.toBeNull();
      expect(token!.address).toBe(0x40020000);
    });
  });

  describe('Flat macro patterns', () => {
    it('extracts RCC_AHB1ENR', () => {
      const token = extractTokenFromLine(
        '  RCC_AHB1ENR |= RCC_AHB1ENR_GPIOAEN;',
        7,
        file,
      );
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('RCC');
      expect(token!.register).toBe('AHB1ENR');
    });

    it('extracts GPIO_MODER', () => {
      const token = extractTokenFromLine('  val = GPIO_MODER;', 2, file);
      expect(token).not.toBeNull();
      expect(token!.peripheral).toBe('GPIO');
      expect(token!.register).toBe('MODER');
    });
  });

  describe('No match', () => {
    it('returns null for plain comment', () => {
      const token = extractTokenFromLine('  // configure the clock', 0, file);
      expect(token).toBeNull();
    });

    it('returns null for empty line', () => {
      const token = extractTokenFromLine('', 0, file);
      expect(token).toBeNull();
    });

    it('returns null for lowercase identifiers', () => {
      const token = extractTokenFromLine('  int counter = 0;', 0, file);
      expect(token).toBeNull();
    });

    it('returns null for single uppercase word', () => {
      const token = extractTokenFromLine('  return TIMEOUT;', 0, file);
      expect(token).toBeNull();
    });
  });
});
