// Das Beziehungsnetz der Artikel: Farbe je Kategorie und die Kennzahlen, die eine Liste nicht
// zeigen kann.
//
// ⚠️ **Die Kategoriefarbe haengt an der KATEGORIE, nicht an ihrer Position in einer gefilterten
// Liste.** Vorher vergab `WikiView` sie ueber den Index der sichtbaren Gruppen – tippte man einen
// Filter, der die erste Kategorie ausblendete, wechselten alle uebrigen die Farbe. Neben einem
// Graphen faellt das sofort auf: dieselbe Kategorie waere links gruen und rechts violett. Die
// Zuordnung laeuft deshalb ueber die Reihenfolge in `categories` (stabil, ungefiltert), und beide
// Ansichten lesen sie hier.

export const CAT_COLORS = [
  'var(--color-thistle)',
  'var(--color-accent)',
  'var(--color-lavender)',
  'var(--color-cyan)',
]

// Artikel ohne Kategorie. Bewusst gedaempft statt bunt: „keine Kategorie" ist keine fuenfte
// Kategorie, sondern ihr Fehlen.
export const UNCATEGORIZED_COLOR = 'var(--color-text-muted)'

/**
 * Kategorie-Id -> Farbe. Deterministisch ueber die Reihenfolge in `categories`.
 * `0`/`null` (unkategorisiert) bekommt bewusst den gedaempften Ton.
 */
export function categoryColors(categories = []) {
  const map = new Map()
  categories.forEach((c, i) => map.set(c.id, CAT_COLORS[i % CAT_COLORS.length]))
  return map
}

export function colorFor(map, categoryId) {
  if (categoryId == null) return UNCATEGORIZED_COLOR
  return map.get(categoryId) || UNCATEGORIZED_COLOR
}

/**
 * Aus `GET /api/relations` das, was der Graph braucht – und die Kennzahlen, die die Liste
 * schuldig bleibt.
 *
 * ⚠️ **Verwaiste Artikel sind der eigentliche Befund dieser Ansicht.** Eine nach Kategorie
 * gruppierte Liste zeigt jeden Artikel gleich prominent; dass auf einen davon nichts zeigt und er
 * auf nichts zeigt, sieht man dort nie. Die Kategorie ist eine ZUORDNUNG, keine Beziehung – genau
 * diesen Unterschied macht der Graph sichtbar.
 *
 * Die Richtung zaehlt getrennt (`out`/`in`): „von hier fuehrt nichts weiter" und „hierher fuehrt
 * nichts" sind zwei verschiedene Luecken, und nur die Summe zu kennen verwischt sie.
 */
export function buildWikiGraph({ nodes = [], edges = [] } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map()
  const inc = new Map()

  // Kanten auf existierende Artikel beschraenken: eine Relation auf einen geloeschten Artikel ist
  // durch das CASCADE zwar ausgeschlossen, aber ein Knoten, den es nicht gibt, waere im Layout ein
  // Punkt ohne Karte – und der ist schlimmer als eine fehlende Linie.
  const valid = edges.filter((e) => byId.has(e.source_id) && byId.has(e.target_id))
  for (const e of valid) {
    out.set(e.source_id, (out.get(e.source_id) || 0) + 1)
    inc.set(e.target_id, (inc.get(e.target_id) || 0) + 1)
  }

  const items = nodes.map((n) => {
    const o = out.get(n.id) || 0
    const i = inc.get(n.id) || 0
    return { ...n, out: o, in: i, degree: o + i, orphan: o + i === 0 }
  })

  return {
    items,
    edges: valid,
    totals: {
      articles: items.length,
      relations: valid.length,
      orphans: items.filter((n) => n.orphan).length,
      // Das Drehkreuz: der Artikel mit den meisten Beziehungen. Bei Gleichstand der erste – die
      // Zahl ist die Aussage, nicht der Name.
      busiest: items.reduce((best, n) => (!best || n.degree > best.degree ? n : best), null),
    },
  }
}

/**
 * Vorschlagskanten aus `GET /api/articles/suggestions` – aber nur fuer die VERWAISTEN.
 *
 * ⚠️ Der verwaiste Artikel ist der Befund, um dessentwillen es diese Ansicht gibt, und der einzige,
 * der ohne Vorschlag in einer Sackgasse endet: „nichts zeigt hierher" ist eine Auskunft, mit der
 * man allein gelassen wird. Alle Paare zu zeichnen waere ehrlicher und trotzdem schlechter – bei
 * vierzig Artikeln sind es achtzig zusaetzliche Linien, in denen genau der Befund wieder untergeht,
 * den die Ansicht sichtbar machen soll.
 *
 * Zwei Festlegungen:
 * - **Ein Paar, eine Linie.** Die Aehnlichkeit ist symmetrisch, also schlagen sich zwei verwaiste
 *   Artikel gegenseitig vor – gezeichnet gaebe das zwei Linien zwischen denselben Karten.
 * - **Die Richtung ist die Geste, nicht die Rechnung.** Ein Klick legt `source -> target` an, und
 *   `source` ist der verwaiste: von dem Artikel aus, dem die Verknuepfung fehlt. Sind es beide,
 *   entscheidet die kleinere Id – irgendeine Richtung muss es sein, und eine, die beim Neuladen
 *   dieselbe bleibt, ist die einzige, die nicht verwirrt.
 */
export function suggestionEdges(items = [], suggestions = []) {
  const orphans = new Set(items.filter((n) => n.orphan).map((n) => n.id))
  const known = new Set(items.map((n) => n.id))
  if (!orphans.size) return []

  const seen = new Set()
  const out = []
  for (const entry of suggestions) {
    for (const item of entry.items || []) {
      const a = entry.id
      const b = item.id
      // Mindestens eine Seite muss verwaist sein – sonst ist es ein Vorschlag zwischen zwei
      // Artikeln, die beide schon im Netz haengen, und der gehoert auf die Artikelseite.
      if (!orphans.has(a) && !orphans.has(b)) continue
      // Ein Vorschlag auf einen Artikel, den der Graph nicht kennt, waere eine Linie ins Leere.
      if (!known.has(a) || !known.has(b)) continue
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      if (seen.has(key)) continue
      seen.add(key)

      const fromOrphan = orphans.has(a) && (!orphans.has(b) || a < b)
      out.push({
        id: `s${key}`,
        source_id: fromOrphan ? a : b,
        target_id: fromOrphan ? b : a,
        score: item.score,
      })
    }
  }
  return out
}

/** Nachbarn eines Artikels (beide Richtungen) – fuer den Hover-Fokus. */
export function neighboursOf(edges, id) {
  const set = new Set()
  for (const e of edges) {
    if (e.source_id === id) set.add(e.target_id)
    else if (e.target_id === id) set.add(e.source_id)
  }
  return set
}
