import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './splash.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
