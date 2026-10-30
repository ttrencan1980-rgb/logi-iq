// Logi IQ Sklad – mobilná appka skladníka (PWA, bez build kroku)
import { CONFIG } from "./config.js";
import { ukazkovaApi, zivaApi } from "./api.js";
import { kameraBezi, spustiKameru, zastavKameru } from "./scanner.js";

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s ?? "").trim().toUpperCase();
const datum = (d) => (d ? d.slice(8, 10) + ". " + d.slice(5, 7) + ". " + d.slice(0, 4) : "bez exp.");
const cislo = (n) => Number(n).toLocaleString("sk-SK", { maximumFractionDigits: 3 });

const ukazka = !CONFIG.supabaseAnonKey || new URLSearchParams(location.search).has("ukazka");
let api;

const S = {
  obr: "prihlasenie", pouzivatel: null, mfa: false, busy: false, hlasenie: null,
  ulohy: null, vyber: new Set(),
  vlna: null,          // {kroky, objednavky, i, faza, mnozstvo, chyby:{}, zabalene:{}}
  prijem: null,        // {faza, polozka, mnozstvo, sarza, expiracia, navrh, doklad}
  inv: null,           // {faza, lokacia, riadky, doklad}
  hladat: null,        // {polozka, miesta}
  robot: null,         // {nastavenie, navrhy, uprava}
  obnova: null,        // {faza: "odkaz" | "mfa" | "heslo", odoslane}
};
const jeDispecer = () => ["spravca", "dispecer"].includes(S.pouzivatel?.rola);

// --------------------------------------------------------------------------- pomocné
function hlas(typ, text) {
  S.hlasenie = { typ, text };
  if (typ === "chyba") navigator.vibrate?.([80, 60, 80]);
  render();
}
async function rob(fn) {
  S.busy = true; S.hlasenie = null; render();
  try { await fn(); } catch (e) { S.hlasenie = { typ: "chyba", text: e.message || String(e) }; navigator.vibrate?.([80, 60, 80]); }
  S.busy = false; render();
}
function prejdi(obr) {
  S.obr = obr; S.hlasenie = null;
  if (!potrebujeSken()) zastavKameru();
  render();
  $("#obsah").scrollTop = 0;
}

// Čo práve skenujeme a čo ponúknuť ako ukážkový sken
function kontextSkenu() {
  if (S.obr === "vlna" && S.vlna && !vlnaHotova()) {
    const k = S.vlna.kroky[S.vlna.i];
    if (S.vlna.faza === "pozicia") return { co: "pozicia", text: "Naskenuj štítok pozície " + k.lokacia, ukazky: [k.lokacia, "B-05-1"] };
    if (S.vlna.faza === "tovar") return { co: "tovar", text: "Naskenuj tovar " + k.nazov, ukazky: [k.ean ?? k.kod, "8580001000451"] };
  }
  if (S.obr === "prijem" && S.prijem?.faza === "sken") return { co: "prijem", text: "Naskenuj EAN prijatého tovaru", ukazky: ["8580001000451", "8580001003308"] };
  if (S.obr === "prijem" && S.prijem?.faza === "naskladnit") return { co: "naskladnit", text: "Naskenuj pozíciu, kam tovar ukladáš", ukazky: [S.prijem.navrh?.do_kod ?? "A-02-1"] };
  if (S.obr === "inventura" && S.inv?.faza === "sken") return { co: "inv-lokacia", text: "Naskenuj štítok pozície", ukazky: ["B-05-1", "A-02-1"] };
  if (S.obr === "inventura" && S.inv?.faza === "pocitaj") return { co: "inv-tovar", text: "Tovar navyše? Naskenuj ho", ukazky: ["8580001005005"] };
  if (S.obr === "hladat") return { co: "hladat", text: "Naskenuj tovar alebo napíš kód", ukazky: ["8580001000017", "VOD-500"] };
  return null;
}
const potrebujeSken = () => !!kontextSkenu();
const vlnaHotova = () => S.vlna && S.vlna.i >= S.vlna.kroky.length;

