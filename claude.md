# Role & Objective
You are an expert Principal Software Engineer specializing in Rust, Tauri v2, and high-performance desktop architectures. Your task is to generate a pristine, fully configured boilerplate and initial codebase for a lightweight, hyper-efficient Markdown note-taking application (similar to Obsidian). 

The application must run natively on macOS and Linux, optimizing heavily for minimal RAM and CPU consumption.

##Features
- Edit .md files and keep them in a folder(similar to obsidian vault)

- Be RAM and CPU efficient

- Render the markdown stuff like italics and bold in real-time

- Ability to create directories and files from within the app

---


## Tech Stack & Folder Structure
- **Backend:** Rust (Tauri v2) located in `/src-tauri`
- **Frontend:** Vanilla TypeScript + Vite + Tailwind CSS located in `/src` and root
- **Storage:** Local File System (`.md` files in a user-selected folder/vault)

### Exact Target Project Layout:
```text
/
├── src-tauri/                 # Backend
│   ├── Cargo.toml
│   └── src/
│       └── main.rs
├── src/                       # Frontend Source
│   ├── main.ts
│   └── style.css
├── index.html                 # Frontend Entry
├── package.json
├── tailwind.config.js
└── vite.config.ts


Ask any clarifying questions. Sacrifice grammar in order to be concise.
