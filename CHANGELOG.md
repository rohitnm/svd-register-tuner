# Changelog

## [0.1.0] — 04-11-2026

### Added
- **SVD Parser** — Full CMSIS-SVD parsing with `derivedFrom` at peripheral, register, and field levels; `dim` expansion at all levels; enumerated value propagation across peripheral siblings
- **Cursor Tracking** — Debounced cursor change detection with configurable delay
- **Symbol Resolution** — Resolves `GPIOA->MODER`, `GPIOA_MODER`, address literals, and more
- **Target Detection** — Auto-detects device from settings, PlatformIO, CubeMX, Makefile, CMake, or workspace SVD files
- **Interactive HUD** — Sidebar webview with bit-field grid, field editors (checkbox/dropdown/number), decode input
- **Code Generator** — Four styles: raw write, read-modify-write, CMSIS macros, commented
- **Register Browser** — Collapsible peripheral tree with search/filter in sidebar idle state
- **Pin/Unpin** — Lock HUD to a specific register
- **Disk Cache** — SHA-256 validated cache with schema versioning and size limits
- **Accessibility** — Keyboard navigation, ARIA labels, focus indicators, screen reader support
- **Theme Support** — Adapts to VS Code light, dark, and high-contrast themes