// --------------------------------------------------------------------------- skeny
async function naSken(kod) {
  const kx = kontextSkenu();
  if (!kx || S.busy) return;
  const k = norm(kod);
  if (kx.co === "pozicia") {
    const krok = S.vlna.kroky[S.vlna.i];
    if (k === norm(krok.lokacia)) { S.vlna.faza = "tovar"; S.hlasenie = { typ: "ok", text: "Pozícia " + krok.lokacia + " sedí." }; navigator.vibrate?.(40); render(); }
    else hlas("chyba", "Toto je " + k + ". Potrebuješ pozíciu " + krok.lokacia + ".");
    return;
  }
  if (kx.co === "tovar") {
    const krok = S.vlna.kroky[S.vlna.i];
    if ((krok.ean && kod.trim() === krok.ean) || k === norm(krok.kod)) {
      S.vlna.faza = "mnozstvo"; S.vlna.mnozstvo = krok.mnozstvo; S.hlasenie = { typ: "ok", text: "Správny tovar." }; navigator.vibrate?.(40); render();
    } else hlas("chyba", "Iný tovar. Hľadáš " + krok.nazov + ", šarža " + (krok.sarza || "—") + ".");
    return;
  }
  if (kx.co === "prijem") return rob(async () => {
    const p = await api.najdiPolozku(kod);
    if (!p) throw new Error("Kód " + kod + " nepoznám. Položku musí najprv založiť vedúca skladu.");
    S.prijem = { faza: "formular", polozka: p, mnozstvo: 1, sarza: "", expiracia: "" };
  });
  if (kx.co === "naskladnit") return rob(async () => {
    const l = await api.najdiLokaciu(kod);
    if (!l) throw new Error("Pozícia " + k + " neexistuje.");
    if (l.typ === "prijem") throw new Error("Tovar už je na príjme. Naskenuj regál, kam ho ukladáš.");
    if (S.prijem.navrh?.do_kod && l.kod !== S.prijem.navrh.do_kod && !S.prijem.inaPotvrdena) {
      S.prijem.inaPozicia = l; S.prijem.inaPotvrdena = false;
      throw new Error("Navrhnutá je " + S.prijem.navrh.do_kod + ". Ak chceš naozaj " + l.kod + ", potvrď ju tlačidlom nižšie.");
    }
    await api.naskladni(S.prijem.navrh, l.id);
    S.prijem.faza = "hotovo"; S.prijem.ulozeneNa = l.kod;
  });
  if (kx.co === "inv-lokacia") return rob(async () => {
    const l = await api.najdiLokaciu(kod);
    if (!l) throw new Error("Pozícia " + k + " neexistuje.");
    const obsah = await api.obsahLokacie(l.id);
    S.inv = { faza: "pocitaj", lokacia: l, riadky: obsah.map((r) => ({ ...r, spocitane: null })) };
  });
  if (kx.co === "inv-tovar") return rob(async () => {
    const p = await api.najdiPolozku(kod);
    if (!p) throw new Error("Kód " + kod + " nepoznám.");
    if (!S.inv.riadky.some((r) => r.polozka_id === p.id)) S.inv.riadky.push({ polozka_id: p.id, kod: p.kod, nazov: p.nazov, jednotka: p.jednotka, sarza: "", expiracia: null, mnozstvo: 0, spocitane: null, navyse: true });
  });
  if (kx.co === "hladat") return rob(async () => {
    const p = await api.najdiPolozku(kod);
    if (!p) throw new Error("Kód " + kod + " nepoznám.");
    S.hladat = { polozka: p, miesta: await api.kdeJe(p.id) };
  });
}

