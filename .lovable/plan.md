# Calculator Website

A single-page calculator app with a clean, modern UI.

## Features
- Digits 0–9, decimal point
- Operations: +, −, ×, ÷
- Clear (AC), delete last (⌫), toggle sign (±), percent (%)
- Equals (=) to evaluate
- Display showing current input and previous expression
- Keyboard support (number keys, operators, Enter = equals, Backspace = delete, Escape = clear)

## Implementation
- Replace placeholder in `src/routes/index.tsx` with the Calculator UI
- New component `src/components/Calculator.tsx` holding state + logic (React `useState`, safe manual evaluation — no `eval`)
- Style with Tailwind using existing semantic tokens (bg-background, bg-card, bg-primary, etc.) — grid layout for buttons, large display area
- Update `__root.tsx` head: title "Calculator", proper meta description, og tags
- Keyboard handling via `useEffect` + window keydown listener

## Design
Modern minimal calculator: centered card on neutral background, rounded buttons, subtle hover/active states, distinct color for operator buttons (primary) vs digits (secondary) vs equals (accent). Responsive/mobile-friendly.

No backend needed.
