<script setup>
// Der Seitenkopf – EINE Form fuer die Ansichten, die einen tragen.
//
// Jede View baute ihn selbst. Das Ergebnis waren SIEBEN H1-Groessen (`text-base`,
// `text-[0.9375rem]`, `text-2xl`, `text-3xl`, `text-4xl/5xl`) und FUENF Inhaltsbreiten
// (`max-w-4xl`/`5xl`/`6xl`/`7xl`/keine) fuer dieselbe Sorte Seite – und drei Ansichten
// (Insights, Bot, Topic) trugen bereits woertlich dieselbe Klassenkette, nur eben als Abschrift:
// Topic schrieb `text-base font-bold` statt `font-mono text-base font-semibold` und `max-w-7xl`
// statt `max-w-6xl`. Kein Vorsatz, nur Drift.
//
// ⚠️ NICHT fuer alle Koepfe. Die Startseite (zentriert, ohne Kopfzeile) und die Code-Ansicht
// (Kommandoleiste mit Live-Metriken, Warteschlange und Werkzeuggruppe, dichter und ohne
// Inhaltsbreite) bleiben eigen – die eine ist keine Seite mit Kopf, die andere ist eine Werkbank.
// Wiki und Tag tragen ihren Titel gross und mitten im Fluss, statt in einer Leiste: das ist ein
// anderer Rang und bleibt deshalb ebenfalls draussen.
//
// ⚠️ Kein `sticky`, kein `backdrop-blur`. Beides stand hier und war WIRKUNGSLOS: die Wurzel dieser
// Ansichten ist `flex h-full min-h-0 flex-col`, der Scroller ist ein GESCHWISTER des Kopfes – der
// Kopf liegt also nie in einem Scroll-Container und bleibt schon durch das Flex-Layout oben. Das
// Ergebnis stimmte, die Begruendung nicht, und `backdrop-blur` zwang den Compositor fuer nichts zu
// einer eigenen Textur.
import { Icon } from '../../lib/icons.js'

defineProps({
  icon: { type: String, default: '' },
  title: { type: String, required: true },
  /** Die Inhaltsbreite. Sie gilt fuer Kopf UND Rumpf – deshalb dieselbe Prop an `PageShell`. */
  width: { type: String, default: '6xl' }, // 4xl | 5xl | 6xl | 7xl
})

const WIDTHS = { '4xl': 'max-w-4xl', '5xl': 'max-w-5xl', '6xl': 'max-w-6xl', '7xl': 'max-w-7xl' }
</script>

<template>
  <header class="shrink-0 border-b border-line px-5 py-3">
    <div :class="['mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-2', WIDTHS[width] || WIDTHS['6xl']]">
      <span
        v-if="icon"
        class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"
      >
        <Icon :icon="icon" class="h-5 w-5" />
      </span>
      <div class="min-w-0">
        <h1 class="font-mono text-base font-semibold tracking-tight text-ink">{{ title }}</h1>
        <!-- Die Bilanzzeile: was dieser Bestand ist, in einer Zeile. Fehlt sie, faellt sie weg –
             eine leere Zeile unter dem Titel behauptet, es haette etwas dort stehen sollen. -->
        <p v-if="$slots.meta" class="flex flex-wrap items-center gap-x-2 text-2xs text-muted">
          <slot name="meta" />
        </p>
      </div>

      <div v-if="$slots.actions" class="ml-auto flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>

    <div v-if="$slots.tabs" :class="['mx-auto mt-3 w-full', WIDTHS[width] || WIDTHS['6xl']]">
      <slot name="tabs" />
    </div>
  </header>
</template>
