import { describe, it, expect } from 'vitest';
import { classifyChatIntent } from '../../intent';

const mode = (text: string) => classifyChatIntent(text).mode;

describe('classifyChatIntent – Aufträge', () => {
	it.each([
		'Ok passe die Chat Funktion so an, dass sie automatisch unterscheiden kann',
		'Implementiere einen Dark Mode',
		'Füge im Header einen Logout-Button hinzu',
		'Baue eine Exportfunktion für CSV',
		'Erstelle eine neue Migration für die Tabelle',
		'Ändere die Farbe des Buttons auf Blau',
		'Entferne die alte Login-Seite',
		'Lösche die ungenutzten Dateien',
		'Fixe den Absturz beim Speichern',
		'Behebe den Fehler im Scheduler',
		'Repariere die Tests',
		'Refaktoriere die Endpunkte',
		'Schreibe Tests für den Scheduler',
		'Ergänze die README um einen Abschnitt',
		'Aktualisiere die Abhängigkeiten',
		'Verschiebe die Hilfsfunktionen nach utils',
		'Benenne die Variable um',
		'Mach den Chat auf dem Handy größer',
		'bitte die Tests reparieren',
		'Bitte den Login-Bug beheben.',
		'Kannst du den Login-Bug fixen?',
		'Kannst du bitte die Übersetzungen ergänzen?',
		'Könntest du die Seite mobil optimieren?',
		'Der Chat soll auf dem PC größer angezeigt werden',
		'Die Seite sollte auch mobil gut aussehen.',
		'Ich möchte, dass der Chat automatisch erkennt, was gemeint ist.',
		'Ich will, dass Fragen anders behandelt werden',
		'Der Build ist rot. Bitte repariere ihn.',
		'Wie geht das? Bitte implementiere es danach.',
		'Add dark mode',
		'Implement a CSV export',
		'Fix the login bug',
		'Please update the dependencies',
		'Can you refactor the scheduler?',
		'Could you remove the old endpoint?',
		'Rename the variable and move it to utils.',
		'ADD DARK MODE',
		'- Erstelle eine Seite für Einstellungen'
	])('„%s“ → task', (text) => {
		expect(classifyChatIntent(text)).toMatchObject({ mode: 'task', confidence: 'high' });
	});
});

describe('classifyChatIntent – Fragen', () => {
	it.each([
		'Wie funktioniert der Scheduler?',
		'Warum schlägt der Build fehl',
		'Kannst du erklären, wie die Migrationen funktionieren?',
		'Was macht protocol.ts?',
		'Wo werden die Runner registriert',
		'Wann läuft der Cleanup-Job',
		'Welche Rollen gibt es',
		'Wer darf Aufträge anlegen',
		'Wofür ist die Tabelle chat_message da',
		'Gibt es schon einen Export',
		'Ist der Runner online',
		'Sind alle Tests grün',
		'Hat das Projekt eine CI',
		'Erkläre mir den Ablauf eines Laufs',
		'Erklär mir bitte die Commit-Policy',
		'Zeig mir, wie man einen Runner einrichtet',
		'Der Build schlägt fehl. Woran liegt das?',
		'Ok, wie hängen Projekt und Runner zusammen',
		'What does protocol.ts do?',
		'How does the scheduler pick an account',
		'Why is the build failing',
		'Where are the migrations stored',
		'Which providers are supported',
		'Is the runner connected',
		'Does the chat keep a history',
		'Can you explain how the live updates work?',
		'WIE FUNKTIONIERT DAS?',
		'Das ist komisch?!'
	])('„%s“ → question', (text) => {
		expect(classifyChatIntent(text)).toMatchObject({ mode: 'question', confidence: 'high' });
	});
});

describe('classifyChatIntent – Code, Begründung und Fallback', () => {
	it('ignoriert Fragezeichen in Code-Blöcken und Inline-Code', () => {
		expect(mode('Hier der Code:\n```ts\nconst a = b ? c : d;\nwhy();?\n```')).not.toBe('question');
		expect(mode('Siehe `foo?`')).not.toBe('question');
		expect(mode('```\nWie funktioniert das?\n```')).toBe('task');
		expect(mode('Ändere das:\n```\nwarum?\n```')).toBe('task');
	});

	it('wertet Text außerhalb von Code-Blöcken weiter aus', () => {
		expect(mode('```js\nx()\n```\nWas macht diese Funktion?')).toBe('question');
	});

	it('liefert kurze deutsche Begründungen', () => {
		expect(classifyChatIntent('Das ist komisch?').reason).toBe('Endet mit Fragezeichen');
		expect(classifyChatIntent('Implementiere X').reason).toBe('Beginnt mit Aufforderung');
		expect(classifyChatIntent('Warum ist das so').reason).toBe('Beginnt mit Fragewort');
		expect(classifyChatIntent('Kannst du den Bug fixen?').reason).toBe('Bitte mit Änderungsverb');
	});

	it('fällt ohne Merkmale auf task mit geringer Sicherheit zurück', () => {
		expect(classifyChatIntent('Der Chat auf dem Handy')).toEqual({
			mode: 'task',
			confidence: 'low',
			reason: expect.any(String)
		});
		expect(classifyChatIntent('')).toMatchObject({ mode: 'task', confidence: 'low' });
		expect(classifyChatIntent('   ')).toMatchObject({ mode: 'task', confidence: 'low' });
	});
});

describe('classifyChatIntent – kurze Folgeaufträge', () => {
	it.each([
		'Setze das um',
		'Ja, mach das',
		'Umsetzen',
		'Passt, umsetzen bitte',
		'Leg los',
		"Los geht's",
		'Los geht’s!',
		'Ja, los',
		'Do it',
		'Go ahead',
		'Implement it',
		'Ok, setz das so um',
		'Go for it',
		'Proceed with the plan'
	])('„%s“ → task/high', (text) => {
		expect(classifyChatIntent(text)).toMatchObject({ mode: 'task', confidence: 'high' });
	});

	it.each([
		'Was soll ich als nächstes tun?',
		'Los?',
		'Go ahead?',
		'Do it yourself?',
		'Wie legt man los?',
		'Passt das so?',
		'Do you have tests for this'
	])('„%s“ bleibt eine Frage', (text) => {
		expect(mode(text)).toBe('question');
	});

	it('„Los“ als Wortbestandteil ist kein Startsignal', () => {
		expect(classifyChatIntent('Los Angeles ist schön')).toMatchObject({ confidence: 'low' });
	});
});
