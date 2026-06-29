<script setup>
// Custom Vue-Flow-Kante fuer ALLE Klassen-Kanten (Call + Import).
// - Call-Kante: Label am (gestaffelten) Mittelpunkt zeigt den aufgerufenen Methodennamen,
//   ist klickbar und hat Hover-Schnellaktionen (Bearbeiten/Loeschen). Manuelle Kanten:
//   gestrichelt + Link-Icon. Unsichere Auto-Kanten: "Bitte pruefen"-Badge.
// - Import-Kante (data.kind === 'import'): nur die Linie, KEIN Label, nicht klickbar.
// Callbacks kommen aus edge.data (von JavaDependencyGraph gesetzt; Vue Flow leitet keine
// Custom-Emits an den Parent).
//
// Parallele Kanten desselben Knotenpaars teilen sich Bottom-/Top-Handle und laegen sonst
// deckungsgleich. Loesung in ZWEI Achsen, gesteuert ueber parallelIndex/parallelCount (vom
// Parent ueber das UNGEORDNETE Knotenpaar vergeben, Call + Import gemeinsam):
//   1) Linien: Endpunkte (und damit der Pfad) horizontal auffaechern (fanOffset).
//   2) Labels: zusaetzlich vertikal staffeln (labelStagger) statt rotieren – rotierte Labels
//      sind schlechter lesbar; gestapelte, leicht versetzte Labels bleiben waagerecht lesbar.
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

const SPREAD = 26 // px horizontaler Abstand zwischen parallelen Linien
const LABEL_STEP = 18 // px vertikaler Versatz gestapelter Labels

// Symmetrisch um die Mitte verteilen: jeder Index erhaelt einen eindeutigen Offset.
const spread = (step) => {
  const count = props.data?.parallelCount || 1
  const index = props.data?.parallelIndex || 0
  return count > 1 ? (index - (count - 1) / 2) * step : 0
}
const fanOffset = computed(() => spread(SPREAD))
const labelStagger = computed(() => spread(LABEL_STEP))

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
const labelY = computed(() => pathData.value[2] + labelStagger.value)

const d = computed(() => props.data || {})
</script>

<template>
  <BaseEdge :id="id" :path="edgePath" :marker-end="markerEnd" :style="d.edgeStyle" />

  <!-- Import- und uses-Kanten haben kein Label (nur die Linie). -->
  <EdgeLabelRenderer v-if="d.kind !== 'import' && d.kind !== 'uses'">
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
      <!-- Gebuendelte Kante (>1 Methode): kompaktes Chip „n Methoden"; sonst der Methodenname. -->
      <span v-if="d.bundleCount > 1" class="me-method me-count" title="Mehrere Methoden – Details anzeigen">
        <Icon icon="lucide:braces" class="me-ic" />{{ d.bundleCount }} Methoden
      </span>
      <span v-else class="me-method">{{ d.method ? d.method + '()' : '—' }}</span>

      <span v-if="d.needsReview" class="me-badge" title="Unsicher erkannt – bitte prüfen">
        <Icon icon="lucide:alert-triangle" class="me-ic" />Bitte prüfen
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
/* Buendel-Chip „n Methoden": dezent abgesetzt, mit fuehrendem Icon. */
.me-count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-weight: 700;
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
</style>
