# How KTH study plans are written: observed differences between programmes

KTH schools run different kinds of programme, so some of what follows is a
legitimate consequence of different needs — a two-year master's programme has
little reason to describe elective space the way a five-year civilingenjör
programme does. Still, several of the differences below look incidental rather
than deliberate: the same fact is recorded in different places, or in prose in
one programme and in structured fields in another. Where that is the case, one
convention is usually easier to read, to maintain and to consume programmatically
than the other, and it seems worth comparing notes across schools.

These are observations, not conclusions. They were gathered while building a tool
that renders utbildningsplaner from KTH's published data (see `CLAUDE.md`), so the
lens is deliberately narrow: what is machine-readable, what is consistent, and
what needs a human to interpret. Anyone who owns one of these programmes will
know better than we do whether a difference is meaningful.

Everything is dated and sourced so it can be re-checked. The first round was
measured in August 2026 over eight programmes: **CTFYS, CTMAT, CFATE, COPEN**
(SCI) and **CINEK, TIEMM, CMAST, CMATD** (ITM). It was extended in September 2026
after reading the remaining civilingenjör programmes — **CDEPR, CENMI, CITEH,
CLGYM** (ITM), **CELTE, CDATE, CINTE, CMETE** (EECS), **CBIOT, CTKEM, CMEDT**
(CBH) and **CSAMH** (ABE) — and the eighteen transition plans from Öppen ingång
(COPEN) into them. Figures marked *(Aug 2026)* were measured over the first eight
programmes only and have not been re-measured.

---

## 1. Elective space: stated as a number in some programmes, only in prose in others

Full-time study is 15 hp per period, so a year's courses should add up to 15 in
every period. Where they do not, the gap is normally the space for *valfria
kurser*. That space is real, and students need to see it — but how it is recorded
varies:

| programme | how elective space is discoverable |
|---|---|
| CTMAT | prose, **with a figure per period**: *"Utrymmet för valfria kurser är 7,5 hp per period hela läsåret."* |
| CTFYS | prose, **with a figure for a term**: *"På våren i årskurs 3 finns ett utrymme på 15,0 hp valfria kurser."* |
| CMEDT | prose, **with a figure for a year**: *"Studenten ska också läsa 15 hp valfria kurser i åk 3"* |
| CLGYM | prose, **a figure per inriktning and year**, in the common text: *"MAFY: 9 hp av de villkorligt valfria kurserna … ska läsas i årskurs 3"* |
| TIEMM | prose, **no figure**: *"…kan du även välja några helt valfria kurser."* |
| CFATE | not stated as such; its prose says the villkorligt valfria courses *"borde läsas som VALFRIA kurser"* (see §2) |
| CMAST | not stated; a uniform 4.5 hp gap in year 2 P3 and P4 across all inriktningar *(Aug 2026)* |

Where a figure is given, the space can be filled in and checked — the stated
amount matched the computed shortfall exactly for CTMAT and CTFYS, and to within
0.5 hp for CMEDT. Where none is given, the arithmetic still reveals *that* space
exists, but not how it is meant to be distributed. The wording also matters:
"7,5 hp per period" and "15 hp on the spring" describe different freedoms, and a
reader should not have to guess which was meant.

CLGYM's figures are exact in an instructive way: each inriktning's obligatoriska
courses plus the stated pool make exactly 60 hp (TEDA year 4: 42 + 18, MAKE
48 + 12, TEMI 54 + 6).

**Suggestion.** Stating elective space as a number, with its period or term, is
materially more useful than stating it qualitatively — and more useful still would
be expressing it as an entry in the plan rather than as prose, so it does not have
to be recovered by subtraction. The wording CTMAT uses reads well and is
unambiguous: *"Utrymmet för valfria kurser är N hp per period."*

## 2. "Villkorligt valfri" is used for several different things

`electiveCondition: VV` marks a course as villkorligt valfri. At least four
situations are recorded the same way:

- **A genuine choice.** CTFYS year 3 lists `EF112X` and `SA114X` — pick one, both
  15 hp in P3+P4. This is a clean pick-one group.
- **A pool with a credit threshold.** CMETE: *"Minst 13 hp av de villkorligt
  valfria kurserna ska läsas."* CINTE states its thresholds over several years:
  *"minst 15 hp kurser ur MatNat-blocket och minst 13,5 hp kurser ur IT-blocket"*,
  with most of those courses listed under both year 2 and year 3.