// --------------------------------------------------------------------------- akcie
const A = {
  async ukazka(rola) { S.pouzivatel = await api.prihlas(rola); await A.domov(); },
  async domov() { S.vlna = null; prejdi("ulohy"); await rob(async () => { S.ulohy = await api.ulohy(); S.vyber = new Set(S.ulohy.objednavky.slice(0, 12).map((o) => o.id)); }); },
  async odhlas() { await api.odhlas(); S.pouzivatel = null; prejdi("prihlasenie"); },
  vyberObj(id) { const n = Number(id); S.vyber.has(n) ? S.vyber.delete(n) : S.vyber.add(n); render(); },
  async zacniVlnu() {
    if (!S.vyber.size) return hlas("chyba", "Vyber aspoň jednu objednávku.");
    await rob(async () => {
      const v = await api.pripravVlnu([...S.vyber]);
      S.vlna = { ...v, i: 0, faza: "pozicia", mnozstvo: 0, chyby: {}, zabalene: {} };
      for (const [n, k] of v.kroky.entries()) if (k.chyba) S.vlna.chyby[n] = k.mnozstvo;
      while (S.vlna.kroky[S.vlna.i]?.chyba) S.vlna.i++;
      S.obr = "vlna";
    });
  },
  menej() { S.vlna.mnozstvo = Math.max(0, S.vlna.mnozstvo - 1); render(); },
  viac() { S.vlna.mnozstvo = Math.min(S.vlna.kroky[S.vlna.i].mnozstvo, S.vlna.mnozstvo + 1); render(); },
  potvrdKrok() {
    const k = S.vlna.kroky[S.vlna.i];
    if (S.vlna.mnozstvo < k.mnozstvo) S.vlna.chyby[S.vlna.i] = k.mnozstvo - S.vlna.mnozstvo;
    dalsiKrok();
  },
  chyba() { S.vlna.chyby[S.vlna.i] = S.vlna.kroky[S.vlna.i].mnozstvo; hlas("chyba", "Zapísané: chýba " + S.vlna.kroky[S.vlna.i].nazov + ". Vedúca skladu dostane upozornenie."); dalsiKrok(true); },
  async expeduj(id) {
    const kg = Number($("#kg-" + id)?.value || 1), bal = Number($("#bal-" + id)?.value || 1);
    await rob(async () => { const v = await api.expeduj(Number(id), kg, bal); S.vlna.zabalene[id] = v.zasielka; });
  },
  zacniPrijem() { S.prijem = { faza: "sken" }; prejdi("prijem"); },
  async ulozPrijem() {
    const p = S.prijem;
    p.mnozstvo = Number($("#p-mn").value); p.sarza = $("#p-sarza").value.trim(); p.expiracia = $("#p-exp").value || null;
    if (!(p.mnozstvo > 0)) return hlas("chyba", "Zadaj množstvo väčšie ako 0.");
    if (!p.expiracia) return hlas("chyba", "Zadaj dátum spotreby, sklad sleduje expirácie.");
    await rob(async () => { const v = await api.prijmi(p); p.doklad = v.doklad; p.navrh = v.navrh; p.faza = "naskladnit"; });
  },
  async potvrdInuPoziciu() {
    const l = S.prijem.inaPozicia;
    await rob(async () => { await api.naskladni(S.prijem.navrh, l.id); S.prijem.faza = "hotovo"; S.prijem.ulozeneNa = l.kod; });
  },
  necham() { S.prijem.faza = "hotovo"; S.prijem.ulozeneNa = "PRÍJEM"; render(); },
  zacniInventuru() { S.inv = { faza: "sken" }; prejdi("inventura"); },
  async ulozInventuru() {
    for (const r of S.inv.riadky) { const v = $("#inv-" + r.polozka_id + "-" + (r.sarza || "x")); r.spocitane = v?.value === "" ? null : Number(v?.value); }
    if (S.inv.riadky.some((r) => r.spocitane === null || r.spocitane < 0)) return hlas("chyba", "Doplň spočítané množstvo pri každom riadku (aj 0).");
    await rob(async () => { const v = await api.inventura(S.inv.lokacia.id, S.inv.riadky); S.inv.doklad = v.doklad; S.inv.faza = "hotovo"; });
  },
  hladaj() { S.hladat = null; prejdi("hladat"); },
  zabudnute() { S.obnova = { faza: "odkaz", email: $("#email")?.value ?? "" }; prejdi("obnova"); },
  spatPrihlasenie() { S.obnova = null; prejdi("prihlasenie"); },
  async posliObnovu() {
    const email = $("#o-email").value.trim();
    if (!email) return hlas("chyba", "Zadaj e-mail.");
    S.obnova.email = email;
    await rob(async () => { await api.posliObnovu(email); S.obnova.odoslane = true;
      S.hlasenie = { typ: "ok", text: "E-mail je odoslaný. Príde od Supabase (predmet „Reset Your Password“), pozri aj spam." }; });
  },
  async robot() { prejdi("robot"); await rob(async () => { S.robot = await api.botPrehlad(); }); },
  async schval(id) {
    const t = $("#bot-text-" + id)?.value;
    await rob(async () => { const v = await api.botRozhodni(Number(id), true, t); S.robot = await api.botPrehlad();
      S.hlasenie = { typ: "ok", text: v.stav === "zamietnuty" ? "Zamietnuté." : v.odosle_sa ? "Schválené, odpoveď odíde zákazníkovi." : S.robot.nastavenie?.rezim === "ostry" ? "Schválené." : "Schválené. Skúšobný režim: nič sa neodoslalo." }; });
  },
  async zamietni(id) { await rob(async () => { await api.botRozhodni(Number(id), false); S.robot = await api.botPrehlad(); S.hlasenie = { typ: "ok", text: "Zamietnuté, zákazníkovi nič neodíde." }; }); },
  async skusRobota() {
    const od = $("#bot-od").value.trim(), text = $("#bot-sprava").value.trim(), predmet = $("#bot-predmet").value.trim();
    if (!od || !text) return hlas("chyba", "Vyplň odosielateľa aj text e-mailu.");
    await rob(async () => { const v = await api.botSkus({ od, predmet, text }); S.robot = await api.botPrehlad();
      S.hlasenie = { typ: "ok", text: "Robot pripravil návrh: " + ({ odpoved: "odpoveď", presun_terminu: "presun termínu", eskalacia: "odovzdať človeku" }[v.typ] ?? v.typ) + ". Nič sa neodoslalo." }; });
  },
  async kamera() {
    if (kameraBezi()) { zastavKameru(); render(); return; }
    try { await spustiKameru($("#kamera"), (kod) => naSken(kod)); render(); }
    catch (e) { hlas("chyba", e.name === "NotAllowedError" ? "Prístup ku kamere je zamietnutý. Povoľ ho v nastaveniach prehliadača." : e.message); }
  },
  sken(kod) { naSken(kod); },
};

function dalsiKrok(tichy) {
  S.vlna.i++; S.vlna.faza = "pozicia";
  while (S.vlna.kroky[S.vlna.i]?.chyba) S.vlna.i++;
  if (!tichy) S.hlasenie = null;
  if (vlnaHotova()) zastavKameru();
  render();
}

