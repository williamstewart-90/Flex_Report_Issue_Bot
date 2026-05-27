/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['"Geist"', 'system-ui', 'sans-serif'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        mono:    ['"JetBrains Mono"', '"Geist Mono"', 'ui-monospace', 'monospace']
      },
      colors: {
        ink:    '#0a0a0a',
        paper:  '#f5f1ea',
        bone:   '#e9e3d8',
        rust:   '#c2410c',
        ember:  '#dc2626',
        moss:   '#4d7c0f',
        gold:   '#b45309',
        slate2: '#1a1a1a'
      },
      boxShadow: {
        sharp: '4px 4px 0 0 rgba(10,10,10,1)'
      }
    }
  },
  plugins: []
};
