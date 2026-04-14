// Test firmware file for RegHUD visual testing
// Open this file in the Extension Development Host (F5)

#include "stm32f4xx.h"

void gpio_init(void) {
    // Enable GPIOA clock
    RCC->AHB1ENR |= (1 << 0);

    // Configure PA5 as output (LED on Nucleo board)
    GPIOA->MODER &= ~(0x3 << 10);
    GPIOA->MODER |= (0x1 << 10);

    // Set output type to push-pull
    GPIOA->OTYPER &= ~(1 << 5);

    // Set speed to high
    GPIOA->OSPEEDR |= (0x3 << 10);

    // No pull-up/pull-down
    GPIOA->PUPDR &= ~(0x3 << 10);
}

void tim1_init(void) {
    // Enable TIM1 clock
    RCC->APB2ENR |= (1 << 0);

    // Configure TIM1
    TIM1->CR1 = 0x0000;
    TIM1->PSC = 8400 - 1;
    TIM1->ARR = 1000 - 1;

    // Start timer
    TIM1->CR1 |= (1 << 0);
}

void led_toggle(void) {
    GPIOA->ODR ^= (1 << 5);
}

// Address literal example
// *(volatile uint32_t*)0x40020000 = 0x00000000;
