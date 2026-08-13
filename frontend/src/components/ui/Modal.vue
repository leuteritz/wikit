<script setup>
// Die EINE Form, in der diese Anwendung etwas ueber die Ansicht legt.
//
// Vorher stand dieselbe Konstruktion – `Teleport` + Verdunkelung + Karte – an zehn Stellen
// woertlich gleich im Markup, jede mit ihrer eigenen Uebergangsanimation, drei ganz ohne, und
// keine einzige mit einem Fokus-Kaefig. Wer mit `Tab` durch ein offenes Modal ging, lief in die
// Seite dahinter.
//
// ⚠️ `closeOnEscape` ist absichtlich standardmaessig AUS. In diesem Projekt gehoert Escape der
// ANSICHT, nicht der Komponente: `App.vue` schliesst damit Palette, Kuerzel-Uebersicht und
// Aktivitaets-Fenster zusammen, und `CodeView` hat eine Vorrangordnung (der Analyse-Dialog
// schliesst nur, wenn kein Konflikt-Dialog darueber liegt). Ein Modal, das Escape bedingungslos
// selbst behandelt, macht diese Ordnung kaputt. Nur wer seinen eigenen Listener hatte, schaltet
// es hier ein.
import { computed, ref, toRef, watch, onBeforeUnmount } from 'vue'
import { useFocusTrap } from '../../composables/useFocusTrap.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** sm/md = Bestaetigungen · lg/xl = Inhalt · full = Arbeitsflaechen (Queue, Export) */
  size: { type: String, default: 'lg' },
  /** Deckel fuer die Hoehe. Leer = die Karte waechst mit ihrem Inhalt (Bestaetigungen). */
  maxHeight: { type: String, default: '' },
  /** Kompakte Karte ohne Kopf/Fuss-Aufbau: Polster direkt an der Karte (Bestaetigungen). */
  padded: { type: Boolean, default: false },
  /** elev-3 „schwebt" (Modal) · elev-4 „ueber allem" (haelt die ganze Ansicht an). */
  elevation: { type: String, default: 'elev-3' },
  emphasis: { type: Boolean, default: false },
  // ⚠️ Die Verdunkelung traegt `backdrop-blur`. Im Graphen ist `filter`/`backdrop-filter` sonst
  // verboten (der Compositor zeichnet grosse Flaechen schwarz) – hier liegt es aber ueber der
  // ganzen Ansicht statt in ihr, und genau so lief es an allen zehn Vorlaeufern. Der Schalter
  // steht trotzdem hier, damit es EINE Stelle waere, wenn es auf dem Pi je kippt.
  blur: { type: Boolean, default: true },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEscape: { type: Boolean, default: false },
  label: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: 'max-w-6xl',
}

const card = ref(null)
useFocusTrap(card, toRef(props, 'open'))

const cardClass = computed(() => [
  SIZES[props.size] || SIZES.lg,
  props.maxHeight,
  props.elevation,
  props.emphasis ? 'border-line-strong' : 'border-line',
  props.padded ? 'p-5' : 'overflow-hidden',
])

function onEscape(e) {
  if (e.key === 'Escape' && props.open) emit('close')
}
watch(
  () => props.open && props.closeOnEscape,
  (on) => {
    if (on) document.addEventListener('keydown', onEscape)
    else document.removeEventListener('keydown', onEscape)
  },
  { immediate: true },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <Teleport to="body">
    <Transition name="wk-modal">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        :class="blur ? 'backdrop-blur-sm' : ''"
        @click.self="closeOnBackdrop && emit('close')"
      >
        <div
          ref="card"
          class="wk-modal-card flex w-full flex-col rounded-2xl border bg-surface-2"
          :class="cardClass"
          role="dialog"
          aria-modal="true"
          :aria-label="label || undefined"
          tabindex="-1"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Eine Bewegung fuer alle Overlays. Die Vorlaeufer hatten vier Varianten derselben Geste
   (0.16 s/0.18 s, translateY ±8px, scale 0.98/0.99) und drei Dialoge gar keine – das Erscheinen
   ohne Uebergang liest sich wie ein Sprung, nicht wie „hier ist jetzt etwas". */
.wk-modal-enter-active,
.wk-modal-leave-active {
  transition: opacity 0.18s ease;
}
.wk-modal-enter-from,
.wk-modal-leave-to {
  opacity: 0;
}
.wk-modal-enter-active .wk-modal-card,
.wk-modal-leave-active .wk-modal-card {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.wk-modal-enter-from .wk-modal-card,
.wk-modal-leave-to .wk-modal-card {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .wk-modal-enter-active,
  .wk-modal-leave-active,
  .wk-modal-enter-active .wk-modal-card,
  .wk-modal-leave-active .wk-modal-card {
    transition: none;
  }
  .wk-modal-enter-from .wk-modal-card,
  .wk-modal-leave-to .wk-modal-card {
    transform: none;
  }
}
</style>
