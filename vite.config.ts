import { defineConfig } from "vite";


export default defineConfig({
    // If you deploy to GitHub Pages under a repo name, set base: "/<REPO_NAME>/"
    // Example: base: "/babylon-fps/",
    base: '/p2p-mesh-sharing/',
    server: {
        port: 5173,
    },
    build: {
        outDir: "dist",
    },
});