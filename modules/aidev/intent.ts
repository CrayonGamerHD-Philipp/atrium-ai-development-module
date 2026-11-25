/**
 * Erkennung Frage/Auftrag im Projekt-Chat (reine Logik, nur Standard-JS – wird auch vom Browser-UI importiert).
 * Regelbasiert für Deutsch und Englisch; genutzt vom Chat-Endpunkt im Modus `auto`.
 */

export type ChatIntentMode = 'task' | 'question';

export interface ChatIntent {
	mode: ChatIntentMode;
	/** `low` = keine eindeutigen Merkmale (Fallback) */
	confidence: 'high' | 'low';
	/** kurze Begründung auf Deutsch, z. B. „Endet mit Fragezeichen“ */
	reason: string;
}

/** Buchstabe/Ziffer (Unicode) – `\b` von JS kennt keine Umlaute */
const L = '[\\p{L}\\p{N}_]';
/** Ganzes Wort irgendwo im Text */
const anywhere = (src: string) => new RegExp(`(?<!${L})(?:${src})(?!${L})`, 'iu');
/** Ganzes Wort am Satzanfang */
const atStart = (src: string) => new RegExp(`^(?:${src})(?!${L})`, 'iu');

/** Änderungsverben (Deutsch) in Imperativ-, Infinitiv- und Partizipformen */
const DE_CHANGE = [
	'anpass\\p{L}*',
	'pass(?:e|en)?',
	'implementier\\p{L}*',
	'hinzuf[üu]g\\p{L}*',
	'f[üu]ge?',
	'hinzu',
	'einbau\\p{L}*',
	'einf[üu]g\\p{L}*',
	'umbau\\p{L}*',
	'umbenenn\\p{L}*',
	'umstell\\p{L}*',
	'umschreib\\p{L}*',
	'umsetz\\p{L}*',
	'bau(?:e|en)?',
	'erstell\\p{L}*',
	'[äa]nder(?:e|n)?',
	'[äa]ndre',
	'entfern\\p{L}*',
	'l[öo]sch(?:e|en)?',
	'fix(?:e|en)?',
	'beheb(?:e|en)?',
	'reparier\\p{L}*',
	'refaktor\\p{L}*',
	'refactor\\p{L}*',
	'schreib(?:e|en)?',
	'erg[äa]nz\\p{L}*',
	'aktualisier\\p{L}*',
	'verschieb(?:e|en)?',
	'benenn(?:e|en)?',
	'mach(?:e|en)?',
	'integrier\\p{L}*',
	'optimier\\p{L}*',
	'verbesser\\p{L}*',
	'[üu]berarbeit\\p{L}*',
	'anleg\\p{L}*',
	'leg(?:e|en)?',
	'einricht\\p{L}*',
	'richte',
	'setz(?:e|en)?',
	'stelle',
	'erweiter\\p{L}*',
	'aktivier\\p{L}*',
	'deaktivier\\p{L}*',
	'konfigurier\\p{L}*',
	'installier\\p{L}*',
	'[üu]bersetz\\p{L}*',
	'dokumentier\\p{L}*',
	'migrier\\p{L}*',
	'programmier\\p{L}*',
	'generier\\p{L}*',
	'ersetz\\p{L}*',
	'teste',
	'pr[üu]fe'
].join('|');

/** Änderungsverben (Englisch, Grundform = Imperativ) */
const EN_CHANGE = [
	'add',
	'implement',
	'fix',
	'create',
	'remove',
	'delete',
	'update',
	'refactor',
	'build',
	'make',
	'change',
	'write',
	'rewrite',
	'rename',
	'move',
	'replace',
	'improve',
	'optimi[sz]e',
	'migrate',
	'install',
	'configure',
	'set\\s+up',
	'integrate',
	'extend',
	'adjust',
	'modify',
	'convert',
	'enable',
	'disable',
	'clean\\s+up',
	'bump',
	'upgrade',
	'introduce',
	'edit',
	'insert',
	'revert',
	'translate',
	'generate'
].join('|');

