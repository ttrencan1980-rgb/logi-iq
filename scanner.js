// Skenovanie: fotoaparát telefónu (BarcodeDetector, inak knižnica ZXing) alebo ručná čítačka,
// ktorá píše ako klávesnica a končí Enterom. Ručné zadanie funguje vždy.

const FORMATY = ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "upc_a"];
const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

let aktivny = null;

export async function spustiKameru(video, onKod) {
  zastavKameru();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Prehliadač nepovoľuje kameru. Použi čítačku alebo napíš kód.");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  await video.play();
  const stav = { stream, bezi: true, posledny: "", cas: 0 };
  aktivny = stav;

  const hlas = (kod) => {
    const teraz = Date.now();
    if (kod === stav.posledny && teraz - stav.cas < 2000) return;   // ten istý kód nečítať dvakrát za sebou
    stav.posledny = kod; stav.cas = teraz;
    navigator.vibrate?.(60);
    onKod(kod);
  };

  if ("BarcodeDetector" in window) {
    const podporovane = await window.BarcodeDetector.getSupportedFormats().catch(() => FORMATY);
    const det = new window.BarcodeDetector({ formats: FORMATY.filter((f) => podporovane.includes(f)) });
    const krok = async () => {
      if (!stav.bezi) return;
      try {
        const kody = await det.detect(video);
        if (kody[0]?.rawValue) hlas(kody[0].rawValue);
      } catch { /* snímka ešte nie je pripravená */ }
      setTimeout(krok, 180);
    };
    krok();
    return;
  }

  // iPhone a starší Android: ZXing
  if (!window.ZXing) {
    await new Promise((ok, chyba) => {
      const s = document.createElement("script");
      s.src = ZXING_URL; s.onload = ok; s.onerror = () => chyba(new Error("Čítačku kódov sa nepodarilo načítať. Napíš kód ručne."));
      document.head.appendChild(s);
    });
  }
  const citac = new window.ZXing.BrowserMultiFormatReader();
  stav.zxing = citac;
  citac.decodeFromStream(stream, video, (vysledok) => { if (stav.bezi && vysledok) hlas(vysledok.getText()); });
}

export function zastavKameru() {
  if (!aktivny) return;
  aktivny.bezi = false;
  try { aktivny.zxing?.reset(); } catch { /* nič */ }
  aktivny.stream.getTracks().forEach((t) => t.stop());
  aktivny = null;
}

export const kameraBezi = () => !!aktivny;
