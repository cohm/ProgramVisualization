# Övergångsplan COPEN → CTFYS — underlag för signering

Planen är inläst från *Övergångsplan för Öppen ingång, påbörjad HT25 (gäller överg till CTFYS HT26)*, version 260114 Christian Ohm. Den maskinella tolkningen stämmer exakt med dokumentet: samtliga sex "Ersätter"-rader, undantaget av SF1544 och upphämtningskursen SF1920 återfinns i planen nedan.

**Källa:** Programansvarigs val av upphämtningskurs; SF1920 hämtad från CELTE årskurs 2 (läsår 2025/26).

**Status:** **inte verifierad** — detta dokument är det som ska signeras.

Varje kurskod nedan länkar till KTH:s kurssida. Kontrollera raderna i tur och
ordning; de som är markerade **Fråga** kräver ett aktivt beslut.

## Tillgodoräknade kurser

De 9 kurserna i COPEN årskurs 1 och vad de ersätter i CTFYS.

| COPEN-kurs | hp | Ersätter i CTFYS | hp | Kommentar |
|---|---|---|---|---|
| [SF1625](https://www.kth.se/student/kurser/kurs/SF1625) Envariabelanalys | 7,5 | [SF1673](https://www.kth.se/student/kurser/kurs/SF1673) Analys i en variabel | 7,5 | Envariabelanalys motsvarar CTFYS Analys i en variabel. |
| [SF1626](https://www.kth.se/student/kurser/kurs/SF1626) Flervariabelanalys | 7,5 | [SF1674](https://www.kth.se/student/kurser/kurs/SF1674) Flervariabelanalys | 7,5 | Flervariabelanalys, samma ämne som CTFYS-kursen. |
| [SF1624](https://www.kth.se/student/kurser/kurs/SF1624) Algebra och geometri | 7,5 | [SF1672](https://www.kth.se/student/kurser/kurs/SF1672) Linjär algebra | 7,5 | Algebra och geometri motsvarar CTFYS Linjär algebra. |
| [DD1310](https://www.kth.se/student/kurser/kurs/DD1310) Programmeringsteknik | 6 | [DD1331](https://www.kth.se/student/kurser/kurs/DD1331) Grundläggande programmering | 5 | Programmeringsteknik motsvarar CTFYS Grundläggande programmering. |
| [SG1133](https://www.kth.se/student/kurser/kurs/SG1133) Mekanik I | 9 | [SG1112](https://www.kth.se/student/kurser/kurs/SG1112) Mekanik I | 9 | Mekanik I, samma kurs som CTFYS läser i årskurs 1. |
| [SK1115](https://www.kth.se/student/kurser/kurs/SK1115) Elektromagnetism och vågrörelselära | 7,5 | [SK1104](https://www.kth.se/student/kurser/kurs/SK1104) Klassisk fysik | 7,5 | Elektromagnetism och vågrörelselära täcker CTFYS Klassisk fysik. |
| [SF1546](https://www.kth.se/student/kurser/kurs/SF1546) Numeriska metoder, grundkurs | 6 | _(ersätter ingen enskild kurs)_ | — | Numeriska metoder; ersätter SF1544, som därför utgår helt (se 'exempt'). |
| [SA1007](https://www.kth.se/student/kurser/kurs/SA1007) Ingenjörsrollen och ingenjörskunskap | 6 | _(ersätter ingen enskild kurs)_ | — | Ingenjörsrollen; tillgodoräknas utan att ersätta en specifik CTFYS-kurs. |
| [KD1000](https://www.kth.se/student/kurser/kurs/KD1000) Kemiska principer för hållbar utveckling | 3 | _(ersätter ingen enskild kurs)_ | — | Kemiska principer; tillgodoräknas utan att ersätta en specifik CTFYS-kurs. |

## Kurser som utgår

Kurser i CTFYS som den transfererande studenten inte läser.

- **[SF1544](https://www.kth.se/student/kurser/kurs/SF1544) Numeriska metoder, grundkurs IV** (6 hp) — tillgodoräknad genom [SF1546](https://www.kth.se/student/kurser/kurs/SF1546)
  Numeriska metoder är redan avklarad genom SF1546 i COPEN.

## Kurser som tillkommer

Kurser som inte finns i någon av de två publicerade studieplanerna.

- **[SF1920](https://www.kth.se/student/kurser/kurs/SF1920) Sannolikhetsteori och statistik** (6 hp, årskurs 2, P3: 6 hp) — i stället för [SF1922](https://www.kth.se/student/kurser/kurs/SF1922)
  Läses i period 3 tillsammans med CELTE årskurs 2. Ersätter SF1922, som CTFYS läser i årskurs 1.

## Läsårsbelastning i den sammansatta planen

Heltid är **15 hp per läsperiod**. Avvikelser är inte nödvändigtvis fel —
en övergångsplan innehåller ofta upphämtningskurser — men de bör stämma med
övergångsplanens egna summor.

| Årskurs | P1 | P2 | P3 | P4 | Totalt |
|---|---|---|---|---|---|
| 1 | 15 | 15 | 15 | 15 | 60 |
| 2 | 15 | 14 | 16 | 15 | 60 |
| 3 | 15 | 15 | 15 | 15 | 60 |

Dessa siffror stämmer med övergångsplanens egna summor (årskurs 2: 15,0/14,0/16,0/15,0).

## Frågor som behöver besvaras

### 1. Valfritt utrymme i årskurs 3

Övergångsplanen anger *Valfria kurser* som 7,5 hp i P3 och 7,5 hp i P4. CTFYS egen studieplan formulerar samma sak som **ett** utrymme på 15,0 hp över hela våren ("På våren i årskurs 3 finns ett utrymme på 15,0 hp valfria kurser"), vilket är så det ritas här: en ruta som spänner P3+P4.

Skillnaden spelar roll för studenten: en sammanhängande ruta säger att 15 hp får fördelas fritt över våren, två rutor säger 7,5 hp i varje period. **Fråga:** är den fria fördelningen över våren avsedd även för studenter från Öppen ingång?

---

När planen är godkänd sätts `verified: true` på posten i
`src/data/transitions.json`, och programmet visas då utan reservation.
