/**
 * Der Testschatten: **was von diesem Code fasst kein Test an?**
 *
 * Jeder andere Reiter fragt, wie der Code beschaffen ist. Dieser fragt, was ihn absichert – und
 * zwar an der Stelle, an der die Frage weh tut: nicht „wie viel Prozent sind abgedeckt" (die Zahl
 * kennt jeder und niemand handelt danach), sondern „die Klasse, die hier ganz oben steht, wird von
 * nichts berührt".
 *
 * ⚠️ **`@Test` steht nicht in der Datenbank.** Der Parser filtert Annotationen bewusst aus den
 * `modifiers` heraus (nur echte Keywords wandern in die Signatur), und `raw_source` nach `@Test` zu
 * durchsuchen hiesse, die groesste Spalte der Datenbank fuer jeden Aufruf des Berichts zu lesen.
 * Erkannt wird deshalb an zwei Spuren, die ohnehin gespeichert sind:
 *
 *   1. **Der Import eines Testframeworks** (`java_dependencies`) – der harte Beleg. Eine Klasse,
 *      die `org.junit.jupiter.api.Test` importiert, ist ein Test, egal wie sie heisst. Dieselbe
 *      Ueberlegung wie beim Reiter „Outside": die Importzeile ist die Spur, die etwas hinterlaesst,
 *      das sonst nirgends steht.
 *   2. **Der Name** – der weiche Beleg, und zwar fuer genau zwei Faelle: Altbestand ohne
 *      gespeicherte Importzeilen, und Tests, die ueber eine eigene Basisklasse laufen.
 *
 * Welcher der beiden zutraf, faehrt bis in die Oberflaeche mit (`evidence`): ein Befund, der auf
 * einer Namensregel beruht, muss als solcher lesbar sein.
 *
 * ⚠️ **Und die wichtigste Festlegung ist der Leerzustand:** findet sich keine einzige Testklasse,
 * ist das KEIN Befund, sondern die Auskunft „hier liegen keine Tests". Wer nur seinen
 * Produktivcode hochlaedt, bekaeme sonst eine Mangelliste ueber seinen gesamten Bestand – eine
 * Zahl, die nie 0 wird, fordert zu nichts auf (dasselbe Argument, mit dem die Brandherde nicht in
 * die Sidebar wandern).
 */

// Was die Rechnung von einer Klasse braucht. Bewusst strukturell und nicht `ClassRow` aus dem
// Service: `score` und `driver` entstehen erst dort, und ein Import in beide Richtungen waere ein
// Zirkel. Gleiche Bauart wie `split-plan.ts`.
export type ShadowClass = {
  id: number;
  className: string;
  package: string;
  score: number;
  loc: number;
  complexity: number;
  driver: string;
  cycle: number | null;
};

// Ein aufgeloestes Klassenpaar: `from` benutzt `to`. Nur diese Richtung zaehlt – ein Test benutzt
// die Klasse, die er prueft, nie umgekehrt.
export type ShadowPair = { from: number; to: number };

export type ShadowImport = { from_file_id: number; to_class_name: string };

// Wie viele ungedeckte Klassen die Rangliste namentlich nennt. Sie ist eine Arbeitsliste, keine
// zweite Ausgabe der Codebasis – wer 400 Zeilen sieht, faengt bei keiner an. Der Rest wird gezaehlt.
const UNCOVERED_SAMPLE = 25;
// Wie viele Testklassen die Gegenliste zeigt. Sie beantwortet „was habe ich ueberhaupt?", und dafuer
// reicht ein Ausschnitt.
const TEST_SAMPLE = 40;
// Wie viele Tests ohne auffindbares Subjekt genannt werden.
const ORPHAN_SAMPLE = 12;

/**
 * Packages, aus denen ein Import die Klasse zum Test macht. Praefixe statt einer Namensliste –
 * `org.junit.Test` und `org.junit.jupiter.api.Test` sind dieselbe Herkunft.
 *
 * ⚠️ Mockito, AssertJ und Hamcrest stehen bewusst dabei, obwohl sie keine Test-RUNNER sind: eine
 * Klasse, die mockt oder assertet, ist ein Test – auch dann, wenn ihr eigentlicher `@Test` in einer
 * geerbten Basisklasse steht. Falsch herum liegt man damit praktisch nie, denn Produktivcode nimmt
 * keine Abhaengigkeit auf eine Assertion-Bibliothek.
 */
