<script setup>
import { ref } from "vue";
import { useJavaAnalyzer } from "../composables/useJavaAnalyzer.js";
import JavaDependencyGraph from "../components/java/JavaDependencyGraph.vue";
import JavaClassDetail from "../components/java/JavaClassDetail.vue";

const { analyzeCode, analyzing, error } = useJavaAnalyzer();

const tab = ref("upload"); // 'upload' | 'graph'
const source = ref("");
const filename = ref("");
const reloadToken = ref(0);
const selectedFileId = ref(null);
const lastResult = ref(null);

async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    filename.value = f.name;
    source.value = await f.text();
}

async function analyze() {
    if (!source.value.trim()) return;
    try {
        const result = await analyzeCode(source.value, filename.value);
        lastResult.value = result.file;
        reloadToken.value++;
        selectedFileId.value = result.file.id;
        tab.value = "graph";
    } catch {
        // Fehler steht in `error` (aus dem Composable) und wird im Template angezeigt.
    }
}

function onSelect(fileId) {
    selectedFileId.value = fileId;
}

function onDetailClose(payload) {
    if (payload?.deleted) reloadToken.value++;
    selectedFileId.value = null;
}
</script>

<template>
    <div class="flex h-[calc(100vh-3.5rem)] flex-col px-5 py-6">
        <div class="mb-4 shrink-0">
            <h1
                class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
            >
                Java Test Analyzer
            </h1>
            <p class="text-sm text-slate-500 dark:text-slate-400">
                Java-Code analysieren – lokal geparst, Abhängigkeiten als Graph,
                KI-Zusammenfassung pro Methode.
            </p>
        </div>

        <!-- Tabs -->
        <div
            class="mb-4 flex shrink-0 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/60"
        >
            <button
                type="button"
                class="rounded-md px-4 py-1.5 text-sm font-medium transition"
                :class="
                    tab === 'upload'
                        ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300'
                        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                "
                @click="tab = 'upload'"
            >
                Hochladen
            </button>
            <button
                type="button"
                class="rounded-md px-4 py-1.5 text-sm font-medium transition"
                :class="
                    tab === 'graph'
                        ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300'
                        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                "
                @click="tab = 'graph'"
            >
                Graph-Ansicht
            </button>
        </div>

        <!-- Upload-Tab -->
        <div v-show="tab === 'upload'" class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto max-w-3xl">
                <div class="mb-3 flex items-center gap-3">
                    <label
                        class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                        <svg
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path d="M12 16V4M5 11l7-7 7 7M5 20h14" />
                        </svg>
                        .java-Datei wählen
                        <input
                            type="file"
                            accept=".java"
                            class="hidden"
                            @change="onFile"
                        />
                    </label>
                    <span
                        v-if="filename"
                        class="truncate text-sm text-slate-500 dark:text-slate-400"
                        >{{ filename }}</span
                    >
                </div>

                <textarea
                    v-model="source"
                    spellcheck="false"
                    placeholder="// Java-Code hier einfügen…"
                    class="h-80 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:focus:ring-indigo-500/20"
                />

                <p v-if="error" class="mt-2 text-sm text-rose-500">
                    {{ error }}
                </p>

                <div class="mt-3 flex items-center gap-3">
                    <button
                        type="button"
                        class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60"
                        :disabled="analyzing || !source.trim()"
                        @click="analyze"
                    >
                        <svg
                            v-if="analyzing"
                            class="h-4 w-4 animate-spin"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path d="M21 12a9 9 0 1 1-6.2-8.5" />
                        </svg>
                        {{ analyzing ? "Analysiere…" : "Analysieren" }}
                    </button>
                    <span class="text-xs text-slate-400"
                        >Wird lokal geparst – kein Cloud-Dienst.</span
                    >
                </div>
            </div>
        </div>

        <!-- Graph-Tab -->
        <div
            v-show="tab === 'graph'"
            class="relative flex min-h-0 flex-1 gap-3"
        >
            <div class="min-w-0 flex-1">
                <JavaDependencyGraph
                    :reload-token="reloadToken"
                    @select="onSelect"
                />
            </div>
            <Transition name="panel">
                <div
                    v-if="selectedFileId"
                    class="h-full w-full max-w-md shrink-0"
                >
                    <JavaClassDetail
                        :file-id="selectedFileId"
                        @close="onDetailClose"
                    />
                </div>
            </Transition>
        </div>
    </div>
</template>

<style scoped>
.panel-enter-active,
.panel-leave-active {
    transition: opacity 0.15s ease;
}
.panel-enter-from,
.panel-leave-to {
    opacity: 0;
}
</style>
