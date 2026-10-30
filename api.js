// Dátová vrstva appky skladníka. Dve implementácie s rovnakým rozhraním:
//   zivaApi(config)  – Supabase (RPC funkcie z migrácií 001–004, oprávnenia kontroluje databáza)
//   ukazkovaApi()    – vymyslené dáta v pamäti na predvedenie a testy
// Rozhranie:
//   prihlas(email, heslo) → {meno, rola, potrebujeMfa}     overMfa(kod)     odhlas()     pouzivatel()
//   ulohy() → {naPrijme, objednavky[], expiruju[]}
//   pripravVlnu(ids) → {kroky[], objednavky[]}             expeduj(id, kg, baliky) → {zasielka}
//   najdiPolozku(kod) → polozka | null                     prijmi({polozka, mnozstvo, sarza, expiracia}) → {doklad, navrh}
//   najdiLokaciu(kod) → lokacia | null                     naskladni(navrh, doLokacie) → void
//   obsahLokacie(lokaciaId) → riadky[]                     inventura(lokaciaId, riadky) → {doklad}
//   kdeJe(polozkaId) → riadky[]
//   Robot-dispečer (správca, dispečer): botPrehlad() → {nastavenie, navrhy[]}   botSkus({od, predmet, text}) → {typ}
//                                       botRozhodni(id, schval, text?) → {stav}

const norm = (s) => String(s ?? "").trim().toUpperCase();

