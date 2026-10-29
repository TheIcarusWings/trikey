// Maps Tailwind's font-weight utilities to the static Geist faces registered in
// src/lib/fonts.ts. React Native can't pick a weight from one family, so each weight
// is its own family name. `font-mono` keeps working through theme.fontFamily.mono.
const plugin = require('tailwindcss/plugin');

module.exports = plugin(function ({ addUtilities }) {
  addUtilities({
    '.font-sans': { fontFamily: 'Geist' },
    '.font-normal': { fontFamily: 'Geist' },
    '.font-medium': { fontFamily: 'Geist-Medium' },
    '.font-semibold': { fontFamily: 'Geist-SemiBold' },
    '.font-bold': { fontFamily: 'Geist-Bold' },
    '.font-mono': { fontFamily: 'GeistMono' },
  });
});
