# SVD Register Tuner

**Interactive register bit-field viewer and C code generator for embedded development.**

SVD Register Tuner parses your device's SVD file and gives you an interactive bit-field HUD right in the VS Code sidebar click bits, pick enum values, and copy ready-to-use C code. This saves time instead of stop referencing SVD file everytime during development.

## Getting Started

1. Install the extension
2. Open a C/C++ embedded project with an SVD file in the workspace
3. The extension auto-detects your SVD File from the workspace.
4. Place your cursor on a register expression — the sidebar HUD loads it automatically.

## Release v0.1.0

- Cursor Driven Register Detection to open the selected register from the code.
- Interactive Bit-Field Grid to toggle the bits of the register.
- Field Editor for the Register Bits.
- C Code Generator.
- Register Browser to browse registers from the SVD.
- Auto-Detection of the svd file from Workspace.

### Cursor-Driven Register Detection

Move your cursor to any register expression in C/C++ code and the HUD automatically resolves it:

- `GPIOA->MODER`, `RCC->AHB1ENR`, `TIM2->CR1`
- `GPIOA_MODER`, `RCC_AHB1ENR` (underscore style)
- Direct address literals (`*(volatile uint32_t*)0x40020000`)

### Interactive Bit-Field Grid

- Visual 32-bit (or 16/8-bit) grid color-coded by field
- Click any bit to toggle it
- Multi-bit fields supported with XOR toggle
- Read-only fields clearly marked

### Field Editor

- **Checkbox** for single-bit fields
- **Dropdown** for fields with enumerated values (e.g. Input/Output/Alternate/Analog)
- **Number input** for multi-bit fields without enums
- Enum propagation across peripheral siblings (GPIOB gets GPIOA's enums automatically)

### C Code Generator

Four code styles, one click to copy or insert at cursor:

- **Read-Modify-Write** — safe, preserves other bits
- **Raw Write** — direct full register write
- **CMSIS Macros** — `MODIFY_REG` / `SET_BIT` / `CLEAR_BIT`
- **Commented** — RMW with full field documentation

### Register Browser

Browse all peripherals and registers from the sidebar idle state. Search/filter by name. Click any register to view its bit-fields.

## Requirements

- VS Code 1.85.0 or later
- An SVD file for your target microcontroller (CMSIS-SVD format)

## License

MIT
