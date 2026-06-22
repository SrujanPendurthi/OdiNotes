/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,js}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Tokyo-night inspired palette, easy on the eyes.
        bg: "#1a1b26",
        panel: "#16161e",
        border: "#2a2b3c",
        fg: "#c0caf5",
        muted: "#565f89",
        accent: "#7aa2f7",
      },
    },
  },
  plugins: [],
};