export async function zivaApi(config) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true } });

  const ok = ({ data, error }) => {
    if (error) throw new Error(error.message || "Chyba spojenia so serverom.");
    return data;
  };
  const rpc = async (fn, args) => ok(await sb.rpc(fn, args));
  let profil = null;

  async function nacitajProfil() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    // Bez registrovanej relácie databáza nič nevráti (stav_relacie)
    const stav = await rpc("zaregistruj_relaciu", { p_zariadenie: "Logi IQ mobil · " + navigator.userAgent.slice(0, 80) });
    if (stav !== "ok") {
      const dovody = { zablokovany: "Účet je zablokovaný.", skuska_skoncila: "Skúšobné obdobie skončilo.", vyprsala: "Prihlásenie vypršalo, prihlás sa znova.", zrusena: "Relácia bola zrušená." };
      throw new Error(dovody[stav] ?? "Prihlásenie sa nepodarilo (" + stav + ").");
    }
    const p = ok(await sb.from("profily").select("meno, rola").eq("id", user.id).single());
    profil = { meno: p.meno, rola: p.rola };
    return profil;
  }

  return {
    rezim: "ziva",
    async pouzivatel() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      try { return profil ?? await nacitajProfil(); } catch { return null; }
    },
    async prihlas(email, heslo) {
      ok(await sb.auth.signInWithPassword({ email, password: heslo }));
      const aal = ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel());
      if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") return { potrebujeMfa: true };
      return await nacitajProfil();
    },
    async overMfa(kod) {
      const f = ok(await sb.auth.mfa.listFactors()).totp?.[0];
      if (!f) throw new Error("Účet nemá nastavené dvojfázové overenie.");
      ok(await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: kod.trim() }));
      return await nacitajProfil();
    },
    async odhlas() { profil = null; await sb.auth.signOut(); },

    // Zabudnuté heslo: e-mail s odkazom → používateľ odkaz SKOPÍRUJE (neotvára) a vloží do appky
    async posliObnovu(email) { ok(await sb.auth.resetPasswordForEmail(email.trim())); },
    async obnovZOdkazu(text) {
      const t = String(text).trim();
      let u; try { u = new URL(t); } catch { throw new Error("Toto nie je odkaz. Skopíruj celý odkaz z e-mailu (pravým tlačidlom → Kopírovať adresu odkazu)."); }
      const h = new URLSearchParams(u.hash.slice(1));
      if (h.get("error_description")) throw new Error("Odkaz už neplatí (" + h.get("error_description") + "). Pošli si nový e-mail.");
      if (h.get("access_token") && h.get("refresh_token")) {
        ok(await sb.auth.setSession({ access_token: h.get("access_token"), refresh_token: h.get("refresh_token") }));
      } else {
        const token = u.searchParams.get("token_hash") ?? u.searchParams.get("token");
        if (!token || (u.searchParams.get("type") ?? "recovery") !== "recovery") throw new Error("V odkaze chýba kód na obnovu hesla. Skopíruj odkaz z e-mailu „Reset Password“.");
        ok(await sb.auth.verifyOtp({ token_hash: token, type: "recovery" }));
      }
      const aal = ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel());
      return { potrebujeMfa: aal.nextLevel === "aal2" && aal.currentLevel !== "aal2" };
    },
    async overMfaBezProfilu(kod) {
      const f = ok(await sb.auth.mfa.listFactors()).totp?.[0];
      if (!f) throw new Error("Účet nemá nastavené dvojfázové overenie.");
      ok(await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: kod.trim() }));
    },
    async nastavHeslo(heslo) {
      ok(await sb.auth.updateUser({ password: heslo }));
      return await nacitajProfil();
    },

    async ulohy() {
      const [prijem, obj, exp] = await Promise.all([
        sb.from("zasoby_pozicie").select("polozka_id", { count: "exact", head: true }).eq("typ", "prijem"),
        sb.from("predaj_objednavky").select("id, cislo, externe_id, zakaznik, stav, priorita, prijate")
          .in("stav", ["rezervovana", "vychystava_sa"]).order("priorita", { ascending: false }).order("prijate").limit(50),
        sb.from("blizke_expiracie").select("kod, nazov, sarza, expiracia, mnozstvo, dni").order("expiracia").limit(5),
      ]);
      if (prijem.error) throw new Error(prijem.error.message);
      return { naPrijme: prijem.count ?? 0, objednavky: ok(obj), expiruju: ok(exp) };
    },

    async pripravVlnu(ids) {
      const riadky = await rpc("vychystavaci_zoznam", { p_objednavky: ids });
      const kody = [...new Set(riadky.map((r) => r.kod))];
      const pol = ok(await sb.from("polozky").select("kod, ean").in("kod", kody));
      const ean = Object.fromEntries(pol.map((p) => [p.kod, p.ean]));
      await rpc("zacni_vychystavat", { p_objednavky: ids });
      const objednavky = ok(await sb.from("predaj_objednavky").select("id, cislo, zakaznik").in("id", ids));
      return {
        objednavky,
        kroky: riadky.map((r) => ({ lokacia: r.lokacia, kod: r.kod, ean: ean[r.kod] ?? null, nazov: r.nazov, sarza: r.sarza,
          expiracia: r.expiracia, mnozstvo: Number(r.mnozstvo), jednotka: r.jednotka, objednavky: r.objednavky, chyba: r.lokacia === "CHÝBA" })),
      };
    },
    async expeduj(id, kg, baliky) {
      const v = await rpc("expeduj_objednavku", { p_id: id, p_hmotnost_kg: kg, p_balikov: baliky });
      return { zasielka: v.zasielka };
    },

    async najdiPolozku(kod) {
      const k = String(kod).trim();
      const r = ok(await sb.from("polozky").select("id, kod, ean, nazov, jednotka, domovska_lokacia_id")
        .or(`ean.eq.${k.replace(/[^A-Za-z0-9._/-]/g, "")},kod.eq.${norm(k).replace(/[^A-Z0-9._/-]/g, "")}`).eq("aktivna", true).limit(1));
      return r[0] ?? null;
    },
    async prijmi({ polozka, mnozstvo, sarza, expiracia }) {
      const doklad = await rpc("zapis_prijem", { p_partner: null, p_poznamka: "Príjem z mobilu",
        p_riadky: [{ polozka_id: polozka.id, mnozstvo, sarza, expiracia }] });
      const navrh = (await rpc("navrh_naskladnenia", {})).find((n) => n.polozka_id === polozka.id) ?? null;
      return { doklad, navrh };
    },
    async najdiLokaciu(kod) {
      const r = ok(await sb.from("lokacie").select("id, kod, typ, sklad_id").eq("kod", norm(kod)).eq("aktivna", true).limit(1));
      return r[0] ?? null;
    },
    async naskladni(navrh, doLokacie) {
      await rpc("naskladni", { p_navrh: [{ ...navrh, do_lokacie: doLokacie }] });
    },
    async obsahLokacie(id) {
      return ok(await sb.from("zasoby_pozicie").select("polozka_id, kod, nazov, jednotka, sarza, expiracia, mnozstvo").eq("lokacia_id", id).order("kod"));
    },
    async inventura(id, riadky) {
      const doklad = await rpc("inventura_pozicie", { p_lokacia: id, p_poznamka: "Inventúra z mobilu",
        p_riadky: riadky.map((r) => ({ polozka_id: r.polozka_id, sarza: r.sarza ?? "", expiracia: r.expiracia, spocitane: r.spocitane })) });
      return { doklad };
    },
    async botPrehlad() { return await rpc("bot_prehlad", {}); },
    async botRozhodni(id, schval, text) { return await rpc("bot_rozhodni", { p_navrh: id, p_schval: schval, p_text: text ?? null }); },
    async botSkus(p) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Prihlás sa znova.");
      const r = await fetch(config.supabaseUrl + "/functions/v1/dispecer-bot/skus", {
        method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json", apikey: config.supabaseAnonKey },
        body: JSON.stringify(p) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 404 && !d.chyba) throw new Error("Robot ešte nie je nasadený (funkcia dispecer-bot).");
      if (!r.ok) throw new Error(d.chyba || "Robot neodpovedal (" + r.status + ").");
      return d;
    },
    async kdeJe(polozkaId) {
      return ok(await sb.from("zasoby_pozicie").select("sklad, lokacia, typ, sarza, expiracia, mnozstvo").eq("polozka_id", polozkaId).order("poradie"));
    },
  };
}

