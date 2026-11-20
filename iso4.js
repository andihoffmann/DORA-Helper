// iso4.js - Journaltitel nach ISO 4 abkuerzen (Abschnitt 7 des ISSN-Handbuchs)
//
// Portierung von pyiso4 0.1.6 (MIT, (c) 2021 Pierre Beaujean,
// https://github.com/pierre-24/pyiso4) nach JavaScript. Die Woerterliste ist
// die "List of Title Word Abbreviations" (LTWA) des ISSN International Centre,
// aufbereitet in ltwa.json (scripts/build-ltwa.js).
//
// Abweichungen vom Original:
//  - Muster mit fuehrendem Bindestrich ("-logy") greifen wirklich; in pyiso4
//    verhindert str(reversed(...)) das.
//  - Positionen zwischen normalisiertem und Originaltitel werden zeichengenau
//    abgebildet statt nur ueber Ligaturen (ß -> ss usw.).
//  - Statt Praefixbaum ein Index ueber die ersten zwei Zeichen.
//
// Benutzung: const iso4 = Iso4.erstellen(ltwaDaten); iso4.abkuerzen('Journal of ...')
//
// Lizenz von pyiso4:
//   MIT License
//   Copyright (c) 2021 Pierre Beaujean
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

(function (global) {
    'use strict';

    // --- Normalisierung --------------------------------------------------------

    const SONDERZEICHEN = {
        'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L',
        'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'TH', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H',
        '’': "'", '‘': "'", '´': "'", '`': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '‐': '-', '‑': '-'
    };

    // Ein Zeichen in ASCII umsetzen (wie unidecode, fuer lateinische Schriften)
    function zeichenAscii(c) {
        if (SONDERZEICHEN[c] !== undefined) return SONDERZEICHEN[c];
        const zerlegt = c.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        return zerlegt;
    }

    // Text in ASCII umsetzen und dabei merken, wo jedes Originalzeichen landet.
    // karte[i] = Position im Ergebnis, an der Originalzeichen i beginnt.
    function asciiMitKarte(text) {
        let aus = '';
        const karte = new Array(text.length + 1);
        for (let i = 0; i < text.length; i++) {
            karte[i] = aus.length;
            aus += zeichenAscii(text[i]);
        }
        karte[text.length] = aus.length;
        return { text: aus, karte };
    }

    function soft(text) { return String(text).normalize('NFKC'); }
    function normal(text) { return asciiMitKarte(text).text; }

    const GRENZE = /^[-\s–—_.,:;!|=+*\\/"()&#%@$?]/;
    const BEUGUNG = /^([iaesn'’]{1,3})/;

    // --- Muster ------------------------------------------------------------------

    function musterAusEintrag(eintrag) {
        // eintrag: [muster (normalisiert, klein), ersatz, sprachen]
        const muster = eintrag[0];
        return {
            muster,
            ersatz: eintrag[1],
            sprachen: eintrag[2] ? eintrag[2].split(' ') : ['mul'],
            vorneStrich: muster[0] === '-',
            hintenStrich: muster[muster.length - 1] === '-'
        };
    }

    function schluessel(m) {
        if (m.vorneStrich) return m.muster.slice(1);
        if (m.hintenStrich) return m.muster.slice(0, -1);
        return m.muster;
    }

    // Suffixmuster ("-bearbeitung"): Stelle im ersten Wort von satz, an der
    // das Wortende beginnt, oder -1. Der Wortstamm davor muss erhalten bleiben.
    function suffixStelle(m, satz) {
        const wortEnde = satz.search(/[-\s\u2013\u2014_.,:;!|=+*\\/"()&#%@$?]/);
        const wort = wortEnde < 0 ? satz : satz.slice(0, wortEnde);
        const kern = m.muster.replace(/^-/, '').replace(/-$/, '');
        if (!kern) return -1;
        if (m.hintenStrich) {
            // "-bírál-": Wortteil mitten im Wort
            const i = wort.indexOf(kern, 1);
            return i > 0 ? i : -1;
        }
        for (let n = 0; n <= 3; n++) {
            if (n && !BEUGUNG.test(wort.slice(-n))) continue;
            const basis = n ? wort.slice(0, -n) : wort;
            if (basis.length > kern.length && basis.endsWith(kern)) return basis.length - kern.length;
        }
        return -1;
    }

    function passt(m, satz, sprachen) {
        if (sprachen && sprachen.length) {
            if (!m.sprachen.some(s => s === 'mul' || sprachen.includes(s))) return false;
        }

        if (m.vorneStrich) return suffixStelle(m, satz) >= 0;

        if (m.hintenStrich) {
            if (m.muster.length > satz.length + 1) return false;
        } else if (m.muster.length > satz.length) {
            return false;
        }

        const muster = m.muster;
        let ende = 0;
        for (let i = 0; i < muster.length; i++) {
            ende = i;
            const c = muster[i];
            if (c === '-' && i === muster.length - 1) return true;
            if (c !== (satz[i] || '').toLowerCase()) return false;
        }
        const beugung = BEUGUNG.exec(satz.slice(ende + 1));
        if (beugung) ende += beugung[1].length;
        if (ende === satz.length - 1) return true;
        return GRENZE.test(satz.slice(ende + 1));
    }

    // --- Lexer (wie pyiso4) --------------------------------------------------------

    const T = { WORT: 'W', ABK: 'ABBRV', STOPP: 'STPW', ARTIKEL: 'ARTC', TEIL: 'P', ORDINAL: 'ORDN', SYMBOL: 'SYMB', STRICH: 'HPHN', ENDE: 'EOS' };
    const TEILE = ['series', 'serie', 'part', 'section', 'série'];
    const TEILE_ABK = ['ser', 'sect', 'sec'];
    const ARTIKEL = ['a', 'an', 'the', 'der', 'die', 'das', 'den', 'dem', 'des', 'le', 'la', 'les', 'el', 'il', 'lo', 'los',
        'de', 'het', 'els', 'ses', 'es', 'gli', 'een'];
    const GAENGIGE_ABK = ['St', 'Mr', 'Ms', 'Mrs', 'Mx', 'Dr', 'Prof', 'vs'];
    const IST_ORDINAL = /^(?:[A-Z]|[IVXivx]+)/;
    const STOPPWOERTER = ('a an the and but or for nor so yet though when whenever where whereas wherever while about afore after ago '
        + 'along amid among amongst apropos as at atop but by ca circa for from hence in into like of off on onto ontop out over per since '
        + 'than til till to unlike until unto up upon upside versus via vis-a-vis vs with within für und aus zu zur im de et y del en di e '
        + "da delle della sue el do og i voor van dell' dell ed för tot vir o its sul fur").split(' ');

    function istAlnum(c) { return /[\p{L}\p{N}]/u.test(c); }

    function* zerlegen(eingabe) {
        const text = eingabe.normalize('NFC');
        const woerter = [];
        const re = /[^ \t\n]+/g;
        let m;
        while ((m = re.exec(text)) !== null) woerter.push({ wert: m[0], start: m.index, ende: m.index + m[0].length });

        function* mitStrich(wort, basis) {
            let laenge = 0;
            const teile = wort.split('-');
            for (let i = 0; i < teile.length; i++) {
                if (i > 0) { yield { typ: T.STRICH, wert: '-', pos: basis + laenge }; laenge += 1; }
                yield { typ: T.WORT, wert: teile[i], pos: basis + laenge };
                laenge += teile[i].length;
            }
        }

        let warTeil = -2;
        for (let zaehler = 0; zaehler < woerter.length; zaehler++) {
            const { start, ende } = woerter[zaehler];
            let wort = woerter[zaehler].wert;
            // Frei stehende Striche ("Gefahrstoffe - Reinhaltung") entfallen
            if (/^[-\u2013\u2014]+$/.test(wort)) continue;
            let klein = wort.toLowerCase();

            let endSymbole = '';
            while (klein.length > 0 && !istAlnum(klein[klein.length - 1])) {
                endSymbole = klein[klein.length - 1] + endSymbole;
                klein = klein.slice(0, -1);
                wort = wort.slice(0, -1);
            }
            if (endSymbole.length > 0 && endSymbole[0] === "'") {
                wort = wort + "'";
                klein = klein + "'";
                endSymbole = endSymbole.slice(1);
            }

            if (wort.length > 0) {
                const mitPunkt = endSymbole.length > 0 && endSymbole[0] === '.';
                if (mitPunkt && (GAENGIGE_ABK.includes(wort) || wort.includes('.'))) {
                    endSymbole = endSymbole.slice(1);
                    yield { typ: T.ABK, wert: wort + '.', pos: start };
                } else if (mitPunkt && wort.length === 1 && wort.toUpperCase() === wort) {
                    endSymbole = endSymbole.slice(1);
                    yield { typ: T.ABK, wert: wort + '.', pos: start };
                } else if (GAENGIGE_ABK.includes(wort)) {
                    yield { typ: T.ABK, wert: wort, pos: start };
                } else if (mitPunkt && TEILE_ABK.includes(klein)) {
                    endSymbole = endSymbole.slice(1);
                    yield { typ: T.TEIL, wert: wort + '.', pos: start };
                    warTeil = zaehler;
                } else if (TEILE.includes(klein)) {
                    yield { typ: T.TEIL, wert: wort, pos: start };
                    warTeil = zaehler;
                } else if (IST_ORDINAL.test(wort) && zaehler === warTeil + 1) {
                    yield { typ: T.ORDINAL, wert: wort, pos: start };
                } else if (ARTIKEL.includes(klein)) {
                    yield { typ: T.ARTIKEL, wert: wort, pos: start };
                } else if (["l'", "d'", 'l’', 'd’'].includes(klein.slice(0, 2))) {
                    yield { typ: T.ARTIKEL, wert: wort.slice(0, 2), pos: start };
                    yield* mitStrich(wort.slice(2), start + 2);
                } else if (["dell'", "nell'", 'dell’', 'nell’'].includes(klein.slice(0, 5))) {
                    yield { typ: T.ARTIKEL, wert: wort.slice(0, 5), pos: start };
                    yield* mitStrich(wort.slice(5), start + 5);
                } else if (STOPPWOERTER.includes(klein)) {
                    yield { typ: T.STOPP, wert: wort, pos: start };
                } else {
                    yield* mitStrich(wort, start);
                }
            }
            if (endSymbole.length > 0) yield { typ: T.SYMBOL, wert: endSymbole, pos: ende - endSymbole.length };
        }
        yield { typ: T.ENDE, wert: '\0', pos: -1 };
    }

    // --- Abkuerzen ------------------------------------------------------------------

    function Iso4(daten, optionen) {
        const opt = optionen || {};
        this.vorne = new Map();   // erste zwei Zeichen -> Muster
        this.kurz = [];           // Schluessel kuerzer als zwei Zeichen
        this.hinten = [];         // Suffixmuster ("-logy")
        (daten || []).forEach(e => {
            const m = musterAusEintrag(e);
            if (m.vorneStrich) { if (!opt.ohneSuffixe) this.hinten.push(m); return; }
            const k = schluessel(m);
            if (k.length < 2) { this.kurz.push(m); return; }
            const s = k.slice(0, 2);
            if (!this.vorne.has(s)) this.vorne.set(s, []);
            this.vorne.get(s).push(m);
        });
    }

    // Rangfolge (abweichend von pyiso4, das Wortanfaenge mit Bindestrich immer
    // vorzieht): Muster in der Sprache des Titels zuerst, dann ein Eintrag fuer
    // das ganze Wort ("health" = nicht abkuerzen) vor einem Wortanfang
    // ("heal-"), dann das laengste. Wortenden ("-bearbeitung") nur, wenn sonst
    // nichts passt.
    Iso4.prototype.kandidaten = function (satz, sprachen, bevorzugt) {
        const wert = m => (bevorzugt && m.sprachen.some(s => s === 'mul' || bevorzugt.includes(s)) ? 2000 : 0)
            + (m.hintenStrich ? 0 : 1000) + m.muster.length;
        const nachRang = (a, b) => wert(b) - wert(a);
        const vorne = (this.vorne.get(satz.slice(0, 2)) || []).concat(this.kurz).filter(m => passt(m, satz, sprachen)).sort(nachRang);
        if (vorne.length) return vorne;
        return this.hinten.filter(m => passt(m, satz, sprachen)).sort(nachRang);
    };

    // Grobe Spracherkennung ueber Fuellwoerter; Ergebnis in LTWA-Sprachcodes
    const SPRACH_MERKMALE = {
        eng: ['of', 'and', 'the', 'journal', 'for', 'in', 'on', 'review', 'letters'],
        ger: ['der', 'die', 'das', 'und', 'für', 'fur', 'zeitschrift', 'des', 'zur', 'im'],
        fre: ['de', 'des', 'et', 'la', 'le', 'les', 'revue', 'du', 'pour'],
        ita: ['di', 'della', 'delle', 'e', 'rivista', 'il', 'per', 'dei']
    };
    function spracheRaten(titel) {
        const woerter = titel.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
        let beste = 'eng', punkte = 0;
        Object.keys(SPRACH_MERKMALE).forEach(sp => {
            const p = woerter.filter(w => SPRACH_MERKMALE[sp].includes(w)).length;
            if (p > punkte) { punkte = p; beste = sp; }
        });
        return [beste];
    }

    // Gross-/Kleinschreibung und Akzente des Originals uebernehmen
    function schreibweiseUebernehmen(abk, original) {
        const zeichen = Array.from(soft(abk));
        const orig = Array.from(original);
        for (let i = 0; i < zeichen.length && i < orig.length; i++) {
            const o = zeichenAscii(orig[i]);
            if ([o.toLowerCase(), o.toUpperCase()].includes(zeichenAscii(zeichen[i]))) zeichen[i] = orig[i];
        }
        return zeichen.join('');
    }

    // Laenge im normalisierten Text -> Anzahl Originalzeichen ab startOrig
    function originalLaenge(karte, startOrig, normLaenge) {
        const ziel = karte[startOrig] + normLaenge;
        let i = startOrig;
        while (i < karte.length - 1 && karte[i] < ziel) i++;
        return i - startOrig;
    }

    Iso4.prototype.wortAbkuerzen = function (satzNorm, wort, fuehrung, sprachen, bevorzugt) {
        const muster = this.kandidaten(satzNorm, sprachen, bevorzugt);
        if (muster.length) {
            const m = muster[0];
            if (m.ersatz === '-') return { abk: wort, laenge: wort.length, norm: false };
            if (m.vorneStrich) {
                // Wortstamm im Original behalten, nur das Ende ersetzen
                const stelleNorm = suffixStelle(m, satzNorm);
                const { karte } = asciiMitKarte(wort);
                let i = 0;
                while (i < wort.length && karte[i] < stelleNorm) i++;
                const ende = m.ersatz.replace(/^-/, '').replace(/-$/, '');
                return { abk: wort.slice(0, i) + schreibweiseUebernehmen(ende, wort.slice(i)), laenge: wort.length, norm: false };
            }
            // Faellt beim Abkuerzen nichts weg ("Control" -> "control."), bleibt das Wort
            if (m.hintenStrich && m.ersatz.replace(/\.$/, '').toLowerCase() === normal(wort).toLowerCase()) {
                return { abk: wort, laenge: wort.length, norm: false };
            }
            return { abk: schreibweiseUebernehmen(m.ersatz, fuehrung), laenge: m.muster.length, norm: true };
        }
        return { abk: wort, laenge: wort.length, norm: false };
    };

    Iso4.prototype.abkuerzen = function (titel, optionen) {
        const opt = Object.assign({ teilEntfernen: true, sprachen: null }, optionen || {});
        const bevorzugt = opt.sprachen || spracheRaten(titel);
        const titelSoft = soft(titel).normalize('NFC');
        const { text: normText, karte } = asciiMitKarte(titelSoft);
        const titelNorm = normText.toLowerCase();

        let tokens = [];
        let erstes = true;
        let vorigerArtikel = null;

        for (const t of zerlegen(titelSoft)) {
            if (t.typ === T.ARTIKEL) { vorigerArtikel = t; continue; }
            if (t.typ === T.STOPP && !erstes) continue;
            if (t.typ === T.SYMBOL) {
                t.wert = t.wert.replace(/,/g, '').replace(/\./g, ',').replace(/,,,/g, '');
                if (t.wert === '&') continue;
            } else if (t.typ === T.ORDINAL && tokens.length && tokens[tokens.length - 1].typ === T.TEIL && opt.teilEntfernen) {
                tokens = tokens.slice(0, -1);
            }
            if (vorigerArtikel) {
                if (t.typ === T.SYMBOL || t.typ === T.ENDE) tokens.push(vorigerArtikel);
                vorigerArtikel = null;
            }
            if (t.typ !== T.ENDE && t.wert !== '') tokens.push(t);
            erstes = false;
        }

        if (tokens.length === 1) return tokens[0].wert;
        if (tokens.length === 2 && tokens[0].typ === T.STOPP) return tokens[0].wert + ' ' + tokens[1].wert;
        if (tokens.length === 2 && tokens[1].typ === T.SYMBOL) return tokens[0].wert + tokens[1].wert;

        let ergebnis = '';
        let mitStrich = false;
        let ohneLeer = false;
        let naechste = 0;
        for (const t of tokens) {
            let abk = t.wert;
            if (t.typ === T.STRICH) {
                mitStrich = true;
            } else if (t.typ === T.WORT || t.typ === T.TEIL) {
                if (t.pos >= naechste) {
                    const r = this.wortAbkuerzen(titelNorm.slice(karte[t.pos]), t.wert, titelSoft.slice(t.pos), opt.sprachen, bevorzugt);
                    abk = r.abk;
                    naechste = t.pos + (r.norm ? originalLaenge(karte, t.pos, r.laenge) : r.laenge);
                } else {
                    abk = '';
                    ohneLeer = true;
                }
            } else if (t.typ === T.SYMBOL) {
                ohneLeer = true;
            }
            ergebnis += ((ergebnis.length === 0 || mitStrich || ohneLeer) ? '' : ' ') + abk;
            ohneLeer = false;
            if (t.typ !== T.STRICH) mitStrich = false;
        }
        return ergebnis;
    };

    Iso4.erstellen = function (daten, optionen) { return new Iso4(daten, optionen); };
    Iso4.normal = normal;

    if (typeof module !== 'undefined' && module.exports) module.exports = Iso4;
    else global.Iso4 = Iso4;
})(typeof globalThis !== 'undefined' ? globalThis : this);