/** Erklärungswünsche – machen aus „Kannst du …“ eine Frage statt eines Auftrags */
const EXPLAIN = anywhere(
	[
		'erkl[äa]r\\p{L}*',
		'zeig(?:e|en|st)?\\s+mir',
		'sag(?:e|en|st)?',
		'beschreib(?:e|en|st)?\\s+mir',
		'wissen',
		'verstehen',
		'nachvollziehen',
		'explain\\p{L}*',
		'show\\s+me',
		'tell\\s+me',
		'describe',
		'understand',
		'know'
	].join('|')
);

/** Fragewörter und feste Frageanfänge */
const QUESTION_START = atStart(
	[
		'wie',
		'was',
		'warum',
		'wieso',
		'weshalb',
		'weswegen',
		'wo',
		'wann',
		'welche[rsmn]?',
		'wer',
		'wen',
		'wem',
		'wessen',
		'wof[üu]r',
		'wozu',
		'womit',
		'woher',
		'wohin',
		'worum',
		'woran',
		'wodurch',
		'worauf',
		'gibt\\s+es',
		'erkl[äa]r(?:e|en)?',
		'zeig(?:e)?\\s+mir,?\\s+wie',
		'how',
		'what',
		'why',
		'where',
		'when',
		'which',
		'who',
		'whom',
		'whose',
		'explain',
		'can\\s+you\\s+explain',
		'could\\s+you\\s+explain',
		'show\\s+me\\s+how',
		'tell\\s+me'
	].join('|')
);

/** Hilfsverben am Satzanfang – nur ohne Änderungsverb eine Frage */
const AUX_DE = atStart(
	'ist|sind|hat|haben|hast|habe|kann|kannst|k[öo]nnen|muss|m[üu]ssen|darf|d[üu]rfen|wird|werden|war|waren|gibt|funktioniert|stimmt'
);
const AUX_EN = atStart('is|are|was|were|does|do|did|has|have|should|would|can|could|will');

const HAS_DE_CHANGE = anywhere(DE_CHANGE);
const HAS_EN_CHANGE = anywhere(EN_CHANGE);
const IMPERATIVE_START = atStart(`${DE_CHANGE}|${EN_CHANGE}`);

/** Bitte- und Modalformen, die mit Änderungsverb einen Auftrag ausdrücken */
const ASK_DE = anywhere(
	'bitte|(?:kannst|k[öo]nntest|k[öo]nnt|k[öo]nnen|k[öo]nnten|w[üu]rdest|w[üu]rdet|w[üu]rden)\\s+(?:du|ihr|sie|wir)|lass\\s+uns|(?:ich|wir)\\s+(?:m[öo]chte|m[öo]chten|will|wollen|h[äa]tte|h[äa]tten|w[üu]rde|w[üu]rden)'
);
const ASK_EN = anywhere(
	"please|(?:can|could|would|will)\\s+(?:you|we)|let'?s|i\\s+(?:want|need|would\\s+like)\\s+(?:you\\s+)?to|i'?d\\s+like\\s+(?:you\\s+)?to|we\\s+(?:need|have)\\s+to"
);

/** Wunschformen: „soll … werden“, „… sollte …“, „ich möchte/will, dass …“ */
const WISH_SHALL = new RegExp(
	`(?<!${L})soll(?:te|en|ten)?(?!${L})[\\s\\S]*(?<!${L})werden(?!${L})`,
	'iu'
);
const WISH_SHOULD = anywhere('sollte|sollten|should');
const WISH_THAT = new RegExp(
	`(?<!${L})(?:ich|wir)\\s+(?:m[öo]chte|m[öo]chten|will|wollen|h[äa]tten?\\s+gerne?|w[üu]rden?\\s+gerne?)(?!${L})[\\s\\S]*(?<!${L})dass(?!${L})`,
	'iu'
);

/** Füllwörter am Satzanfang („Ok, …“, „Also bitte …“) */
const FILLER = new RegExp(
	`^(?:(?:ok(?:ay|ey)?|also|so|und|aber|dann|jetzt|nun|gut|super|prima|perfekt|danke|ja|nein|hey|hi|hallo|moin|noch|mal|bitte|well|and|but|then|now|alright|great|thanks|yes|no|please)(?!${L})[\\s,.!:;–-]*)+`,
	'iu'
);