- **Eligibility for a master's programme.** In the ITM programmes' year 3
  (CMAST, CMATD, CDEPR, CENMI, CITEH) every curriculum but the common one is named
  after a years 4–5 destination ("Master, industriell ekonomi"). A course named
  under a destination is marked VV, whether the destination requires it or merely
  recommends it. CITEH's ITH destination lists 22 such courses with no count. Read
  as choices, the destinations stack: CITEH year 3 came out at 23/13/21/21 hp.
- **Free elective space.** CFATE's own prose says the VV courses of its year 3
  *"borde läsas som VALFRIA kurser"* — they are electives, some of which also
  qualify for a master's programme.

None of these is detectable from the flag alone; the second and third only show
up as periods summing past full-time.

**Suggestion.** Where the requirement is "at least N hp from this set", recording
the threshold alongside the set would remove the ambiguity. Where a course is
listed because a master's programme requires it, saying *required* or
*recommended* per destination — as several programmes already do in prose
("Kurser som krävs: SI1146 och SH1014") — distinguishes a condition from advice.

## 3. Rules for a choice are written in different fields

The study plan has a field for the villkorligt valfri rule,
`conditionallyElectiveCoursesInformation`. Many programmes use it — *"Minst en av
de villkorligt valfria kurserna … ska läsas"*, *"En villkorligt valfri kurs ska
läsas"* — but the same kind of rule also appears elsewhere:

- CSAMH states its year-2 choice in the common `supplementaryInformation`:
  *"Det betyder att du väljer två av dem"*. Its HT2022–24 pages say *"väljer en av
  dem"*, for one path only, so the count also changes between cohorts.
- CLGYM states its per-inriktning pools in the common text (§1).
- CITEH states that ML1506 *"är obligatorisk endast för studenter som kommer från
  Öppen ingång"* in a course's free text — on the 2026/27 page only; the 2025/26
  page lists the same course with no note.

Measured over the first eight programmes *(Aug 2026)*, 39 of 166 curricula
populate the VV field, and 42 % of its lines carry a machine-readable rule.

**Suggestion.** Keeping every rule about a choice in the VV field, and phrasing it
as a count or a credit minimum, would let a reader — or a tool — find all of them
in one place.

## 4. A "group" of one

15 of 34 option groups extracted across the first eight programmes contained
exactly **one** course — 5 of CFATE's 7 and 10 of TIEMM's 23 *(Aug 2026)*. Kopps
marks these villkorligt valfri, but a choice between one alternative is not a
choice, and none of the hand-curated study plans in this project models them as
groups. CMAST's international profiles have a later example: MG1026 is the only
villkorligt valfri course with its layout in year 2, and nothing states whether it
must be taken.

This is probably an artefact of how the plan was entered rather than an intent.
Worth a look by whoever maintains those plans: either the group is missing its
other members, or the course is effectively obligatorisk within that inriktning.

## 5. Structure splits by school; wording does not

Two things vary independently, and it is useful to keep them apart.

**Structure follows the owning school.** SCI, EECS and CBH programmes return a
single curriculum with no inriktningar in years 1–3. ITM and ABE programmes split,
in two different ways:

| kind of split | programmes |
|---|---|
| none in years 1–3 | CTFYS, CTMAT, CFATE, COPEN (SCI); CELTE, CDATE, CINTE, CMETE (EECS); CBIOT, CTKEM, CMEDT (CBH) |
| real inriktningar | CINEK (4, from year 2), CLGYM (4, from year 2), CSAMH (5, in year 3), CMAST (3 international profiles) |
| year 3 split by master destination | CMAST, CMATD, CDEPR, CENMI, CITEH |

The master-destination split looks like the inriktning split in the data — CMAST
year 3 has 15 parallel curricula — but it means something else: a student
follows one destination, and most of the year is shared. The two can only be
told apart by the curriculum names.

**The common curriculum is sometimes a track of its own.** CMAST's only
inriktningar are its three international profiles, which most students do not
take. The common curriculum is therefore the default track, and it marks MG1026,
MF1016 and MJ1112 obligatoriska while the profiles offer them as choices. There is
no named "without a profile" option, so nothing in the data says the common
curriculum is a complete plan for most students rather than the part everyone
shares.

**Wording does not follow the school**, because prerequisite text belongs to the
*course*, not the programme: 23 courses appear in both an SCI and an ITM programme
and carry identical text in each *(Aug 2026)*. The variation tracks the department
that owns the course and the cycle level. TIEMM, a master's programme, is the
outlier on every measure (80 % of its prerequisite texts use "motsvarande",
against 15–29 % for the bachelor programmes).

## 6. `electiveCondition: R` is used by one programme only

