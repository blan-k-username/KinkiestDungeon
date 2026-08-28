/**
 * KDM-281 — every player-facing string the co-op client can put on screen, in one table, behind one
 * helper.
 *
 * ── THE DRIFT THIS ENDS ───────────────────────────────────────────────────────────────────────────
 * Two neighbouring files answered the same question differently. `coop-lobby.js` resolved its labels
 * through a private `text(key, fallback)` that reads KD's own `TextGet` — 29 call sites, each
 * carrying its English inline. `coop-bootstrap.js` wrote plain English straight into the very same
 * lobby fields through `lobbySay`, so one screen was half translatable: the buttons could be
 * localised and the refusal painted between them could not.
 *
 * Nobody caused that. Each task followed the file it was editing, which is the right local call and
 * the wrong global one — which is exactly why the answer is a shared module plus a guard
 * (`tests/unit/mp-client-strings.spec.ts`), and not a convention.
 *
 * ── WHY THE ENGLISH LIVES HERE AND NOT AT THE CALL SITE ───────────────────────────────────────────
 * `text('KDMPBack', 'Back')` reads well and does not scale: the source string is duplicated wherever
 * the key is used (`KDMPBack` had three copies, `KDMPModMore` two), so the copies can disagree, and
 * — the part that matters — a file full of legitimate inline prose gives a drift guard nothing to
 * bite on. It cannot tell `text('K', 'Back')` from `lobbySay({ error: 'Back' })`. With the English
 * in ONE table, "a prose literal in a client file" becomes an unambiguous red, and that is the
 * acceptance criterion this task was written around.
 *
 * ── TEMPLATING ────────────────────────────────────────────────────────────────────────────────────
 * Bare UPPERCASE tokens, substituted by name: `t('KDMPWorldSeed', { SEED: seed })`. This is the
 * convention the lobby already used (`text('KDMPModMore', '…and MORE more').replace('MORE', n)`),
 * kept rather than replaced — the point of this task is to stop having two conventions.
 *
 * Substitution is `split`/`join`, not `String.replace`: a replacement value containing `$&` or `$1`
 * would otherwise be interpreted, and one of these values is a mod list a player can influence.
 *
 * Concatenation is avoided where word order is the translator's business — `NAME wants to join your
 * game` rather than `name + ' wants to join your game'` — because a language that puts the verb
 * first cannot express that as a suffix.
 *
 * ── LOAD ORDER ────────────────────────────────────────────────────────────────────────────────────
 * FIRST of the client scripts that paint (see `INJECT` in demo-server.js): both `coop-bootstrap.js`
 * and `coop-lobby.js` consume `window.KDMPText`. It has no ordering constraint of its OWN — it just
 * has to precede its two consumers, which the spec asserts.
 *
 * It does now read two bundle globals (`TextGet`, `TranslationLanguage`), but only from inside a
 * function, never at load time, and both reads degrade when the binding is absent. So injecting this
 * before the bundle is ready is still safe: the first `t()` of a frame sees whatever KD has by then.
 *
 * ── TRANSLATION ───────────────────────────────────────────────────────────────────────────────────
 * `t()` asks KD's `TextGet` first and falls back to the English below, so a localised build that
 * knows `KDMPBack` wins and one that does not is unchanged. That is the whole integration: this file
 * registers nothing and overrides nothing.
 *
 * KDM-289 added the middle step. `LANGS` below carries the same keys in the six languages KD
 * supports, and `t()` consults the active one between KD's answer and the English. It is still true
 * that this file registers nothing with KD: it reads `TranslationLanguage` and resolves its own
 * table, rather than injecting into `TextProvider` the way a MOD would — the co-op client is an
 * injected `<script src>`, not a mod, and splitting the fallback chain across two owners is the
 * shape KDM-281 existed to remove. See `activeLanguage()` for why the bare read works at all.
 */
