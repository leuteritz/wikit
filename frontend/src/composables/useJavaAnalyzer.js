// Composable fuer die Java-Analyse (kein Pinia). Kapselt alle API-Aufrufe ueber lib/api.js
// -> in Komponenten wird nie direkt fetch() benutzt.
import { reactive, toRefs } from 'vue'
import { api } from '../lib/api.js'
// Fortschritt eines langen Laufs gehoert nicht in die Komponente, die ihn ausgeloest hat:
// der Server arbeitet weiter, wenn sie verschwindet (s. useActivity.js).
import { useActivity } from './useActivity.js'

const { trackRun } = useActivity()

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
  // Optionale Suchanfrage fuer den Hand-off (globale Suche -> CodeView -> Klassen-Panel): der
  // Begriff, mit dem der Treffer gefunden wurde, steht danach in der Suchleiste des Quellcode-Tabs.
  // Ohne das faenge man in der geoeffneten Klasse wieder bei null an, obwohl man gerade nach genau
  // diesem Wort gesucht hat. `lastSearchOpts` traegt die Schalter (Case/Wort/Regex) mit, sonst
  // faende die Klasse etwas anderes als die Palette. Beide werden nach Verbrauch genullt.
  lastSearchQuery: null,
  lastSearchOpts: null,
  // Hand-off fuer ein PACKAGE (Insights -> CodeView): der Bericht nennt Zyklen und Kennzahlen auf
  // Package-Ebene, und der Sprung dorthin meint genau diese Ebene – nicht eine Klasse darin.
  // Eigenes Feld statt einer Klassen-Id, weil `lastFileId` das Ego EINER Klasse aufschlaegt; ein
  // stellvertretend gewaehltes Mitglied waere die Antwort auf eine andere Frage.
  lastPackage: null,
  // Hand-off „einlesen": die Landing-Seite hat keine eigene Drop-Zone mehr (sie ist Suche und
  // Bilanz, sonst nichts). Ihr „Add code"-Verweis setzt dieses Flag und springt in die
  // Code-Ansicht, die das Modal beim Ankommen oeffnet – sonst laege der Knopf, den man gerade
  // gedrueckt hat, dort ein zweites Mal und man muesste ihn erneut suchen.
  openAddCode: false,
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
    // Der Fortschritt laeuft IMMER (frueher nur, wenn der Aufrufer ein `onProgress` mitgab): ein
    // Paste ueber 150.000 Zeilen ist sonst eine einzige, stumme Anfrage, die minutenlang laeuft.
    // Gemeldet wird an `useActivity` und nicht an den Aufrufer – sonst haengt die Anzeige an der
    // Komponente, die den Lauf gestartet hat, und ist beim Ansichtswechsel weg, obwohl der Server
    // weiterarbeitet.
    async analyzeBatch(source, { overwrite = false } = {}) {
      state.analyzing = true
      state.error = ''
      try {
        const result = await trackRun(
          'import',
          (jobId) => api.analyzeJavaBatch({ source, overwrite, jobId }),
          // Rueckfrage wegen Duplikaten -> der Lauf ist NICHT fertig, sondern wartet auf eine
          // Entscheidung. Kein Abschluss melden, sonst stuende „Imported 0 classes" da, waehrend
          // der Dialog noch offen ist.
          {
            summarize: (res) =>
              res?.needsConfirm ? null : `Imported ${(res?.saved || []).length} class(es)`,
          },
        )
        if (!result.needsConfirm) await fetchFiles()
        return result
      } catch (e) {
        state.error = e.message
        throw e
      } finally {
        state.analyzing = false
      }
    },
    async deleteFile(id) {
      await api.deleteJavaFile(id)
      await fetchFiles()
    },
    // Komplett-Reset: ALLE analysierten Klassen dauerhaft aus der DB loeschen (Methoden/
    // Dependencies/Versionen via CASCADE, Kanten einmal am Ende). EIN Request – frueher lief hier
    // ein DELETE je Klasse, und jeder einzelne rechnete den gesamten Kantengraphen neu.
    // `userContext` bleibt BEWUSST erhalten: Session-/Projekt-Einstellung fuer KI-Prompts.
    async resetAll() {
      // Die Zahl VOR dem Loeschen – danach ist die Liste leer und koennte nichts mehr melden.
      const removed = state.files.length
      await trackRun('reset', (jobId) => api.resetAllJavaFiles(jobId), {
        summarize: () => `Removed ${removed} class(es)`,
      })
      await fetchFiles()
      state.lastFileId = null
      state.lastTargetLine = null
      state.lastTargetEndLine = null
      state.lastSearchQuery = null
      state.lastSearchOpts = null
      state.error = ''
    },
    summarizeMethod: (id, data) => api.summarizeJavaMethod(id, data),
    linkArticle: (id, articleId) => api.linkJavaArticle(id, { article_id: articleId }),
  }
}