// ---------------------------------------------------------------------------
// Ukážkový režim: rovnaké správanie, dáta v pamäti
// ---------------------------------------------------------------------------
export function ukazkovaApi() {
  const cakaj = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const polozky = [
    { id: 1, kod: "MLK-001", ean: "8580001000017", nazov: "Mlieko polotučné 1 l", jednotka: "ks", domov: "A-02-1" },
    { id: 2, kod: "JOG-014", ean: "8580001000147", nazov: "Jogurt biely 150 g", jednotka: "ks", domov: "A-03-1" },
    { id: 3, kod: "MAK-110", ean: "8580001001106", nazov: "Múka hladká 1 kg", jednotka: "ks", domov: "B-01-1" },
    { id: 4, kod: "KAV-330", ean: "8580001003308", nazov: "Káva zrnková 1 kg", jednotka: "ks", domov: "B-07-1" },
    { id: 5, kod: "VOD-500", ean: "8580001005005", nazov: "Voda pramenitá 1,5 l", jednotka: "ks", domov: "C-02-1" },
    { id: 6, kod: "OLE-045", ean: "8580001000451", nazov: "Olej slnečnicový 1 l", jednotka: "ks", domov: "B-04-1" },
  ];
  const botNavrhy = [
    { id: 1, typ: "odpoved", stav: "odoslany", automaticky: false, kanal: "email", od: "Jana Kollárová <jana@example.sk>", overeny: true, zasielka: "ZS2026-01185",
      sprava_predmet: "Kedy príde objednávka?", sprava_text: "Dobrý deň, kedy mi dnes príde objednávka? Ďakujem.", istota: 0.94, dovod: "Stav na_trase, odhad 15:05",
      text: "Dobrý deň, vaša zásielka ZS2026-01185 je na ceste, vodič príde dnes medzi 14:35 a 15:35.\n\nS pozdravom\nKeylo s.r.o.", vytvorene: "29.10. 08:12" },
    { id: 2, typ: "presun_terminu", stav: "navrh", kanal: "email", od: "Tomáš Baláž <tomas@example.sk>", overeny: true, zasielka: "ZS2026-01169", novy_datum: "2026-10-31",
      sprava_predmet: "Nebudem doma", sprava_text: "Zajtra nebudem doma, dalo by sa to doručiť v sobotu dopoludnia?", istota: 0.9, dovod: "Zákazník žiada sobotu dopoludnia",
      text: "Dobrý deň, doručenie presunieme na sobotu 31. 10. medzi 9:00 a 12:00.\n\nS pozdravom\nKeylo s.r.o.", vytvorene: "29.10. 09:40" },
    { id: 3, typ: "eskalacia", stav: "navrh", kanal: "email", od: "Bistro Zelená <bistro@example.sk>", overeny: true, zasielka: "ZS2026-01184",
      sprava_predmet: "Poškodený tovar", sprava_text: "Včera prišli dva kartóny mlieka rozbité. Chceme náhradu.", istota: 0, dovod: "Reklamácia, rieši človek",
      text: "Zákazník reklamuje 2 rozbité kartóny mlieka zo zásielky ZS2026-01184 a žiada náhradu.", vytvorene: "29.10. 10:05" },
  ];
  const lokacie = ["PRIJEM", "A-02-1", "A-03-1", "B-01-1", "B-04-1", "B-05-1", "B-07-1", "C-02-1", "C-03-1"]
    .map((kod, i) => ({ id: i + 1, kod, typ: kod === "PRIJEM" ? "prijem" : "regal", sklad_id: 1 }));
  const lok = (kod) => lokacie.find((l) => l.kod === kod);
  let zasoby = [
    { lokacia: "A-02-1", polozka_id: 1, sarza: "L2", expiracia: "2026-11-15", mnozstvo: 24 },
    { lokacia: "A-02-1", polozka_id: 1, sarza: "L3", expiracia: "2027-01-10", mnozstvo: 48 },
    { lokacia: "A-03-1", polozka_id: 2, sarza: "J7", expiracia: "2026-11-09", mnozstvo: 120 },
    { lokacia: "B-01-1", polozka_id: 3, sarza: "F2", expiracia: "2027-04-18", mnozstvo: 210 },
    { lokacia: "B-05-1", polozka_id: 6, sarza: "O9", expiracia: "2027-02-14", mnozstvo: 30 },
    { lokacia: "B-05-1", polozka_id: 3, sarza: "F3", expiracia: "2027-05-30", mnozstvo: 12 },
    { lokacia: "B-07-1", polozka_id: 4, sarza: "K2", expiracia: "2027-01-30", mnozstvo: 38 },
    { lokacia: "C-02-1", polozka_id: 5, sarza: "V6", expiracia: "2027-04-12", mnozstvo: 180 },
  ];
  let objednavky = [
    { id: 1184, cislo: "EO2026-01184", externe_id: "W-5531", zakaznik: "Bistro Zelená", stav: "rezervovana", priorita: 2 },
    { id: 1185, cislo: "EO2026-01185", externe_id: "W-5532", zakaznik: "Jana Kollárová", stav: "rezervovana", priorita: 0 },
    { id: 1186, cislo: "EO2026-01186", externe_id: "W-5534", zakaznik: "Pekáreň U Lukáša", stav: "rezervovana", priorita: 0 },
    { id: 1187, cislo: "EO2026-01187", externe_id: "W-5537", zakaznik: "Ing. Martin Šimko", stav: "rezervovana", priorita: 0 },
  ];
  const riadkyObj = {
    1184: [[1, 6], [2, 12]], 1185: [[1, 4], [5, 18]], 1186: [[3, 4]], 1187: [[4, 2]],
  };
  let cislo = 412;
  const pol = (id) => polozky.find((p) => p.id === id);

  return {
    rezim: "ukazka",
    async pouzivatel() { return null; },
    async prihlas(rola) { await cakaj(); return rola === "dispecer" ? { meno: "Keylo", rola: "dispecer" } : { meno: "Mária", rola: "skladnik" }; },
    async overMfa() { return { meno: "Mária", rola: "skladnik" }; },
    async odhlas() {},
    async posliObnovu() { throw new Error("V ukážke sa heslo neobnovuje."); },
    async obnovZOdkazu() { throw new Error("V ukážke sa heslo neobnovuje."); },
    async overMfaBezProfilu() {},
    async nastavHeslo() { throw new Error("V ukážke sa heslo neobnovuje."); },
    async ulohy() {
      await cakaj();
      return {
        naPrijme: zasoby.filter((z) => z.lokacia === "PRIJEM" && z.mnozstvo > 0).length,
        objednavky: objednavky.filter((o) => ["rezervovana", "vychystava_sa"].includes(o.stav)),
        expiruju: [{ kod: "JOG-014", nazov: "Jogurt biely 150 g", sarza: "J7", expiracia: "2026-11-09", mnozstvo: 120, dni: 12 },
                   { kod: "MLK-001", nazov: "Mlieko polotučné 1 l", sarza: "L2", expiracia: "2026-11-15", mnozstvo: 24, dni: 18 }],
      };
    },
    async pripravVlnu(ids) {
      await cakaj(400);
      const potreba = {};
      for (const id of ids) for (const [p, m] of riadkyObj[id] ?? []) (potreba[p] ??= { m: 0, obj: new Set() }), potreba[p].m += m, potreba[p].obj.add(objednavky.find((o) => o.id === id).cislo.slice(-5));
      const kroky = [];
      for (const [pid, { m, obj }] of Object.entries(potreba)) {
        let zostava = m;
        for (const z of zasoby.filter((z) => z.polozka_id === Number(pid) && z.mnozstvo > 0 && z.lokacia !== "PRIJEM").sort((a, b) => a.expiracia.localeCompare(b.expiracia))) {
          if (zostava <= 0) break;
          const ber = Math.min(zostava, z.mnozstvo);
          const p = pol(Number(pid));
          kroky.push({ lokacia: z.lokacia, kod: p.kod, ean: p.ean, nazov: p.nazov, sarza: z.sarza, expiracia: z.expiracia, mnozstvo: ber, jednotka: p.jednotka, objednavky: [...obj].join(", ") });
          zostava -= ber;
        }
      }
      kroky.sort((a, b) => a.lokacia.localeCompare(b.lokacia));
      for (const o of objednavky) if (ids.includes(o.id)) o.stav = "vychystava_sa";
      return { kroky, objednavky: objednavky.filter((o) => ids.includes(o.id)) };
    },
    async expeduj(id) {
      await cakaj();
      const o = objednavky.find((x) => x.id === id);
      for (const [p, m] of riadkyObj[id] ?? []) {
        let zostava = m;
        for (const z of zasoby.filter((z) => z.polozka_id === p && z.mnozstvo > 0).sort((a, b) => a.expiracia.localeCompare(b.expiracia))) {
          const ber = Math.min(zostava, z.mnozstvo); z.mnozstvo -= ber; zostava -= ber; if (zostava <= 0) break;
        }
      }
      o.stav = "zabalena";
      return { zasielka: "ZS2026-0" + (1300 + (id % 100)) };
    },
    async najdiPolozku(kod) {
      await cakaj(150);
      const k = norm(kod);
      const p = polozky.find((x) => x.ean === String(kod).trim() || x.kod === k);
      return p ? { id: p.id, kod: p.kod, ean: p.ean, nazov: p.nazov, jednotka: p.jednotka } : null;
    },
    async prijmi({ polozka, mnozstvo, sarza, expiracia }) {
      await cakaj();
      zasoby.push({ lokacia: "PRIJEM", polozka_id: polozka.id, sarza, expiracia, mnozstvo });
      const p = pol(polozka.id);
      return { doklad: "PR2026-00" + cislo++, navrh: { polozka_id: p.id, kod: p.kod, mnozstvo, z_lokacie: lok("PRIJEM").id, do_lokacie: lok(p.domov)?.id, do_kod: p.domov } };
    },
    async najdiLokaciu(kod) { await cakaj(120); return lok(norm(kod)) ?? null; },
    async naskladni(navrh, doLokacie) {
      await cakaj();
      const ciel = lokacie.find((l) => l.id === doLokacie).kod;
      for (const z of zasoby.filter((z) => z.lokacia === "PRIJEM" && z.polozka_id === navrh.polozka_id)) z.lokacia = ciel;
    },
    async obsahLokacie(id) {
      await cakaj();
      const kod = lokacie.find((l) => l.id === id)?.kod;
      return zasoby.filter((z) => z.lokacia === kod && z.mnozstvo > 0).map((z) => ({ ...pol(z.polozka_id), polozka_id: z.polozka_id, sarza: z.sarza, expiracia: z.expiracia, mnozstvo: z.mnozstvo }));
    },
    async inventura(id, riadky) {
      await cakaj();
      const kod = lokacie.find((l) => l.id === id)?.kod;
      for (const r of riadky) {
        const z = zasoby.find((x) => x.lokacia === kod && x.polozka_id === r.polozka_id && x.sarza === r.sarza);
        if (z) z.mnozstvo = r.spocitane;
      }
      return { doklad: "IN2026-00" + cislo++ };
    },
    // ----- robot-dispečer (ukážka: jednoduché pravidlá namiesto umelej inteligencie)
    async botPrehlad() { await cakaj(150); return { nastavenie: { rezim: "skusobny" }, navrhy: botNavrhy.slice().reverse() }; },
    async botRozhodni(id, schval, text) {
      await cakaj();
      const n = botNavrhy.find((x) => x.id === id);
      if (!n || n.stav !== "navrh") throw new Error("O návrhu už bolo rozhodnuté.");
      if (text) n.text = text;
      n.stav = !schval ? "zamietnuty" : n.typ === "eskalacia" ? "odoslany" : "schvaleny";
      return { stav: n.stav };
    },
    async botSkus({ od, predmet, text }) {
      await cakaj(700);
      const overeny = /eva@example\.sk|peter@example\.sk/i.test(od);
      const t = String(text);
      let typ = "odpoved", navrh, dovod, istota = 0.92, novy;
      if (/^\s*človek|reklam|poškoden|peniaze|vráti/i.test(t)) { typ = "eskalacia"; navrh = "Zákazník potrebuje človeka: " + t.slice(0, 120); dovod = "Reklamácia alebo žiadosť o človeka"; istota = 0; }
      else if (!overeny) { navrh = "Dobrý deň, z bezpečnostných dôvodov poskytujeme informácie o zásielke len z e-mailu, ktorý ste uviedli pri objednávke."; dovod = "Odosielateľ nie je overený"; istota = 0.8; }
      else if (/presun|zajtra|piatok|pondel|inokedy|nebudem doma/i.test(t)) { typ = "presun_terminu"; novy = "2026-10-30"; navrh = "Dobrý deň, doručenie presunieme na piatok 30. 10. medzi 9:00 a 12:00."; dovod = "Zákazník žiada iný deň"; istota = 0.88; }
      else { navrh = "Dobrý deň, vaša zásielka ZS2026-01185 je na ceste, vodič príde dnes medzi 14:35 a 15:35. Sledovať ju môžete tu: https://sledovanie.keylo.sk/?t=…"; dovod = "Stav na_trase, okno z plánu"; }
      if (typ !== "eskalacia") navrh += "\n\nS pozdravom\nKeylo s.r.o.\n\n— Toto je automatická odpoveď asistenta Logi IQ. Ak chcete hovoriť s človekom, odpíšte slovom „človek“.";
      botNavrhy.push({ id: botNavrhy.length + 1, typ, stav: "navrh", text: navrh, predmet: "Re: " + (predmet || "Vaša zásielka"), adresat: od, novy_datum: novy,
        dovod, istota, kanal: "test", od, sprava_predmet: predmet, sprava_text: t, overeny, zasielka: overeny ? "ZS2026-01185" : null, vytvorene: "dnes" });
      return { typ, overeny };
    },
    async kdeJe(polozkaId) {
      await cakaj(150);
      return zasoby.filter((z) => z.polozka_id === polozkaId && z.mnozstvo > 0)
        .map((z) => ({ sklad: "Hlavný sklad", lokacia: z.lokacia, typ: lok(z.lokacia).typ, sarza: z.sarza, expiracia: z.expiracia, mnozstvo: z.mnozstvo }));
    },
  };
}
