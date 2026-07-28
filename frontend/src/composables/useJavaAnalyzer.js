// Composable fuer die Java-Analyse (kein Pinia). Kapselt alle API-Aufrufe ueber lib/api.js
// -> in Komponenten wird nie direkt fetch() benutzt.
import { reactive, toRefs } from 'vue'
import { api } from '../lib/api.js'

const state = reactive({
  files: [],
  loading: false,
  analyzing: false,
  error: '',
  // Projekt-/Windchill-Kontext: bleibt fuer die gesamte Session erhalten und wird von
  // Modal UND Artikel-Panel gemeinsam genutzt (in jeden KI-Prompt eingespeist).
  userContext: '',
  // Zuletzt analysierte/ausgewaehlte Datei -> die Landing-Seite setzt sie, der Analyzer
  // liest sie beim Mount aus (Vorauswahl nach Upload). Danach im Analyzer zuruecksetzen.
  lastFileId: null,
  // Optionale Ziel-Quellzeile fuer den Hand-off (Suche/Edge-Panel -> CodeView): wenn gesetzt,
  // oeffnet CodeView den Quellcode-Tab und hebt diese Zeile hervor. Wird nach Verbrauch genullt.
  lastTargetLine: null,
  // Optionale Ziel-End-Zeile: ist sie gesetzt (> lastTargetLine), markiert CodeView den GESAMTEN
  // Methodenbereich (lastTargetLine..lastTargetEndLine) statt nur einer Zeile (Edge-Panel
  // „Definiert in"). Wird ebenfalls nach Verbrauch genullt.
  lastTargetEndLine: null,
})

async function fetchFiles() {
  state.loading = true
  state.error = ''
  try {
    state.files = await api.listJavaFiles()
  } catch (e) {
    state.error = e.message
  } finally {
    state.loading = false
  }
}

export function useJavaAnalyzer() {
  return {
    ...toRefs(state),
    fetchFiles,
    getFile: (id) => api.getJavaFile(id),
    // Versionsverlauf (Changelog) einer Klasse + Quelltext einer einzelnen Version (on-demand).
    getFileVersions: (id) => api.getJavaFileVersions(id),
    getVersionSource: (id, versionId) => api.getJavaFileVersionSource(id, versionId),
    async analyzeCode(source, filename = '') {
      state.analyzing = true
      state.error = ''
      try {
        const result = await api.analyzeJava({ source, filename })
        await fetchFiles()
        return result
      } catch (e) {
        state.error = e.message
        throw e
      } finally {
        state.analyzing = false
      }
    },
    // Mehrere Klassen aus einem Roh-Paste analysieren. Liefert das Backend needsConfirm
    // (DB-Duplikate, kein overwrite), wird die Dateiliste NICHT aktualisiert -> der Aufrufer
    // zeigt den Confirm-Dialog und ruft erneut mit { overwrite: true } auf.
    //
    // `onProgress` schaltet den Live-Fortschritt ein: Der Client erzeugt eine jobId, oeffnet damit
    // den SSE-Stream und schickt sie mit. Ein Paste ueber 150.000 Zeilen laeuft sonst als eine
    // einzige, stumme Anfrage – der Nutzer sieht minutenlang nur einen Spinner.
    // Der Stream ist eine reine Zugabe: faellt er aus (Proxy, alter Server), laeuft die Analyse
    // unveraendert weiter, nur eben ohne Detailfortschritt.
    async analyzeBatch(source, { overwrite = false, onProgress = null } = {}) {
      state.analyzing = true
      state.error = ''
      let es = null
      let jobId = null
      if (onProgress) {
        jobId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        try {
          es = new EventSource(api.javaAnalyzeProgressUrl(jobId))
          es.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data)
              if (msg && msg.phase !== 'heartbeat') onProgress(msg)
            } catch {
              /* unlesbares Event ignorieren */
            }
          }
          es.onerror = () => {}
          // Kurz warten, bis die Verbindung wirklich offen ist – sonst gehen die ersten
          // Ereignisse (split/parse-Start) verloren.
          await new Promise((resolve) => {
            const done = () => resolve()
            es.addEventListener('open', done, { once: true })
            setTimeout(done, 400)
          })
        } catch {
          es = null
        }
      }
      try {
        const result = await api.analyzeJavaBatch({ source, overwrite, jobId })
        if (!result.needsConfirm) await fetchFiles()
        return result
      } catch (e) {
        state.error = e.message
        throw e
      } finally {
        es?.close()
        state.analyzing = false
      }
    },
    async deleteFile(id) {
      await api.deleteJavaFile(id)
      await fetchFiles()
    },
    // Komplett-Reset: ALLE analysierten Klassen dauerhaft aus der DB loeschen (inkl. Methoden/
    // Dependencies via CASCADE; das Backend rechnet die Auto-Kanten je Delete neu). Sequentiell,
    // nicht parallel -> vermeidet SQLITE_BUSY/Transaktions-Contention (N ist klein). Danach einmal
    // refetchen (-> leere Liste). `userContext` bleibt BEWUSST erhalten: Session-/Projekt-
    // Einstellung fuer KI-Prompts, keine Klassen-Metadaten.
    async resetAll() {
      for (const f of state.files) await api.deleteJavaFile(f.id)
      await fetchFiles()
      state.lastFileId = null
      state.lastTargetLine = null
      state.lastTargetEndLine = null
      state.error = ''
    },
    summarizeMethod: (id, data) => api.summarizeJavaMethod(id, data),
    linkArticle: (id, articleId) => api.linkJavaArticle(id, { article_id: articleId }),
  }
}