// --------------------------------------------------------------------------- obrazovky
const btn = (akcia, text, trieda = "", arg = "") => `<button class="${trieda}" data-a="${akcia}" ${arg !== "" ? `data-arg="${esc(arg)}"` : ""}>${text}</button>`;

function obrPrihlasenie() {
  if (ukazka) return `<section class="karta stred">
      <h1>Ukážkový režim</h1>
      <p class="tlmene">Appka nie je pripojená k databáze, dáta sú vymyslené. Môžeš si vyskúšať vychystávanie, príjem, inventúru aj hľadanie.</p>
      ${btn("ukazka", "Vstúpiť ako skladník", "hlavne")}
      ${btn("ukazka", "Vstúpiť ako dispečer (robot)", "sekundarne", "dispecer")}
    </section>`;
  return `<form class="karta" data-form="${S.mfa ? "mfa" : "login"}">
      <h1>${S.mfa ? "Overovací kód" : "Prihlásenie"}</h1>
      ${S.mfa ? `<label for="mfa">Kód z aplikácie Authenticator</label><input id="mfa" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>`
        : `<label for="email">E-mail</label><input id="email" type="email" autocomplete="username" required>
           <label for="heslo">Heslo</label><input id="heslo" type="password" autocomplete="current-password" required>`}
      <button class="hlavne" type="submit">${S.mfa ? "Overiť" : "Prihlásiť sa"}</button>
      ${S.mfa ? "" : btn("zabudnute", "Zabudnuté heslo", "sekundarne")}
    </form>`;
}

function obrObnova() {
  const o = S.obnova;
  if (o.faza === "mfa") return `<form class="karta" data-form="obnova-mfa">
      <h1>Overovací kód</h1>
      <p class="tlmene">Odkaz platí. Ešte zadaj kód z aplikácie Authenticator, potom si nastavíš nové heslo.</p>
      <label for="o-mfa">Kód (6 číslic)</label><input id="o-mfa" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <button class="hlavne" type="submit">Overiť</button>
    </form>`;
  if (o.faza === "heslo") return `<form class="karta" data-form="obnova-heslo">
      <h1>Nové heslo</h1>
      <p class="tlmene">Aspoň 10 znakov. Heslo nikomu neposielaj, ani do chatu.</p>
      <label for="o-h1">Nové heslo</label><input id="o-h1" type="password" autocomplete="new-password" minlength="10" required>
      <label for="o-h2">Zopakuj heslo</label><input id="o-h2" type="password" autocomplete="new-password" minlength="10" required>
      <button class="hlavne" type="submit">Uložiť heslo a prihlásiť sa</button>
    </form>`;
  return `<form class="karta" data-form="obnova-odkaz">
      <h1>Zabudnuté heslo</h1>
      <p>1. Zadaj svoj e-mail a pošli si odkaz na obnovu.</p>
      <label for="o-email">E-mail</label><input id="o-email" type="email" autocomplete="username" value="${esc(o.email ?? "")}">
      ${btn("posliObnovu", o.odoslane ? "Poslať znova" : "Poslať e-mail na obnovu", "sekundarne")}
      <p>2. V e-maile <b>na odkaz neklikaj</b>. Klikni naň pravým tlačidlom → <b>Kopírovať adresu odkazu</b> a vlož ho sem.</p>
      <label for="o-odkaz">Odkaz z e-mailu</label><textarea id="o-odkaz" rows="3" autocomplete="off" spellcheck="false"></textarea>
      <button class="hlavne" type="submit">Pokračovať</button>
      ${btn("spatPrihlasenie", "Späť na prihlásenie", "sekundarne")}
    </form>`;
}

function obrUlohy() {
  const u = S.ulohy;
  if (!u) return `<p class="tlmene">Načítavam úlohy…</p>`;
  const obj = u.objednavky.map((o) => `<label class="riadok-obj"><input type="checkbox" data-a="vyberObj" data-arg="${o.id}" ${S.vyber.has(o.id) ? "checked" : ""}>
      <span><b>${esc(o.zakaznik)}</b><small class="mono">${esc(o.cislo)}${o.priorita > 0 ? " · prednostne" : ""}</small></span></label>`).join("");
  return `<h1 class="pozdrav">Ahoj, ${esc(S.pouzivatel?.meno ?? "")}</h1>
    ${jeDispecer() ? `<section class="karta">
      <span class="stitok">Robot-dispečer</span>
      <p>Odpovedá zákazníkom na e-maily. Návrhy schvaľuješ ty.</p>
      ${btn("robot", "Otvoriť návrhy robota", "hlavne tmave")}
    </section>` : ""}
    <section class="karta akcent">
      <span class="stitok">Teraz</span>
      <h2>Vychystať ${u.objednavky.length} ${u.objednavky.length === 1 ? "objednávku" : u.objednavky.length < 5 ? "objednávky" : "objednávok"}</h2>
      ${u.objednavky.length ? `<div class="zoznam-obj">${obj}</div>${btn("zacniVlnu", `Začať vlnu (${S.vyber.size})`, "hlavne tmave")}` : `<p>Všetko je vychystané.</p>`}
    </section>
    <div class="mriezka">
      ${btn("zacniPrijem", `<b>Príjem</b><small>${u.naPrijme ? u.naPrijme + " čaká na naskladnenie" : "skenom EAN"}</small>`, "dlazdica")}
      ${btn("zacniInventuru", "<b>Inventúra</b><small>jednej pozície</small>", "dlazdica")}
      ${btn("hladaj", "<b>Kde je tovar</b><small>sken alebo kód</small>", "dlazdica")}
    </div>
    ${u.expiruju.length ? `<section class="karta varovanie"><h3>Predať prednostne</h3>${u.expiruju.map((e) => `<p><b>${esc(e.nazov)}</b> · šarža ${esc(e.sarza || "—")} · exp. ${datum(e.expiracia)}</p>`).join("")}</section>` : ""}`;
}

