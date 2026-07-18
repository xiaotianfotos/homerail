/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "var(--hr-border)",
        input: "var(--hr-control)",
        ring: "var(--hr-focus-ring)",
        background: "var(--hr-bg)",
        foreground: "var(--hr-text-1)",
        primary: {
          DEFAULT: "var(--hr-accent)",
          foreground: "var(--hr-on-accent)",
        },
        secondary: {
          DEFAULT: "var(--hr-surface-2)",
          foreground: "var(--hr-text-2)",
        },
        destructive: {
          DEFAULT: "var(--hr-danger)",
          foreground: "var(--hr-on-strong)",
        },
        muted: {
          DEFAULT: "var(--hr-surface-1)",
          foreground: "var(--hr-text-3)",
        },
        accent: {
          DEFAULT: "var(--hr-accent-soft)",
          foreground: "var(--hr-accent)",
        },
        popover: {
          DEFAULT: "var(--hr-panel)",
          foreground: "var(--hr-text-1)",
        },
        card: {
          DEFAULT: "var(--hr-surface-1)",
          foreground: "var(--hr-text-1)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [],
}
