import { Injectable } from '@nestjs/common';

// Serverseitige Java-Einrueckung fuer Code-Bloecke in Artikeln. Wird in der Markdown-Pipeline
// (MarkdownService.getMd -> core-Ruler `reindent-java`) VOR Shiki auf jeden ```java-Block
// angewandt, sodass das gerenderte/gecachte HTML bereits korrekt eingerueckt ist und das
// Frontend keinerlei Formatierungslogik braucht.
//
// Reiner Text-Transform: Zeilen werden anhand der `{`/`}`-Tiefe neu eingerueckt. Ein
// zeichen-genauer Scanner ignoriert Klammern in Strings ("…"), Chars ('…'), Zeilen-Kommentaren
// (//) und Block-Kommentaren (/* … */) inkl. Escapes (\). Bewusste Vereinfachung: kein
// Sonder-Indent fuer switch/case (case bleibt auf Block-Ebene), keine Behandlung mehrzeiliger
// Ausdruecke ohne Klammern – robust statt perfekt, fuer Notiz-Snippets ausreichend.

const INDENT_SIZE = 4;
const INDENT = ' '.repeat(INDENT_SIZE);

@Injectable()
export class CodeFormatterService {
  reindentJava(code: string): string {
    if (!code) return code;
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let depth = 0;
    let inBlockComment = false;

    for (const raw of lines) {
      const stripped = raw.trim();
      if (stripped === '') {
        out.push('');
        continue;
      }

      if (inBlockComment) {
        // Folgezeile eines Block-Kommentars: auf aktueller Tiefe; '*'-Zeilen um ein Zeichen
        // einruecken, damit sie unter dem oeffnenden '/*' ausgerichtet bleiben.
        const pad = INDENT.repeat(Math.max(0, depth));
        out.push(stripped.startsWith('*') ? pad + ' ' + stripped : pad + stripped);
        const scan = this.scanLine(stripped, true);
        depth = Math.max(0, depth + scan.delta);
        inBlockComment = scan.inBlockComment;
        continue;
      }

      // Fuehrende schliessende Klammern dedenten DIESE Zeile (z. B. `}`, `} else {`, `});`).
      // Nur `}` zaehlt – die Tiefe wird ausschliesslich ueber `{`/`}` gefuehrt.
      let lead = 0;
      for (const ch of stripped) {
        if (ch === '}') lead++;
        else break;
      }
      const lineDepth = Math.max(0, depth - lead);
      out.push(INDENT.repeat(lineDepth) + stripped);

      const scan = this.scanLine(stripped, false);
      depth = Math.max(0, depth + scan.delta);
      inBlockComment = scan.inBlockComment;
    }

    return out.join('\n');
  }

  // Scannt eine (getrimmte) Zeile und liefert die Netto-`{`/`}`-Tiefenaenderung sowie ob am
  // Zeilenende noch ein Block-Kommentar offen ist. Klammern in Strings/Chars/Kommentaren zaehlen
  // nicht.
  private scanLine(
    line: string,
    startInBlockComment: boolean,
  ): { delta: number; inBlockComment: boolean } {
    let delta = 0;
    let inBlock = startInBlockComment;
    let inString = false;
    let inChar = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlock) {
        if (ch === '*' && next === '/') {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch === '\\') i++;
        else if (ch === "'") inChar = false;
        continue;
      }

      if (ch === '/' && next === '/') break; // Zeilen-Kommentar -> Rest ignorieren
      if (ch === '/' && next === '*') {
        inBlock = true;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "'") {
        inChar = true;
        continue;
      }
      if (ch === '{') delta++;
      else if (ch === '}') delta--;
    }

    return { delta, inBlockComment: inBlock };
  }
}