function obrVlna() {
  const v = S.vlna;
  if (vlnaHotova()) {
    const chyby = Object.entries(v.chyby);
    return `<section class="karta">
        <h1>Vlna je vychystaná</h1>
        ${chyby.length ? `<p class="hlasenie chyba">Chýba ${chyby.length} ${chyby.length === 1 ? "položka" : "položky"}: ${chyby.map(([n, m]) => esc(v.kroky[n].nazov) + " " + cislo(m) + " " + esc(v.kroky[n].jednotka)).join(", ")}. Objednávky s chýbajúcim tovarom neexpeduj, vedúca to dorieši.</p>` : `<p class="tlmene">Všetko kompletné. Zabaľ objednávky a expeduj ich.</p>`}
      </section>
      ${v.objednavky.map((o) => {
        const z = v.zabalene[o.id];
        const nekompletna = chyby.some(([n]) => v.kroky[n].objednavky?.includes(o.cislo.slice(-5)) || v.kroky[n].objednavky?.includes(o.cislo));
        return `<section class="karta">
          <div class="medzi"><b>${esc(o.zakaznik)}</b><span class="mono tlmene">${esc(o.cislo)}</span></div>
          ${z ? `<p class="hlasenie ok">Expedované · zásielka <b class="mono">${esc(z)}</b></p>`
            : nekompletna ? `<p class="hlasenie chyba">Nekompletná, počká na doriešenie.</p>`
            : `<div class="riadok-pol"><label for="kg-${o.id}">Váha kg</label><input id="kg-${o.id}" type="number" inputmode="decimal" min="0.1" step="0.1" value="1">
               <label for="bal-${o.id}">Balíky</label><input id="bal-${o.id}" type="number" inputmode="numeric" min="1" value="1"></div>
               ${btn("expeduj", "Zabalené, expedovať", "hlavne", o.id)}`}
        </section>`;
      }).join("")}
      ${btn("domov", "Hotovo, späť na úlohy", "sekundarne")}`;
  }
  const k = v.kroky[v.i];
  const kroky = ["pozicia", "tovar", "mnozstvo"];
  return `<section class="karta krok">
      <div class="kroky">${kroky.map((f, n) => `<span class="${f === v.faza ? "aktivny" : kroky.indexOf(v.faza) > n ? "hotovy" : ""}">${["Pozícia", "Tovar", "Množstvo"][n]}</span>`).join("")}</div>
      <p class="tlmene">Choď na</p>
      <div class="lokacia mono">${esc(k.lokacia)}</div>
      <h2>${esc(k.nazov)}</h2>
      <p class="mono tlmene">${esc(k.kod)} · šarža ${esc(k.sarza || "—")} · exp. ${datum(k.expiracia)}</p>
      <div class="zobrat"><span>Zobrať</span><b class="mono">${cislo(k.mnozstvo)} ${esc(k.jednotka)}</b></div>
      <p class="tlmene mensie">Pre objednávky ${esc(k.objednavky)}</p>
    </section>
    ${v.faza === "mnozstvo" ? `<section class="karta">
        <p>Koľko si vložil do prepravky?</p>
        <div class="stepper">${btn("menej", "−", "krokove")}<b class="mono">${cislo(v.mnozstvo)}</b>${btn("viac", "+", "krokove")}</div>
        ${btn("potvrdKrok", v.mnozstvo < k.mnozstvo ? `Potvrdiť, chýba ${cislo(k.mnozstvo - v.mnozstvo)}` : "Potvrdiť a ďalej", "hlavne")}
      </section>` : ""}
    <div class="dvojica">${btn("chyba", "Tovar chýba", "nebezpecne")}${btn("domov", "Prerušiť", "sekundarne")}</div>`;
}