const TEST_IMPORT_PREFIXES = [
  'org.junit',
  'junit.framework',
  'org.testng',
  'org.mockito',
  'org.easymock',
  'org.jmock',
  'org.powermock',
  'org.assertj',
  'org.hamcrest',
  'com.google.common.truth',
  'io.cucumber',
  'net.jqwik',
  'org.springframework.test',
  'org.springframework.boot.test',
  'io.quarkus.test',
  'io.micronaut.test',
  'org.robolectric',
  'androidx.test',
  'org.awaitility',
  'org.testcontainers',
  'com.tngtech.archunit',
];

const startsWithPkg = (name: string, prefix: string) => name === prefix || name.startsWith(`${prefix}.`);
const isTestImport = (fqcn: string) => TEST_IMPORT_PREFIXES.some((p) => startsWithPkg(fqcn, p));

/**
 * Der Name als Beleg.
 *
 * ⚠️ **`IT` allein ist die Falle dieser Regel.** Ein blosses `endsWith('IT')` trifft `AUDIT`,
 * `SUBMIT`, `EXIT` und `SPLIT` – lauter Klassennamen, die es wirklich gibt. Das Kuerzel steht aber
 * immer als eigenes Wort am Ende eines CamelCase-Namens, also muss davor ein Klein- oder
 * Zifferzeichen stehen (`OrderIT` ja, `AUDIT` nein).
 *
 * Bewusst NICHT dabei: `…Spec`. Spock-Spezifikationen sind Groovy, und Wikit liest nur `.java` –
 * die Regel koennte hier also nur Fehltreffer erzeugen (`OpenApiSpec`, `FileSpec`) und keinen
 * einzigen echten Fund.
 */
const TEST_NAME = /(?:^Test[A-Z0-9]|Tests?$|TestCase$|TestSuite$|[a-z0-9]IT$|[a-z0-9]ITCase$)/;

/**
 * Auf welche Klasse zeigt der Name eines Tests? `OrderServiceTest` -> `OrderService`.
 *
 * Mehrere Kandidaten, weil mehrere Regeln greifen koennen – aufgeloest wird spaeter gegen den
 * Bestand, und zwar in dieser Reihenfolge. Die laengeren Endungen stehen zuerst: `FooTestCase`
 * soll `Foo` ergeben und nicht an der kuerzeren Regel vorbeilaufen.
 *
 * ⚠️ Ob der Name mit `Test` ANFAENGT oder AUFHOERT, faehrt mit – nicht fuer die Aufloesung, aber
 * fuer die Frage danach. Ein Suffix ist eine Zusage („dieser Test gehoert zu jener Klasse"), ein
 * Praefix ist es nicht: `TestFixtures`, `TestSupport` und `TestData` sind Hilfsklassen und
 * versprechen keine Klasse namens `Fixtures`. Gemessen wurde genau das – der Bericht forderte dazu
 * auf, eine Klasse hochzuladen, die es nie gegeben hat. Erkannt wird ein solcher Name weiterhin
 * als Test; nur als vermisstes Subjekt taugt er nicht.
 */
type Candidate = { name: string; fromSuffix: boolean };
function subjectCandidates(testName: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, fromSuffix: boolean) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, fromSuffix });
  };
  for (const suffix of ['TestCase', 'TestSuite', 'ITCase', 'Tests', 'Test', 'IT']) {
    if (testName.endsWith(suffix) && testName.length > suffix.length) {
      add(testName.slice(0, -suffix.length), true);
    }
  }
  if (/^Test[A-Z0-9]/.test(testName)) add(testName.slice(4), false);
  return out;
}