CMAST records 144 participations with `electiveCondition: R` (rekommenderad) —
courses recommended for the master track a given inriktning leads to. None of the
other seven programmes of the first round uses this value at all *(Aug 2026;
not re-checked for the programmes added later)*.

It is genuinely useful information: it answers "what should I put in my elective
slots?", which none of the other programmes answers in structured form. But
because only one programme uses it, a consumer that has not met CMAST will not
know the value exists.

**Suggestion.** This looks like the better convention, not the deviant one. If
recommended-course-per-track were recorded this way across programmes, the
"elective space" problem in §1 would largely solve itself: the space and the
suggested ways to fill it would both be structured data. Worth discussing whether
CMAST's practice should spread rather than be normalised away.

## 7. Prerequisites: free text carrying structured intent

Prerequisites are published only as prose, in the syllabus *Särskild behörighet*
field, while what they express is almost always structured: a set of courses and a
requirement type. Recurring patterns:

```
"Aktivt deltagande i SF1673 Analys i en variabel."               -> participation
"Slutförd kurs SF1672 Linjär algebra"                            -> completed
"SG1112 Mekanik I eller motsvarande"                             -> completed, type implicit
"Kunskaper … motsvarande slutförd kurs DD1310-DD1319/DD1331/…"    -> a long alternative list
"…slutfört moment LAB1 i SH1017"                                 -> one module of another course
"Minst 104 högskolepoäng … ska vara avklarade"                    -> a credit threshold
"Obligatorisk åk 2 för studenter som har läst … Öppen ingång …"   -> an admission route, not a course
```

Four specific frictions, each of which needed a rule to work around:

1. **Type is often implicit.** "SG1112 Mekanik I eller motsvarande" does not say
   whether the course must be completed or merely attended. The distinction
   matters — one must finish before the course starts, the other may run in
   parallel.
2. **Requirements are not reliably separated.** EI1320's 2026 syllabus runs two
   requirements together with no punctuation between them: *"…motsvarande slutförd
   kurs SI1200 eller SF1693 Kunskaper i grundläggande elektromagnetism…,
   motsvarande slutförd kurs SK1104/SH1017…"*. Read as one clause, two independent
   requirements look like alternatives.
3. **Alternative sets are written two ways** — slash lists (`DD1331/DD1337`) and
   hyphen ranges (`DD1310-DD1319`) — sometimes both in one sentence. 43 range
   expressions appear across the first eight programmes *(Aug 2026)*.
4. **Lists of qualifying courses go stale.** DD1385 and DD1380 ask for knowledge
   in programming and list `DD1310/DD1311/…/DD1331` — but not `DD1333`, which is
   CTMAT's own first-year programming course. Neither syllabus has been revised
   since HT2021. DD1328 had the same omission and it *was* fixed in its 2026
   revision, which shows the process works when someone notices. MF1018's
   eligibility still names *"SF1502 Ingenjörsrollen och ingenjörskunskap"*, a
   code that recurs in three transition plans where Öppen ingång's course is
   SA1007 (§9).

**Suggestion.** Point 4 is the one with a clear owner: when a course lists the
courses that satisfy a knowledge requirement, that list needs revisiting whenever
a programme introduces a new course covering the same ground. Points 1–3 are
about wording, and a short house style would help — always state "slutförd" or
"aktivt deltagande" explicitly, and start each requirement as its own sentence.

## 8. Where the same fact lives in different places

Smaller observations, each costing a consumer a special case:

- **Course period data is authoritative in one place and stale in another.** The
  KOPPS API returns an older syllabus version than the course page for 51 of 217
  courses checked *(Aug 2026)*. Since KOPPS is being retired this is expected, but
  it is worth saying explicitly somewhere public that it should no longer be read.
- **A programme with no curriculum for a year says so in prose.** CFATE and CTFYS
  both explain in `supplementaryInformation` that years 4–5 are taken inside a
  master's programme. COPEN has no year 2–3 curriculum at all, and that is only
  discoverable by finding zero courses listed.
- **Courses for one admission route sit in the receiving programme's plan.**
  CITEH's year 2 lists ML1506 *Övergångsmodul till industriell teknik*, which only
  students from Öppen ingång take, and says so only in free text (§3). CSAMH's
  AI1531 is not in its plan at all; its own syllabus eligibility is the only
  public statement that Öppen ingång students must read it.
- **Known data errors are documented in prose.** CTMAT's plan says: *"En bugg gör
  tyvärr att fel poängfördelning för SA1006 visas i studentgränssnittet."*
  Honest and helpful to a human reader, invisible to anything automated.