function obrPrijem() {
  const p = S.prijem;
  if (p.faza === "sken") return `<h1>Príjem tovaru</h1><p class="tlmene">Naskenuj čiarový kód na tovare. Množstvo a šaržu zadáš v ďalšom kroku.</p>`;
  if (p.faza === "formular") return `<form class="karta" data-form="prijem">
      <h2>${esc(p.polozka.nazov)}</h2>
      <p class="mono tlmene">${esc(p.polozka.kod)} · EAN ${esc(p.polozka.ean ?? "—")}</p>
      <label for="p-mn">Množstvo (${esc(p.polozka.jednotka)})</label>
      <input id="p-mn" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(p.mnozstvo)}" required>
      <div class="dvojica">
        <div><label for="p-sarza">Šarža</label><input id="p-sarza" value="${esc(p.sarza)}" maxlength="40" autocomplete="off"></div>
        <div><label for="p-exp">Spotrebujte do</label><input id="p-exp" type="date" value="${esc(p.expiracia)}"></div>
      </div>
      <button class="hlavne" type="submit">Uložiť príjem</button>
    </form>`;
  if (p.faza === "naskladnit") return `<section class="karta">
      <p class="hlasenie ok">Príjemka <b class="mono">${esc(p.doklad)}</b> je uložená.</p>
      <p>Odnes tovar na pozíciu</p>
      <div class="lokacia mono">${esc(p.navrh?.do_kod ?? "—")}</div>
      <p class="tlmene mensie">${p.navrh?.do_kod ? "Navrhnutá podľa domovskej pozície alebo voľného miesta." : "Žiadna voľná pozícia, nechaj tovar na príjme."}</p>
    </section>
    ${p.inaPozicia ? btn("potvrdInuPoziciu", "Uložiť na " + esc(p.inaPozicia.kod), "hlavne") : ""}
    ${btn("necham", "Nechať zatiaľ na príjme", "sekundarne")}`;
  return `<section class="karta">
      <h1>Hotovo</h1>
      <p>${esc(p.polozka.nazov)} · ${cislo(p.mnozstvo)} ${esc(p.polozka.jednotka)} je na pozícii <b class="mono">${esc(p.ulozeneNa)}</b>.</p>
    </section>
    <div class="dvojica">${btn("zacniPrijem", "Ďalší príjem", "hlavne")}${btn("domov", "Na úlohy", "sekundarne")}</div>`;
}

function obrInventura() {
  const v = S.inv;
  if (v.faza === "sken") return `<h1>Inventúra pozície</h1><p class="tlmene">Naskenuj štítok pozície. Potom spočítaj všetko, čo na nej leží. Systémové množstvo neuvidíš, aby počítanie bolo nestranné.</p>`;
  if (v.faza === "pocitaj") return `<form data-form="inventura">
      <h1 class="mono">${esc(v.lokacia.kod)}</h1>
      ${v.riadky.length ? "" : `<p class="tlmene">Podľa systému je pozícia prázdna. Ak tu niečo je, naskenuj to.</p>`}
      ${v.riadky.map((r) => `<section class="karta">
          <b>${esc(r.nazov)}</b>${r.navyse ? ` <span class="odznak">navyše</span>` : ""}
          <p class="mono tlmene">${esc(r.kod)} · šarža ${esc(r.sarza || "—")} · exp. ${datum(r.expiracia)}</p>
          <label for="inv-${r.polozka_id}-${esc(r.sarza || "x")}">Spočítané (${esc(r.jednotka)})</label>
          <input id="inv-${r.polozka_id}-${esc(r.sarza || "x")}" type="number" inputmode="decimal" min="0" step="any" value="${r.spocitane ?? ""}">
        </section>`).join("")}
      <button class="hlavne" type="submit">Uložiť inventúru</button>
    </form>`;
  return `<section class="karta"><h1>Inventúra uložená</h1><p>Doklad <b class="mono">${esc(v.doklad)}</b>. Rozdiely sa zapísali do skladu.</p></section>
    <div class="dvojica">${btn("zacniInventuru", "Ďalšia pozícia", "hlavne")}${btn("domov", "Na úlohy", "sekundarne")}</div>`;
}

function obrHladat() {
  const h = S.hladat;
  if (!h) return `<h1>Kde je tovar</h1><p class="tlmene">Naskenuj tovar alebo napíš jeho kód.</p>`;
  const spolu = h.miesta.reduce((s, m) => s + Number(m.mnozstvo), 0);
  return `<h1>${esc(h.polozka.nazov)}</h1>
    <p class="mono tlmene">${esc(h.polozka.kod)} · spolu ${cislo(spolu)} ${esc(h.polozka.jednotka)}</p>
    ${h.miesta.length ? h.miesta.map((m) => `<section class="karta medzi">
        <span><b class="mono velke">${esc(m.lokacia)}</b><small class="tlmene">${esc(m.sklad)}${m.typ === "karantena" ? " · karanténa" : ""}</small></span>
        <span class="vpravo"><b class="mono">${cislo(m.mnozstvo)}</b><small class="tlmene">šarža ${esc(m.sarza || "—")} · ${datum(m.expiracia)}</small></span>
      </section>`).join("") : `<p class="hlasenie chyba">Tovar nie je na sklade.</p>`}`;
}


