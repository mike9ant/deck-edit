/** @type {import('tailwindcss').Config} */
import typography from "@tailwindcss/typography"
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f7f6f3',
        panel: '#ffffff',
        hair: '#e4e2dc',
        ink: '#1f2328',
        'ink-2': '#4b5058',
        'ink-3': '#7c818a',
        accent: '#3d63dd',
        'accent-soft': '#e8edfc',
        note: '#f5c542',
      },
      fontFamily: {
        ui: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [typography],
}
