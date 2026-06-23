/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,js}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Neutral dark-grey / white palette.
        bg: "#1e1e1e",
        panel: "#181818",
        border: "#333333",
        fg: "#f5f5f5",
        muted: "#8a8a8a",
        accent: "#b0b0b0",
      },
    },
  },
  plugins: [],
};