(function () {
	'use strict';

	/**
	 * Key → English source string. The ONLY place a co-op UI string is written.
	 *
	 * Grouped by the screen that shows it. A key used by more than one screen (`KDMPBack`,
	 * `KDMPModMore`, `KDMPSomeone`) is listed once, under the first.
	 */
	var STRINGS = {
		// ── the menu entry and the root screen ────────────────────────────────────────────────────
		KDMPLobbyTitle:      'Multiplayer',
		KDMPHostGame:        'Host Game',
		KDMPContinueSave:    'Continue Save',
		KDMPJoinGame:        'Join Game',
		KDMPPerksBtn:        'Perks',
		KDMPCharBtn:         'Character',
		KDMPAboutBtn:        'How co-op differs',
		KDMPBack:            'Back',
		KDMPCancel:          'Cancel',
		KDMPSaveUnusable:    'That save cannot be continued.',
		// A page served without the co-op bootstrap — a status line rather than a throw, because the
		// lobby is still on screen and a blank one explains nothing.
		KDMPNoTransport:     'No transport available.',
		KDMPYourName:        'Your name',
		KDMPWorldSeedField:  'World seed (optional — the host\'s to choose)',

		// ── "How co-op differs" ───────────────────────────────────────────────────────────────────
		KDMPAboutTitle:      'Playing together is a little different',
		KDMPAboutPerks:      'Start perks are the party\'s — everyone\'s apply to everyone, debuffs included.',
		KDMPAboutHost:       'The host\'s settings and world seed govern the run.',
		KDMPAboutDescend:    'You descend together — the stairs wait for the whole party.',
		KDMPAboutTrade:      'Drop an item to hand it to your partner.',
		KDMPAboutPvP:        'PvP resets to co-op at the hub, and you can offer peace.',
		KDMPAboutRejoin:     'A dropped connection does not end the run — they can rejoin as themselves.',

		// ── the Host screen ───────────────────────────────────────────────────────────────────────
		KDMPShareAddress:    'Tell your friend to join:',
		KDMPShareLocalOnly:  'That is this machine only — your friend needs this computer\'s address on your network.',
		KDMPSomeone:         'Someone',
		KDMPWantsToJoin:     'NAME wants to join your game',
		KDMPModsToSend:      'They will be sent COUNT of your mods:',
		KDMPAcceptBtn:       'Accept',
		KDMPDeclineBtn:      'Decline',
		KDMPWaitingGuest:    'Waiting for someone to join…',

		// ── the Join screen ───────────────────────────────────────────────────────────────────────
		KDMPHostAddress:     'Host address',
		KDMPModsToGet:       'The host is running COUNT mods you don\'t have:',
		KDMPConnectBtn:      'Join',
		KDMPConnecting:      'Connecting…',

		// ── what the host's world looks like, and what it would cost to load ──────────────────────
		KDMPWorldLead:       'The host\'s game:',
		KDMPWorldSeed:       '• seed: SEED',
		KDMPModMore:         '…and MORE more',
		KDMPModConflict:     ' (a different version of yours)',
		KDMPModDegraded:     'Co-op: some of the host\'s mods could not be loaded — MODS',

		// ── OUR name for a world mode, used only when KD has none ─────────────────────────────────
		// `modeLabel` (coop-lobby.js) asks KD for its OWN word first — these are the fallback, and a
		// mode KD cannot name must never be shown to a guest as a raw identifier (KDM-283).
		KDMPModeRandom:          'Spell Choice: Random Spells',
		KDMPModeHard:            'Hard Mode',
		KDMPModeExtreme:         'Extreme Mode',
		KDMPModeSaveRogue:       'Save Mode: Roguelike',
		KDMPModeLootNone:        'Loot Recovery: Disabled',
		KDMPModeLootPartial:     'Loot Recovery: Partial',
		KDMPModePrisonEasy:      'Prison Strictness: Easy',
		KDMPModePrisonStrict:    'Prison Strictness: Strict',
		KDMPModePerksOff:        'Perk Progression: Disabled',
		KDMPModePerksMandatory:  'Perk Progression: Mandatory',
		KDMPModePerksDebuff:     'Perk Progression: Debuffs Only',
		KDMPModeProgKey:         'Progression Mode: Key Hunt',
		KDMPModeProgRandom:      'Progression Mode: Random',

		// ── KDM-281: what the CONNECTION says, previously plain English in coop-bootstrap.js ──────
		// These land in `lobby.status` / `lobby.error`, i.e. on the screens above, which is why they
		// belong in the same table rather than in a second one next to their sender.
		KDMPWaitingApproval: 'Waiting for the host to let you in…',
		KDMPStarting:        'Starting…',
		KDMPNoAnswer:        'No answer from WHERE — is the game hosting there?',
		KDMPCouldNotReach:   'Could not reach WHERE',
		// KDM-270 — a refusal that names another seat is an OFFER, not the end of the conversation.
		KDMPAlreadyHosting:  'Somebody is already hosting there — join them instead.',
		KDMPNobodyHosting:   'Nobody is hosting there yet — you can host it yourself.',
		// …and the refusals that really are final.
		KDMPRefusedDeclined: 'The host declined your request.',
		KDMPRefusedFull:     'That game is full.',
		KDMPRefusedBusy:     'The host is already answering someone else.',
		KDMPRefusedBuild:    'Different game versions — host has HOSTBUILD, you have GUESTBUILD.',
		KDMPRefusedOther:    'Refused: REASON',
	};

	/**
	 * KDM-289 — the same keys, in the six languages KD supports.
	 *
	 * ⚠️ MACHINE-GENERATED SEEDS, UNREVIEWED. Every string below was produced by an AI translator and
	 * has NOT been checked by a native speaker. That is the repo's standing convention for a first
	 * localisation pass: ship a complete table so the screen is coherent, mark it so a reviewer can
	 * find it, and correct it in place as reports arrive. English remains the fallback, so a wrong
	 * seed is a wrong sentence, never a broken screen.
	 *
	 * ── TWO RULES WHEN EDITING ────────────────────────────────────────────────────────────────────
	 *  1. TOKENS ARE SUBSTITUTED BY NAME. `SEED`, `NAME`, `COUNT`, `WHERE`, `MODS`, `MORE`, `REASON`,
	 *     `HOSTBUILD`, `GUESTBUILD` may be MOVED anywhere in the sentence — that freedom is the whole
	 *     reason KDM-281 replaced concatenation with templating — but one that is dropped silently
	 *     deletes a seed, a player's name or a build number, and the result still reads as a finished
	 *     sentence. `mp-client-strings.spec.ts` asserts token parity against the English for exactly
	 *     this.
	 *  2. SOME PUNCTUATION IS STRUCTURE. `KDMPModConflict` begins with a space because it is appended
	 *     to a mod name; `KDMPWorldSeed` begins with the bullet its column expects; `KDMPModMore`
	 *     opens with an ellipsis because it continues a list.
	 *
	 * A language is complete or it is declared incomplete in the spec — a table missing keys would
	 * paint half a screen in one language and half in another, which is worse than English.
	 */
	var LANGS = {
		// ── 简体中文 ──────────────────────────────────────────────────────────────────────────────
		CN: {
			KDMPLobbyTitle:      '多人游戏',
			KDMPHostGame:        '创建房间',
			KDMPContinueSave:    '继续存档',
			KDMPJoinGame:        '加入游戏',
			KDMPPerksBtn:        '天赋',
			KDMPCharBtn:         '角色',
			KDMPAboutBtn:        '合作模式有何不同',
			KDMPBack:            '返回',
			KDMPCancel:          '取消',
			KDMPSaveUnusable:    '该存档无法继续。',
			KDMPNoTransport:     '没有可用的连接方式。',
			KDMPYourName:        '你的名字',
			KDMPWorldSeedField:  '世界种子（可选 —— 由房主决定）',
			KDMPAboutTitle:      '一起游玩会有些不同',
			KDMPAboutPerks:      '起始天赋属于全队 —— 每个人的天赋都会作用于所有人，负面效果也一样。',
			KDMPAboutHost:       '房主的设置和世界种子决定这场游戏。',
			KDMPAboutDescend:    '你们一起下楼 —— 楼梯会等待全队到齐。',
			KDMPAboutTrade:      '丢下物品即可交给你的同伴。',
			KDMPAboutPvP:        '回到大厅时 PvP 会恢复为合作，你也可以提出停战。',
			KDMPAboutRejoin:     '掉线不会结束这场游戏 —— 他们可以用原身份重新加入。',
			KDMPShareAddress:    '让你的朋友加入：',
			KDMPShareLocalOnly:  '那只是本机地址 —— 你的朋友需要这台电脑在你们网络中的地址。',
			KDMPSomeone:         '某人',
			KDMPWantsToJoin:     'NAME 想加入你的游戏',
			KDMPModsToSend:      '将会向他们发送你的 COUNT 个模组：',
			KDMPAcceptBtn:       '接受',
			KDMPDeclineBtn:      '拒绝',
			KDMPWaitingGuest:    '正在等待有人加入…',
			KDMPHostAddress:     '房主地址',
			KDMPModsToGet:       '房主正在使用 COUNT 个你没有的模组：',
			KDMPConnectBtn:      '加入',
			KDMPConnecting:      '正在连接…',
			KDMPWorldLead:       '房主的游戏：',
			KDMPWorldSeed:       '• 种子：SEED',
			KDMPModMore:         '…还有另外 MORE 个',
			KDMPModConflict:     '（与你的版本不同）',
			KDMPModDegraded:     '合作模式：房主的部分模组无法加载 —— MODS',
			KDMPModeRandom:          '法术选择：随机法术',
			KDMPModeHard:            '困难模式',
			KDMPModeExtreme:         '极限模式',
			KDMPModeSaveRogue:       '存档模式：肉鸽',
			KDMPModeLootNone:        '战利品找回：关闭',
			KDMPModeLootPartial:     '战利品找回：部分',
			KDMPModePrisonEasy:      '监狱严格度：宽松',
			KDMPModePrisonStrict:    '监狱严格度：严格',
			KDMPModePerksOff:        '天赋成长：关闭',
			KDMPModePerksMandatory:  '天赋成长：强制',
			KDMPModePerksDebuff:     '天赋成长：仅负面',
			KDMPModeProgKey:         '进程模式：寻找钥匙',
			KDMPModeProgRandom:      '进程模式：随机',
			KDMPWaitingApproval: '正在等待房主允许你加入…',
			KDMPStarting:        '正在开始…',
			KDMPNoAnswer:        'WHERE 没有回应 —— 那里有人在开房吗？',
			KDMPCouldNotReach:   '无法连接到 WHERE',
			KDMPAlreadyHosting:  '那里已经有人在开房了 —— 加入他们吧。',
			KDMPNobodyHosting:   '那里还没有人开房 —— 你可以自己来开。',
			KDMPRefusedDeclined: '房主拒绝了你的请求。',
			KDMPRefusedFull:     '该房间已满。',
			KDMPRefusedBusy:     '房主正在回应其他人。',
			KDMPRefusedBuild:    '游戏版本不同 —— 房主为 HOSTBUILD，你为 GUESTBUILD。',
			KDMPRefusedOther:    '已拒绝：REASON',
		},

		// ── Deutsch ───────────────────────────────────────────────────────────────────────────────
		DE: {
			KDMPLobbyTitle:      'Mehrspieler',
			KDMPHostGame:        'Spiel hosten',
			KDMPContinueSave:    'Spielstand fortsetzen',
			KDMPJoinGame:        'Spiel beitreten',
			// The English word is the word German players use — declared in SAME_AS_ENGLISH so that
			// "identical to the English" stays a red everywhere else.
			KDMPPerksBtn:        'Perks',
			KDMPCharBtn:         'Charakter',
			KDMPAboutBtn:        'Was im Koop anders ist',
			KDMPBack:            'Zurück',
			KDMPCancel:          'Abbrechen',
			KDMPSaveUnusable:    'Dieser Spielstand kann nicht fortgesetzt werden.',
			KDMPNoTransport:     'Keine Verbindung verfügbar.',
			KDMPYourName:        'Dein Name',
			KDMPWorldSeedField:  'Welt-Seed (optional — der Host entscheidet)',
			KDMPAboutTitle:      'Zu zweit spielt es sich etwas anders',
			KDMPAboutPerks:      'Start-Perks gehören der Gruppe — die von allen gelten für alle, Debuffs eingeschlossen.',
			KDMPAboutHost:       'Die Einstellungen und der Welt-Seed des Hosts bestimmen den Durchlauf.',
			KDMPAboutDescend:    'Ihr steigt gemeinsam ab — die Treppe wartet auf die ganze Gruppe.',
			KDMPAboutTrade:      'Lass einen Gegenstand fallen, um ihn deinem Gegenüber zu geben.',
			KDMPAboutPvP:        'PvP wird im Hub wieder zu Koop, und du kannst Frieden anbieten.',
			KDMPAboutRejoin:     'Ein Verbindungsabbruch beendet den Durchlauf nicht — sie können als sie selbst zurückkehren.',
			KDMPShareAddress:    'Diese Adresse zum Beitreten weitergeben:',
			KDMPShareLocalOnly:  'Das gilt nur für diesen Rechner — dein Gegenüber braucht die Adresse dieses Computers in eurem Netzwerk.',
			KDMPSomeone:         'Jemand',
			KDMPWantsToJoin:     'NAME möchte deinem Spiel beitreten',
			KDMPModsToSend:      'Es werden COUNT deiner Mods übertragen:',
			KDMPAcceptBtn:       'Annehmen',
			KDMPDeclineBtn:      'Ablehnen',
			KDMPWaitingGuest:    'Warte darauf, dass jemand beitritt…',
			KDMPHostAddress:     'Host-Adresse',
			KDMPModsToGet:       'Der Host verwendet COUNT Mods, die du nicht hast:',
			KDMPConnectBtn:      'Beitreten',
			KDMPConnecting:      'Verbinde…',
			KDMPWorldLead:       'Das Spiel des Hosts:',
			KDMPWorldSeed:       '• Seed: SEED',
			KDMPModMore:         '…und MORE weitere',
			KDMPModConflict:     ' (eine andere Version als deine)',
			KDMPModDegraded:     'Koop: Einige Mods des Hosts konnten nicht geladen werden — MODS',
			KDMPModeRandom:          'Zauberwahl: Zufällige Zauber',
			KDMPModeHard:            'Schwerer Modus',
			KDMPModeExtreme:         'Extremer Modus',
			KDMPModeSaveRogue:       'Speichermodus: Roguelike',
			KDMPModeLootNone:        'Beutewiederherstellung: Deaktiviert',
			KDMPModeLootPartial:     'Beutewiederherstellung: Teilweise',
			KDMPModePrisonEasy:      'Gefängnisstrenge: Leicht',
			KDMPModePrisonStrict:    'Gefängnisstrenge: Streng',
			KDMPModePerksOff:        'Perk-Fortschritt: Deaktiviert',
			KDMPModePerksMandatory:  'Perk-Fortschritt: Verpflichtend',
			KDMPModePerksDebuff:     'Perk-Fortschritt: Nur Debuffs',
			KDMPModeProgKey:         'Fortschrittsmodus: Schlüsseljagd',
			KDMPModeProgRandom:      'Fortschrittsmodus: Zufällig',
			KDMPWaitingApproval: 'Warte darauf, dass der Host dich hereinlässt…',
			KDMPStarting:        'Starte…',
			KDMPNoAnswer:        'Keine Antwort von WHERE — wird dort wirklich gehostet?',
			KDMPCouldNotReach:   'WHERE nicht erreichbar',
			KDMPAlreadyHosting:  'Dort hostet bereits jemand — tritt einfach bei.',
			KDMPNobodyHosting:   'Dort hostet noch niemand — du kannst selbst hosten.',
			KDMPRefusedDeclined: 'Der Host hat deine Anfrage abgelehnt.',
			KDMPRefusedFull:     'Dieses Spiel ist voll.',
			KDMPRefusedBusy:     'Der Host beantwortet gerade jemand anderen.',
			KDMPRefusedBuild:    'Unterschiedliche Spielversionen — der Host hat HOSTBUILD, du hast GUESTBUILD.',
			KDMPRefusedOther:    'Abgelehnt: REASON',
		},

		// ── Español ───────────────────────────────────────────────────────────────────────────────
		ES: {
			KDMPLobbyTitle:      'Multijugador',
			KDMPHostGame:        'Crear partida',
			KDMPContinueSave:    'Continuar partida guardada',
			KDMPJoinGame:        'Unirse a una partida',
			KDMPPerksBtn:        'Ventajas',
			KDMPCharBtn:         'Personaje',
			KDMPAboutBtn:        'En qué se diferencia el cooperativo',
			KDMPBack:            'Atrás',
			KDMPCancel:          'Cancelar',
			KDMPSaveUnusable:    'Esa partida guardada no se puede continuar.',
			KDMPNoTransport:     'No hay transporte disponible.',
			KDMPYourName:        'Tu nombre',
			KDMPWorldSeedField:  'Semilla del mundo (opcional: la elige quien aloja)',
			KDMPAboutTitle:      'Jugar juntos es un poco diferente',
			KDMPAboutPerks:      'Las ventajas iniciales son de todo el grupo: las de cada quien se aplican a todos, penalizaciones incluidas.',
			KDMPAboutHost:       'Los ajustes y la semilla del mundo de quien aloja rigen la partida.',
			KDMPAboutDescend:    'Descienden juntos: las escaleras esperan a todo el grupo.',
			KDMPAboutTrade:      'Suelta un objeto para entregárselo a tu acompañante.',
			KDMPAboutPvP:        'El PvP vuelve a cooperativo en el refugio, y puedes ofrecer la paz.',
			KDMPAboutRejoin:     'Una desconexión no termina la partida: pueden volver a entrar como quienes eran.',
			KDMPShareAddress:    'Comparte esta dirección para que se unan:',
			KDMPShareLocalOnly:  'Esa es solo esta máquina: tu acompañante necesita la dirección de esta computadora en tu red.',
			KDMPSomeone:         'Alguien',
			KDMPWantsToJoin:     'NAME quiere unirse a tu partida',
			KDMPModsToSend:      'Se le enviarán COUNT de tus mods:',
			KDMPAcceptBtn:       'Aceptar',
			KDMPDeclineBtn:      'Rechazar',
			KDMPWaitingGuest:    'Esperando a que alguien se una…',
			KDMPHostAddress:     'Dirección de quien aloja',
			KDMPModsToGet:       'Quien aloja usa COUNT mods que tú no tienes:',
			KDMPConnectBtn:      'Unirse',
			KDMPConnecting:      'Conectando…',
			KDMPWorldLead:       'La partida de quien aloja:',
			KDMPWorldSeed:       '• semilla: SEED',
			KDMPModMore:         '…y MORE más',
			KDMPModConflict:     ' (una versión distinta de la tuya)',
			KDMPModDegraded:     'Cooperativo: algunos mods de quien aloja no se pudieron cargar: MODS',
			KDMPModeRandom:          'Elección de hechizos: hechizos aleatorios',
			KDMPModeHard:            'Modo difícil',
			KDMPModeExtreme:         'Modo extremo',
			KDMPModeSaveRogue:       'Modo de guardado: Roguelike',
			KDMPModeLootNone:        'Recuperación de botín: desactivada',
			KDMPModeLootPartial:     'Recuperación de botín: parcial',
			KDMPModePrisonEasy:      'Rigor de la prisión: bajo',
			KDMPModePrisonStrict:    'Rigor de la prisión: estricto',
			KDMPModePerksOff:        'Progresión de ventajas: desactivada',
			KDMPModePerksMandatory:  'Progresión de ventajas: obligatoria',
			KDMPModePerksDebuff:     'Progresión de ventajas: solo penalizaciones',
			KDMPModeProgKey:         'Modo de progresión: búsqueda de llaves',
			KDMPModeProgRandom:      'Modo de progresión: aleatorio',
			KDMPWaitingApproval: 'Esperando a que quien aloja te deje entrar…',
			KDMPStarting:        'Empezando…',
			KDMPNoAnswer:        'Sin respuesta de WHERE: ¿de verdad hay una partida ahí?',
			KDMPCouldNotReach:   'No se pudo conectar con WHERE',
			KDMPAlreadyHosting:  'Ahí ya hay alguien alojando: únete en vez de alojar.',
			KDMPNobodyHosting:   'Ahí todavía no hay nadie alojando: puedes alojar tú.',
			KDMPRefusedDeclined: 'Quien aloja rechazó tu solicitud.',
			KDMPRefusedFull:     'Esa partida está llena.',
			KDMPRefusedBusy:     'Quien aloja ya está respondiendo a otra persona.',
			KDMPRefusedBuild:    'Versiones distintas del juego: quien aloja tiene HOSTBUILD y tú tienes GUESTBUILD.',
			KDMPRefusedOther:    'Rechazado: REASON',
		},

		// ── 日本語 ────────────────────────────────────────────────────────────────────────────────
		JP: {
			KDMPLobbyTitle:      'マルチプレイ',
			KDMPHostGame:        'ホストする',
			KDMPContinueSave:    'セーブを続ける',
			KDMPJoinGame:        'ゲームに参加',
			KDMPPerksBtn:        'パーク',
			KDMPCharBtn:         'キャラクター',
			KDMPAboutBtn:        '協力プレイの違い',
			KDMPBack:            '戻る',
			KDMPCancel:          'キャンセル',
			KDMPSaveUnusable:    'そのセーブは続きから始められません。',
			KDMPNoTransport:     '利用できる通信手段がありません。',
			KDMPYourName:        'あなたの名前',
			KDMPWorldSeedField:  'ワールドシード（任意 — 決めるのはホストです）',
			KDMPAboutTitle:      '一緒に遊ぶと少し勝手が違います',
			KDMPAboutPerks:      '開始時のパークはパーティ全員のもの — 誰のパークも全員に適用され、デバフも同様です。',
			KDMPAboutHost:       'ホストの設定とワールドシードがこのランを決めます。',
			KDMPAboutDescend:    '一緒に降ります — 階段はパーティ全員を待ちます。',
			KDMPAboutTrade:      'アイテムを落とすと相手に渡せます。',
			KDMPAboutPvP:        '拠点では PvP は協力に戻り、和平を申し出ることもできます。',
			KDMPAboutRejoin:     '接続が切れてもランは終わりません — 本人のまま再参加できます。',
			KDMPShareAddress:    '参加してもらう相手にこれを伝えてください：',
			KDMPShareLocalOnly:  'これはこのマシンだけの表示です — 相手にはネットワーク上のこのコンピューターのアドレスが必要です。',
			KDMPSomeone:         '誰か',
			KDMPWantsToJoin:     'NAME があなたのゲームへの参加を希望しています',
			KDMPModsToSend:      'あなたのモッド COUNT 個が送られます：',
			KDMPAcceptBtn:       '受け入れる',
			KDMPDeclineBtn:      '断る',
			KDMPWaitingGuest:    '誰かの参加を待っています…',
			KDMPHostAddress:     'ホストのアドレス',
			KDMPModsToGet:       'ホストはあなたが持っていないモッドを COUNT 個使っています：',
			KDMPConnectBtn:      '参加',
			KDMPConnecting:      '接続中…',
			KDMPWorldLead:       'ホストのゲーム：',
			KDMPWorldSeed:       '• シード：SEED',
			KDMPModMore:         '…ほか MORE 個',
			KDMPModConflict:     '（あなたのものとは別のバージョン）',
			KDMPModDegraded:     '協力プレイ：ホストのモッドの一部を読み込めませんでした — MODS',
			KDMPModeRandom:          '呪文選択：ランダム呪文',
			KDMPModeHard:            'ハードモード',
			KDMPModeExtreme:         'エクストリームモード',
			KDMPModeSaveRogue:       'セーブモード：ローグライク',
			KDMPModeLootNone:        '戦利品の回収：無効',
			KDMPModeLootPartial:     '戦利品の回収：一部',
			KDMPModePrisonEasy:      '監獄の厳しさ：ゆるい',
			KDMPModePrisonStrict:    '監獄の厳しさ：厳しい',
			KDMPModePerksOff:        'パーク成長：無効',
			KDMPModePerksMandatory:  'パーク成長：必須',
			KDMPModePerksDebuff:     'パーク成長：デバフのみ',
			KDMPModeProgKey:         '進行モード：鍵さがし',
			KDMPModeProgRandom:      '進行モード：ランダム',
			KDMPWaitingApproval: 'ホストの許可を待っています…',
			KDMPStarting:        '開始しています…',
			KDMPNoAnswer:        'WHERE から応答がありません — そこでホストしていますか？',
			KDMPCouldNotReach:   'WHERE に接続できませんでした',
			KDMPAlreadyHosting:  'そこでは既に誰かがホストしています — その人に参加しましょう。',
			KDMPNobodyHosting:   'そこではまだ誰もホストしていません — 自分でホストできます。',
			KDMPRefusedDeclined: 'ホストがあなたのリクエストを断りました。',
			KDMPRefusedFull:     'そのゲームは満員です。',
			KDMPRefusedBusy:     'ホストは今、別の人に応答しています。',
			KDMPRefusedBuild:    'ゲームのバージョンが違います — ホストは HOSTBUILD、あなたは GUESTBUILD です。',
			KDMPRefusedOther:    '拒否されました：REASON',
		},

		// ── 한국어 ────────────────────────────────────────────────────────────────────────────────
		KR: {
			KDMPLobbyTitle:      '멀티플레이',
			KDMPHostGame:        '방 만들기',
			KDMPContinueSave:    '저장 이어하기',
			KDMPJoinGame:        '게임 참가',
			KDMPPerksBtn:        '특전',
			KDMPCharBtn:         '캐릭터',
			KDMPAboutBtn:        '협동 플레이의 차이점',
			KDMPBack:            '뒤로',
			KDMPCancel:          '취소',
			KDMPSaveUnusable:    '그 저장 데이터는 이어서 할 수 없습니다.',
			KDMPNoTransport:     '사용할 수 있는 연결 수단이 없습니다.',
			KDMPYourName:        '당신의 이름',
			KDMPWorldSeedField:  '월드 시드 (선택 사항 — 방장이 정합니다)',
			KDMPAboutTitle:      '함께 하면 조금 다릅니다',
			KDMPAboutPerks:      '시작 특전은 파티 전체의 것입니다 — 모두의 특전이 모두에게 적용되며, 디버프도 마찬가지입니다.',
			KDMPAboutHost:       '방장의 설정과 월드 시드가 이번 플레이를 결정합니다.',
			KDMPAboutDescend:    '함께 내려갑니다 — 계단은 파티 전원을 기다립니다.',
			KDMPAboutTrade:      '아이템을 내려놓으면 동료에게 건넬 수 있습니다.',
			KDMPAboutPvP:        '거점에서는 PvP가 협동으로 돌아가며, 평화를 제안할 수 있습니다.',
			KDMPAboutRejoin:     '연결이 끊겨도 플레이는 끝나지 않습니다 — 본인 그대로 다시 들어올 수 있습니다.',
			KDMPShareAddress:    '친구에게 이 주소로 들어오라고 알려주세요:',
			KDMPShareLocalOnly:  '이것은 이 컴퓨터에서만 쓰는 주소입니다 — 친구에게는 네트워크상의 이 컴퓨터 주소가 필요합니다.',
			KDMPSomeone:         '누군가',
			KDMPWantsToJoin:     'NAME 님이 당신의 게임에 참가하려 합니다',
			KDMPModsToSend:      '당신의 모드 COUNT 개가 전송됩니다:',
			KDMPAcceptBtn:       '수락',
			KDMPDeclineBtn:      '거절',
			KDMPWaitingGuest:    '누군가 들어오기를 기다리는 중…',
			KDMPHostAddress:     '방장 주소',
			KDMPModsToGet:       '방장이 당신에게 없는 모드 COUNT 개를 사용 중입니다:',
			KDMPConnectBtn:      '참가',
			KDMPConnecting:      '연결 중…',
			KDMPWorldLead:       '방장의 게임:',
			KDMPWorldSeed:       '• 시드: SEED',
			KDMPModMore:         '…외 MORE 개 더',
			KDMPModConflict:     ' (당신 것과 다른 버전)',
			KDMPModDegraded:     '협동: 방장의 모드 일부를 불러오지 못했습니다 — MODS',
			KDMPModeRandom:          '주문 선택: 무작위 주문',
			KDMPModeHard:            '어려움 모드',
			KDMPModeExtreme:         '극한 모드',
			KDMPModeSaveRogue:       '저장 방식: 로그라이크',
			KDMPModeLootNone:        '전리품 회수: 비활성화',
			KDMPModeLootPartial:     '전리품 회수: 일부',
			KDMPModePrisonEasy:      '감옥 엄격도: 쉬움',
			KDMPModePrisonStrict:    '감옥 엄격도: 엄격',
			KDMPModePerksOff:        '특전 성장: 비활성화',
			KDMPModePerksMandatory:  '특전 성장: 필수',
			KDMPModePerksDebuff:     '특전 성장: 디버프만',
			KDMPModeProgKey:         '진행 방식: 열쇠 찾기',
			KDMPModeProgRandom:      '진행 방식: 무작위',
			KDMPWaitingApproval: '방장이 들여보내 주기를 기다리는 중…',
			KDMPStarting:        '시작하는 중…',
			KDMPNoAnswer:        'WHERE 에서 응답이 없습니다 — 거기서 방을 열고 있나요?',
			KDMPCouldNotReach:   'WHERE 에 연결할 수 없습니다',
			KDMPAlreadyHosting:  '거기에는 이미 방을 연 사람이 있습니다 — 그 방에 참가하세요.',
			KDMPNobodyHosting:   '거기에는 아직 방을 연 사람이 없습니다 — 직접 열 수 있습니다.',
			KDMPRefusedDeclined: '방장이 당신의 요청을 거절했습니다.',
			KDMPRefusedFull:     '그 게임은 정원이 찼습니다.',
			KDMPRefusedBusy:     '방장이 지금 다른 사람에게 응답하고 있습니다.',
			KDMPRefusedBuild:    '게임 버전이 다릅니다 — 방장은 HOSTBUILD, 당신은 GUESTBUILD 입니다.',
			KDMPRefusedOther:    '거절됨: REASON',
		},

		// ── Русский ───────────────────────────────────────────────────────────────────────────────
		RU: {
			KDMPLobbyTitle:      'Мультиплеер',
			KDMPHostGame:        'Создать игру',
			KDMPContinueSave:    'Продолжить сохранение',
			KDMPJoinGame:        'Присоединиться к игре',
			KDMPPerksBtn:        'Перки',
			KDMPCharBtn:         'Персонаж',
			KDMPAboutBtn:        'Чем отличается кооп',
			KDMPBack:            'Назад',
			KDMPCancel:          'Отмена',
			KDMPSaveUnusable:    'Это сохранение нельзя продолжить.',
			KDMPNoTransport:     'Нет доступного соединения.',
			KDMPYourName:        'Ваше имя',
			KDMPWorldSeedField:  'Сид мира (необязательно — его выбирает хост)',
			KDMPAboutTitle:      'Вместе играется немного иначе',
			KDMPAboutPerks:      'Стартовые перки общие для отряда — перки каждого действуют на всех, включая дебаффы.',
			KDMPAboutHost:       'Настройки и сид мира хоста определяют забег.',
			KDMPAboutDescend:    'Вы спускаетесь вместе — лестница ждёт весь отряд.',
			KDMPAboutTrade:      'Выбросьте предмет, чтобы передать его напарнику.',
			KDMPAboutPvP:        'В хабе PvP снова становится кооперативом, и можно предложить мир.',
			KDMPAboutRejoin:     'Обрыв связи не заканчивает забег — можно вернуться собой же.',
			KDMPShareAddress:    'Скажите другу, куда подключаться:',
			KDMPShareLocalOnly:  'Это адрес только для этого компьютера — другу нужен адрес этого компьютера в вашей сети.',
			KDMPSomeone:         'Кто-то',
			KDMPWantsToJoin:     'NAME хочет присоединиться к вашей игре',
			KDMPModsToSend:      'Ему будет отправлено ваших модов: COUNT',
			KDMPAcceptBtn:       'Принять',
			KDMPDeclineBtn:      'Отклонить',
			KDMPWaitingGuest:    'Ожидание того, кто присоединится…',
			KDMPHostAddress:     'Адрес хоста',
			KDMPModsToGet:       'У хоста запущено модов, которых у вас нет: COUNT',
			KDMPConnectBtn:      'Присоединиться',
			KDMPConnecting:      'Подключение…',
			KDMPWorldLead:       'Игра хоста:',
			KDMPWorldSeed:       '• сид: SEED',
			KDMPModMore:         '…и ещё MORE',
			KDMPModConflict:     ' (другая версия вашего)',
			KDMPModDegraded:     'Кооп: часть модов хоста не удалось загрузить — MODS',
			KDMPModeRandom:          'Выбор заклинаний: случайные заклинания',
			KDMPModeHard:            'Сложный режим',
			KDMPModeExtreme:         'Экстремальный режим',
			KDMPModeSaveRogue:       'Режим сохранения: рогалик',
			KDMPModeLootNone:        'Возврат добычи: отключён',
			KDMPModeLootPartial:     'Возврат добычи: частичный',
			KDMPModePrisonEasy:      'Строгость тюрьмы: низкая',
			KDMPModePrisonStrict:    'Строгость тюрьмы: высокая',
			KDMPModePerksOff:        'Развитие перков: отключено',
			KDMPModePerksMandatory:  'Развитие перков: обязательно',
			KDMPModePerksDebuff:     'Развитие перков: только дебаффы',
			KDMPModeProgKey:         'Режим прогресса: поиск ключа',
			KDMPModeProgRandom:      'Режим прогресса: случайный',
			KDMPWaitingApproval: 'Ожидание, пока хост вас впустит…',
			KDMPStarting:        'Запуск…',
			KDMPNoAnswer:        'Нет ответа от WHERE — там точно кто-то хостит?',
			KDMPCouldNotReach:   'Не удалось связаться с WHERE',
			KDMPAlreadyHosting:  'Там уже кто-то хостит — присоединяйтесь к нему.',
			KDMPNobodyHosting:   'Там ещё никто не хостит — вы можете захостить сами.',
			KDMPRefusedDeclined: 'Хост отклонил вашу заявку.',
			KDMPRefusedFull:     'Эта игра заполнена.',
			KDMPRefusedBusy:     'Хост сейчас отвечает другому.',
			KDMPRefusedBuild:    'Разные версии игры — у хоста HOSTBUILD, у вас GUESTBUILD.',
			KDMPRefusedOther:    'Отклонено: REASON',
		},
	};

	/**
	 * KD's word for `key`, or `''` when it has none.
	 *
	 * One function rather than a guard per call site: `drawWorldSummary` had its own copy that tested
	 * for `'MISSING'` and let `[NotFound]` through, which is exactly how the second site drifted from
	 * the first.
	 */
	function kdText(key) {
		try {
			if (typeof TextGet !== 'function') return '';
			var s = String(TextGet(key) || '');
			if (!s || s === key) return '';
			if (s.indexOf('[NotFound]') >= 0 || s.indexOf('MISSING') >= 0) return '';
			return s;
		} catch (e) { return ''; }
	}

	/** Substitute bare UPPERCASE tokens. `split`/`join` so a `$&` in a value stays a `$&`. */
	function fill(s, params) {
		if (!params) return s;
		var out = String(s);
		for (var token in params) {
			if (!Object.prototype.hasOwnProperty.call(params, token)) continue;
			out = out.split(token).join(String(params[token] === undefined ? '' : params[token]));
		}
		return out;
	}

	/**
	 * KDM-289 — the language KD is running in, or `''` for "use the English source".
	 *
	 * ── WHY THIS IS A BARE READ AND NOT A LOOKUP ──────────────────────────────────────────────────
	 * `TranslationLanguage` is a bundle `let` (`out/main.js`, from `Scripts/Translation.ts:1`). Top-
	 * level `let`/`const`/`class` in a classic script land in the GLOBAL LEXICAL ENVIRONMENT, which is
	 * shared by every classic script in the realm but is NOT reflected on `globalThis` — so
	 * `globalThis.TranslationLanguage` is `undefined` and a bare read is the only way to see it. This
	 * file is injected as a `<script src>` (`INJECT` in demo-server.js), which is exactly such a
	 * script; `coop-lobby.js` already relies on the same rule from the other side when it assigns
	 * `KinkyDungeonState`.
	 *
	 * The `try` is not decoration: a bare read of an undeclared binding THROWS. This script also runs
	 * on pages with no KD bundle at all (the unit spec evaluates it in a bare `node:vm`), and a throw
	 * there would take every caller's label with it.
	 *
	 * ── WHY EVERYTHING UNKNOWN COLLAPSES TO ONE ANSWER ────────────────────────────────────────────
	 * The value is not reliably one of our six. It starts as `'EN'`; KD's own settings picker writes
	 * `''` for English (`KDLanguages[0]`); `GetUserPreferredLanguage` works from raw `Intl` locale
	 * segments; and upstream may add a language before we have seeds for it. Rather than a branch per
	 * case, anything that is not a table we have becomes `''` — which is the behaviour that shipped
	 * before this task, for every one of them.
	 */
	function activeLanguage() {
		var lang;
		try {
			// eslint-disable-next-line no-undef
			lang = typeof TranslationLanguage === 'string' ? TranslationLanguage : '';
		} catch (e) { return ''; }
		lang = String(lang || '').toUpperCase();
		return Object.prototype.hasOwnProperty.call(LANGS, lang) ? lang : '';
	}

	/**
	 * The seeded string for `key` in the active language, or `''` when there is none.
	 *
	 * Answers `''` rather than falling back itself, for the same reason `kdText` does: the precedence
	 * belongs in ONE place (`t`), and a helper that quietly substitutes English would make "did the
	 * seed resolve?" unanswerable from outside.
	 */
	function langText(key) {
		var lang = activeLanguage();
		if (!lang) return '';
		var table = LANGS[lang];
		return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : '';
	}

	/**
	 * The one helper. Four steps, in this order, and the order is the contract:
	 *
	 *   1. `kdText(key)`   — KD's OWN word, if a build ever learns our keys. It wins over our seeds
	 *                        deliberately: a localisation shipped by the game is better than ours, and
	 *                        this is the hook that lets one replace them without touching this file.
	 *   2. `langText(key)` — KDM-289: our seed for the language KD is running in.
	 *   3. `STRINGS[key]`  — the English source. Every language falls back here, per key, so a gap in
	 *                        one seed is one English sentence and never a blank.
	 *   4. `key`           — an undeclared key answers with the key itself rather than `''`: a blank
	 *                        line on the Host screen is the failure that looks like a layout bug, and
	 *                        `KDMPTypo` on screen names its own cause. The static guard
	 *                        (`mp-client-strings.spec.ts` R2) is what stops one reaching a player.
	 *
	 * ⚠️ STEP 1 MUST TEST FOR A WORD, NOT FOR A CALL. `kdText` maps KD's `[NotFound] …` and `MISSING`
	 * markers to `''`, and KD does not know a single `KDMP*` key today — so a step 1 that accepted
	 * whatever `TextGet` returned would swallow every seed below it and paint markers.
	 *
	 * `fill()` runs last, on whichever string won, so templating behaves identically in every
	 * language. That is what makes the token-parity check in the spec worth having.
	 */
	function t(key, params) {
		var s = kdText(key);
		if (!s) s = langText(key);
		if (!s) s = Object.prototype.hasOwnProperty.call(STRINGS, key) ? STRINGS[key] : key;
		return fill(s, params);
	}

	if (typeof Object.freeze === 'function') {
		Object.freeze(STRINGS);
		// Each table AND the map of tables: freezing only the outer object would leave every seed
		// writable, and a mod that scribbled on one would change what other players are told.
		for (var lang in LANGS) {
			if (Object.prototype.hasOwnProperty.call(LANGS, lang)) Object.freeze(LANGS[lang]);
		}
		Object.freeze(LANGS);
	}

	var api = {
		t: t, fill: fill, kdText: kdText,
		// KDM-289 — exported so the spec can assert on each STEP of the chain in `t` rather than only
		// on its outcome. A guard that can only see the end cannot tell "the seed won" from "the
		// English won and happens to match".
		langText: langText, activeLanguage: activeLanguage,
		STRINGS: STRINGS, LANGS: LANGS,
	};
	if (typeof Object.freeze === 'function') Object.freeze(api);
	(typeof window !== 'undefined' ? window : globalThis).KDMPText = api;
})();
