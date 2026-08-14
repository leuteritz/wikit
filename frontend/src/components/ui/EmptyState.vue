<script setup>
// „Hier ist nichts" – und warum, und was man dagegen tut.
//
// Der gestrichelte Rahmen stand 21-mal in 14 Dateien, und die Qualitaet schwankte stark: die guten
// Fassungen (Spalte 3 der Code-Ansicht, die leere Fassungsliste) haben Icon, Titel, Erklaersatz und
// einen Weg nach vorn; die schwachen waren ein grauer Satz in einem Rahmen.
//
// ⚠️ Der Unterschied ist keine Geschmacksfrage. Ein Leerzustand beantwortet eine von ZWEI Fragen,
// und welche, entscheidet der Fall:
//   * „Du hast noch nichts angelegt"  -> es fehlt ein ANFANG, also gehoert eine Handlung dazu.
//   * „Deine Auswahl trifft nichts"   -> der Bestand ist da, die Frage war zu eng: kein Aufruf,
//     sondern der Hinweis, was die Auswahl gerade ausschliesst.
// Ein „Neu anlegen"-Knopf unter einer leeren Suchtrefferliste ist die falsche Antwort auf die
// zweite Frage – deshalb ist die Handlung ein Slot und keine Pflicht.
//
// ⚠️ NICHT fuer Fehler. Ein misslungener Request ist kein leerer Bestand, sondern eine Stoerung –
// dafuer gibt es `.notice-danger` und den Toast. Ein Fehler im Kleid eines Leerzustands behauptet,
// es gaebe nichts, wo in Wahrheit nur niemand nachgesehen hat.
import { Icon } from '../../lib/icons.js'

defineProps({
  icon: { type: String, default: '' },
  title: { type: String, required: true },
  /** Ein bis zwei Saetze. Warum es leer ist – nicht, DASS es leer ist (das sagt der Titel). */
  hint: { type: String, default: '' },
  /** `block` steht in der Seite, `fill` fuellt eine Spalte auf ganzer Hoehe (Panels). */
  variant: { type: String, default: 'block' }, // block | fill
  /** Ohne Rahmen – fuer Leerzustaende INNERHALB einer Karte, die schon einen hat. */
  bare: { type: Boolean, default: false },
})
</script>

<template>
  <div
    class="text-center"
    :class="[
      bare ? '' : 'rounded-xl border border-dashed border-line',
      variant === 'fill' ? 'grid h-full place-items-center px-6' : 'px-6 py-11',
    ]"
  >
    <div class="mx-auto max-w-md">
      <span
        v-if="icon"
        class="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface-offset text-muted"
      >
        <Icon :icon="icon" class="h-5 w-5" />
      </span>
      <p class="text-sm font-semibold text-ink">{{ title }}</p>
      <p v-if="hint" class="mt-1 text-xs leading-relaxed text-muted">{{ hint }}</p>
      <!-- Der Weg nach vorn. Leer zu lassen ist eine Aussage, keine Luecke – s. Kopfkommentar. -->
      <div v-if="$slots.default" class="mt-3 flex flex-wrap items-center justify-center gap-2">
        <slot />
      </div>
    </div>
  </div>
</template>