/** Code-Blöcke (auch ungeschlossene) und Inline-Code entfernen */
function stripCode(text: string): string {
	return text
		.replace(/```[\s\S]*?(?:```|$)/g, '\n')
		.replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n')
		.replace(/`[^`\n]*`/g, ' ');
}

/** Satzanfang ohne Aufzählungszeichen, Anführungszeichen und Füllwörter */
function core(sentence: string): string {
	return sentence
		.replace(/^[\s\-*#>"'„“”»«(]+/u, '')
		.replace(FILLER, '')
		.trim();
}

/** Endet (ohne Leerzeichen und Satzzeichen am Ende) mit „?“ */
function endsWithQuestionMark(text: string): boolean {
	return /\?$/u.test(text.replace(/[\s.!,;:…)\]"'“”»«]+$/u, ''));
}

/** Aufforderung im Satz → Begründung, sonst null */
function requestIn(sentence: string): string | null {
	const start = core(sentence);
	if (IMPERATIVE_START.test(start)) return 'Beginnt mit Aufforderung';
	const explain = EXPLAIN.test(sentence);
	if (!explain && ASK_DE.test(sentence) && HAS_DE_CHANGE.test(sentence)) {
		return 'Bitte mit Änderungsverb';
	}
	if (!explain && ASK_EN.test(sentence) && HAS_EN_CHANGE.test(sentence)) {
		return 'Bitte mit Änderungsverb';
	}
	if (QUESTION_START.test(start)) return null;
	if (WISH_THAT.test(sentence) || WISH_SHALL.test(sentence)) return 'Enthält einen Änderungswunsch';
	// „sollte“ am Satzanfang ist eher eine Frage („Sollte ich …?“)
	const rest = start.replace(/^\p{L}+/u, '');
	if (WISH_SHOULD.test(rest)) return 'Enthält einen Änderungswunsch';
	return null;
}

/** Frage im Satz (Fragezeichen, Fragewort, Hilfsverb ohne Änderungsverb) → Begründung, sonst null */
function questionIn(sentence: string): string | null {
	const start = core(sentence);
	if (endsWithQuestionMark(sentence)) return 'Endet mit Fragezeichen';
	if (QUESTION_START.test(start)) {
		return EXPLAIN.test(start) ? 'Bittet um Erklärung' : 'Beginnt mit Fragewort';
	}
	if (AUX_DE.test(start) && !HAS_DE_CHANGE.test(start)) return 'Beginnt mit Fragewort';
	if (AUX_EN.test(start) && !HAS_EN_CHANGE.test(start)) return 'Beginnt mit Fragewort';
	return null;
}

/**
 * Unterscheidet eine Chatnachricht regelbasiert in Frage oder Auftrag (Deutsch/Englisch, Groß-/Kleinschreibung egal).
 * Code-Blöcke und Inline-Code zählen nicht. Eine Aufforderung (Imperativ, Bitte mit Änderungsverb, „soll … werden“,
 * „ich möchte, dass …“) irgendwo im Text ergibt `task` – auch gegen ein Fragezeichen („Kannst du den Bug fixen?“).
 * Sonst ist es eine Frage, wenn der erste Satz oder der ganze Text wie eine Frage aussieht. Fallback: `task`/`low`.
 */
export function classifyChatIntent(text: string): ChatIntent {
	const clean = stripCode(text ?? '').trim();
	if (!clean) return { mode: 'task', confidence: 'low', reason: 'Kein auswertbarer Text' };
	const sentences = clean
		.split(/(?<=[.!?…])\s+|\n+/u)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const s of sentences) {
		const reason = requestIn(s);
		if (reason) return { mode: 'task', confidence: 'high', reason };
	}
	const question =
		questionIn(sentences[0] ?? '') ??
		(endsWithQuestionMark(clean) ? 'Endet mit Fragezeichen' : null);
	if (question) return { mode: 'question', confidence: 'high', reason: question };
	return {
		mode: 'task',
		confidence: 'low',
		reason: 'Keine eindeutigen Merkmale – Standard Auftrag'
	};
}
