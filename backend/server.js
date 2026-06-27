// Express-Server: REST-API + Auslieferung der gebauten Vue-SPA auf einem Port.
import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { initDb } from "./db.js";
import { runSeed } from "./seed/seed.js";
import articlesRouter from "./routes/articles.js";
import categoriesRouter from "./routes/categories.js";
import tagsRouter from "./routes/tags.js";
import searchRouter from "./routes/search.js";
import relationsRouter from "./routes/relations.js";
import javaRouter from "./routes/java.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

initDb();
await runSeed();

const app = express();
app.use(express.json({ limit: "8mb" }));

app.use("/api/articles", articlesRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/tags", tagsRouter);
app.use("/api/search", searchRouter);
app.use("/api/relations", relationsRouter);
app.use("/api/java", javaRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Zentraler Fehler-Handler -> saubere JSON-Antwort statt HTML-Stacktrace.
app.use("/api", (err, req, res, _next) => {
    console.error("[API-Fehler]", err);
    res.status(500).json({ error: "Interner Serverfehler" });
});

// Gebaute SPA ausliefern (Vite-Output). Im Dev laeuft das Frontend ueber Vite mit Proxy.
const dist = path.join(__dirname, "../frontend/dist");
if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (req, res, next) => {
        if (req.path.startsWith("/api")) return next();
        res.sendFile(path.join(dist, "index.html"));
    });
} else {
    app.get("/", (req, res) =>
        res
            .type("text/plain")
            .send(
                'Frontend noch nicht gebaut. Bitte "npm run build" ausfuehren (oder im Dev "npm run dev").'
            )
    );
}

app.listen(PORT, HOST, () => {
    console.log(
        `Wikit laeuft auf http://${
            HOST === "0.0.0.0" ? "localhost" : HOST
        }:${PORT}`
    );
});