export function buildTestShadow(
  classes: ShadowClass[],
  pairs: ShadowPair[],
  imports: ShadowImport[],
): any {
  // --- 1. Wer ist ein Test? ---------------------------------------------------------------------
  const byImport = new Set<number>();
  let importLines = 0;
  for (const row of imports) {
    const raw = String(row.to_class_name || '');
    if (!raw) continue;
    importLines++;
    // Der Wildcard-Stern gehoert nicht zum Package-Namen (`org.junit.*` ist `org.junit`).
    const fqcn = raw.endsWith('.*') ? raw.slice(0, -2) : raw;
    if (isTestImport(fqcn)) byImport.add(Number(row.from_file_id));
  }

  type TestInfo = { cls: ShadowClass; evidence: 'imports' | 'name' };
  const tests = new Map<number, TestInfo>();
  for (const c of classes) {
    if (byImport.has(c.id)) tests.set(c.id, { cls: c, evidence: 'imports' });
    else if (TEST_NAME.test(c.className)) tests.set(c.id, { cls: c, evidence: 'name' });
  }

  // --- 2. Was prueft dieser Test? ---------------------------------------------------------------
  // ⚠️ Aufgeloest wird ueber den Bestand, nicht ueber den Namen allein: erst im EIGENEN Package
  // (dort liegt der Test bei jeder ueblichen Projektstruktur), dann im Bestand, sofern der Name
  // dort genau einmal vorkommt. Zwei gleichnamige Klassen sind nicht entscheidbar – und zu raten
  // hiesse hier, eine Abdeckung zu behaupten, die es vielleicht nicht gibt. Dieselbe Regel wie bei
  // `path:` im Code-Graphen: lieber keine Antwort als eine erfundene.
  const byName = new Map<string, ShadowClass[]>();
  for (const c of classes) {
    const list = byName.get(c.className);
    if (list) list.push(c);
    else byName.set(c.className, [c]);
  }

  const subjectOf = new Map<number, ShadowClass>();
  const orphans: Array<{ id: number; className: string; package: string; expected: string }> = [];
  for (const { cls } of tests.values()) {
    let hit: ShadowClass | null = null;
    // Nur ein SUFFIX macht aus „nicht gefunden" einen Befund (s. `subjectCandidates`).
    let promised = '';
    for (const { name, fromSuffix } of subjectCandidates(cls.className)) {
      if (fromSuffix && !promised) promised = name;
      const found = byName.get(name) || [];
      // Ein Test testet keinen Test – sonst gilt `OrderServiceTestTest` als Abdeckung fuer
      // `OrderServiceTest`, und die Kette faengt an, sich selbst zu bestaetigen.
      const usable = found.filter((f) => !tests.has(f.id));
      const samePkg = usable.filter((f) => f.package === cls.package);
      if (samePkg.length === 1) hit = samePkg[0];
      else if (usable.length === 1) hit = usable[0];
      if (hit) break;
    }
    if (hit) subjectOf.set(cls.id, hit);
    else if (promised) {
      // Der Name nennt eine Klasse, die hier nicht liegt. Das ist kein Fehler des Tests, sondern
      // derselbe Befund wie eine Luecke im Reiter „Outside": etwas fehlt im Bestand.
      orphans.push({ id: cls.id, className: cls.className, package: cls.package, expected: promised });
    }
  }

  // --- 3. Was beruehrt ein Test sonst noch? ------------------------------------------------------
  // Jede Kante, die von einer Testklasse ausgeht. „Beruehrt" ist bewusst schwaecher als „geprueft":
  // ein Test, der ein DTO als Parameter baut, testet es nicht – aber er laeuft durch es hindurch,
  // und das ist mehr als nichts. Die beiden Stufen stehen deshalb getrennt.
  const touchedBy = new Map<number, Set<number>>();
  const touches = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (!tests.has(p.from) || tests.has(p.to)) continue;
    let users = touchedBy.get(p.to);
    if (!users) touchedBy.set(p.to, (users = new Set()));
    users.add(p.from);
    let reach = touches.get(p.from);
    if (!reach) touches.set(p.from, (reach = new Set()));
    reach.add(p.to);
  }

  // Ein Subjekt gilt auch dann als beruehrt, wenn keine Kante es belegt: der Test kann die Klasse
  // ueber Reflection, Spring-Verdrahtung oder einen Helfer erreichen, und sein NAME sagt trotzdem
  // eindeutig, worum es geht.
  const testedBy = new Map<number, number[]>();
  for (const [testId, subject] of subjectOf) {
    const list = testedBy.get(subject.id);
    if (list) list.push(testId);
    else testedBy.set(subject.id, [testId]);
  }

  // --- 4. Die Abdeckung je Produktivklasse -------------------------------------------------------
  const production = classes.filter((c) => !tests.has(c.id));
  const nameOf = new Map<number, string>(classes.map((c) => [c.id, c.className]));

  const rows = production.map((c) => {
    const direct = testedBy.get(c.id) || [];
    const near = [...(touchedBy.get(c.id) || [])];
    return {
      id: c.id,
      className: c.className,
      package: c.package,
      score: c.score,
      loc: c.loc,
      complexity: c.complexity,
      driver: c.driver,
      cycle: c.cycle,
      // 'tested' – ein Test traegt ihren Namen · 'touched' – ein Test benutzt sie, hat sie aber
      // nicht zum Gegenstand · 'none'.
      coverage: direct.length ? 'tested' : near.length ? 'touched' : 'none',
      by: (direct.length ? direct : near).slice(0, 3).map((id) => ({ id, className: nameOf.get(id) || String(id) })),
      byCount: direct.length || near.length,
    };
  });

  const tested = rows.filter((r) => r.coverage === 'tested');
  const touchedOnly = rows.filter((r) => r.coverage === 'touched');
  const uncovered = rows.filter((r) => r.coverage === 'none');

  // ⚠️ **Die Prozentzahl, die zaehlt, ist die gewichtete.** „62 % der Klassen haben einen Test"
  // behandelt eine 12-Zeilen-Konstantenklasse wie den Brandherd daneben – und genau dieses
  // Verhaeltnis laesst sich mit Tests fuer die einfachen Faelle beliebig schoenrechnen. Gewichtet
  // wird deshalb mit dem Hotspot-Score: er ist bereits die Antwort auf „was kostet mich Zeit?".
  // Ohne berechnete Kanten sind alle Scores klein, aber nicht 0 – ist die Summe dennoch 0, ist die
  // Aussage nicht definiert (null) und nicht „0 %".
  const riskTotal = rows.reduce((s, r) => s + r.score, 0);
  const riskCovered = tested.reduce((s, r) => s + r.score, 0);

  const rank = (list: typeof rows) =>
    [...list].sort((a, b) => b.score - a.score || b.complexity - a.complexity || a.className.localeCompare(b.className));

  // Die Rangliste fuehrt beide ungedeckten Stufen zusammen, `none` zuerst: „kein Test kennt diese
  // Klasse" ist die schwerere Aussage als „ein Test laeuft durch sie hindurch". Innerhalb der Stufe
  // entscheidet der Score – die Frage lautet nicht „was fehlt", sondern „wo faengt man an".
  const shadow = [...rank(uncovered), ...rank(touchedOnly)];

  const testList = [...tests.values()]
    .map(({ cls, evidence }) => {
      const subject = subjectOf.get(cls.id);
      return {
        id: cls.id,
        className: cls.className,
        package: cls.package,
        evidence,
        subject: subject ? { id: subject.id, className: subject.className } : null,
        touches: (touches.get(cls.id) || new Set()).size,
      };
    })
    .sort((a, b) => b.touches - a.touches || a.className.localeCompare(b.className));

  return {
    totals: {
      tests: tests.size,
      byImport: [...tests.values()].filter((t) => t.evidence === 'imports').length,
      byName: [...tests.values()].filter((t) => t.evidence === 'name').length,
      production: production.length,
      tested: tested.length,
      touched: touchedOnly.length,
      uncovered: uncovered.length,
      orphans: orphans.length,
      // Wie viele Importzeilen ueberhaupt gespeichert sind. Ohne sie beruht die Erkennung allein
      // auf Namen, und die Oberflaeche muss das sagen duerfen – sonst liest sich „no tests found"
      // als Aussage ueber das Projekt statt ueber den Bestand.
      importLines,
      risk: {
        total: riskTotal,
        covered: riskCovered,
        pct: riskTotal > 0 ? Math.round((riskCovered / riskTotal) * 100) : null,
      },
    },
    // Der Befund: die schwersten Klassen, die kein Test zum Gegenstand hat.
    shadow: shadow.slice(0, UNCOVERED_SAMPLE),
    moreShadow: Math.max(0, shadow.length - UNCOVERED_SAMPLE),
    // Die Gegenliste – ein Bericht, der nur Fehlendes zeigt, wird als Noergeln gelesen und
    // irgendwann nicht mehr geoeffnet (dieselbe Ueberlegung wie beim geheilten Zyklus im Drift).
    tests: testList.slice(0, TEST_SAMPLE),
    moreTests: Math.max(0, testList.length - TEST_SAMPLE),
    orphans: orphans.slice(0, ORPHAN_SAMPLE),
    moreOrphans: Math.max(0, orphans.length - ORPHAN_SAMPLE),
  };
}