const TYPY = { odpoved: "Odpoveď", presun_terminu: "Presun termínu", eskalacia: "Pre človeka", suhrn: "Súhrn dňa" };
const STAVY = { navrh: "čaká na teba", schvaleny: "schválené", zamietnuty: "zamietnuté", odoslany: "vybavené", chyba: "chyba odoslania" };
function obrRobot() {
  const r = S.robot;
  if (!r) return `<p class="tlmene">Načítavam návrhy robota…</p>`;
  const rezim = r.nastavenie?.rezim ?? "skusobny";
  const caka = r.navrhy.filter((n) => n.stav === "navrh");
  const karta = (n) => `<section class="karta ${n.typ === "eskalacia" && n.stav === "navrh" ? "varovanie" : ""}">
      <div class="medzi"><span class="odznak">${esc(TYPY[n.typ] ?? n.typ)}</span><small class="tlmene">${esc(n.vytvorene ?? "")} · ${esc(STAVY[n.stav] ?? n.stav)}${n.automaticky ? " · automaticky" : ""}</small></div>
      ${n.typ !== "suhrn" ? `<p class="mensie"><b>${esc(n.od ?? "")}</b>${n.kanal === "test" ? ` <span class="odznak">skúška</span>` : ""}${n.overeny === false ? ` <span class="odznak">neoverený odosielateľ</span>` : ""}${n.zasielka ? ` · <span class="mono">${esc(n.zasielka)}</span>` : ""}</p>
      <p class="mensie tlmene bot-sprava">${n.sprava_predmet ? `<b>${esc(n.sprava_predmet)}</b>\n` : ""}${esc(n.sprava_text ?? "")}</p>` : ""}
      ${n.typ === "presun_terminu" ? `<p class="hlasenie ok">Nový termín: <b>${datum(n.novy_datum)}</b></p>` : ""}
      ${n.stav === "navrh" && n.typ !== "eskalacia" && n.typ !== "suhrn"
        ? `<label for="bot-text-${n.id}">${n.typ === "presun_terminu" ? "Potvrdenie pre zákazníka" : "Odpoveď zákazníkovi"} (môžeš upraviť)</label><textarea id="bot-text-${n.id}" rows="6">${esc(n.text)}</textarea>`
        : `<p class="bot-text">${esc(n.text)}</p>`}
      ${n.dovod ? `<p class="mensie tlmene">Prečo: ${esc(n.dovod)}${n.istota != null && n.typ !== "eskalacia" ? ` · istota ${Math.round(Number(n.istota) * 100)} %` : ""}</p>` : ""}
      ${n.stav === "navrh" ? `<div class="dvojica">${btn("schval", n.typ === "eskalacia" || n.typ === "suhrn" ? "Vybavené" : n.typ === "presun_terminu" ? "Schváliť presun" : "Schváliť", "hlavne", n.id)}${n.typ !== "suhrn" ? btn("zamietni", "Zamietnuť", "sekundarne", n.id) : ""}</div>` : ""}
    </section>`;
  return `<h1>Robot-dispečer</h1>
    <section class="karta ${rezim === "ostry" ? "akcent" : "varovanie"}">
      <b>${rezim === "ostry" ? "Ostrý režim" : rezim === "vypnuty" ? "Robot je vypnutý" : "Skúšobný režim"}</b>
      <p class="mensie">${rezim === "ostry" ? "Schválené odpovede odchádzajú zákazníkom. Jednoduché odpovede s vysokou istotou robot pošle sám." : "Robot len navrhuje. Zákazníkom sa nič neodošle, ani keď návrh schváliš."}</p>
    </section>
    <form class="karta" data-form="bot-skus">
      <h2>Vyskúšaj robota</h2>
      <p class="mensie tlmene">Napíš e-mail, ako keby prišiel od zákazníka. Robot pripraví návrh, nič sa neodošle.</p>
      <label for="bot-od">Od (e-mail zákazníka)</label><input id="bot-od" type="email" value="eva@example.sk" autocomplete="off">
      <label for="bot-predmet">Predmet</label><input id="bot-predmet" value="Kedy príde balík?" autocomplete="off">
      <label for="bot-sprava">Text e-mailu</label><textarea id="bot-sprava" rows="4">Dobrý deň, kedy mi príde objednávka? Ďakujem.</textarea>
      <button class="hlavne" type="submit">Pripraviť návrh</button>
    </form>
    <h2>${caka.length ? `Čaká na teba: ${caka.length}` : "Nič nečaká na schválenie"}</h2>
    ${caka.map(karta).join("")}
    ${r.navrhy.filter((n) => n.stav !== "navrh").length ? `<h2>Vybavené</h2>${r.navrhy.filter((n) => n.stav !== "navrh").map(karta).join("")}` : ""}`;
}

