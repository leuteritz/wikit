// Was als Naechstes ansteht – aus den Befunden, die es ohnehin schon gibt.
//
// ⚠️ **Rechnet nichts.** Wikit ermittelt sieben Sorten Befund und legt jede in eine andere
// Ansicht: Zyklen und Regelverstoesse in `/insights`, veraltete Klassenartikel und tote Links in
// `/wiki` → Health, unanalysierte Klassen in `/code`, fehlende Vektoren in `/bot`. Jede fuer sich
// beantwortet „wie steht es dort?". Niemand fragt so. Man fragt „was soll ich als Naechstes tun?"
// – und dafuer musste man bis hierher fuenf Orte abklappern.
//
// Diese Datei ist deshalb kein neuer Befund, sondern eine LESEART der vorhandenen: sie nimmt
// Zahlen entgegen, die andere Stores schon geladen haben, und ordnet sie.
//
// ⚠️ Sortiert wird nach WIRKUNG durch AUFWAND, nicht nach Menge. Ein toter Link ist in zwei
// Sekunden weg, dreissig veraltete Klassenartikel sind ein Nachmittag – beide als „30 findings"
// nebeneinanderzustellen ist genau die Gleichmacherei, die den Bericht unbrauchbar macht.
// `weight` ist diese Rangfolge, von Hand gesetzt und begruendet, nicht gerechnet: es sind sieben
// Faelle, und eine Formel ueber sieben handverlesene Faelle waere eine Formel ueber nichts.
//
// ⚠️ Was erledigt ist, VERSCHWINDET. Eine Liste, die immer gleich lang ist, fordert zu nichts auf
// (dieselbe Regel wie bei den Sidebar-Zahlen: „eine Zahl, die nie 0 wird, ist keine").

/**
 * ⚠️ `health` ist OPTIONAL und wird von der Startseite bewusst NICHT mitgegeben: der Bericht
 * kostet einen eigenen Request und rechnet dabei Beinah-Duplikate ueber alle Artikel-Vektoren.
 * Die Startseite zeigt, was ohnehin im Speicher liegt (`App.vue` laedt es fuer die Sidebar) –
 * eine Startseite, die beim Oeffnen rechnet, waere genau die zweite Ansicht vor der Ansicht, die
 * es dort schon einmal gab. Wer den Bericht will, ist einen Klick entfernt.
 *
 * @param {object} input
 * @param {object|null} input.insights   `totals` aus `useInsights` (Zyklen, Regelverstoesse)
 * @param {object|null} input.health     Antwort von `GET /api/articles/health` – optional
 * @param {number} input.unanalysed      Klassen ohne KI-Beschreibung
 * @param {object|null} input.embeddings `{ enabled, todo }` aus `useEmbeddings`
 * @returns {Array<{id,label,labelMany,count,to,icon,tone,weight}>} nach Rang, hoechster zuerst
 */
export function buildNextActions({ insights = null, health = null, unanalysed = 0, embeddings = null } = {}) {
  const out = []
  const add = (item) => {
    if (item.count > 0) out.push(item)
  }

  // 1. Regelverstoesse zuerst – der einzige Befund, den der Nutzer SELBST als Regel aufgeschrieben
  //    hat. Alles andere hier ist Wikits Meinung; das ist seine.
  add({
    id: 'rules',
    label: 'relation breaks a rule you wrote',
    labelMany: 'relations break rules you wrote',
    count: insights?.ruleViolations || 0,
    to: '/insights?tab=rules',
    icon: 'lucide:scale',
    tone: 'danger',
    weight: 100,
  })

  // 2. Zyklen: der einzige Befund, der bei Nichtbeachtung TEURER wird – jede neue Kante im Kreis
  //    macht das Aufloesen schwerer.
  add({
    id: 'cycles',
    label: 'dependency loop',
    labelMany: 'dependency loops',
    count: (insights?.classCycles || 0) + (insights?.packageCycles || 0),
    to: '/insights?tab=cycles',
    icon: 'lucide:repeat',
    tone: 'danger',
    weight: 90,
  })

  // 3. Tote Links: winzige Arbeit, sofort erledigt – und bis dahin fuehrt ein sichtbarer Verweis
  //    im Text ins Leere.
  add({
    id: 'broken',
    label: 'dead wiki link',
    labelMany: 'dead wiki links',
    count: health?.totals?.broken || 0,
    to: '/wiki?view=health',
    icon: 'lucide:unlink',
    tone: 'warning',
    weight: 70,
  })

  // 4. Veraltete Klassenartikel: der Artikel behauptet etwas ueber Code, der sich geaendert hat.
  add({
    id: 'outdated',
    label: 'class article is behind its code',
    labelMany: 'class articles are behind their code',
    count: health?.totals?.outdated || 0,
    to: '/wiki?view=health',
    icon: 'lucide:file-warning',
    tone: 'warning',
    weight: 60,
  })

  // 5. Fehlende Vektoren: keine Unordnung, sondern eine abgeschaltete Faehigkeit – `/ask` und die
  //    Bedeutungssuche finden diese Klassen schlicht nicht. Nur wenn die Suche ueberhaupt an ist:
  //    ohne Embedding-Modell ist „nicht indiziert" der gewaehlte Zustand und kein Befund.
  if (embeddings?.enabled) {
    add({
      id: 'embeddings',
      label: 'source is not in the meaning index',
      labelMany: 'sources are not in the meaning index',
      count: embeddings.todo || 0,
      to: '/bot',
      icon: 'lucide:sparkles',
      tone: 'muted',
      weight: 40,
    })
  }

  // 6. Unanalysierte Klassen: eine Moeglichkeit, kein Mangel – deshalb ganz unten und ohne Farbe.
  add({
    id: 'unanalysed',
    label: 'class has no AI description',
    labelMany: 'classes have no AI description',
    count: unanalysed,
    to: '/code',
    icon: 'lucide:bot',
    tone: 'muted',
    weight: 20,
  })

  // 7. Unfertige Artikel: der Nutzer weiss selbst, dass sie unfertig sind – erinnern genuegt.
  add({
    id: 'incomplete',
    label: 'article is still a stub',
    labelMany: 'articles are still stubs',
    count: health?.totals?.incomplete || 0,
    to: '/wiki?view=health',
    icon: 'lucide:file-question',
    tone: 'muted',
    weight: 10,
  })

  return out.sort((a, b) => b.weight - a.weight)
}
