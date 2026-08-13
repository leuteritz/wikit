<script setup>
// „Bist du sicher?" – die Form, die es in dieser Anwendung dreimal woertlich gleich gab
// (Klasse loeschen · Klassen ueberschreiben · alles zuruecksetzen) und die dabei nicht einmal
// einen Uebergang hatte: der Dialog stand ploetzlich da.
//
// Der Rumpf ist ein Slot, weil er sich unterscheidet – einmal ein Satz, einmal die Liste der
// betroffenen Klassen, einmal ein laufender Fortschrittsbalken. Gleich ist alles darum herum:
// Ton, Icon, Titel, Zeile darunter, und die zwei Knoepfe rechts unten in derselben Reihenfolge.
import { computed } from 'vue'
import { Icon } from '../../lib/icons.js'
import Modal from './Modal.vue'
import Button from './Button.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** danger = unumkehrbar · warning = ueberschreibt · accent = gewoehnliche Bestaetigung */
  tone: { type: String, default: 'danger' },
  icon: { type: String, default: '' },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  cancelLabel: { type: String, default: 'Cancel' },
  busy: { type: Boolean, default: false },
  busyLabel: { type: String, default: '' },
  size: { type: String, default: 'sm' },
})
const emit = defineEmits(['confirm', 'cancel'])

// Der Kreis traegt den Ton als Tint. `/15` statt des frueheren
// `color-mix(in srgb, … 16%, transparent)`: seit die Farben Theme-Tokens sind, ist der
// Opacity-Modifier der direkte Weg – er rechnet in oklab statt srgb, was bei 15 % nicht zu
// sehen ist, aber den handgeschriebenen Ausdruck aus dem Markup nimmt.
const TONES = {
  danger: { ring: 'bg-danger/15 text-danger', icon: 'lucide:alert-triangle', variant: 'danger' },
  warning: { ring: 'bg-warning/15 text-warning', icon: 'lucide:alert-triangle', variant: 'primary' },
  accent: { ring: 'bg-accent-soft text-accent', icon: 'lucide:help-circle', variant: 'primary' },
}
const tone = computed(() => TONES[props.tone] || TONES.danger)
</script>

<template>
  <Modal :open="open" :size="size" padded :label="title" @close="emit('cancel')">
    <div class="mb-3 flex items-center gap-3">
      <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full" :class="tone.ring">
        <Icon :icon="icon || tone.icon" class="h-5 w-5" />
      </span>
      <div class="min-w-0">
        <h3 class="truncate font-semibold text-ink">{{ title }}</h3>
        <!-- Slot statt nur Prop: unter dem Titel steht mal ein Satz, mal ein Klassenname –
             und ein Klassenname gehoert in dieser Anwendung in die Schreibmaschinenschrift. -->
        <p v-if="$slots.subtitle || subtitle" class="truncate text-xs text-muted">
          <slot name="subtitle">{{ subtitle }}</slot>
        </p>
      </div>
    </div>

    <div class="mb-4 text-sm text-muted"><slot /></div>

    <div class="flex justify-end gap-2">
      <Button variant="secondary" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</Button>
      <Button :variant="tone.variant" :busy="busy" :busy-label="busyLabel" @click="emit('confirm')">
        {{ confirmLabel }}
      </Button>
    </div>
  </Modal>
</template>
