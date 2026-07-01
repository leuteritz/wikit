// Zentrale, OFFLINE gebuendelte Icon-Registry (Iconify).
//
// Wikit laeuft "fully local" (Raspberry Pi, keine Internet-Pflicht). `@iconify/vue` wuerde
// Icons per Default zur LAUFZEIT von api.iconify.design nachladen -> das wuerde den Offline-
// Betrieb brechen. Deshalb importieren wir hier jedes benoetigte Icon einzeln (tree-shakebar,
// winziger Bundle) und registrieren es per `addIcon`. Templates nutzen danach den String-Namen
// (z. B. <Icon icon="lucide:search" />), aufgeloest rein aus dem Bundle -> KEIN Netzwerk.
//
// Neues Icon? Hier importieren + `addIcon` ergaenzen, sonst rendert es leer (offline keine API).
// Iconify ist die EINZIGE Icon-Quelle im Projekt: keine Emojis, keine inline-<svg>, keine andere Lib.
import { Icon, addIcon } from '@iconify/vue'

// --- Lucide (Stroke-Icons, UI-Chrome) ---
import search from '@iconify-icons/lucide/search'
import x from '@iconify-icons/lucide/x'
import sun from '@iconify-icons/lucide/sun'
import moon from '@iconify-icons/lucide/moon'
import bookOpen from '@iconify-icons/lucide/book-open'
import braces from '@iconify-icons/lucide/braces'
import listChecks from '@iconify-icons/lucide/list-checks'
import share2 from '@iconify-icons/lucide/share-2'
import plus from '@iconify-icons/lucide/plus'
import upload from '@iconify-icons/lucide/upload'
import trash2 from '@iconify-icons/lucide/trash-2'
import chevronDown from '@iconify-icons/lucide/chevron-down'
import chevronLeft from '@iconify-icons/lucide/chevron-left'
import chevronRight from '@iconify-icons/lucide/chevron-right'
import arrowRight from '@iconify-icons/lucide/arrow-right'
import sparkles from '@iconify-icons/lucide/sparkles'
import list from '@iconify-icons/lucide/list'
import foldVertical from '@iconify-icons/lucide/fold-vertical'
import unfoldVertical from '@iconify-icons/lucide/unfold-vertical'
import loader2 from '@iconify-icons/lucide/loader-2'
import check from '@iconify-icons/lucide/check'
import alertTriangle from '@iconify-icons/lucide/alert-triangle'
import refreshCw from '@iconify-icons/lucide/refresh-cw'
import zoomIn from '@iconify-icons/lucide/zoom-in'
import zoomOut from '@iconify-icons/lucide/zoom-out'
import maximize from '@iconify-icons/lucide/maximize'
import rotateCcw from '@iconify-icons/lucide/rotate-ccw'
import fileText from '@iconify-icons/lucide/file-text'
import pencil from '@iconify-icons/lucide/pencil'
import play from '@iconify-icons/lucide/play'
import info from '@iconify-icons/lucide/info'
import folder from '@iconify-icons/lucide/folder'
import fileCode from '@iconify-icons/lucide/file-code'
import box from '@iconify-icons/lucide/box'
import wand2 from '@iconify-icons/lucide/wand-2'
import clock from '@iconify-icons/lucide/clock'
import copy from '@iconify-icons/lucide/copy'
import code2 from '@iconify-icons/lucide/code-2'
import arrowDown from '@iconify-icons/lucide/arrow-down'
import arrowUpDown from '@iconify-icons/lucide/arrow-up-down'
import target from '@iconify-icons/lucide/target'
import link from '@iconify-icons/lucide/link'
import terminal from '@iconify-icons/lucide/terminal'
import checkCircle from '@iconify-icons/lucide/check-circle'
import gitBranch from '@iconify-icons/lucide/git-branch'
import gitFork from '@iconify-icons/lucide/git-fork'
import arrowUpFromLine from '@iconify-icons/lucide/arrow-up-from-line'
import unlink from '@iconify-icons/lucide/unlink'
import layoutGrid from '@iconify-icons/lucide/layout-grid'

// --- Phosphor (Duotone, fuer das Brand-Logo) ---
import phBooksDuotone from '@iconify-icons/ph/books-duotone'

const ICONS = {
  'lucide:search': search,
  'lucide:x': x,
  'lucide:sun': sun,
  'lucide:moon': moon,
  'lucide:book-open': bookOpen,
  'lucide:braces': braces,
  'lucide:list-checks': listChecks,
  'lucide:share-2': share2,
  'lucide:plus': plus,
  'lucide:upload': upload,
  'lucide:trash-2': trash2,
  'lucide:chevron-down': chevronDown,
  'lucide:chevron-left': chevronLeft,
  'lucide:chevron-right': chevronRight,
  'lucide:arrow-right': arrowRight,
  'lucide:sparkles': sparkles,
  'lucide:list': list,
  'lucide:fold-vertical': foldVertical,
  'lucide:unfold-vertical': unfoldVertical,
  'lucide:loader-2': loader2,
  'lucide:check': check,
  'lucide:alert-triangle': alertTriangle,
  'lucide:refresh-cw': refreshCw,
  'lucide:zoom-in': zoomIn,
  'lucide:zoom-out': zoomOut,
  'lucide:maximize': maximize,
  'lucide:rotate-ccw': rotateCcw,
  'lucide:file-text': fileText,
  'lucide:pencil': pencil,
  'lucide:play': play,
  'lucide:info': info,
  'lucide:folder': folder,
  'lucide:file-code': fileCode,
  'lucide:box': box,
  'lucide:wand-2': wand2,
  'lucide:clock': clock,
  'lucide:copy': copy,
  'lucide:code-2': code2,
  'lucide:arrow-down': arrowDown,
  'lucide:arrow-up-down': arrowUpDown,
  'lucide:target': target,
  'lucide:link': link,
  'lucide:terminal': terminal,
  'lucide:check-circle': checkCircle,
  'lucide:git-branch': gitBranch,
  'lucide:git-fork': gitFork,
  'lucide:arrow-up-from-line': arrowUpFromLine,
  'lucide:unlink': unlink,
  'lucide:layout-grid': layoutGrid,
  'ph:books-duotone': phBooksDuotone,
}

for (const [name, data] of Object.entries(ICONS)) addIcon(name, data)

export { Icon }