- **Selecting a historical course version is no longer possible in the UI.** The
  `?startterm=` parameter is ignored; only the current round is shown. The full
  version history is still present in the page's own data, and in PDF form in the
  kursutveckling archive, but a programme director cannot browse to the version a
  past cohort actually studied.

## 9. Transition plans from Öppen ingång have no common form

A COPEN student takes one year of Öppen ingång and then transfers. What they read
next is described only in the receiving programme's *övergångsplan*, which is
published nowhere else. All eighteen were read for this note, and they differ in
ways that make them hard to compare or check:

- **Format.** Most are exports of a shared spreadsheet layout (Öppen ingång's year
  1, the receiving year 1, then years 2 and 3, with a green/pink legend for
  "ordinarie" and "valbar"). CINTE's is a three-page slide deck whose year 2 is
  labelled *"exempel"*. CMETE's and CDATE's are scans with no text layer. CLGYM's
  is a set of per-inriktning tables.
- **Versioning.** Most carry a version date; CMEDT's and CINTE's do not. CTKEM's
  heading says *"påbörjad HT26"* for a plan filed as kull HT25.
- **Where equivalences are stated.** In a comments column on the Öppen ingång side
  (CMEDT *"Ersätter HI1024"*, CITEH, CDEPR), on the receiving side (CMAST
  *"Ersätts av …"*, CENMI *"Ingår i OPEN"*, CMETE *"Läses ej, ersätts av …"*), in
  a footnote (CDEPR), or only in aggregate: CBIOT's year 1 *"Motsvarar 51hp
  obligatoriska kurser … och 9hp villkorligt valfria kurser"*, without saying
  which.
- **Sums that do not match their rows.** CBIOT's year-3 hp column totals 61, which
  holds only without KD1270, while its P4 sum includes KD1270 and leaves out
  BB1230. CDEPR's year-2 P1 sum leaves out MG1028. Colour carries meaning that a
  text export loses; CBIOT also greys rows that the legend does not explain.
- **Course codes out of step with the receiving programme.** CMEDT's plan names
  CM1004 and HL102X where the programme now has CM1009 and HL103X, and gives
  different sizes for four courses. CENMI's names SF1514 where its data has
  SF1512. Three plans (CMAST, CDEPR, CTKEM) write *"SF1502 Ingenjörsrollen och
  ingenjörskunskap"* for Öppen ingång's SA1007.
- **Term labels a year off.** CDEPR's comments say *"ht-25"* and *"ht-26"* for
  rows in its 2026/27 and 2027/28 tables; CSAMH's headings put year 2 of kull HT25
  in *"lå 25/26"*; CLGYM's year 3 is headed *"HT 2026/2027"*.
- **The eligibility box is usually empty.** The shared layout has *"Ange särskild
  behörighet för kurser i år 2"*. Where it appears it is blank, a dash, or (CMETE)
  a pointer to the study plan — including in CSAMH's plan, where AL1302 and
  AI1525 require AI1527 while the transfer student reads its replacement AI1531
  in parallel.

None of these is an error in the transfer itself — the arithmetic of the plans
usually works, and several programmes send each student to the study counsellor
for an individual plan (CTKEM says so explicitly). But a student comparing two
receiving programmes, or a counsellor checking one, has to read each plan on its
own terms.

**Suggestion.** A single template, kept as the spreadsheet rather than a scan or a
slide, with a version date, the receiving programme's current course codes, sums
computed by formula, and one fixed place for equivalences ("ersätter X") and for
special eligibility, would make the plans comparable and checkable. Most of them
already follow such a template; the gain is in the rest.

---

## Summary of what seems to work best

Drawn from the above, and offered for discussion rather than as recommendations:

| topic | the convention that reads best | seen in |
|---|---|---|
| elective space | stated as hp per period, in the plan rather than in prose | CTMAT (prose with figure) |
| recommended courses | structured per inriktning, not described in text | CMAST (`R`) |
| credit-threshold groups | threshold recorded with the set | CMETE, CINTE (in prose) |
| master eligibility | required vs recommended stated per destination | CFATE (in prose) |
| rules for a choice | in the VV field, as a count or minimum | most; not CSAMH, CLGYM |
| prerequisite type | "slutförd" / "aktivt deltagande" always explicit | CTFYS, mostly |
| requirement separation | one sentence per requirement | most, but not EI1320 |
| qualifying-course lists | reviewed when a programme adds a covering course | DD1328 (fixed 2026) |
| transition plans | one spreadsheet template, dated, current codes, fixed place for equivalences | most COPEN plans |

None of this is urgent. But since several of these are already done well
*somewhere* at KTH, harmonising is mostly a matter of picking whichever
convention already exists rather than inventing anything.
