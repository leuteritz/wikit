<script setup>
// Globaler Toast-Stapel (unten rechts). Einziger Ort, an dem Benachrichtigungen gerendert werden –
// gespeist aus useNotifications(), das wiederum jeden fehlgeschlagenen Request aus lib/api.js
// erhaelt. Frueher hatte CodeView einen eigenen Toast; zwei Systeme nebeneinander hiesse, dass die
// Haelfte der App weiter stumm bleibt.
//
// Aufbau einer Karte, von oben nach unten in der Reihenfolge, in der man sie braucht:
//   1. Titel   – was ist passiert („Request rejected")
//   2. Meldung – WARUM, im Klartext vom Backend
//   3. Meta    – HTTP-Status + Endpunkt, klein; nur fuer den, der es wissen will
import { ref } from 'vue'
import { Icon } from '../lib/icons.js'
import { useNotifications } from '../composables/useNotifications.js'
import { copyToClipboard } from '../lib/clipboard.js'

const { items, dismiss, pause, resume } = useNotifications()

const ICONS = {
  error: 'lucide:alert-triangle',
  warning: 'lucide:alert-triangle',
  success: 'lucide:check-circle',
  info: 'lucide:info',
}

// Kopiertes Item kurz quittieren (der Knopf selbst ist die Rueckmeldung – ein Toast ueber einem
// Toast waere albern).
const copied = ref(0)
async function copyDetails(n) {
  const text = [n.title, n.message, n.meta, n.detail].filter(Boolean).join('\n')
  if (await copyToClipboard(text)) {
    copied.value = n.id
    setTimeout(() => {
      if (copied.value === n.id) copied.value = 0
    }, 1600)
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="nh-stack" role="region" aria-label="Notifications">
      <TransitionGroup name="nh">
        <div
          v-for="n in items"
          :key="n.id"
          class="nh-card"
          :class="`nh-card--${n.kind}`"
          :role="n.kind === 'error' ? 'alert' : 'status'"
          @mouseenter="pause(n.id)"
          @mouseleave="resume(n.id)"
        >
          <span class="nh-rail" />
          <Icon :icon="ICONS[n.kind] || ICONS.info" class="nh-icon" />

          <div class="nh-body">
            <p v-if="n.title" class="nh-title">
              {{ n.title }}
              <!-- Derselbe Fehler mehrfach: Zaehler statt Kartenstapel. -->
              <span v-if="n.count > 1" class="nh-count">×{{ n.count }}</span>
            </p>
            <p class="nh-msg">{{ n.message }}</p>
            <p v-if="n.meta" class="nh-meta">{{ n.meta }}</p>
          </div>

          <div class="nh-actions">
            <button
              v-if="n.kind === 'error'"
              type="button"
              class="nh-btn"
              :title="copied === n.id ? 'Copied' : 'Copy error details'"
              :aria-label="copied === n.id ? 'Copied' : 'Copy error details'"
              @click="copyDetails(n)"
            >
              <Icon :icon="copied === n.id ? 'lucide:check' : 'lucide:copy'" class="nh-btn-ic" />
            </button>
            <button type="button" class="nh-btn" title="Dismiss" aria-label="Dismiss" @click="dismiss(n.id)">
              <Icon icon="lucide:x" class="nh-btn-ic" />
            </button>
          </div>

          <!-- Ablaufbalken: macht sichtbar, dass die Karte von selbst geht (und wie lange noch).
               Laeuft als reine CSS-Animation und haelt beim Hover an – kein Timer im Render-Pfad. -->
          <span v-if="n.ttl" class="nh-timer" :style="{ animationDuration: `${n.ttl}ms` }" />
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
@reference "../assets/style.css";

.nh-stack {
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* Der Stapel selbst faengt nichts ab – nur die Karten. Sonst laege ein unsichtbares Rechteck
     ueber der rechten unteren Ecke der Seite. */
  pointer-events: none;
  max-width: min(26rem, calc(100vw - 2.5rem));
}

.nh-card {
  position: relative;
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  overflow: hidden;
  padding: 0.625rem 0.625rem 0.625rem 0.875rem;
  border-radius: 0.75rem;
  border: 1px solid var(--tone-border, var(--color-border));
  background: color-mix(in srgb, var(--color-surface-2) 92%, transparent);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.22);
  backdrop-filter: blur(8px);
}
/* Farbstreifen links statt flaechiger Einfaerbung: die Art der Meldung ist sofort erkennbar,
   der Text bleibt auf ruhigem Grund lesbar. */
.nh-rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--tone);
}
.nh-card--error {
  --tone: var(--color-danger);
  --tone-border: color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
}
.nh-card--warning {
  --tone: var(--color-warning);
  --tone-border: color-mix(in srgb, var(--color-warning) 42%, var(--color-border));
}
.nh-card--success {
  --tone: var(--color-success);
  --tone-border: color-mix(in srgb, var(--color-success) 38%, var(--color-border));
}
.nh-card--info {
  --tone: var(--color-accent);
}

.nh-icon {
  flex-shrink: 0;
  margin-top: 0.0625rem;
  width: 1.05rem;
  height: 1.05rem;
  color: var(--tone);
}
.nh-body {
  min-width: 0;
  flex: 1;
}
.nh-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--color-text);
}
.nh-count {
  border-radius: 999px;
  background: color-mix(in srgb, var(--tone) 20%, transparent);
  padding: 0 0.375rem;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--tone);
}
.nh-msg {
  /* Backend-Meldungen koennen lang sein (Parser-Fehler mit Zeilenangabe) – umbrechen lassen,
     nicht abschneiden: der Grund ist der eigentliche Inhalt der Karte. */
  margin-top: 0.125rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.nh-meta {
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.nh-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0.125rem;
}
.nh-btn {
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 0.375rem;
  color: var(--color-text-muted);
  opacity: 0.7;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.nh-btn:hover {
  opacity: 1;
  color: var(--color-text);
  background: var(--color-surface-offset);
}
.nh-btn-ic {
  width: 0.875rem;
  height: 0.875rem;
}

.nh-timer {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left;
  background: color-mix(in srgb, var(--tone) 55%, transparent);
  animation: nh-drain linear forwards;
}
.nh-card:hover .nh-timer {
  animation-play-state: paused;
}
@keyframes nh-drain {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

/* Ein- und Ausblenden: von rechts herein, beim Gehen zusammenfallen, damit die darunter
   liegenden Karten nicht springen. */
.nh-enter-active,
.nh-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.nh-enter-from {
  opacity: 0;
  transform: translateX(1.5rem) scale(0.97);
}
.nh-leave-to {
  opacity: 0;
  transform: translateX(1.5rem) scale(0.97);
}
.nh-move {
  transition: transform 0.22s ease;
}
@media (prefers-reduced-motion: reduce) {
  .nh-enter-active,
  .nh-leave-active,
  .nh-move {
    transition: none;
  }
  .nh-timer {
    animation: none;
  }
}
</style>
