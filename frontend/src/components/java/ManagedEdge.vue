<script setup>
// Custom Vue-Flow-Kante fuer die persistierten Klassen-Kanten.
// - Label am Mittelpunkt (EdgeLabelRenderer) zeigt den aufgerufenen Methodennamen.
// - Manuelle Kanten: gestrichelt + Link-Icon. Unsichere Auto-Kanten: "Bitte pruefen"-Badge.
// - Hover blendet Schnell-Aktionen (Bearbeiten/Loeschen) ein -> rufen Callbacks aus edge.data
//   auf (von JavaDependencyGraph gesetzt; Vue Flow leitet keine Custom-Emits an den Parent).
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@vue-flow/core'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  id: { type: String, required: true },
  sourceX: { type: Number, default: 0 },
  sourceY: { type: Number, default: 0 },
  targetX: { type: Number, default: 0 },
  targetY: { type: Number, default: 0 },
  sourcePosition: { type: String, default: 'bottom' },
  targetPosition: { type: String, default: 'top' },
  markerEnd: { type: String, default: '' },
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
})

// Parallele Kanten desselben Knotenpaars (A ruft mehrere Methoden von B) teilen sich Bottom-/
// Top-Handle und liegen sonst deckungsgleich. Darum die Endpunkte (und damit das Label)
// senkrecht zur Hauptrichtung X-versetzen -> die Kanten faechern sichtbar auf.
const SPREAD = 26 // px Abstand zwischen parallelen Kanten
const fanOffset = computed(() => {
  const count = props.data?.parallelCount || 1
  const index = props.data?.parallelIndex || 0
  return count > 1 ? (index - (count - 1) / 2) * SPREAD : 0
})

const pathData = computed(() =>
  getSmoothStepPath({
    sourceX: props.sourceX + fanOffset.value,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX + fanOffset.value,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  }),
)
const edgePath = computed(() => pathData.value[0])
const labelX = computed(() => pathData.value[1])
const labelY = computed(() => pathData.value[2])

const d = computed(() => props.data || {})
</script>

<template>
  <BaseEdge :id="id" :path="edgePath" :marker-end="markerEnd" :style="d.edgeStyle" />

  <EdgeLabelRenderer>
    <div
      class="me-label"
      :class="{
        'me-label--manual': d.isManual,
        'me-label--review': d.needsReview,
        'me-label--selected': selected,
      }"
      :style="{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }"
      title="Details anzeigen"
      @click.stop="d.onOpen && d.onOpen(d, $event)"
    >
      <Icon v-if="d.isManual" icon="lucide:link" class="me-ic me-ic--manual" title="Manuelle Kante" />
      <span class="me-method">{{ d.method ? d.method + '()' : '—' }}</span>

      <span v-if="d.needsReview" class="me-badge" title="Unsicher erkannt – bitte prüfen">
        <Icon icon="lucide:alert-triangle" class="me-ic" />Bitte prüfen
      </span>

      <span class="me-actions">
        <button type="button" class="me-act" title="Bearbeiten" @click.stop="d.onEdit && d.onEdit(d, $event)">
          <Icon icon="lucide:pencil" class="me-ic" />
        </button>
        <button
          type="button"
          class="me-act me-act--danger"
          title="Löschen"
          @click.stop="d.onDelete && d.onDelete(d, $event)"
        >
          <Icon icon="lucide:trash-2" class="me-ic" />
        </button>
      </span>
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
@reference "../../assets/style.css";

/* EdgeLabelRenderer-Overlay ist pointer-events:none -> Label muss Klicks wieder annehmen. */
.me-label {
  position: absolute;
  pointer-events: all;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-accent);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.me-label--manual {
  border-style: dashed;
}
.me-label--review {
  border-color: color-mix(in srgb, #d4a017 60%, var(--color-border));
}
.me-label--selected {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 45%, transparent);
}
.me-method {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.me-ic {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}
.me-ic--manual {
  color: var(--color-text-muted);
}
.me-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: #d4a017;
}
/* Schnell-Aktionen: erst bei Hover/Selektion sichtbar (halten das Label kompakt). */
.me-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-width 0.15s ease, opacity 0.15s ease;
}
.me-label:hover .me-actions,
.me-label--selected .me-actions {
  max-width: 48px;
  opacity: 1;
}
.me-act {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--color-text-muted);
  transition: background 0.12s ease, color 0.12s ease;
}
.me-act:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.me-act--danger:hover {
  color: #dc2626;
}
</style>