// --------------------------------------------------------------------------- vykreslenie
function render() {
  const prihlaseny = !!S.pouzivatel;
  $("#hlavicka-info").innerHTML = prihlaseny
    ? (S.obr === "vlna" && S.vlna && !vlnaHotova()
        ? `<span>Krok ${S.vlna.i + 1} z ${S.vlna.kroky.length}</span><span class="progres"><i style="width:${Math.round(S.vlna.i / S.vlna.kroky.length * 100)}%"></i></span>`
        : `<span>${esc(S.pouzivatel.meno)} · ${esc(CONFIG.nazovSkladu)}</span>`)
    : `<span>${ukazka ? "ukážka" : ""}</span>`;
  const obr = { prihlasenie: obrPrihlasenie, ulohy: obrUlohy, vlna: obrVlna, prijem: obrPrijem, inventura: obrInventura, hladat: obrHladat, robot: obrRobot, obnova: obrObnova }[S.obr];
  $("#obsah").innerHTML = (S.hlasenie ? `<p class="hlasenie ${S.hlasenie.typ}" role="${S.hlasenie.typ === "chyba" ? "alert" : "status"}">${esc(S.hlasenie.text)}</p>` : "") + obr();
  $("#obsah").setAttribute("aria-busy", String(S.busy));

  const kx = kontextSkenu();
  const dok = $("#dok");
  dok.hidden = !kx;
  if (kx) {
    $("#dok-text").textContent = kx.text;
    $("#kamera").hidden = !kameraBezi();
    $("#kamera-btn").textContent = kameraBezi() ? "Vypnúť kameru" : "Zapnúť kameru";
    $("#ukazky").innerHTML = ukazka ? `<span>Ukážka:</span>` + kx.ukazky.map((u) => `<button type="button" data-a="sken" data-arg="${esc(u)}">${esc(u)}</button>`).join("") : "";
    if (!kameraBezi()) setTimeout(() => $("#kod")?.focus({ preventScroll: true }), 0);   // ručná čítačka píše rovno sem
  }
  $("#lista").hidden = !prihlaseny || S.obr === "vlna";
  for (const b of document.querySelectorAll("#lista button")) b.setAttribute("aria-current", String(b.dataset.obr === S.obr || (b.dataset.obr === "ulohy" && S.obr === "ulohy")));
  document.body.classList.toggle("zaneprazdneny", S.busy);
}

// --------------------------------------------------------------------------- udalosti
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (!b || S.busy) return;
  if (b.type === "checkbox") return A[b.dataset.a](b.dataset.arg);
  e.preventDefault();
  A[b.dataset.a]?.(b.dataset.arg);
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.dataset.form;
  if (f === "kod") { const v = $("#kod").value; $("#kod").value = ""; if (v.trim()) naSken(v); return; }
  // hodnoty čítať PRED rob(): rob() hneď prekreslí obrazovku a formulár by bol prázdny
  if (f === "login") { const email = $("#email").value.trim(), heslo = $("#heslo").value; return rob(async () => {
    const v = await api.prihlas(email, heslo);
    if (v.potrebujeMfa) { S.mfa = true; return; }
    S.pouzivatel = v; await A.domov();
  }); }
  if (f === "mfa") { const kod = $("#mfa").value; return rob(async () => { S.pouzivatel = await api.overMfa(kod); S.mfa = false; await A.domov(); }); }
  if (f === "prijem") return A.ulozPrijem();
  if (f === "inventura") return A.ulozInventuru();
  if (f === "bot-skus") return A.skusRobota();
  if (f === "obnova-odkaz") { const odkaz = $("#o-odkaz").value; return rob(async () => { const v = await api.obnovZOdkazu(odkaz); S.obnova.faza = v.potrebujeMfa ? "mfa" : "heslo"; }); }
  if (f === "obnova-mfa") { const kod = $("#o-mfa").value; return rob(async () => { await api.overMfaBezProfilu(kod); S.obnova.faza = "heslo"; }); }
  if (f === "obnova-heslo") {
    const h1 = $("#o-h1").value, h2 = $("#o-h2").value;
    if (h1.length < 10) return hlas("chyba", "Heslo musí mať aspoň 10 znakov.");
    if (h1 !== h2) return hlas("chyba", "Heslá sa nezhodujú.");
    return rob(async () => { S.pouzivatel = await api.nastavHeslo(h1); S.obnova = null; await A.domov(); S.hlasenie = { typ: "ok", text: "Heslo je zmenené. Si prihlásený." }; });
  }
});
$("#kamera-btn").addEventListener("click", () => A.kamera());
for (const b of document.querySelectorAll("#lista button")) b.addEventListener("click", () => (b.dataset.obr === "ulohy" ? A.domov() : b.dataset.obr === "hladat" ? A.hladaj() : A.odhlas()));
document.addEventListener("visibilitychange", () => { if (document.hidden) zastavKameru(); });

// --------------------------------------------------------------------------- štart
(async () => {
  try {
    api = ukazka ? ukazkovaApi() : await zivaApi(CONFIG);
    const p = await api.pouzivatel();
    if (p) { S.pouzivatel = p; await A.domov(); } else render();
  } catch (e) {
    render(); hlas("chyba", "Nepodarilo sa spojiť so serverom: " + e.message);
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
