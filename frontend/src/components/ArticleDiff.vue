<script setup>
// Zwei Fassungen eines Artikels nebeneinander – wortgenau.
//
// ⚠️ Die Komponente RECHNET NICHTS. Zeilenpaare und Wortsegmente kommen fertig vom Server
// (articles/text-diff.ts); hier wird nur gemalt. Ein zweiter Diff-Algorithmus im Client wäre eine
// zweite Antwort auf dieselbe Frage – und die Bibliothek dafür läge dann zweimal im Bundle.
//
// ⚠️ Zwei Ebenen Farbe, nicht eine: die ZEILE bekommt einen schwachen Grund („hier hat sich etwas
// getan"), das geänderte WORT einen kräftigen („und zwar das"). Mit nur einer Stärke ist die
// Ansicht entweder ein rot-grüner Block wie jeder Zeilendiff oder die Markierung geht unter –
// dieselbe Überlegung wie beim Balken/Grund im Themen-Bündel.
import { computed } from 'vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({
  diff: { type: Object, default: null },
})

const rows = computed(() => props.diff?.rows || [])

// Leere Zeilen brauchen trotzdem Höhe, sonst rutschen die beiden Spalten gegeneinander –
// und genau ihre gemeinsame Höhe ist der ganze Punkt der Gegenüberstellung.
function cellText(segs) {
  return segs && segs.length ? segs : [{ text: '', changed: false }]
}
</script>

<template>
  <div class="ad-wrap">
    <!-- Titel und Zusammenfassung stehen nicht IM Text und fänden im Zeilendiff nicht statt.
         Eine Fassung, die nur den Titel ändert, sähe sonst aus wie eine ohne jede Änderung. -->
    <div v-if="diff?.meta?.title_changed || diff?.meta?.summary_changed" class="ad-meta">
      <Icon icon="lucide:pencil" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <template v-if="diff.meta.title_changed">
          Title: <s class="opacity-60">{{ diff.from.title }}</s> → <strong>{{ diff.to.title }}</strong>
        </template>
        <template v-if="diff.meta.title_changed && diff.meta.summary_changed"> · </template>
        <template v-if="diff.meta.summary_changed">Summary changed</template>
      </span>
    </div>

    <div class="ad-head">
      <div class="ad-head-cell">{{ diff?.from ? `Version ${diff.from.version_number}` : 'Empty' }}</div>
      <div class="ad-head-cell">Version {{ diff?.to?.version_number }}</div>
    </div>

    <div class="ad-body">
      <template v-for="(row, i) in rows" :key="i">
        <!-- Zusammengefaltete unveränderte Strecke. Sie wird ANGESCHRIEBEN statt weggelassen:
             ein Sprung von Zeile 12 auf Zeile 300 sähe sonst aus wie ein Fehler der Ansicht. -->
        <div v-if="row.kind === 'gap'" class="ad-gap">
          <span class="ad-gap-line" />
          <span class="ad-gap-text">{{ row.lines }} unchanged {{ row.lines === 1 ? 'line' : 'lines' }}</span>
          <span class="ad-gap-line" />
        </div>

        <div v-else class="ad-row" :class="`ad-row--${row.kind}`">
          <div class="ad-no">{{ row.leftNo ?? '' }}</div>
          <div class="ad-cell ad-cell--left">
            <span v-for="(seg, s) in cellText(row.left)" :key="s" :class="seg.changed ? 'ad-seg-del' : ''">{{ seg.text }}</span>
          </div>
          <div class="ad-no">{{ row.rightNo ?? '' }}</div>
          <div class="ad-cell ad-cell--right">
            <span v-for="(seg, s) in cellText(row.right)" :key="s" :class="seg.changed ? 'ad-seg-add' : ''">{{ seg.text }}</span>
          </div>
        </div>
      </template>

      <p v-if="!rows.length" class="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
        These two versions are identical.
      </p>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

.ad-wrap {
  @apply overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)];
}

.ad-meta {
  @apply flex items-start gap-2 border-b border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text)];
  background-color: color-mix(in srgb, var(--color-accent) 7%, transparent);
}

.ad-head {
  @apply grid border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] font-mono text-2xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)];
  grid-template-columns: 1fr 1fr;
}
.ad-head-cell {
  @apply px-4 py-2;
}
.ad-head-cell + .ad-head-cell {
  @apply border-l border-[var(--color-border)];
}

.ad-body {
  @apply max-h-[calc(100vh-19rem)] overflow-auto;
}

/* Zeilennummer + Zelle, zweimal. Feste Nummernspalte, damit die beiden Textspalten exakt gleich
   breit bleiben – ungleiche Spalten lesen sich als unterschiedlich viel Text. */
.ad-row {
  @apply grid items-stretch;
  grid-template-columns: 3rem minmax(0, 1fr) 3rem minmax(0, 1fr);
}

.ad-no {
  @apply select-none border-r border-[var(--color-border)] px-2 py-0.5 text-right font-mono text-2xs leading-6 text-[var(--color-text-muted)] opacity-60;
}

.ad-cell {
  /* pre-wrap: Einrückung und Leerzeilen von Markdown sind Bedeutung, kein Zufall – und lange
     Absätze müssen trotzdem umbrechen, sonst scrollt die Ansicht waagerecht. */
  @apply whitespace-pre-wrap break-words px-3 py-0.5 font-mono text-xs leading-6 text-[var(--color-text)];
}
.ad-cell--left {
  @apply border-r border-[var(--color-border)];
}

/* Die Zeilen-Ebene: schwach, sagt nur „hier". */
.ad-row--del .ad-cell--left,
.ad-row--change .ad-cell--left {
  background-color: color-mix(in srgb, var(--color-danger) 8%, transparent);
}
.ad-row--add .ad-cell--right,
.ad-row--change .ad-cell--right {
  background-color: color-mix(in srgb, var(--color-success) 8%, transparent);
}
/* Eine reine Einfügung hat links nichts – die leere Seite wird gedämpft, statt so auszusehen,
   als stünde dort eine Zeile, die man nur nicht liest. */
.ad-row--add .ad-cell--left,
.ad-row--del .ad-cell--right {
  background-color: color-mix(in srgb, var(--color-text-muted) 4%, transparent);
}

/* Die Wort-Ebene: kräftig, sagt „das". */
.ad-seg-del {
  @apply rounded-[3px];
  background-color: color-mix(in srgb, var(--color-danger) 32%, transparent);
}
.ad-seg-add {
  @apply rounded-[3px];
  background-color: color-mix(in srgb, var(--color-success) 32%, transparent);
}

.ad-gap {
  @apply flex items-center gap-3 px-4 py-2;
  background-color: color-mix(in srgb, var(--color-text-muted) 5%, transparent);
}
.ad-gap-line {
  @apply h-px flex-1 bg-[var(--color-border)];
}
.ad-gap-text {
  @apply font-mono text-2xs uppercase tracking-[0.1em] text-[var(--color-text-muted)];
}
</style>
