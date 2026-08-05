// Die Farbskalen der gerechneten Kennzahlen – EINE Quelle für Bericht, Graph und Legende.
//
// Warum geteilt: dieselbe Zahl bekommt in `/insights` (Rangliste) und in `/code` (Kartenfarbe)
// dieselbe Farbe. Zwei Fassungen wären zwei Schwellen, und ein Brandherd, der im Bericht rot und
// im Bild gelb ist, ist keine Auskunft mehr, sondern eine Frage.
//
// Bewusst STUFEN statt eines Verlaufs: ein kontinuierlicher Farbverlauf sieht schöner aus, lässt
// sich aber nicht beschriften – und eine Skala, die keine Legende haben kann, erklärt nichts.

// Ab wo ein Score „viel" ist. Perzentilbasiert gerechnet (s. insights.service.ts), also sind das
// Ränge: 75 heißt „schwerer als drei Viertel aller Klassen".
export const HOTSPOT_HIGH = 75
export const HOTSPOT_MID = 50

/** Farbe eines Hotspot-Scores (0…100). */
export function hotspotColor(score) {
  if (score >= HOTSPOT_HIGH) return 'var(--color-danger)'
  if (score >= HOTSPOT_MID) return 'var(--color-warning)'
  return 'var(--color-text-muted)'
}

// Instabilität nach Martin: 0 = alle hängen daran, 1 = hängt an allen.
export const UNSTABLE_HIGH = 0.8
export const STABLE_LOW = 0.2

/**
 * Farbe einer Instabilität (0…1, `null` = keine Beziehungen).
 *
 * ⚠️ Bewusst DIESELBEN Töne wie die Rollen: „wird benutzt" ist grün, „benutzt andere" lavendel,
 * beides violett-neutral. Die Rolle IST die grobe Fassung derselben Aussage – sie entsteht nur im
 * gezeichneten Ausschnitt, die Instabilität über den ganzen Bestand. Zwei Farbfamilien für eine
 * Aussage hätten behauptet, es seien zwei.
 */
export function instabilityColor(i) {
  if (i == null) return 'var(--color-role-isolated)'
  if (i >= UNSTABLE_HIGH) return 'var(--color-role-consumer)'
  if (i <= STABLE_LOW) return 'var(--color-role-provider)'
  return 'var(--color-role-hub)'
}

// Die Farbmodi des Graphen als Tabelle: ein weiterer Modus ist eine Zeile, keine dritte
// Fallunterscheidung im Template.
export const COLOR_MODES = [
  {
    id: 'role',
    label: 'Role',
    icon: 'lucide:share-2',
    hint: 'How a class sits in the drawn picture — provider, consumer, hub.',
  },
  {
    id: 'hotspot',
    label: 'Weight',
    icon: 'lucide:flame',
    hint: 'Size, branching and coupling as one rank against every other class.',
  },
  {
    id: 'instability',
    label: 'Stability',
    icon: 'lucide:target',
    hint: 'Whether a class is depended upon or depends outward — across the whole codebase.',
  },
]

// Was die Legende je Modus zeigt: Beschriftung und Farbe, in Leserichtung der Skala.
export const SCALE_STOPS = {
  hotspot: [
    { label: `heavy (${HOTSPOT_HIGH}+)`, color: 'var(--color-danger)' },
    { label: `noticeable (${HOTSPOT_MID}+)`, color: 'var(--color-warning)' },
    { label: 'quiet', color: 'var(--color-text-muted)' },
  ],
  instability: [
    { label: 'depended upon', color: 'var(--color-role-provider)' },
    { label: 'balanced', color: 'var(--color-role-hub)' },
    { label: 'depends outward', color: 'var(--color-role-consumer)' },
    { label: 'no relations', color: 'var(--color-role-isolated)' },
  ],
}
